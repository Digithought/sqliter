----
description: The persistent store picks a full table scan for queries that match a column against a list of values, even when that column has an index; teach it to serve list-membership lookups from the index like the in-memory engine already does.
files: packages/quereus-store/src/, packages/quereus/src/runtime/foreign-key-actions.ts
----
## Observation

Against the LevelDB-backed store module, with `child(pid)` carrying a secondary index
`idx_child_pid`:

- `select pid from child where pid = 3 limit 1` → `INDEXSEEK child USING idx_child_pid` (good)
- `select pid from child where pid in (1, 2, 3, 4, 5) limit 1` → `FILTER` over
  `INDEXSCAN child USING _primary_` — a full scan of the child table with a residual filter.

The memory module serves **both** shapes with `INDEXSEEK ... USING idx_child_pid`, so this is a
store-side access-path gap (presumably its `getBestAccessPlan` does not decompose an IN
constraint into per-member index seeks), not a planner-wide one.

Repro: create the two tables above with the index on the store module, insert a few rows, and
compare `query_plan('<probe>')` output between `default_vtab_module = 'memory'` and `'store'`.

## Why it matters

- The batched parent-side RESTRICT flush (`flushParentRestrictBatch`,
  `packages/quereus/src/runtime/foreign-key-actions.ts`) probes each child table with
  `where fkcol in (?, …)` in ~500-key chunks. On the store this is currently one full child
  scan per chunk. That is per-statement, not per-row — accepted as tolerable when the batched
  path landed — but on a large child table over slow storage (IndexedDB) each chunk still pays
  O(child size) instead of O(chunk × log child size).
- Any user query with `col in (list)` on an indexed store column pays the same full scan.

## Expected behavior

The store module should satisfy an IN-list constraint on an indexed column via that index —
e.g. one seek per list member (the memory module's strategy), or a merged ordered scan —
rather than falling back to a full primary scan with a residual filter.
