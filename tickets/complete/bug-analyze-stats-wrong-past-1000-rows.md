----
description: The in-memory table backend used to guess its own column statistics from a 1000-row peek and hand them to the query planner as if it had read every row, so on larger tables the planner was told most rows were empty and that columns held far fewer different values than they did. It now reports only its row count and lets the existing full-scan collector do the rest.
files:
  - packages/quereus/src/vtab/memory/table.ts                          # getStatistics() — the fix
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # sampleColumnValues deleted; getBaseLayerStats reduced
  - packages/quereus/src/runtime/emit/analyze.ts                       # stale doc-comment claim corrected
  - packages/quereus/src/planner/stats/analyze.ts                      # review: reservoir-sampling denominator
  - packages/quereus/test/optimizer/analyze-stats-equivalence.spec.ts  # the general equivalence test (+ histogram invariants)
  - packages/quereus-store/test/analyze-stats-equivalence.spec.ts      # store-backend arm
  - packages/quereus/test/optimizer/statistics.spec.ts                 # comment on SizeOnlyStatsModule
  - docs/module-authoring.md                                           # the getStatistics contract
  - docs/progressive-optimizer.md                                      # stale MemoryTable claims
  - docs/sql-txn.md                                                    # the partial-answer protocol
----

# `ANALYZE` on a memory table no longer invents column statistics

## What shipped

`MemoryTable.getStatistics()` returns the primary BTree's node count (O(1) — inheritree
maintains `_count`) with an **empty** `columnStats`. It used to derive every per-column figure
from a systematic sample capped at 1000 non-null values and report it as a full read, so past
1000 rows `ANALYZE` recorded exactly what the sample said: every un-sampled row counted as a
NULL, `distinctCount` saturated at 1000, min/max were the sample's extremes.

`collectTableStatistics` (`runtime/emit/analyze.ts`) reads an empty `columnStats` as "size
answered, collect the rest yourself", so `ANALYZE` now falls through to
`collectStatisticsFromScan` and gets exact figures over every live row — the same route the
store backend has always taken. `MemoryTableManager.sampleColumnValues` was deleted and
`getBaseLayerStats` reduced to `{ rowCount }`; no callers remained for either removal.

The deliverable is as much the test as the fix: `analyze-stats-equivalence.spec.ts` asserts an
**equivalence**, not fixed numbers — every figure `ANALYZE` records must equal the same figure
computed by plain SQL over the same table (`rowCount` vs `count(*)`, `nullCount` vs
`count(*) where c is null`, `distinctCount` vs `count(distinct c)`, min/max vs `min(c)`/`max(c)`).
Shapes: 0 / 3 / 999 / 1000 / 1001 / 2500 rows, all-null / some-null / no-null columns, high and
low cardinality, integer and text, primary-key / plain / secondary-indexed, plus the pinned
5000-row case from the bug report and an in-transaction case. Adding a shape is one entry in
`COLUMNS` / `ROW_COUNTS`. The store package carries a matching arm (12 / 1200 rows + the
transaction case) over `InMemoryKVStore`.

Docs corrected across `module-authoring.md` (the `getStatistics` contract), `sql-txn.md` (the
four-case full-answer / partial-answer / decline / no-hook protocol) and
`progressive-optimizer.md` (two claims that `MemoryTable` supplied distinct-value estimates,
plus a tier-selection section that describes behaviour nothing implements — now marked **not
yet implemented** with the intended design kept below the marker).

## Review findings

### What was checked

The implement-stage diff read before the handoff summary. Every `getStatistics` implementer
and caller across all packages (memory, store, the isolation wrapper) — confirming
`runtime/emit/analyze.ts` is its only caller in the engine, so nothing at planning time
regressed. Repo-wide search for dangling references to the deleted `sampleColumnValues` and
the reduced `getBaseLayerStats` (none, including in docs), and for imports left unused by the
deletions (none). Every doc that mentions `getStatistics` or memory-table statistics:
`module-authoring.md`, `sql-txn.md`, `progressive-optimizer.md`, `store.md`,
`optimizer-costing.md`, `optimizer.md`, `memory-table.md`, `architecture.md`, the package
README. Whether the store backend's `getStatistics` echoes its persisted snapshot — which
would turn every `ANALYZE` into a no-op that re-saves numbers it never recomputed — it does
not; `getPersistedStatistics` feeds only `publishPersistedStatistics`. Whether `BTree.getCount()`
is really O(1), since the new comments claim it (yes — a maintained `_count`).

Whether the new `Math.random()`-driven reservoir could make existing plan-shape tests flaky:
it cannot. The reservoir replaces only above 1000 sampled values, and every ANALYZE-using
test in the suite (`108-cardinality-estimation`, `07.7.4-where-conjunct-ordering`,
`11.3-index-nested-loop-join`, `11.4-hash-join-side-swap`, `filter-selectivity.spec.ts`,
`join-row-estimates.spec.ts`) seeds ≤ ~100 rows, so their sampling stays deterministic.

### Fixed in this pass

