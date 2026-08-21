----
description: The in-memory table backend guesses its own column statistics from a 1000-row peek and hands them to the query planner as if it had looked at every row, so on any larger table the planner is told most rows are empty and that columns hold far fewer different values than they do. Stop it guessing and let the existing full-scan collector — which is already correct — do the work.
files:
  - packages/quereus/src/vtab/memory/table.ts              # getStatistics() ~line 184 — THE broken site
  - packages/quereus/src/vtab/memory/layer/manager.ts      # sampleColumnValues ~line 502, getBaseLayerStats ~line 484
  - packages/quereus/src/runtime/emit/analyze.ts           # collectTableStatistics — the module-vs-scan choice
  - packages/quereus/src/planner/stats/analyze.ts          # collectStatisticsFromScan — VERIFIED CORRECT, do not change
  - packages/quereus/test/optimizer/statistics.spec.ts     # existing getStatistics protocol tests
  - packages/quereus-store/test/column-statistics-plan.spec.ts # createFixture — store-backend test harness to copy
  - docs/module-authoring.md                               # ~979-1025 — the getStatistics contract
  - docs/progressive-optimizer.md                          # ~48, ~206 — stale claims about MemoryTable stats
  - docs/sql-txn.md                                        # ~428 — understates the partial-answer protocol
difficulty: medium
repro: verified
----

# `ANALYZE` on a memory table reports invented column statistics

## Root cause — one site

`MemoryTable.getStatistics()` (`packages/quereus/src/vtab/memory/table.ts:184`).

It calls `this.manager.sampleColumnValues(colIdx, 1000)` — a **systematic sample capped at
1000 non-null values** — and then treats the result as if it were a full read of the column:

```ts
const values = this.manager.sampleColumnValues(colIdx, 1000);
...
// Null count: difference between rowCount and non-null sample (exact for full scan)
const nullCount = rowCount - values.length;
...
minValue: values.length > 0 ? values[0] : undefined,
maxValue: values.length > 0 ? values[values.length - 1] : undefined,
```

The parenthetical in that comment is the whole bug: the sample **is** a full scan at or below
1000 rows, and is not one above. Past 1000 rows every un-sampled row is counted as a NULL,
`distinctCount` saturates at the sample size, and min/max are the sample's extremes rather than
the column's.

The scan-based collector named in the original report — `collectStatisticsFromScan` in
`packages/quereus/src/planner/stats/analyze.ts` — **is correct and never runs here.**
`collectTableStatistics` (`runtime/emit/analyze.ts:54`) takes the module's answer whenever
`columnStats` is non-empty, and the memory backend always returns a non-empty one.

## What was measured

Table `t (id integer primary key, g integer, v integer)`, 5000 rows, `v` = 1..5000,
`g` = j % 7, no NULLs. Both statistics sources were called directly on the same connected
table, and `ANALYZE` was run for comparison:

```
=== rows=5000
  module getStatistics():      id: distinct=5000 null=4000 min=1 max=4996
                                g: distinct=7    null=4000 min=0 max=6
                                v: distinct=1000 null=4000 min=1 max=4996
  collectStatisticsFromScan:   id: distinct=5000 null=0    min=1 max=5000
                                g: distinct=7    null=0    min=0 max=6
                                v: distinct=5000 null=0    min=1 max=5000
  after ANALYZE (recorded):   == module getStatistics(), verbatim
```

At 500 rows all three agree — the sample is a full read there. The arithmetic matches the
code exactly: with `count = 5000` and `maxSample = 1000`, `sampleColumnValues` takes
`step = floor(5000/1000) = 5`, yielding rows 1, 6, … 4996 — hence 1000 distinct values,
`5000 - 1000 = 4000` phantom nulls, and `max = 4996`.

The `id` anomaly the original report flagged (distinct 5000 **plus** null 4000 over 5000 rows)
is explained too: `getStatistics` overrides `distinctCount = rowCount` for primary-key columns
but leaves the sample-derived `nullCount` alone, so the two disagree with each other.

The store backend is correct for a structural reason, not a coincidental one: its
`getStatistics()` returns a row count with an **empty** `columnStats`, which routes it to the
same scan collector proven exact above. Nothing in this fix can regress it.

## Second arm — same site, same fix

`getBaseLayerStats()` reads `this._currentCommittedLayer` only, so the module-reported path is
blind to the connection's uncommitted rows. Verified:

```
begin; insert 100 more rows          -> select count(*) = 102
  module getStatistics(): rowCount = 2     (the committed base)
  collectStatisticsFromScan:  rowCount = 102   (what the connection can see)
  ANALYZE recorded:           rowCount = 2
```

`ANALYZE` inside an open transaction therefore records the pre-transaction size. The isolation
layer already declines (`getStatistics()` returning `undefined`) in exactly this situation; the
memory backend does not. Routing memory to the scan fixes this arm at the same stroke, because
`collectTableStatistics` prefers the scan's row count over the reported one.

## The fix

Make `MemoryTable.getStatistics()` report only what BTree metadata proves — the row count —
with an empty `columnStats`, exactly as `StoreTable.getStatistics()` already does. `ANALYZE`
then reads it as *"size answered, collect the rest yourself"*, runs the shared scan collector,
and gets the numbers shown correct above.

This loses no accuracy whatsoever. The scan computes exact distinct counts over every row
(better than the index-derived counts), exact null counts, true min/max, and builds histograms
from a sample of up to 1000 values just as the current code does. The only cost is that
`ANALYZE` on a memory table becomes a scan — which is what `ANALYZE` means, and it is the sole
caller of `getStatistics()` in the engine today (`runtime/emit/analyze.ts:54`; nothing consults
it during planning).

