description: Fixed a bug where creating a case-insensitive unique index over a JSON column in the persistent store could succeed even though existing rows already broke that uniqueness rule — the fix makes the check run at index-build time match the check the store already runs on every write.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # new storeDedupeKeyTransform + cross-referenced docstrings
  - packages/quereus-store/src/common/store-module-index-build.ts   # both dedupe-signature call sites now use it; two NOTE tripwires added
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # corrected stale docstring at pkKeyCollationName
  - packages/quereus-store/test/unique-constraints.spec.ts          # new regression test, committed-row build path
  - packages/quereus-store/test/isolated-store.spec.ts              # new regression test, wrapper (mid-transaction) build path
difficulty: easy
---

# Build-time UNIQUE dedupe now reproduces the write-time comparison

## What changed

Root cause (full analysis was done in the `fix/` stage and carried into this ticket's
body — see git history for `bug-store-index-build-dedupe-skips-collation` if the
reasoning needs re-deriving): the store's build-time UNIQUE dedupe signature
(`dedupeRowSignature` in `store-module-index-build.ts`) ran a JSON column's value
through `storeSemanticKeyTransform`, which returns a `Uint8Array` structural key.
`serializeKey` only ever applies a collation NORMALIZER to a raw `string` value — a
`Uint8Array` is tagged as an opaque byte array and the normalizer never runs — so an
index-level `COLLATE NOCASE` on a JSON column was silently dropped at build time, while
the write-time check (`JSON_TYPE.compare`, which DOES honor the collation for a
string-scalar pair) still enforced it. Net effect: `CREATE UNIQUE INDEX … (d COLLATE
NOCASE)` could succeed over two case-variant rows that a subsequent `INSERT` of a third
variant would then reject.

Fix: added `storeDedupeKeyTransform` (`pk-key-resolution.ts`), the dedupe-signature twin
of `storeSemanticKeyTransform` — same job, but a JSON value that is a `string` scalar is
left AS a string (so `serializeKey`'s normalizer still runs), and everything else (JSON
object/array/number/boolean/null) still gets the structural bytes. Every other
semantic-ordering type (TIMESPAN) is unaffected — it defers straight through to
`storeSemanticKeyTransform`, since TIMESPAN's `compare` ignores collation entirely and
already collides every equal-identity spelling via `groupKey` on both paths.

Both build-time call sites now use the new transform: `buildIndexEntries`'s in-pass
`seen` check (which needed a SECOND transform array — `indexTransforms` still feeds
`buildIndexKey` and must stay the hard-structural physical-key-bytes transform) and
`assertNoDuplicateRows` (shared by `validateUniqueOverExistingRows` and
`validateUniqueIndexOverRows`).

Also corrected a stale docstring parenthetical at `pkKeyCollationName`
(`comparison-collation.ts`): it claimed DDL rejects a non-BINARY `COLLATE` on a
collation-blind type (JSON, temporals) as a general rule, backstopped by the hard-coded
BINARY branch. That's true for COLUMN DDL (`validateCollationForType`) but false for
INDEX DDL — `SchemaManager.buildIndexSchema` / `importIndex` resolve an index column's
collation with no type gate at all, which is what made this bug reachable. The comment
now says the hard-coding is the ONLY gate for an index column, not a backstop.

## Use cases / how to validate

Direct repro (now rejected, matching a plain memory table):

```sql
create table t (id integer primary key, d json) using store;
insert into t values (1, '"a"'), (2, '"A"');
create unique index ix on t (d collate nocase);   -- now: UNIQUE constraint failed (was: succeeded)
```

Two new regression tests pin this:

- `packages/quereus-store/test/unique-constraints.spec.ts`, describe `'collation guard'`
  → `'a JSON column with pre-existing NOCASE-equal rows rejects CREATE UNIQUE INDEX …
  COLLATE NOCASE'`. Covers the committed-row build path
  (`buildIndexEntries`/`StoreModuleIndex.createIndex` with no wrapper), asserting BOTH
  the store and a plain memory table reject.
