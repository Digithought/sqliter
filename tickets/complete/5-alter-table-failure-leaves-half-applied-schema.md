description: A failed ALTER TABLE on a stored table used to leave the open session behaving as if it had succeeded — a rule that was never added stopped blocking bad rows, and a rule that was never removed stopped being applied. Every ALTER shape that changes only the table's description, and no stored data, now undoes itself cleanly.
files:
  - packages/quereus-store/src/common/store-module-index.ts          # adoptAndPersistSchema (408) — the seam; unwindFailedSchemaDdl, guardedUnwindStep, SchemaDdlProgress
  - packages/quereus-store/src/common/store-module-alter.ts          # the four schema-only arms route through the seam; NOTE: at the dispatcher's reconcile (122)
  - packages/quereus-store/src/common/store-module-alter-column.ts   # storeMutated gate (107) — routes ALTER COLUMN's schema-only shapes through the seam too
  - packages/quereus-store/README.md                                 # refused-DDL semantics documented under the transaction-isolation bullets
  - packages/quereus-store/test/refused-ddl-residue.ts               # shared (non-spec) harness; + catalogDdlText
  - packages/quereus-store/test/alter-refused-residue.spec.ts        # 7 cases, one case table
  - packages/quereus-store/test/stream-index-build.spec.ts           # imports the shared harness
----

# What shipped

A store-backed `ALTER TABLE` persists in two steps: adopt the post-ALTER schema on the
connected table, then write it to the durable catalog. When the catalog write threw, the
first step stayed. The module's cached schema was then one statement ahead of both the
engine and the catalog for the rest of the session — a `UNIQUE` that was never added
stopped rejecting duplicates while the session believed it was live, and one that was
never dropped stopped being enforced.

`StoreModuleIndex.adoptAndPersistSchema(table, updatedSchema)` is the seam that closes it:
swap, persist, and on a persist failure put the previous cached schema back and rethrow.
It reuses the unwind `createIndex` / `dropIndex` already had, renamed away from "index"
now that two DDL families share it (`unwindFailedSchemaDdl`, `SchemaDdlProgress`).

Every `ALTER TABLE` path that rewrites no row data before the catalog write now persists
through it:

- `ADD` / `DROP` / `RENAME CONSTRAINT` and `RENAME COLUMN` (implement stage)
- the `ALTER COLUMN` shapes that mutate nothing physical — `DROP NOT NULL`, `SET DEFAULT`,
  a `SET NOT NULL` over rows holding no NULL, a `SET COLLATE` on an unindexed non-PK
  column (**review stage — see finding 1**)

The row-rewriting paths (`ADD` / `DROP COLUMN`, `ALTER PRIMARY KEY`, and the `ALTER COLUMN`
shapes that convert values, re-key, or rebuild indexes) deliberately keep the bare pair:
they have already re-encoded the store, so restoring the old schema would misread the new
bytes. That window is a pre-existing accepted tradeoff recorded at `alterDropColumn`; it
was not reopened.

# Review findings

## Checked

Read the implement diff (`f558238b`) before the handoff summary. Scrutinized: the seam's
ordering and capture semantics; whether `catalogWritten: false` is a safe assumption;
whether the restore itself can fail; every other `table.updateSchema(...)` +
`saveTableDDL(...)` pair in the package (`store-module-alter.ts` ×4,
`store-module-alter-column.ts` ×1, `store-module-rename.ts` ×1); the four new tests for
vacuity; the shared harness lift; and the package README against the new reality.

## Fixed in this pass

**1. `ALTER COLUMN`'s schema-only shapes still carried the whole bug.** (major finding,
fixed inline because the seam and the harness already existed) `alterColumnChange` is only
*sometimes* row-rewriting, but the implement stage excluded the entire arm with a blanket
"this arm may already have rewritten stored values" comment. `DROP NOT NULL`, `SET
DEFAULT`, a `SET NOT NULL` over rows holding no NULL, and a `SET COLLATE` on an unindexed
non-PK column all reach the persist having touched no store at all — same class, same
harm, unfixed. Reproduced before fixing: with the catalog write refused,
`alter table t alter column n set default 42` left the phantom default in the module's
cached schema, and the *next* successful catalog write from an unrelated statement made it
durable (the catalog re-renders the whole bundle from the cached schema). Same for
`drop not null`. Fixed with a `storeMutated` flag set at each of the arm's three mutation
sites (PK re-key, value rewrite, index rebuild) and read at the persist — set at the site
rather than re-derived from the gate conditions, so it cannot drift from them. Two new
test cases; both fail without the fix.

**2. `adoptAndPersistSchema` took a `subject` string every caller derived identically.**
(simplification) All four call sites passed `alterSubject(oldSchema)`, a module-local
helper in `store-module-alter.ts` — which `store-module-alter-column.ts` would have had to
import to make finding 1 work. The seam already captures `table.getSchema()`; it now
derives the warning subject from that. Parameter and helper both gone.

