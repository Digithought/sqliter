----
description: Row-count estimates assume conditions on different columns are unrelated, so a query filtering on two columns that move together (like city and postal code) is estimated as far more selective than it really is.
files: packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/stats/selectivity-combine.ts, packages/quereus/src/planner/stats/analyze.ts, packages/quereus/src/planner/stats/histogram.ts
tradeoffs: Only the cheapest tier needs no new stored statistics; everything beyond it means collecting, storing and maintaining multi-column statistics - a large ongoing cost for better estimates rather than correct answers.
----

## Background

`feat-conjunction-selectivity` combines the estimates for `where a = 1 and b = 2` using a damped
independence model (each condition's estimate multiplied in with a decreasing exponent). That
damping is a blunt hedge against correlation, not a measurement of it — the planner still has no
data about how columns relate to each other.

Where it goes wrong:

- **Correlated columns.** `city = 'Portland' and state = 'OR'` — the second condition eliminates
  almost nothing once the first has been applied, but the model treats it as an independent cut.
  The estimate comes out far too small, which pushes the planner toward index and join-order
  choices tuned for a handful of rows when thousands will arrive.
- **Two conditions on the same column.** `a > 1 and a < 10` is one range, not two independent
  cuts. The current code estimates each bound separately and combines them, which double-counts.
  This is the cheapest case to fix and needs no new statistics — only a pass that pairs up bounds
  on the same column and asks the existing histogram for the range between them.

## What this would need

Roughly in increasing order of cost:

1. **Same-column bound pairing.** Group a conjunction's conditions by column; when one gives a
   lower bound and another an upper bound, ask the histogram for the range directly instead of
   combining two separate estimates. Purely local; no new stored statistics.
2. **Multi-column distinct counts.** Record, per column group, how many distinct combinations
   actually occur. `where a = ? and b = ?` then estimates as one-over-that-number instead of a
   product. Requires deciding which column groups to collect (declared indexes and primary keys
   are the obvious default) and extending both what `ANALYZE` writes and what the catalog stores.
3. **Multi-column histograms or sketches** for range conditions across correlated columns. Much
   more storage and collection cost; only worth it if (1) and (2) prove insufficient.

## Open questions for whoever picks this up

- Which column groups get collected — automatically from declared indexes, or only when a user
  asks for them explicitly?
- Does the virtual-table statistics interface need to carry multi-column groups, or is this
  `ANALYZE`-only to start?
- How does a stale or missing column group degrade — silently back to the independence model, or
  visibly?

## Related

Follows `feat-conjunction-selectivity` and `feat-join-filter-selectivity`. Part of the broader
`adaptive-query-optimization` direction.
