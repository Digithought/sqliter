----
description: The persistent store used to keep two identical hidden indexes when someone declared both a UNIQUE column and a separate plain index on the same column; it now reuses the existing index instead of building a duplicate, and rebuilds the hidden one if that index is later dropped.
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts   # findReusableIndexForUnique + indexCollationsMatchDeclared; withImplicitUniqueIndexes skips a covered UNIQUE
  - packages/quereus-store/src/common/store-module.ts  # implicitUniqueIndexNameMap is reuse-aware; createIndex / dropIndex reconcile; teardowns DDL-commit first
  - packages/quereus-store/test/unique-constraints.spec.ts  # describe 'implicit unique index — explicit-index reuse' (21 tests) + createIndexTrackingProvider
  - packages/quereus-store/README.md                   # § implicit per-constraint index — reuse + DDL-commit bullets
----

# Store: reuse an existing explicit index instead of a duplicate implicit UNIQUE index

## What shipped

A plain `UNIQUE` (`email text unique`, or `unique (email)`) is enforced in the store
through a hidden secondary index named `_uc_<cols>` — or after the constraint, when it is
named. That index lives only in `StoreTable`'s private "materialized" schema; the engine
never sees it, it is never persisted as a `create index`, and it is re-derived from the
constraint list every time the table is opened.

It used to be built unconditionally, so `create index ix on t(email)` alongside
`email text unique` left two byte-for-byte identical structures, both written on every
insert / update / delete.

Now a `UNIQUE` whose columns are already covered — in the same order — by a
collation-compatible, full (non-partial) explicit index gets no hidden index; that index
enforces it. `findUniqueConflictViaIndex` already accepted any full index over the
constrained columns, so enforcement needed no change; only the materialization decision
and the physical-store lifecycle moved.

- **`findReusableIndexForUnique(schema, uc)`** (`store-table.ts`) is the gate. It refuses
  index-derived UNIQUEs, partial UNIQUEs, partial indexes, collation-mismatched indexes,
  indexes over different or reordered columns, indexes with extra columns, and the
  constraint's own `_uc_*` — that self-exclusion is what makes an already-materialized
  schema answer the same as its engine-facing original.
- **`implicitUniqueIndexNameMap`** (`store-module.ts`) applies the same gate, so the set
  of `_uc_*` stores that *should* exist matches what the materializer produces.
- **`createIndex` / `dropIndex`** call `reconcileImplicitUniqueIndexStores`, which diffs
  those name maps: creating a covering index tears the redundant `_uc_*` store down,
  dropping it rebuilds `_uc_*` from the live rows.

A **DESC** index is reusable — every writer and reader derives direction from the index's
own `columns[].desc`, so the enforcement probe lands on the window the entry was written
to.

The collation gate is stricter than today's encoding needs: store index keys are encoded
under the table key collation for every index alike, so a same-column index is
byte-identical to the `_uc_*` it replaces regardless of declared `COLLATE`. Kept strict to
mirror `MemoryTableManager.indexCollationsMatchDeclared` and to stay correct if store index
keys ever move to per-column collations (`plan/debt-store-index-keys-use-column-collation`).

## Review findings

### Checked and clean

- **Enforcement equivalence.** Duplicate insert, distinct insert, `UPDATE` into a
  collision, self-collision on `UPDATE`, reuse of a vacated value, `INSERT OR IGNORE`,
  `INSERT OR REPLACE` — all behave through the reused index exactly as through `_uc_*`.
  `UPDATE` and the conflict-resolution clauses had no test; added.
- **Reuse predicate boundaries.** Multi-column `UNIQUE` reuses a same-order index and
  refuses a reversed one; an index with extra trailing columns is refused; a `NOCASE`
  column with a plain (no explicit `COLLATE`) index is reused and still enforces `NOCASE`.
  None of these were pinned; added.
- **Transitions.** Two covering indexes: dropping the first keeps reuse, dropping the last
  rebuilds `_uc_*`. `ALTER TABLE DROP COLUMN` renumbering leaves the decision intact.
  `ALTER COLUMN … SET COLLATE` keeps enforcement correct. Added the first two as tests.
- **The name-aliasing case** (a user index whose name equals the constraint's implicit
  name) is genuinely unchanged: both the old and new name maps contain that name, so the
  reconcile is a no-op there, exactly as before this ticket. It remains owned by
  `fix/bug-drop-index-removes-unique-constraint-backing`.
