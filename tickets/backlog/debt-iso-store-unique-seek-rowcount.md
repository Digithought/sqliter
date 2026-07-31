---
description: The speed-up that lets a duplicate check on a stored table look up its answer through an index (instead of reading the whole table) has no automated test proving the shortcut actually happens on the persistent store — only that the answer stays correct. Add one so a silent regression to slow full-table reads gets caught.
files:
  - packages/quereus-isolation/src/isolated-table.ts                 # findUnderlyingUniqueConflict / canSeekForConstraint
  - packages/quereus-isolation/src/filter-info.ts                    # makeSecondaryIndexEqSeekFilter
  - packages/quereus-isolation/test/isolation-layer.spec.ts          # existing memory row-count proof (CountingMemoryModule)
  - packages/quereus-store/test/isolated-store.spec.ts               # where a store-backed seek-count test would live
difficulty: medium
---

## Why

The isolation layer's non-primary-key UNIQUE check was changed (ticket
`iso-unique-check-index-seek`) to look a duplicate up through the backing index — an
O(log n) seek — instead of scanning the whole underlying table, whenever the constraint
is index-derived and the backing index keys its columns under the collation the check
enforces under.

That optimisation is what the ticket exists for, and the arm it most cares about is the
**persistent store** (LevelDB-backed), not the in-memory backend. But the only test that
proves the seek *actually happened* (rather than merely stayed correct) is memory-specific:
it wraps a `MemoryTableModule` in a counting `Proxy` (`CountingMemoryModule` in
`isolation-layer.spec.ts`) and asserts the underlying yields `≤ 5` rows on a seek vs
`≥ 100` on a full scan.

On the store there is **no equivalent guard**. Store correctness is covered indirectly
(`yarn test:store`, existing `isolated-store.spec` UNIQUE swap tests), so if the store ever
stopped honouring the isolation-built equality-seek `FilterInfo` and silently full-scanned
instead, every correctness test would still pass — the performance win would just vanish
unnoticed. For a ticket whose entire purpose is that win, that is a real blind spot.

## What to build

A store-mode analogue of the memory row-count proof: against a store-backed table with an
index-derived UNIQUE over a large committed row set, drive a constrained insert through
the isolation layer and assert the number of underlying rows read is bounded (seek), not
linear in the table size (scan). Run it for both a BINARY index and a `collate nocase`
one — since `store-index-collation-guard-collapse` both seek.

**The negative control changed.** A `collate nocase` index used to full-scan and was the
obvious control; it now seeks. Use a table-level `unique(email)` instead (no index in the
engine-facing schema at all, so nothing to name in a seek), which is what the memory-side
row-count test in `isolation-layer.spec.ts` switched to. An `any collate nocase` column
also still declines, but it exercises a narrower branch.

The counting hook differs from memory: the store yields rows through its own KVStore
iteration, not a `query()` generator you can Proxy at the module boundary the same way, so
the row/seek count has to be observed at whatever seam the store exposes (e.g. a KVStore
iterate counter, or an instrumented provider). Pick the seam that most directly reflects
"did the physical index seek run" so the test fails if the seek silently degrades to a scan.

## Notes

- Low priority: this is a hardening / regression-guard test, not a correctness fix. The
  behaviour is already correct and covered; this only prevents a *silent perf* regression.
- Keep it out of the default `yarn test` if it needs the LevelDB store harness — colocate
  with the existing store-mode isolation tests (`isolated-store.spec.ts`) that already run
  under the store test path.
