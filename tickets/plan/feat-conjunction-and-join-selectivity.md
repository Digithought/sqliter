description: Make row-count estimates smarter for WHERE clauses that combine several conditions with AND, and for filters that sit on top of joins — today those cases fall back to a very rough guess.
files: packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/stats/index.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts
----

Follow-on to the filter-selectivity work (`5.5-planner-filter-selectivity`, which makes single-column filter selectivity read real column statistics). Two cases that ticket deliberately left coarse:

## Conjunctions (`where a = 1 and b = 2`)

The statistics provider (`CatalogStatsProvider.estimatePredicateSelectivity`) only handles a predicate that is a single column-vs-constant comparison. For an `AND` of several conditions, it finds no single column and falls back to `NaiveStatsProvider`, which returns a flat `0.1` for any binary operator — regardless of how many conjuncts there are or which columns they touch. So `a = 1 and b = 2 and c = 3` gets the same estimate as `a = 1`.

Desired: decompose a conjunction into its conjuncts, estimate each conjunct's selectivity from column stats, and combine them (independence assumption: multiply; optionally cap, and account for correlated columns later). This is standard textbook selectivity combination.

## Filters over joins / multi-table sources

The selectivity rule only fires when the filter's source resolves to a single base table (`extractTableSchema` returns one table). A filter sitting above a join keeps the default 0.5. Estimating selectivity for a predicate whose columns come from different join inputs needs per-input attribution and is a larger piece of work.

## Why backlog, not now

Both need genuine estimation design (conjunct combination model, correlation handling, cross-input attribution) rather than wiring existing stats to an existing consumer. The near-term ticket delivers the high-value single-column-equality case; these extend it. Relates to the broader `adaptive-query-optimization` vision.

## Use case

`select * from orders where status = 'shipped' and region = 'EU'` over a table with per-column histograms should estimate far fewer rows than a single `status = 'shipped'` filter — today both estimate the same.
