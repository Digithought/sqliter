description: After ANALYZE records how many rows a table holds, the query planner still ignores that number when a query reads the whole table — so its row estimates for full scans stay at zero, and the smarter filter estimates layered on top get multiplied by nothing.
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/test/optimizer/statistics.spec.ts, docs/optimizer.md
difficulty: easy
----

## What's wrong

`TableReferenceNode.estimatedRows` (`planner/nodes/reference.ts:90`) returns
`this.tableSchema.estimatedRows` — a **static** schema field that `SchemaManager` hardcodes
to `0` at CREATE TABLE (`schema/manager.ts:1906`). It never consults
`tableSchema.statistics?.rowCount`, which is the value `ANALYZE` actually records
(`runtime/emit/analyze.ts:67` re-registers the table schema with a `statistics` object).

Every physical access node inherits that number: `SeqScanNode` / `IndexScanNode` /
`IndexSeekNode.computePhysical` all read `this.source.estimatedRows`
(`planner/nodes/table-access-nodes.ts`), as does `RetrieveNode.computePhysical`
(`retrieve-node.ts:73`). So a full scan over an analyzed, populated table reports
`physical.estimatedRows: 0`.

`CatalogStatsProvider.tableRows` (`planner/stats/catalog-stats.ts:134`) already knows the
right number, but it is only consulted for **selectivity**, never for base cardinality.

### Measured, at HEAD

Probe: create `m (id integer primary key, a integer, s text)` using memory, insert 100 rows,
`analyze m`, then plan `select * from m where a = 1`. Walking the optimized plan prints:

```
schema.estimatedRows = 0   stats.rowCount = 100
Filter          logical=undefined  physical=0    sel=0.25
IndexScan       logical=undefined  physical=0    sel=undefined
TableReference  logical=0          physical=undefined
```

The selectivity is computed *correctly* (0.25 = 1/ndv over 4 distinct values) and then
multiplied by a zero source, so the Filter reports 0 rows. Cost estimates that scale a base
row count (join ordering, cache advisory thresholds, sort cost) start from 0 for every full
scan over an analyzed table.

## The change

Make the table reference prefer collected statistics over the static schema estimate:

```ts
get estimatedRows(): number | undefined {
    return catalogRowCount(this.tableSchema);
}
```

where `catalogRowCount(table)` is `table.statistics?.rowCount ?? table.estimatedRows`.

With that one-line semantic change the probe above becomes:

```
Filter          logical=undefined  physical=25
IndexScan       logical=undefined  physical=100
TableReference  logical=100        physical=undefined
```

which is exactly the desired end state (scan ≈ 100, residual filter ≈ 25).

### Why the node getter, and not a Physical-pass rule

The original plan ticket floated a `rule-filter-selectivity`-style rule that stamps a
catalog-derived count onto the access node. That was the right instinct for `FilterNode`,
where the estimate needs an `OptContext` to reach the stats provider — but it does not apply
here. The statistics live on `TableSchema`, and `TableReferenceNode` already holds the schema
it needs; no context is required. A rule would also be strictly worse:

- it would only fix the physical access node, leaving the *logical* getter (read by
  `rule-select-access-path.ts:1174` to cost a scan, by `rule-key-set-seek.ts:334`, and by
  `rule-lateral-top1-asof.ts:261`) still reporting 0;
- `SeqScanNode` / `IndexScanNode` have no `estimatedRows` override field, so a stamping rule
  would need a new constructor parameter on each of them plus matching `withChildren`
  threading — a large change for a strictly smaller fix.

The one thing the getter cannot do is honour a **custom** `StatsProvider` (the `stats`
constructor argument on `Optimizer`, defaulted to `CatalogStatsProvider` at
`planner/optimizer.ts:1278`). Nothing in the engine passes a custom provider today, and a
provider that wanted to override base cardinality would be overriding the catalog itself. The
mitigation is DRY rather than indirection: both the node and `CatalogStatsProvider.tableRows`
call the *same* helper, so they cannot drift.

Keep the helper's return type `number | undefined` and do **not** fold
`NaiveStatsProvider`'s default of 1000 into it. `undefined` must keep meaning "nobody knows";
the 1000 belongs to the provider's fallback chain, and pushing it into the node would change
every un-analyzed table's cardinality from 0 to 1000.

### Verified fallout: none

The plan ticket predicted golden-plan churn. It does not happen, and the reason is worth
recording: `statistics` is populated **only** by `ANALYZE` (`analyze.ts` is the sole writer;
`grep "statistics:" src` returns one hit). The golden-plan corpus
(`test/plan/golden-plans.spec.ts`) builds two empty tables and never runs `ANALYZE`, so
`statistics` is undefined and the fallback keeps the existing `0`.

The one-line change above was applied at HEAD and both suites run clean, unmodified:

- `node test-runner.mjs` → **8225 passing, 13 pending**
- `node test-runner.mjs --store` → **8217 passing, 21 pending**

Store mode matters because `ANALYZE` falls back to `collectStatisticsFromScan`
(`planner/stats/analyze.ts`) for any vtab without `getStatistics`, so store-backed tables do
receive statistics and are affected by this change.

Re-run both after adding the `getLogicalAttributes` change below, which was *not* part of the
probe.

## Edge cases & interactions

- **No statistics (the default state).** Never-analyzed table → helper falls through to
  `tableSchema.estimatedRows` → unchanged. This is the case the whole existing test corpus
  exercises; it must stay byte-identical.
- **`ANALYZE` on an empty table.** `rowCount: 0` → `estimatedRows` 0, same as today.
  `FilterNode.computePhysical` short-circuits `srcRows > 0 ? … : 0`, so the filter still
  reports 0 rather than the min-1 floor. Assert this explicitly — it is the boundary where
  `??` (correct) and `||` (would silently substitute the static estimate) differ.
