---
description: Gathering statistics on an in-memory table gets the numbers wrong once the table holds more than a thousand rows — it reports most rows as empty when none are, and undercounts how many different values a column holds. The query planner then makes its choices from those wrong numbers.
files:
  - packages/quereus/src/planner/stats/analyze.ts        # collectStatisticsFromScan — the scan loop, its null branch, and the maxSample = 1000 boundary
  - packages/quereus/src/runtime/emit/analyze.ts         # collectTableStatistics — decides between module-reported and scan-collected stats
  - packages/quereus/src/vtab/memory/                    # the backend whose query() the scan consumes; the store backend does NOT show this
  - packages/quereus/src/planner/stats/catalog-stats.ts  # the consumer — nullCount / distinctCount / min / max drive selectivity
  - packages/quereus/src/planner/stats/conjunct-selectivity.ts
repro: verified
---

# `ANALYZE` reports wrong column statistics on the memory backend past 1000 rows

## What happens

`ANALYZE` on a memory-backed table with more than 1000 rows produces column statistics that
are plainly wrong. The row count is right; every per-column number is not.

Measured on a table `t (id integer primary key, g integer, v integer)` with 5000 rows,
`v` holding the values 1..5000, no NULLs anywhere:

| column statistic | reported | actual |
|---|---|---|
| `v.nullCount` | 4000 | 0 |
| `v.distinctCount` | 1000 | 5000 |
| `v.maxValue` | 4996 | 5000 |
| `g.nullCount` (7 distinct values) | 4000 | 0 |
| `rowCount` | 5000 | 5000 ✓ |

The same table built on the **store** backend reports every one of these correctly. A memory
table of 500 rows also reports correctly. So the fault is memory-backend-specific and appears
only above a threshold.

## The threshold is 1000, and it is not the insert batch size

`nullCount` came out as exactly `rowCount - 1000` and `distinctCount` as exactly `1000` at
every insert batch size tried (100, 500, 1000, and one single 5000-row insert). The number
1000 is `maxSample` in `collectStatisticsFromScan` — the reservoir-sampling cap — which is
suspicious, because that constant is supposed to bound only the histogram sample, never
`nullCount` or `distinctCount`.

Reading the loop, it should not be able to do this. `nullCounts[i]++` and
`distinctSets[i].add(...)` are the two arms of one `if (val === null || val === undefined)`,
so a single row can only feed one of them per column — yet in a 5000-row run the `id`
column reported `distinctCount` 5000 **and** `nullCount` 4000, which is 9000 events over
5000 rows. Something is being counted twice, or the rows arriving from the memory backend's
`query()` past row 1000 are not the rows that were written. Finding out which is the first
job of this ticket.

## Why it matters

These numbers are the planner's whole picture of the data:

- `distinctCount` drives equality selectivity as `1/D`. Reporting 1000 instead of 5000
  makes every equality on the column look 5x less selective than it is.
- `nullCount` drives null-aware selectivity and nullability reasoning.
- `minValue` / `maxValue` bound range selectivity.

Nothing here returns a wrong row — statistics are only cost estimates. The cost is that the
memory backend is the **default** backend and the one `yarn test` exercises, so every plan
choice made from statistics on a table of any real size is being made from corrupt inputs,
including the seek-versus-scan and hash-versus-index-nested-loop decisions this repo has
spent several tickets tuning.

## Reproducing

```js
const db = new Database();                       // default memory backend
await db.exec('create table t (id integer primary key, g integer, v integer)');
// insert 5000 rows: (j, j % 7, j) for j in 1..5000, any batch size
for await (const _ of db.eval('analyze')) { /* drain */ }
const st = db.schemaManager.getTable('main', 't').statistics;
for (const [name, s] of st.columnStats)          // columnStats is a Map, not an object
  console.log(name, s.distinctCount, s.nullCount, s.minValue, s.maxValue);
```

Note for whoever picks this up: `columnStats` is a `Map`. Reading it with `Object.keys` or
`JSON.stringify` shows `{}` and looks like "no column statistics were collected at all",
which is a different and wrong conclusion. Iterate it.

## Where this came from

Found while investigating four downstream performance reports from a user running the
IndexedDB store backend. Three of those traced to statistics never having been collected at
all; this bug is the adjacent discovery that collecting them does not necessarily help on
the memory backend.

## Related, but not this

`feat-store-index-derived-distinct-counts` (backlog) also names `analyze.ts`. It is about
replacing the full-table scan with cheaper index-derived counts on the store backend — a
different concern at the same file. This ticket is about the existing scan miscounting.

## TODO

- Instrument the memory backend's `query()` under the full-scan `FilterInfo` that
  `collectStatisticsFromScan` builds (`makeFullScanFilterInfo(Infinity, Number.MAX_SAFE_INTEGER)`)
  and record what actually arrives past row 1000 — row length, element values, and how many
  times each row is yielded. That single observation decides whether the fault is in the
  collector or in the backend.
- Confirm whether `id` (the primary key) really does report `distinctCount` and `nullCount`
  that sum above the row count, or whether its value is arriving from the module-reported
  path in `runtime/emit/analyze.ts` instead of the scan.
- Check whether the `Infinity` / `Number.MAX_SAFE_INTEGER` limit-and-offset arguments are
  handled by the memory backend the way the collector assumes.
- Establish whether the store backend is correct by construction or merely by taking a
  different code path, so the fix does not regress it.
- Cover the class, not the instance: a property test asserting that for any generated table,
  `ANALYZE`'s per-column `nullCount`, `distinctCount`, `minValue` and `maxValue` agree with
  the same figures computed by plain SQL (`count(*) where col is null`, `count(distinct col)`,
  `min(col)`, `max(col)`) — across both backends and across the 1000-row boundary. Filing the
  general test alongside the fix is the point; a point fix here would not have caught this and
  will not catch the next one.
