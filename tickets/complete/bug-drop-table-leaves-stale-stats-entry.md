description: Dropping a table used to leave its saved statistics behind, so a new table created with the same name started out believing it already held the old table's rows and value distribution. Fixed and reviewed — a drop now deletes that leftover entry too.
files:
  - packages/quereus-store/src/common/store-module.ts             # tearDownTableStorage — the fix
  - packages/quereus-store/src/common/store-module-rename.ts      # rename-path stats re-key — silent catch now logs (review)
  - packages/quereus-store/test/drop-table-residue.spec.ts        # no-residue sweep; +2 cases added in review
  - packages/quereus-store/test/reclaim-detached-table.spec.ts    # updated preconditions + stats assertion
  - packages/quereus-plugin-indexeddb/src/provider.ts             # comment fix near deleteTableStores
  - packages/quereus-plugin-leveldb/src/provider.ts               # comment fix near deleteTableStores
  - docs/store.md                                                 # stats value format + lifecycle (review)
---

# Dropping a table no longer leaves statistics behind

`StoreModule.tearDownTableStorage` — the private method behind both `destroy` (live
`DROP TABLE`) and `reclaimDetachedTable` (the sync layer's detached-basis-table reclaim) —
now deletes the table's entry in the unified `__stats__` store, keyed by
`buildStatsKey(schemaName, tableName)`.

Order, and why each step sits where it does:

1. `table.dispose()` — flushes any buffered stats delta.
2. **stats-entry delete** — after dispose (so that flush cannot resurrect it), before
   step 3 (a provider with a PER-TABLE stats store drops that store inside
   `deleteTableStores`; calling `getStatsStore` afterwards would silently re-create an
   empty store just to delete an absent key).
3. `provider.deleteTableStores(...)`.
4. Catalog drain + `removeTableDDL`.

The delete is advisory: a failure is logged (`console.warn`) and never blocks the drop.
Same accepted tradeoff already recorded on the rename path — neither stats write rides the
transaction coordinator, so a `DROP TABLE` in a rolled-back explicit transaction still
loses the statistics. Pre-existing, not re-litigated here.

## Review findings

**Read first**: the implement diff (`f76424013`) before the handoff summary, plus the
surrounding stats lifecycle (`store-table-base.ts` prime/flush/dispose, `key-builder.ts`,
`store-module-rename.ts`, the `KVStoreProvider.deleteTableStores` contract in
`kv-store.ts`), the two provider comments, and `docs/store.md`.

**Correctness of the fix itself — no findings.** Statistics for a table are ONE record
under one key (`{schema}.{table}` in `__stats__`); the `ANALYZE` column snapshot,
`analyzedRowCount` and `lastAnalyzed` all live inside that record, so a single-key delete
genuinely covers the per-column arm. `getStatsStore` is a required provider method, so the
call is unconditional and safe on the not-currently-connected path (`reclaimDetachedTable`
of a table absent from `this.tables`). The ordering claim holds.

**Fixed in this pass (minor):**
- `store-module-rename.ts` — the rename path's stats re-key swallowed every error with a
  bare `catch {}`. AGENTS.md forbids silent swallows, and the implement diff had just
  introduced the logged sibling next door. Now logs the same shape.
- `docs/store.md` — two stale claims in the Statistics section. The persisted value format
  was documented as `{rowCount, updatedAt}` only, predating the column-statistics fields;
  and nothing documented what happens to the entry when a table is renamed or dropped —
  the very behavior this ticket and its rename predecessor established. Both corrected.
- Tests — added the two cases the implementer listed as gaps: a provider whose stats-store
  `delete` throws (drop must still complete; the warn line is visible in the run), and a
  per-table-stats provider that asserts the entry delete happens BEFORE `deleteTableStores`
  and leaves no re-created empty stats store, so reordering the two calls now fails a test.

**Filed as a new ticket (major):**
- `backlog/debt-store-table-dispose-awaits-inflight-stats-flush` — `dispose()` flushes only
  a delta still buffered on the instance; it does not await a flush already in flight from
  `trackMutation`'s untracked `queueMicrotask(flushStats)` (which zeroes `mutationCount`
  before its awaits). On a provider with a genuinely async `put`, that write can land after
  this ticket's delete and resurrect the entry. Filed at the invariant level — one change in
  `store-table-base.ts` (track the flush promise, await it in dispose) orders the drop
  delete, the rename re-key and plain close against background saves at once, rather than a
  point fix on the drop path. `static` repro; a cross-reference `NOTE:` sits at the delete
  site in `store-module.ts`.

**Tripwires recorded (not ticketed):** the `NOTE:` above is the only one; it points at the
filed ticket rather than standing alone.

**Considered and left alone:** the "stats writes do not ride the transaction coordinator"
tradeoff carries an accepted-tradeoff `NOTE:` at `store-table-base.ts` and its revisit
condition (statistics gaining a non-deterministic consumer) has not tripped. `store-module.ts`
is 777 lines — well under the sizes tracked by `debt-oversized-source-files`, so no size arm
was appended there.

**Not covered, deliberately:** the real LevelDB / IndexedDB plugins still have no test
exercising the new delete against their backends (the in-memory harnesses stand in), and
`yarn test:store` was not run — it is the slow store-specific run, out of scope for an
agent pass. Neither plugin has a spec asserting the old leftover-stats behavior, so nothing
there needed updating.

## Validation

- `yarn workspace @quereus/store run test` — 1922 passing (1920 before, +2 review cases).
- `yarn test` (whole workspace) — passing.
- `yarn typecheck` — clean. `yarn lint` — clean. `yarn docs:check` — OK.