- **`estimatedRows` absent entirely.** `TableSchema.estimatedRows` is optional. With neither
  statistics nor the static field the helper returns `undefined`, and every consumer keeps
  its existing `?? default` / `|| default` handling. Do not coerce to 0.
- **Stale statistics.** `rowCount` is a snapshot from the last `ANALYZE`; rows written
  afterwards are invisible until the next one. Pre-existing for selectivity, now also true
  for cardinality. Record as a `NOTE:` at the helper, not as a ticket.
- **Re-`ANALYZE`.** `ANALYZE` mints a *new* `TableSchema` object and re-registers it
  (`analyze.ts:67-75`), so a `TableReferenceNode` built earlier still holds the old object.
  Add a regression test that plans, inserts more rows, re-analyzes, and re-plans, asserting
  the scan's `physical.estimatedRows` tracks the new count — this pins the schema-change
  notification path that the estimate now depends on.
  (`test/logic/108-cardinality-estimation.sqllogic` already exercises re-`ANALYZE`
  end-to-end, but only asserts result correctness.)
- **`IndexSeekNode.computePhysical`** computes `Math.min(this.source.estimatedRows || 1000, 100)`.
  For an analyzed table of fewer than 100 rows a non-PK seek now reports the whole table count
  instead of the flat 100 — strictly closer to the truth, never worse, and a full PK-equality
  seek still short-circuits to 1. Note the `||`: an analyzed *empty* table falls to 1000 → 100.
  Both are pre-existing quirks of that expression; leave them and record a `NOTE:` at the site.
- **Self-join / two references to one table.** Both references read the same schema object
  and get the same count; nothing here is per-instance.
- **Views and subquery sources** never produce a `TableReferenceNode`, so they are untouched.
- **Downstream tickets.** `debt-join-rows-from-physical-children` and
  `debt-store-analyze-row-count` both list this slug as a prereq and both assume this landed.
  Do not pre-empt either: leave `JoinNode.computePhysical` reading its children's logical
  getters, and do not add `getStatistics` to `StoreTable`.

## Documentation

`docs/optimizer.md` § *Statistics Abstraction* documents the provider and filter row
estimates but says nothing about where a **base-table** row count comes from. Add a short
paragraph next to the existing "Filter row estimates" one: statistics-first, static schema
estimate second, `undefined` when neither is known; the node and
`CatalogStatsProvider.tableRows` share one helper so they cannot disagree; and no plan
changes for a table that was never analyzed.

## TODO

- Add `packages/quereus/src/planner/stats/table-cardinality.ts` exporting
  `catalogRowCount(table: TableSchema): number | undefined` = `table.statistics?.rowCount ?? table.estimatedRows`.
  Its own file (importing only the `TableSchema` *type*) rather than a new export from
  `catalog-stats.ts`, because `reference.ts` needs a **value** import and `catalog-stats.ts`
  pulls in `predicate-conjuncts` / node modules — an import cycle waiting to happen.
  Document the statistics-first rule and the staleness `NOTE:` in its doc comment.
- Change `TableReferenceNode.estimatedRows` (`reference.ts:90`) to return
  `catalogRowCount(this.tableSchema)`.
- Change `TableReferenceNode.getLogicalAttributes` (`reference.ts:276`) so
  `estimates.rows` reports `this.estimatedRows` instead of re-reading
  `this.tableSchema.estimatedRows` — otherwise EXPLAIN prints 0 for a table the cost model
  is treating as 100.
- Rewrite `CatalogStatsProvider.tableRows` (`catalog-stats.ts:134`) over the helper, keeping
  the existing log line and the `NaiveStatsProvider` fallback for the `undefined` case.
  Confirm the value is unchanged for all three inputs (statistics present / absent with a
  static estimate / absent with none).
- Add a `NOTE:` at `IndexSeekNode.computePhysical` (`table-access-nodes.ts:409`) recording
  that the seek estimate is now capped by a real table count, and that if seek cardinality
  ever drives a bad plan it should derive from the seek key's own selectivity rather than
  `min(tableRows, 100)`.
- Tests in `test/optimizer/statistics.spec.ts`, new
  `describe('base-table cardinality from catalog statistics')`:
  - `catalogRowCount` unit cases: statistics present → `rowCount`; statistics absent with
    `estimatedRows: 0` → `0`; both absent → `undefined`.
  - end-to-end, mirroring the probe above: 100-row memory table, `analyze`,
    `select * from t where <non-key col> = <literal>` → the access node's
    `physical.estimatedRows` is 100 and the residual `FilterNode`'s is
    `max(1, floor(100 / ndv))`. Assert the scan is specifically **not** 0.
  - the un-analyzed control: the same query on a populated but never-analyzed table still
    reports the static estimate, so the change is inert without `ANALYZE`.
  - `ANALYZE` on an empty table → scan and filter both report 0.
  - re-`ANALYZE` after further inserts → the scan estimate follows the new count.
- Update `docs/optimizer.md` as described above.
- Run `yarn workspace @quereus/quereus run lint`, then `node test-runner.mjs 2>&1 | tee /tmp/q-test.log; tail -n 60 /tmp/q-test.log`
  and `node test-runner.mjs --store 2>&1 | tee /tmp/q-store.log; tail -n 40 /tmp/q-store.log`
  from `packages/quereus`. Both were green with the core change already; any new failure is
  from the `getLogicalAttributes` / helper work, not from the cardinality change itself.
  If a golden plan does churn, regenerate with `UPDATE_PLANS=true` and explain in the review
  handoff *why* a snapshot moved — an un-analyzed corpus should not move at all.
