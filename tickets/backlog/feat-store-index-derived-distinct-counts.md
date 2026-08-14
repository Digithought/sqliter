----
description: Gathering statistics on the persistent storage backend reads every row of a table, which is slow on a large one and goes stale the moment writing resumes. The backend's own indexes could answer "how many different values does this column hold" much more cheaply, and could keep the answer current as rows change.
prereq: store-per-predicate-selectivity
files:
  - packages/quereus-store/src/common/store-table-base.ts        # getStatistics — reports a row count and an empty column-statistics map
  - packages/quereus/src/planner/stats/analyze.ts                # collectStatisticsFromScan — the full-table scan this would replace
  - packages/quereus/src/runtime/emit/analyze.ts                 # collectTableStatistics — "empty column stats means scan it yourself"
  - packages/quereus-store/src/common/store-table-constraints.ts # updateSecondaryIndexes — where a maintained count would be updated
tradeoffs: Statistics are only ever cost estimates, never correctness, so a maintainer can reasonably say that a periodic full ANALYZE is good enough and refuse to add per-write bookkeeping to the hot path.
----

# Where this comes from

`store-per-predicate-selectivity` made the persistent storage backend price index lookups
from the per-column distinct-value counts that `ANALYZE` collects, and
`store-persist-column-statistics` made those counts survive a database reopen. Both take the
counts as a **snapshot**: `ANALYZE` reads every row of the table to compute them, and they
are frozen until someone runs it again.

Two costs follow, neither of them a wrong answer:

- **Collection is a full scan.** On a large table on a slow backend (IndexedDB in a browser),
  `ANALYZE` is an expensive, blocking, all-or-nothing operation — so users run it rarely, or
  never.
- **The snapshot ages.** Estimates are computed as "one over the number of distinct values I
  saw last time" against the table's *current* size. A table that has doubled since the last
  `ANALYZE` gets estimates that assume the value variety did not change with it.

# What the backend could do instead

A secondary index in this backend stores one entry per row, keyed by the indexed column's
value followed by the row's primary key — so **entries for the same value are physically
adjacent**. That structure can answer cardinality questions the engine's row-by-row scan
cannot answer cheaply:

- **Cheap collection.** Walking an index and counting value-group boundaries reads the index
  rather than the rows, and can skip to the next distinct value instead of reading every
  entry within a group. For a low-cardinality column that is dramatically less work than a
  full table scan.
- **Cheap maintenance.** On insert, a value that was not previously present raises the count
  by one; on delete, the count drops only if no other row still holds that value — a bounded
  probe of the index answers exactly that, because the entries are grouped.

Either would let the backend report real column statistics from its own `getStatistics()`
instead of the empty map it returns today, and could keep them current between `ANALYZE`
runs.

# What has to be decided before this is buildable

- **Exact versus approximate.** Maintained-exactly (a probe per delete, on the write path) vs.
  a probabilistic sketch (constant space, a few percent error, no probe) vs. periodic recount.
  Each has a different cost on the write path and a different error model; the choice should
  be driven by a measurement of how much the probe actually costs on the slowest backend.
- **What "the module answered" should mean to `ANALYZE`.** Today an empty column-statistics
  map from a module means "I answered the size cheaply, you collect the rest by scanning".
  If the backend starts reporting real counts, `ANALYZE` will take them and stop scanning —
  which also means it stops collecting the null counts, min/max and histograms that only a
  scan produces. That interface needs to be able to say "here is part of the answer" before
  this can land, or `ANALYZE` gets quietly worse.
- **Which columns.** Every column has no index to walk; only indexed and primary-key columns
  do. Non-indexed columns would still need the scan, which is another reason the partial-answer
  question above has to be settled first.
- **Skew.** A distinct count says nothing about a lopsided distribution (a two-valued column
  that is 99% one value). Histograms are the answer to that and no cheap index-derived form of
  them is obvious; leaving them scan-only is the likely outcome and should be stated rather
  than discovered.

# Related

- `feat-multi-column-correlation-stats` — the same estimates, wrong for a different reason
  (columns that move together).
- `bug-drop-table-leaves-stale-stats-entry` — dropped tables leave their statistics record
  behind; more state per table makes that leak bigger.
