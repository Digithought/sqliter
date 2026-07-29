description: After ANALYZE records how many rows a table has, the query planner still ignores that number when a query reads the whole table — so its row estimates for full scans stay at zero (or a stale guess), and any smarter estimate layered on top is invisible.
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/stats/catalog-stats.ts
----

## What's wrong

`TableReferenceNode.estimatedRows` (packages/quereus/src/planner/nodes/reference.ts:90) returns `this.tableSchema.estimatedRows` — a **static** schema field. It never consults `tableSchema.statistics?.rowCount`, which is the value `ANALYZE` (and `VirtualTable.getStatistics()`) actually populate.

The physical access nodes inherit this: `SeqScanNode` / `IndexScanNode.computePhysical` set `estimatedRows: this.source.estimatedRows` (packages/quereus/src/planner/nodes/table-access-nodes.ts). So a full scan's physical cardinality is whatever the static field says — for the memory vtab that is `0` (visible in the golden plans, e.g. `test/plan/aggregates/group-by.plan.json`, which show `"estimatedRows": 0` on IndexScan nodes over populated tables).

There is already a stats provider method that knows the right number — `CatalogStatsProvider.tableRows(table)` returns `table.statistics.rowCount` when present — but nothing wires it into the access node's cardinality. The provider is consulted for selectivity, not for base cardinality.

## Why it matters

Two consequences:

1. **Cost model runs on zeros.** Every cost estimate that multiplies a base-table row count (join ordering, cache advisory thresholds, sort cost) starts from `0` for full-scan sources over the memory vtab. Plans still come out right today only because the *comparisons* happen to tie or because other signals dominate — it is luck, not correctness.

2. **Filter selectivity is invisible over full scans.** The `5.5-planner-filter-selectivity` work makes a residual `FilterNode` multiply its **physical source cardinality** by a stats-derived selectivity. `floor(0 * sel) = 0`, so `select * from t where cat = 'a'` over a plain full scan reports `0` estimated rows — the selectivity is computed correctly and then discarded because the source is `0`. The feature is only observable over sources that already carry a positive physical cardinality (range seeks). That is the *narrow* slice `5.5` could demonstrate; the *common* case (equality filter over a full scan) shows nothing.

## Desired behavior

When a table has catalog statistics, the access node's physical `estimatedRows` should derive from `statistics.rowCount` (via `CatalogStatsProvider.tableRows`, or an equivalent seam that both the reference node and the access node can reach). Fall back to the current static `tableSchema.estimatedRows` when no statistics exist.

Note the access node's `computePhysical` carries no `OptContext` (same constraint `5.5` hit for the Filter), so the wiring likely wants a Physical-pass rule that stamps a catalog-derived row count onto the access node, mirroring `rule-filter-selectivity` — or a change so `TableReferenceNode.estimatedRows` itself prefers `statistics.rowCount`.

## Expected fallout

Fixing this **will churn golden EXPLAIN plans** — the `estimatedRows: 0` values on scans over analyzed tables become real counts, and any downstream `estimatedRows` (filters, joins, aggregates) shifts with them. `5.5` deliberately produced no golden churn precisely because scans reported `0`; expect that churn to land here instead. Budget for regenerating the plan snapshots and eyeballing that the new numbers are sane.

## Use case

```sql
analyze t;
explain select * from t where cat = 'a';   -- 4 distinct cat values, 100 rows
```

Today: the residual Filter reports `estimatedRows = 0` (source scan is 0). Desired: source scan reports ~100, Filter reports ~25 (`100 * 1/ndv`).

## Relationship to other tickets

Distinct from `feat-conjunction-and-join-selectivity` (that ticket improves *selectivity* for multi-condition / join predicates; this one fixes the *base cardinality* the selectivity multiplies). Both feed the broader `adaptive-query-optimization` direction. This one is arguably the higher-leverage of the two, since without it single-column selectivity — already implemented — stays invisible on the most common query shape.