- `packages/quereus-store/test/isolated-store.spec.ts`, describe `'row-validating DDL
  over an open transaction'` → `'CREATE UNIQUE INDEX … COLLATE NOCASE over a JSON column
  is rejected for pending NOCASE-equal rows (wrapper dedupe)'`. Covers the OTHER call
  site — `validateUniqueIndexOverRows`, reached when `createIsolatedStoreModule` supplies
  the row stream for a mid-transaction `CREATE UNIQUE INDEX` (confirmed reachable from
  SQL via the existing sibling test `'CREATE UNIQUE INDEX rejected over pending
  duplicates loses no staged row'` in the same describe block).

Full verification run this stage: `yarn workspace @quereus/store run test` — 1284
passing, 0 failing (was 1283 before the two new tests; net +1 because the isolated-store
test file gained one and the count already included the first new test from an earlier
run in this same session). `yarn workspace @quereus/store run typecheck` clean. `yarn
workspace @quereus/quereus run lint` clean (comment-only change in that package). Full
`yarn test` (whole monorepo) green — no failures anywhere, no pre-existing-failure file
needed.

## Known gaps for the reviewer

- **TIMESPAN and TEXT controls were not duplicated into the new tests.** Both are
  already pinned elsewhere as build/write-agreement regressions:
  TIMESPAN in `timespan-semantic-key-identity.spec.ts` ("rejects `create unique index`
  over existing equal-elapsed spellings"), TEXT in `unique-constraints.spec.ts`
  ("build-time dedup and DML enforcement agree on the index collation"). The new JSON
  test cross-references both by name in a comment rather than re-asserting them, to stay
  DRY. If the reviewer wants them inline next to the JSON case for locality, that's a
  style call, not a coverage gap — the assertions already run on every `yarn test`.
- **Comparator-only custom collation on a JSON index column — investigated by code
  reading only, NOT exercised by a test.** Per the ticket's own flag: DDL-time
  `assertIndexKeyCollationsCanKey` checks the PHYSICAL key collation
  (`resolveIndexKeyCollations`, hard-`BINARY` for JSON) and passes; but
  `indexDedupeNormalizers` (build-time dedupe signature) looks up the column's own
  DECLARED collation name (JSON can hold text) and `keyNormalizers` throws for a
  comparator-only name. So `CREATE UNIQUE INDEX … (json_col COLLATE some_comparator_only)`
  likely throws a confusing "no key normalizer" error despite the key-collation gate
  just having passed. This is pre-existing behavior, untouched by this fix (the
  normalizer lookup, not the transform, is what throws) — documented as a `NOTE:` at
  `indexDedupeNormalizers` in `store-module-index-build.ts` rather than filed as a
  ticket, since it degrades to a thrown error, not silent wrong data. Confirm by reading
  the NOTE and, if it's worth a friendlier error message, that's a fresh `debt-` ticket,
  not a re-open of this one.
- **`packages/quereus-store/README.md` (~line 300, the row-validating-DDL paragraph) and
  `docs/types.md` § "Semantic ordering"** were both read and checked against this
  change. Neither states a build-time collation rule this fix makes stale — the README
  paragraph describes WHICH row stream row-validating DDL reads (effective vs.
  committed), not how the dedupe signature is computed; the types.md section's claim
  "creating an index never changes a query's answer" is about physical key bytes /
  read-path correctness, orthogonal to the build-time UNIQUE-check defect fixed here. No
  doc edits made.

## Tripwire already recorded (not a ticket)

`store-module-index-build.ts`, at `dedupeRowSignature`: a `NOTE:` that the signature
normalizes STRING values only, so any FUTURE semantic-ordering type that both carries a
key transform and honors a collation in its `compare` (like `JSON_TYPE`) needs its own
`storeDedupeKeyTransform` branch, or its build-time check silently degrades to BINARY
while the write-time check honors the collation. This is the generalized version of the
bug this ticket fixed, written at the site a future author would actually meet it.