- **The in-transaction behaviour is a guarantee, not the empirical accident the handoff
  feared.** The handoff said "if you want one thing to probe, probe that", because `ANALYZE`
  connects a *fresh* vtab and nothing stated why its scan sees the open transaction's
  uncommitted rows. Traced: `MemoryTable.ensureConnection` (`table.ts:84`) adopts the
  `MemoryTableConnection` already registered on the `Database` for that qualified table name,
  pending transaction layer and all, and `query` starts its scan from that layer. Separately,
  `MemoryTableManager.disconnect` (`manager.ts:523`) defers while the connection
  `hasOpenWork()`, so `ANALYZE`'s own `disconnect()` cannot drop a live transaction. Both
  recorded in the `getStatistics` doc comment. The transaction tests pin a contract.
- **The shared scan collector's reservoir sampling used the wrong denominator.**
  `collectStatisticsFromScan` drew `Math.floor(Math.random() * rowCount)`, where Algorithm R
  needs the count of items seen *in that column's own stream*. For a column with NULLs the
  replacement probability was too low by the null fraction, biasing histograms toward the rows
  the scan reached first. Pre-existing, but this ticket routes memory tables into that path for
  the first time (their old path used a deterministic systematic sample), so it now ships as
  part of this behaviour. Fixed with a per-column `nonNullCounts`.
- **Histograms had no assertion anywhere** — named by the handoff as a gap. Added
  `builds well-formed histograms from the sampled values` to the memory spec: invariants that
  hold regardless of the random draw — buckets non-empty, cumulative counts strictly rising to
  `sampleSize`, `sampleSize` ≤ 1000 and ≤ the column's non-null count, bucket bounds
  non-decreasing and contained in the column's true `[min, max]`, all-null column has no
  histogram. Also covers the reservoir fix above.
- **`docs/module-authoring.md`'s statistics lede contradicted the rule the ticket added three
  paragraphs below it** — it still opened with "report row counts, per-column distinct values,
  min/max, and histograms" over an example that reports column statistics with nothing marking
  them as necessarily exact. The lede is what a module author reads first. Rewritten, example
  annotated.

### Filed as a ticket

- **`bug-statistics-value-identity-uses-string-keys`** (backlog). Statistics decide whether two
  values are the same by stringifying them, which is not the engine's own value identity: a
  column mixing the integer `1` with the text `'1'` counts as one value where
  `count(distinct)` says two, and a column of a million distinct blobs counts as one. The
  histogram builder uses a *third*, different key, so the two halves of one statistics record
  disagree with each other as well. Root cause is one thing at two sites — ad-hoc text keys
  where `createValueSet(compareSqlValues)`, already used by the engine's own `DISTINCT`
  aggregate, is the answer. Filed at the invariant rather than the instance: closing it means
  adding a mixed-type and a blob column to the equivalence spec's generated shapes, which
  covers the class permanently. Site-claim grep found no open ticket on either file.

  This is the question the handoff flagged as gap 2 and correctly declined to decide inside
  this ticket. Statistics-only — it can slow a plan, never change a result. The spec header
  now names the slug rather than leaving the question hanging.

### Recorded as tripwires, not tickets

- `ANALYZE` on a memory table is now O(rows) where it was O(sample) — intended, since that is
  what `ANALYZE` means, and `getStatistics()` itself stays O(1). `NOTE:` at the site in
  `table.ts` saying the fix, if it ever shows up in a profile, is to cache and invalidate the
  scan's result rather than sample again. No wall-clock delta was measured; the only datapoint
  is the spec's 5000-row case at ~300 ms including its inserts.

### Considered and left alone

- **`SizeOnlyStatsModule` is now behaviourally identical to a plain memory table** (handoff
  gap 1, which invited restructuring it around a non-memory stub). Left as is: it overrides
  `getStatistics` on the *instance*, so it pins the size-only protocol independently of what
  the memory backend happens to do, and the `NOTE:` the implementer left says exactly that. A
  stub would buy nothing.
- **`MemoryTable.getStatistics()`'s return value is now unobservable through `ANALYZE`** — the
  scan always wins on row count, and memory always has `query()`, so the reported value is
  reachable only if the scan throws. Kept: it is the documented `VirtualTable` contract, costs
  one O(1) read, and is the fallback the emitter's last branch depends on.
- **The history-bearing doc comments** on `getStatistics` and `getBaseLayerStats` (each several
  times longer than the code) match the comment density of the surrounding files —
  `runtime/emit/analyze.ts` and `store-table-base.ts` read the same way. Trimming them to git
  history would be a house-style change, not a fix.

## Validation

- `yarn test` (whole workspace): **green** — 9984 mocha passing (+1 for the new histogram
  test), 25 pending, 0 failing; vitest 119 / 64 / 68 passing. No pre-existing failures
  surfaced, so no `.pre-existing-error.md` was written.
- `yarn lint` (all packages, including quereus' eslint + `tsconfig.test.json` type pass):
  clean. `yarn workspace @quereus/store run typecheck`: clean.
- Not run: `yarn test:store` (LevelDB arm). The store logic is exercised in-process by the new
  spec via `InMemoryKVStore`; the LevelDB re-run is a slow release-prep pass.