**3. Coverage gaps from the handoff, closed.**
- *Constraint-kind coverage was partial* (UNIQUE and CHECK only): added a `FOREIGN KEY`
  case through `alterAddConstraint`. It passed on the implement-stage code — the seam
  already covered it — so it is a regression guard, not a bug found.
- *`yarn test:store` was not run*: run, **9224 passing / 0 failing** (2m). This is the run
  that exercises `ALTER COLUMN` through a real LevelDB provider, so it was load-bearing
  for finding 1's fix, not belt-and-braces.

**4. Two test-quality defects in the new cases, caught before they landed.** The first
`DROP NOT NULL` assertion matched a bare `/not null/i` against the whole catalog text — the
PK column renders one, so it passed even with the relaxation leaked; narrowed to the
column's own rendered definition. The `FOREIGN KEY` case's residue snapshot was
destabilized by stats-store entries first written during the refused statement (provider
noise, not schema residue); the setup now warms them.

**Anti-vacuity, re-run:** with the seam's unwind call disabled, all 7 cases fail. Restored
and re-verified green.

## Checked and found correct — no change needed

- **`catalogWritten: false` is sound.** The handoff flagged a worry that `saveTableDDL`
  might fail partway through a multi-key write, breaking the "the catalog was never
  written" assumption the seam relies on to skip the catalog restore. It cannot:
  `saveTableDDL` is one `catalogStore.put` of one key. The second failure mode the handoff
  wanted exercised — an encoder rejection on unencodable DDL text — throws in
  `encodeCatalogDDL` *before* that put, so it lands in the same state the tested mode does.
  No second injection added; the two are indistinguishable to the seam.
- **A failing unwind on the ALTER path is unreachable, not merely untested.** The handoff
  listed it as a gap. Restoring needs `table.updateSchema(originalSchema)` to throw, and
  `updateSchema` validates key collations and semantic key transforms *before* adopting
  anything — over a schema the table demonstrably carried a moment earlier, with the same
  registered collations. Symmetric, so it cannot reject. `guardedUnwindStep`'s swallow-and-
  log stays covered through `createIndex`, which reaches it via a physical teardown.
- **The validation-rejection path is correct by construction.** If
  `updateSchema(updatedSchema)` throws, `schemaSwapped` is still false and nothing is
  restored — right, because nothing was adopted. `updateSchema` assigns no field until
  after both validators pass.
- **The isolation wrapper is orthogonal.** The seam runs after every row read and takes no
  `rows` parameter, so the `EffectiveRowSource` path cannot reach it differently.

## Tripwires — parked, not ticketed

- **The residual window after the arm returns.** `alterTable` runs
  `reconcileImplicitUniqueIndexStores` outside the seam; if that `_uc_*` build or teardown
  throws (an IO error), the catalog and the connected table carry the post-ALTER constraint
  set while the engine does not. The handoff asked the reviewer to decide whether this
  deserves its own ticket. **It does not.** The site it would resolve at —
  `reconcileImplicitUniqueIndexStores`' build loop — already carries a pre-existing
  accepted-tradeoff `NOTE:` covering exactly this ("no teardown-on-failure wrapper …
  tolerated … add a try/catch teardown if this ever bites"), whose revisit condition has
  not tripped. The divergence is also weaker than the one just fixed: the *durable* state
  stays self-consistent (catalog and stores both post-ALTER) and a reopen converges; only
  the erroring session's engine schema lags. The implement stage's `NOTE:` at the
  dispatcher (`store-module-alter.ts:122`) is the right home for it and stays.
- **One assertion hard-codes the physical store name `main.t_idx_uq`.** Deliberate: the
  harness's `indexStoreSize` helper returns 0 for both "absent" and "empty", and the harm
  being asserted is precisely an *empty ghost* store, so `stores.has(...) === false` is the
  stronger claim. It needs updating if `implicitUniqueIndexName` ever changes. Noted here
  rather than in code — the spec's own case comment already explains what the name is.

## Filed as new tickets

None. Finding 1 was the only major one and was fixable inline against a seam that already
existed; filing it would have queued a ticket to make a one-line routing decision.

## Docs

`packages/quereus-store/README.md` had no statement of refused-DDL semantics at all — the
implement stage added none. Two bullets added under the transaction-isolation list: what a
refused schema-only DDL statement now guarantees (naming each shape, including the
`ALTER COLUMN` ones), and the row-rewriting exception with its accepted tradeoff. No other
doc in the repo describes store DDL failure behavior; `docs/architecture.md` and
`docs/schema.md` were checked and do not reach this level.

# Validation

- `yarn workspace @quereus/store test` — **1600 passing, 0 failing** (1597 + 3 new cases)
- `yarn test` (whole workspace) — **all green, 0 failing**
- `yarn test:store` (LevelDB-backed) — **9224 passing, 33 pending, 0 failing**
- `yarn build` — clean
- `yarn lint` — clean
- `yarn typecheck` — clean (covers `tsconfig.test.json`, so the new test code is checked)
