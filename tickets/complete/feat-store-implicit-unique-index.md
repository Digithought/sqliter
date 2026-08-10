description: The persistent store now builds a hidden per-constraint index behind every plain UNIQUE column, so enforcing uniqueness is a fast index lookup instead of a whole-table scan — bulk inserts under a UNIQUE go from O(n²) to O(n log n).
prereq:
files:
  - packages/quereus-store/src/common/store-table.ts    # withImplicitUniqueIndexes + implicitUniqueIndexName; materializedSchema; findIndexForUniqueConstraint; updateSecondaryIndexes; getMaterializedSchema
  - packages/quereus-store/src/common/store-module.ts    # alterTable reconcileImplicitUniqueIndexStores; NEW materializedIndexNames helper; destroy + renameTable fixes
  - packages/quereus-store/README.md                     # implicit-index note (+ new DROP/RENAME TABLE bullet)
  - packages/quereus-store/test/unique-constraints.spec.ts   # lifecycle/coexistence/reopen/collation tests + NEW DROP/RENAME TABLE tests
difficulty: hard
---

# Complete: store materializes an implicit index for every non-derived UNIQUE

## What landed

A plain column/table-level `UNIQUE` in the persistent store previously had no
backing index, so enforcement full-scanned the table per constrained row written
(bulk load of *n* rows ≈ *n²*). The store now synthesizes a hidden per-constraint
index — `<constraint name>` when named, else `_uc_<columns>` — held ONLY in a new
private `StoreTable.materializedSchema` (never the engine-facing `tableSchema`),
and enforcement routes through the existing index point-seek. Bulk inserts under a
plain `UNIQUE` are now O(n log n), at parity with the memory backend.

The engine-facing/enforcement schema split is the load-bearing design choice: the
read-query planner and the persisted catalog read the non-materialized
`tableSchema` (so they never see `_uc_*`), while enforcement
(`findIndexForUniqueConstraint`), DML maintenance (`updateSecondaryIndexes`), and
key-collation validation read `materializedSchema`. Physical `_uc_*` stores are
reconciled once per ALTER in `reconcileImplicitUniqueIndexStores`.

## Review findings

Checked from every angle (correctness, SPP/DRY, resource cleanup, error handling,
type safety, docs, tests). The implementation is sound and the split is correct —
but the reconcile design was applied only to the ALTER *constraint* paths and
missed the two table-level lifecycle paths, one of which was a silent correctness
regression.

### Major — fixed inline (was a correctness regression introduced by this feature)

- **`RENAME TABLE` did not relocate the `_uc_*` store → silent duplicate
  acceptance.** `StoreModule.renameTable` derived the physical index-store list
  from `getSchema().indexes` (the engine-facing schema, which omits `_uc_*`), so
  after a rename the hidden store stayed under the OLD table name and the renamed
  table lazily created a **fresh EMPTY** `_uc_*` store — an `INSERT` duplicating a
  pre-rename row was then accepted. Confirmed with a throwaway repro against a
  provider that implements `renameTableStores`.
- **`DROP TABLE` leaked the `_uc_*` store.** `StoreModule.destroy` had the same
  root cause: it handed `deleteTableStores` only the engine-facing index names, so
  the implicit store was stranded on disk (resource leak).
- **Fix (both):** new private `StoreModule.materializedIndexNames(table, fallback)`
  returns the MATERIALIZED index-store name set (explicit + `_uc_*`), used by both
  `destroy` and `renameTable` for physical relocation/reclamation. `renameTable`'s
  `currentSchema` stays non-materialized so the rewritten catalog DDL still carries
  no `_uc_*`. Two regression tests added
  (`… — DROP / RENAME TABLE store lifecycle`): RENAME relocates + keeps enforcing +
  leaves no orphan under the old name; DROP reclaims the store. README gained a
  **"Relocated / reclaimed with the table"** bullet.

### Verified correct (no change needed)

- **Enforcement / maintenance / read split** — every `.indexes` read audited:
  `updateSecondaryIndexes` and `findIndexForUniqueConstraint` read
  `materializedSchema`; the read-query planner (`resolveIndexFromIdxStr`,
  `bestAccessPlan`) reads the non-materialized `tableSchema`; all three
  `rebuildSecondaryIndexes` sites are called with `withImplicitUniqueIndexes(...)`.
  Consistent and correct.
- **ALTER reconcile** — `dropIndex` strips only explicit indexes (engine schema);
  `_uc_*` re-materializes for surviving UCs on `updateSchema`. All arms call
  `table.updateSchema` before the end-of-`alterTable` reconcile reads
  `getSchema()`, so the diff is against fresh state. Teardown of a never-built lazy
  store is safe (`releaseIndexStore` no-ops on an uncached handle;
  `clearAndDropStore` `getOrCreate`s then drops).
- **Reopen** — persisted `_uc_*` store is reopened lazily under its deterministic
  name; catalog carries no `CREATE INDEX`. Covered by the reopen test.
- **Behavior change (accepted, no test hits it):** a plain **text** UNIQUE now
  makes the table key collation K a *keyable* requirement at CREATE (the `_uc_*`
  text column is validated by `validateKeyCollations`). A comparator-only custom K
  + plain text UNIQUE that "worked" pre-feature would now throw at CREATE. Correct
  (the index genuinely can't be keyed); full suites green.

### Tripwires (recorded, not ticketed)

- **`reclaimDetachedTable` (sync basis eviction)** takes its index-name list from
  the sync recorder's *captured* list, not from the materialized schema. IF a
  detached sync **basis** table carries a plain UNIQUE and is later evicted, its
  `_uc_*` store would leak — the same class of miss as the two fixed here, but the
  capture lives in the sync layer (another package) and basis tables are a separate
  subsystem. Conditional on sync basis tables using plain UNIQUE; recorded here as
  the index. No code site in this package to tag; revisit if sync basis + plain
  UNIQUE + eviction ever coincide.
- **Reconcile build non-atomicity** and **no `assertStoreNameFree` on the implicit
  build** — both already carry `NOTE:` comments at the build site in
  `reconcileImplicitUniqueIndexStores` (mirror `rebuildSecondaryIndexes` /
  `createIndex` semantics). Unchanged; still accurate.

### Deferred (already ticketed by implement)

- **Explicit-index reuse** — every non-derived UNIQUE always materializes its own
  `_uc_*` even when a collation-compatible `CREATE INDEX` already covers the
  columns (redundant double maintenance, byte-identical, never wrong). Deferred to
  `tickets/backlog/debt-store-implicit-unique-index-reuse`.

## Validation (all green)

- `yarn workspace @quereus/store run build` — clean.
- `@quereus/store` unit suite — **959 passing** (957 + 2 new DROP/RENAME TABLE
  tests), 0 failing.
- `@quereus/isolation` suite — **245 passing** (wrapped ALTER path).
- Store-path SQL logic — `node test-runner.mjs --store` — **6962 passing**.
- Store package ships no real lint (intentional no-op; `tsc` build type-checks the
  package, tests type-check the spec at run).
