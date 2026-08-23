---
description: Dropping a table leaves its saved statistics behind, so a new table created with the same name starts out believing it already holds the old table's rows and value distribution — the query planner then sizes and prices it wrongly.
files:
  - packages/quereus-store/src/common/store-module.ts            # tearDownTableStorage — the one site to change
  - packages/quereus-store/src/common/store-module-rename.ts     # the stats re-key on rename — the shape to mirror
  - packages/quereus-store/src/common/key-builder.ts             # buildStatsKey
  - packages/quereus-store/src/common/store-table-base.ts        # primeStats / publishPersistedStatistics — the readers of the stale entry
  - packages/quereus-store/test/reclaim-detached-table.spec.ts   # comment + assertions that state today's (wrong) expectation
  - packages/quereus-store/test/rename-stats-migration.spec.ts   # provider harness to copy for the new spec
  - packages/quereus-plugin-indexeddb/src/provider.ts            # stale comment ("if needed") near deleteTableStores
repro: verified
difficulty: easy
---

# Dropping a table must leave no statistics behind

## Confirmed behavior (ran it)

A throwaway spec against a unified-`__stats__` in-memory provider (the shipped providers'
layout), driving a real `Database` + `StoreModule`:

- `create table t` -> 5 inserts -> `analyze t` -> `drop table t`, then read the `__stats__`
  store directly at key `main.t`:

  ```
  {"rowCount":5,"updatedAt":...,"columnStats":{"id":{...},"v":{...}},
   "analyzedRowCount":5,"lastAnalyzed":...}
  ```

  The entry survives the drop intact.

- Same again with 12 rows and 3 distinct values in `v`, then `drop table t`, then
  `create table t (...)` and one insert into the new, empty table. The new table's
  REGISTERED schema came back carrying the dead table's snapshot —
  `statistics.rowCount === 12`, `columnStats` keyed `id`, `v` — and the persisted entry
  still read `rowCount: 12` rather than the one row the new table actually holds.

So both arms of the original report are real, not inferred: the row count AND the whole
per-column `ANALYZE` snapshot are inherited by any table later created under a dropped
name. `StoreTableBase.primeStats` reads the entry on first touch and
`publishPersistedStatistics` stamps it onto the registered schema; every later write adds
its delta on top, so the count stays inflated for the table's life. Nothing returns wrong
ROWS — the planner sizes access paths and prices predicate selectivity from a dead table's
numbers.

The temp spec was deleted; the real test lives in the TODO below.

## Why it happens

Each table's statistics live as ONE ENTRY in a single shared `__stats__` store, keyed by
`{schema}.{table}` (`buildStatsKey`) — not in a per-table store. `tearDownTableStorage`
(behind both `drop table` and the sync layer's `reclaimDetachedTable`) removes the data
store, the index stores and the catalog DDL, and never touches that entry. The providers
correctly leave the unified store alone; two of them carry comments saying the entry is
"removed by the calling code" — no calling code removes it.

`renameTable` DOES handle the entry (reads the old key, writes the value under the new key,
deletes the old key), so the drop path is the outlier, not the design.

## Expected behavior

After a drop (or a detached-table reclaim), nothing keyed to that table survives anywhere
the module writes: no data store, no index store, no catalog entry, no statistics entry. A
table created under a dropped name starts from no statistics at all — the same state as a
name never used before.

## Ordering constraints for the fix

Two orderings are load-bearing; both are cheap to get wrong:

- **After `table.dispose()`.** `dispose()` flushes buffered stats, which WRITES the entry.
  Deleting before the dispose is undone by it.
- **Before `provider.deleteTableStores(...)`.** Providers that keep a PER-TABLE stats store
  (the double in `reclaim-detached-table.spec.ts` does) drop it inside `deleteTableStores`;
  calling `getStatsStore` afterwards would re-create an empty store as a side effect just to
  delete an absent key from it.

So: dispose -> delete the stats entry -> `deleteTableStores` -> catalog drain + `removeTableDDL`.

Must stay idempotent (`reclaimDetachedTable` is called speculatively; deleting an absent key
is a no-op), and a stats-store failure must not block the drop — same posture as the rename
path. Log a warning rather than swallowing silently (AGENTS.md), since the rename arm's bare
`catch {}` is the one thing not worth copying.

Not in scope: the delete does not ride the transaction coordinator, so a `drop table` in a
rolled-back explicit transaction loses the statistics. That matches the existing accepted
tradeoff already recorded on `saveStatistics` / `remapPersistedColumnStatistics` in
`store-table-base.ts` — statistics are advisory and the next `ANALYZE` reconciles. Don't
re-litigate it here; if it ever changes, all three sites move together.

## Test: assert the class, not the instance

This is the third kind of per-table residue (data, catalog, statistics) and a fourth would
go unnoticed the same way. Prefer ONE general assertion over a single-case regression test:
after a drop, nothing keyed to the dropped table survives anywhere the module writes.

That assertion belongs at the `StoreModule` level in `packages/quereus-store/test/`, NOT in
the provider-level reclaim battery (`src/testing/kv-reclaim-conformance.ts`) — the statistics
entry is written by the module, and the providers are RIGHT never to touch the unified store.
The conformance test that pins that ("leaves the reserved stats and catalog stores untouched
when a table is deleted") stays exactly as it is.

Copy the unified-stats provider harness from `rename-stats-migration.spec.ts`; it exposes its
`stores` map, so the assertion can sweep every surviving store's keys rather than probing the
one key the fix touches.

## TODO

- Delete the statistics entry in `StoreModuleBase.tearDownTableStorage`
  (`packages/quereus-store/src/common/store-module.ts`): `buildStatsKey(schemaName, tableName)`
  against `this.provider.getStatsStore(schemaName, tableName)`, placed after `table.dispose()`
  and before `deleteTableStores`, wrapped so a stats-store failure warns and lets the drop
  proceed. Note the two orderings in a comment — both are silently undone if a later edit
  moves the call.

- Add `packages/quereus-store/test/drop-table-residue.spec.ts`: a general "no residue"
  assertion over a unified-stats provider. After `create table` + index + rows + `analyze` +
  `drop table`, assert that no surviving store is named for the table, that the catalog holds
  no entry for it, and that no key in any surviving store (including `__stats__`) decodes to
  the dropped table's qualified name. Run the same assertion for `reclaimDetachedTable`, and
  once more for a table that was analyzed before the drop (covers the per-column arm).

- Add the round-trip case the bug is actually about: drop an analyzed table, re-create it
  under the same name, touch it, and assert the new table's registered `statistics` is
  undefined and its persisted row count reflects only its own rows.

- Update `packages/quereus-store/test/reclaim-detached-table.spec.ts`: the parenthetical at
  the preconditions block ("stats live in a unified store ... so they are not part of the
  per-table reclaim — mirroring destroy()") states the behavior being changed. Rewrite it, and
  add the stats-store assertion the spec currently omits (its provider is per-table-stats, so
  it can assert the store is gone).

- Fix the two provider comments that describe a caller that did not exist:
  `packages/quereus-plugin-indexeddb/src/provider.ts:264` ("will be removed by the calling code
  if needed") and, if its wording still reads conditionally,
  `packages/quereus-plugin-leveldb/src/provider.ts:297`. Point both at
  `StoreModule.tearDownTableStorage` by name.

- Validate: `yarn workspace @quereus/store run test`, then `yarn build` and
  `yarn workspace @quereus/store run typecheck`.