The alternative — keeping the module's answer and computing the column facts exactly with a
full pass over the primary tree — was considered and rejected: it duplicates
`collectStatisticsFromScan` line for line for no accuracy gain (repo rule: stay DRY), and it is
O(n) either way. Cheap-but-exact per-column statistics are a real prize, but they belong to
`feat-store-index-derived-distinct-counts` (backlog), which is about deriving counts from index
metadata rather than sampling rows. Do not attempt that here; this ticket is correctness only.

## Docs that assert the wrong thing today

- `docs/progressive-optimizer.md:48` and `:206` — claim `MemoryTable` supplies "exact row counts
  and distinct-value estimates from BTree metadata via `getStatistics()`" and that tier
  selection queries modules for stats availability. Stale on both counts: the distinct-value
  estimates are the sampled ones this ticket removes, and no planning-time caller of
  `getStatistics()` exists.
- `docs/sql-txn.md:428` — "If a virtual table module implements `getStatistics()`, those
  statistics are used directly. Otherwise, a full table scan…" — omits the partial-answer
  (empty `columnStats`) path that `docs/module-authoring.md` documents and that this fix relies on.
- `docs/module-authoring.md:979-1025` — the contract is missing the rule the memory backend
  broke. Add it: **report a column statistic only if it is exact over every live row the
  connection can see. A sample is not an answer — leave `columnStats` empty and let `ANALYZE`
  scan.** Same section should note that an implementation blind to uncommitted rows must decline
  (`return undefined`) while a transaction is open, as `IsolatedTable` does.

## Covering the class, not the instance

A point fix here would not have caught this bug and will not catch the next one — nothing
compares what `ANALYZE` records against what the data actually contains. Add that comparison as
a general test: for generated tables, every per-column figure `ANALYZE` records must equal the
same figure computed by plain SQL over the same table.

| recorded statistic | must equal |
|---|---|
| `rowCount` | `select count(*) from t` |
| `columnStats.get(c).nullCount` | `select count(*) from t where c is null` |
| `columnStats.get(c).distinctCount` | `select count(distinct c) from t` |
| `columnStats.get(c).minValue` | `select min(c) from t` |
| `columnStats.get(c).maxValue` | `select max(c) from t` |

Generate across the axes that mattered here — row counts straddling 1000 (e.g. 3, 999, 1000,
1001, 2500), columns with all-null / no-null / some-null, high and low cardinality, integer and
text, primary-key and plain and secondary-indexed columns — and run it on both backends.

Gotcha for whoever writes it: `columnStats` is a `Map`. `Object.keys` / `JSON.stringify` on it
show `{}`, which reads as "no statistics collected" and is a different, wrong conclusion.

## TODO

### Phase 1 — fix

- Rewrite `MemoryTable.getStatistics()` (`packages/quereus/src/vtab/memory/table.ts:184`) to
  return `{ rowCount, columnStats: new Map() }` from `getBaseLayerStats()`. Drop the
  per-column loop, the sample-derived `nullCount` / `distinctCount` / `minValue` / `maxValue`,
  the primary-key `distinctCount` override, the secondary-index distinct-count lookup, and the
  histogram build. Leave a short comment saying why it reports size only, pointing at the
  scan collector.
- Delete `MemoryTableManager.sampleColumnValues` (`layer/manager.ts:502`) — `getStatistics`
  is its only caller; confirm with a repo-wide search before deleting.
- Reduce `getBaseLayerStats` (`layer/manager.ts:484`) to the row count if `indexDistinctCounts`
  has no remaining reader; confirm the same way. Its per-index `getCount()` is a genuine
  distinct count (the secondary BTree keys on the index key, with primary keys collected into
  one entry) — say so in the commit message so it is not mistaken for another instance of this
  bug if it is ever revived.
- Prune now-unused imports in `table.ts` (`buildHistogram`, `ColumnStatistics`, and anything
  else the loop was the only user of). `yarn lint` in `packages/quereus` catches these.

### Phase 2 — the general test

- Add `packages/quereus/test/optimizer/analyze-stats-equivalence.spec.ts` covering the memory
  backend: for each generated table shape, run `ANALYZE`, then assert every row in the table
  above against the plain-SQL figure. Drive the generation from a table of shapes rather than
  hand-writing each case, so a new shape is one line.
- Add the store-backend arm in `packages/quereus-store/test/` using the `createFixture` helper
  in `column-statistics-plan.spec.ts` — `createInMemoryProvider` keeps it in-process and fast.
  Keep the store side to a couple of shapes just past the boundary (e.g. 1200 rows); the
  exhaustive matrix belongs on the memory side.
- Assert the in-transaction arm explicitly: open a transaction, insert past the committed size,
  `ANALYZE`, and require the recorded `rowCount` to match `select count(*)` as the connection
  sees it.
- Keep a regression case pinned at the exact numbers from this report — 5000 rows,
  `v` = 1..5000 — since those are the values the bug produced and the ones a reader can check
  by eye.

### Phase 3 — docs and validation

- Correct `docs/progressive-optimizer.md` (~48, ~206), `docs/sql-txn.md` (~428), and add the
  exactness rule plus the open-transaction rule to `docs/module-authoring.md` (~979-1025).
- Run `yarn test` (whole workspace — covers both the memory and store arms) and `yarn lint`
  from `packages/quereus`. Expect no other test to move: the existing `getStatistics` protocol
  tests in `optimizer/statistics.spec.ts` assert only `rowCount` for `MemoryTable`, and
  `SizeOnlyStatsModule` there reads `rich.rowCount` off the real `getStatistics()`, which
  survives this change.
- `SizeOnlyStatsModule` becomes a near-duplicate of the memory table's own behaviour after this
  fix. Keep it — it is a protocol test for the *contract*, not for the memory backend — but say
  so in a comment so a future reader does not delete it as redundant.