- **`DROP TABLE` / `RENAME TABLE`** resolve their physical-store list from the materialized
  schema, which correctly omits a reused-away `_uc_*`. No stranding, no empty-store rename.
- **Memory-backend parity spot-check.** Confirmed the memory backend does *not* reuse a
  partial index for a full `UNIQUE` (its reuse runs before any later `create index`), so
  the divergence there is cost, not correctness — see the backlog ticket below.
- **Build, lint, typecheck** clean. `yarn test` (full workspace) clean.
  `yarn test:store` (logic suite against the LevelDB store module) 7758 passing,
  0 failing, 20 pending.

### Found and fixed in this pass

- **Regression: `CREATE INDEX` mid-transaction over a written UNIQUE column failed at
  commit.** The new teardown closes and deletes a `KVStore` the module coordinator still
  holds buffered ops against (pending ops are keyed on the store *handle*), so
  `begin; insert …; create index …; commit` threw `store is closed` at commit. It worked
  before this ticket. The implement handoff flagged the exposure but left it untested and
  unfixed.

  Probing it showed the same crash already reached `DROP INDEX` after writes in a
  transaction (with or without a UNIQUE involved) and `ALTER TABLE DROP CONSTRAINT` after
  writes — a pre-existing class, not a one-off.

  Fixed at both teardown sites with the module's established mechanism: `dropIndex` and
  `reconcileImplicitUniqueIndexStores` now call `ddlCommitPendingOps()` before deleting a
  store, which is exactly what `ddlTransactionality: 'auto-commit'` already promises and
  what the row-rewriting `ALTER` arms do. The reconcile flushes only when something is
  actually doomed, so a `CREATE INDEX` that retires no `_uc_*` does not force-commit the
  caller's transaction. Three tests added (`CREATE INDEX`, `DROP INDEX`,
  `ALTER … DROP CONSTRAINT`, each mid-transaction after writes).
- **Stale docs.** `packages/quereus-store/README.md` still stated the hidden index is
  "always materialized, even alongside an explicit index" and pointed at this ticket as a
  deferred optimization. Rewritten to describe reuse, the non-reusable shapes, the
  create/drop transition, and the new DDL-commit behavior. The engine-side docs
  (`docs/schema.md`, `docs/sql-ddl.md`) mention `_uc_*` only as an auto-generated
  constraint name and needed no change.
- **Stale code comments.** The `createIndex` `NOTE:` describing the unfixed transaction
  exposure, and `alterDropConstraint`'s "schema-only catalog rewrite" claim (it now
  DDL-commits via the reconcile), were corrected.

### Recorded as tripwires (not tickets)

- `withImplicitUniqueIndexes` appends `_uc_*` *after* the explicit indexes, so when both
  exist — the collation-mismatch case the strict gate deliberately produces —
  `findIndexForUniqueConstraint`'s `find` picks the explicit index and the `_uc_*` is
  maintained but never seeked. Harmless today (all index keys are encoded under the table
  key collation, so the two are byte-identical), but it would silently under-fetch if index
  keys move to per-column collations. `NOTE:` at
  `store-table.ts` `findIndexForUniqueConstraint`, naming
  `plan/debt-store-index-keys-use-column-collation` as the change that must address it.

### Filed as a new ticket

- `backlog/debt-memory-unique-index-reuse-after-create-index` — the memory backend decides
  reuse once at table construction, so `create table t(… unique); create index ix on t(…)`
  leaves it maintaining two identical structures forever. Cost only, no wrong answers, but
  the two backends' reuse rules are now documented as mirroring each other and no longer do.

### Explicitly not addressed

- **Databases written before this change** still carry a `_uc_*` store on disk for a
  constraint that now reuses an explicit index. Nothing reads it and nothing reclaims it,
  so `drop table` / `rename table` will strand it. Left alone under the project's
  "backwards compat: don't worry yet" policy; the README already says a pre-feature store
  needs its index rebuilt.
- **No benchmark.** The saving is structural (one index maintained instead of two) and is
  pinned by entry-count assertions, not by a timing measurement.

### Test-provider caveat worth knowing

`createIndexTrackingProvider` in the spec implements `deleteIndexStore` but not
`deleteTableStores`, so `DROP TABLE` under it falls back to closing the data store only and
leaves index-store keys in its map. That makes it unsuitable for asserting `DROP TABLE`
reclamation; the existing drop/rename coverage uses the other providers in that file.
