description: Dropping a table used to leave its saved statistics behind, so a new table created with the same name would start out believing it already held the old table's rows and value distribution. Fixed — a drop now deletes that leftover entry too.
files:
  - packages/quereus-store/src/common/store-module.ts            # tearDownTableStorage — the fix
  - packages/quereus-store/src/common/store-module-rename.ts     # unchanged; shape the fix mirrors
  - packages/quereus-store/src/common/key-builder.ts             # buildStatsKey (unchanged, just consumed)
  - packages/quereus-store/test/drop-table-residue.spec.ts       # NEW — general no-residue sweep
  - packages/quereus-store/test/reclaim-detached-table.spec.ts   # updated preconditions + stats assertion
  - packages/quereus-plugin-indexeddb/src/provider.ts            # comment fix near deleteTableStores
  - packages/quereus-plugin-leveldb/src/provider.ts              # comment fix near deleteTableStores
difficulty: easy
---

# Dropping a table no longer leaves statistics behind

## What changed

`StoreModule.tearDownTableStorage` (`packages/quereus-store/src/common/store-module.ts`,
private method backing both `destroy` — live `DROP TABLE` — and `reclaimDetachedTable` —
the sync layer's detached-basis-table reclaim) now deletes the table's entry in the
unified `__stats__` store, keyed by `buildStatsKey(schemaName, tableName)`.

Ordering, exactly as the ticket specified and now commented in place:

1. `table.dispose()` (already existed) — flushes any buffered stats delta.
2. **NEW**: delete the stats entry — after dispose (so the flush in step 1 can't
   resurrect it), before step 3.
3. `provider.deleteTableStores(...)` (already existed) — a provider that keeps a
   PER-TABLE stats store (unlike the shipped providers' unified one) drops it here;
   doing the stats delete first avoids calling `getStatsStore` after the store is gone,
   which would silently re-create an empty one just to delete an absent key.
4. Catalog drain + `removeTableDDL` (already existed).

The delete is wrapped in try/catch: a stats-store failure is logged
(`console.warn('[StoreModule] Failed to delete persisted statistics for ...')`) and does
NOT block the drop — same advisory posture as the rename path's stats re-key
(`store-module-rename.ts`), and the same accepted tradeoff already recorded there: this
delete does not ride the transaction coordinator, so a `DROP TABLE` inside a rolled-back
explicit transaction still loses the statistics. Not new behavior, not re-litigated.

Also fixed: two provider comments (`indexeddb/src/provider.ts`, `leveldb/src/provider.ts`,
both near `deleteTableStores`) that described a caller removing the stats entry — that
caller now exists (`StoreModule.tearDownTableStorage`) and the comments name it.

## Test coverage

New: `packages/quereus-store/test/drop-table-residue.spec.ts`. Uses the same
unified-`__stats__`-store provider harness as `rename-stats-migration.spec.ts` (the
shipped providers' real layout, `stores` map exposed for inspection). One general sweep
helper (`assertNoResidue`) checks, after a drop: no store is physically named for the
table (data or `_idx_`), and no key in ANY surviving store — including `__stats__` and
`__catalog__` — decodes as UTF-8 to the table's qualified `schema.table` name. Chosen
over a single-key probe so a future 4th residue class would fail this test too, per the
ticket's ask.

Four cases:
- Drop a never-analyzed table → no residue.
- Drop an `ANALYZE`d table (12 rows, 3 distinct values) → no residue, covering the
  per-column snapshot arm specifically.
- `reclaimDetachedTable` on an analyzed table → same sweep, same result.
- **The round-trip the bug report is actually about**: drop an analyzed table, create a
  new table under the same name, insert one row, `db.close()` + `mod.closeAll()` to force
  the stats flush, then assert the new table's registered `schema.statistics` is
  `undefined` and its own persisted `__stats__` entry has `rowCount === 1` — not the old
  table's 12.

Updated `reclaim-detached-table.spec.ts`: rewrote the preconditions comment that stated
the now-false claim ("stats ... are not part of the per-table reclaim"), added an
`analyze t` step, and added `has('main.t.__stats__')` before/after assertions — this
spec's provider is per-table-stats (unlike the unified-store harness above), so it's the
one place that can directly assert the physical stats store is gone.

## Validation run

- `yarn workspace @quereus/store run test` — 1920 passing (includes all 4 new cases + the
  updated reclaim spec). The console warnings in the run are pre-existing intentional
  fixtures for other specs' error paths (bad DDL, non-deterministic MV bodies, etc.), not
  failures from this change.
- `yarn typecheck` (whole workspace) — clean.
- `yarn build` (whole workspace, `tsc -b` + the three bundled apps) — clean.
- `yarn workspace @quereus/store run lint` — no-op for this package (`No lint configured`,
  matches every other non-`quereus` package per AGENTS.md).

## Known gaps / things NOT covered

- **Not tested**: the real LevelDB / IndexedDB provider plugins. Their `deleteTableStores`
  comments were updated to name the new caller, but no test in
  `quereus-plugin-leveldb`/`quereus-plugin-indexeddb` exercises `tearDownTableStorage`'s
  new stats-delete call against the real backend — only the in-memory harnesses in
  `packages/quereus-store/test/`. If those plugins have their own drop/reclaim specs,
  worth a glance to confirm they don't assert the OLD (leftover-stats) behavior anywhere;
  I did not find any in a targeted grep for `deleteTableStores`/stats in those packages'
  own `test/` directories, so I believe there's nothing to update, but I didn't
  exhaustively read every spec in those two packages.
  - `yarn test:store` (LevelDB-backed logic-test run) was NOT run for this ticket — it's
    documented as slower / for store-specific diagnosis. Worth running before this ships
    if the reviewer wants extra confidence on the real backend.
- **Not tested**: the failure path itself (a provider whose `getStatsStore` or the
  returned store's `delete` throws) — the try/catch and `console.warn` are covered by
  code reading, not by a spec that injects a throwing provider. Existing specs
  (`coordinator-callback-leak.spec.ts` et al.) show the pattern for a throwing-provider
  harness if the reviewer wants that added.
- **In scope but unverified by a dedicated test**: the ticket's ordering constraint
  ("before `provider.deleteTableStores`, or a per-table-stats provider's `getStatsStore`
  would re-create an empty store"). The updated `reclaim-detached-table.spec.ts` exercises
  a per-table-stats provider end-to-end and asserts the store is gone, which is consistent
  with correct ordering, but there's no test that would specifically fail if the two
  delete calls were reordered (e.g. by asserting the stats store was never re-created as
  empty). Left as an inline code comment in `store-module.ts` explaining why the order
  matters, per the ticket's own note that this ordering is "cheap to get wrong."
