description: After ANALYZE records how many rows a table holds, the query planner still ignores that number when a query reads the whole table — so its row estimates for full scans stay at zero, and the smarter filter estimates layered on top get multiplied by nothing.
files: packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/test/optimizer/statistics.spec.ts, docs/optimizer.md
----

## What changed

`TableReferenceNode.estimatedRows` (`packages/quereus/src/planner/nodes/reference.ts:90`) used to
return the static `TableSchema.estimatedRows` field, which `SchemaManager` hardcodes to `0` at
`CREATE TABLE` and never updates. It now prefers the row count `ANALYZE` actually collected:

```ts
get estimatedRows(): number | undefined {
    return catalogRowCount(this.tableSchema);
}
```

`catalogRowCount(table)` is a new one-line helper in
`packages/quereus/src/planner/stats/table-cardinality.ts`:
`table.statistics?.rowCount ?? table.estimatedRows` (own file, not folded into
`catalog-stats.ts`, to avoid `catalog-stats.ts`'s node-module imports pulling into
`reference.ts`, which imports it as a *value*, not just a type).

Every physical access node built on `TableReferenceNode.estimatedRows` (`SeqScanNode`,
`IndexScanNode`, `IndexSeekNode`, `RetrieveNode`) inherits the fix automatically — no changes
needed to those node classes.

Three other spots now route through the same helper so the base-cardinality number can't drift
between call sites:
- `TableReferenceNode.getLogicalAttributes()` (`reference.ts:276`) — reports `this.estimatedRows`
  instead of re-reading the static field directly, so `EXPLAIN` prints the same number the cost
  model actually used.
- `CatalogStatsProvider.tableRows()` (`catalog-stats.ts:134`) — rewritten over the helper,
  keeping its existing log line and the `NaiveStatsProvider` fallback for the fully-unknown case.
- `IndexSeekNode.computePhysical()` (`table-access-nodes.ts:409`) got a `NOTE:` (no behavior
  change) recording that its `min(tableRows, 100)` cap is now driven by a real catalog count for
  analyzed tables, and where to look if that ever produces a bad plan.

`docs/optimizer.md` gained a "Base-table row estimates" paragraph next to the existing "Filter
row estimates" one, describing the statistics-first rule and that a never-analyzed table is
unaffected.

## Why not a Physical-pass rule

The plan ticket floated stamping the count onto the access node via an optimizer rule (the
pattern `rule-filter-selectivity` uses for `FilterNode`). Doesn't apply here: the statistics live
on `TableSchema`, which `TableReferenceNode` already holds directly — no `OptContext` needed. A
rule would also only fix the *physical* node, leaving the *logical* `estimatedRows` getter (read
by `rule-select-access-path.ts`, `rule-key-set-seek.ts`, `rule-lateral-top1-asof.ts` for costing
decisions) still reporting 0, and `SeqScanNode`/`IndexScanNode` have no field to stamp onto
without new constructor params. The getter is strictly smaller and covers both readers.

## Test coverage (packages/quereus/test/optimizer/statistics.spec.ts)

New `describe('base-table cardinality from catalog statistics', ...)`, two sub-blocks:

**`catalogRowCount` unit tests** (mock `TableSchema` objects, no DB):
- statistics present → returns `rowCount`, ignoring the static field.
- statistics absent → falls through to the static `estimatedRows` (0 and non-zero both checked).
- both absent → `undefined`.
- `rowCount: 0` is honoured as a real zero, not treated as "unknown" — this is the `??` vs `||`
  boundary the ticket called out explicitly; a `||` implementation would wrongly fall through to
  the static estimate for an analyzed-but-empty table.

**End-to-end** (real `Database`, `memory` vtab, walks the optimized plan tree for the first
physical access node — `SeqScan`/`IndexScan`/`IndexSeek` — and the first residual `FilterNode`):
- 100-row table, `ANALYZE`, `select * from m where a = 1` (non-key column, 4 distinct values) →
  scan reports **100** (not 0), residual filter reports `max(1, floor(100/ndv))`, and both are
  asserted `!= 0` explicitly. This is the probe from the ticket.
- Same query, populated but **never analyzed** → scan estimate equals the static schema
  estimate, unchanged — pins that the change is inert without `ANALYZE` (this is also what
  protects the golden-plan corpus, see below).
- `ANALYZE` on an **empty** table → scan and filter both report 0.
- Insert 20, `ANALYZE`, assert scan=20; insert 30 more, re-`ANALYZE`, assert scan=50 — pins that
  a `TableReferenceNode` built after a later plan picks up the *new* `TableSchema` object
  `ANALYZE` re-registers (not a stale cached one).

## Verified

- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc --noEmit`) — clean.
- `node test-runner.mjs` (memory backend, from `packages/quereus`): **8233 passing, 13 pending**
  (baseline before this ticket: 8225 passing / 13 pending — the delta is exactly the 8 new specs
  above; no other test's pass/fail count moved).
- `node test-runner.mjs --store` (LevelDB backend): **8225 passing, 21 pending** (baseline: 8217 —
  same +8 delta). Store mode matters because `ANALYZE` falls back to
  `collectStatisticsFromScan` for any vtab without `getStatistics`, so store-backed tables are
  affected by this change too, and this run confirms no regression there.
- **No golden-plan churn** (`test/plan/golden-plans.spec.ts` unaffected, ran as part of the full
  suite above). Expected and explained in the plan ticket: that corpus builds tables but never
  runs `ANALYZE`, so `statistics` stays undefined and every node falls through to the unchanged
  static estimate.

## Gaps / things the reviewer should know

- I did not add a *new* golden-plan fixture that includes `ANALYZE` — the ticket's own "verified
  fallout: none" section argues convincingly why the existing corpus can't move, and the new
  end-to-end specs cover the actual estimate numbers directly (which a golden-plan snapshot
  would only assert indirectly via cost-driven plan shape). If the reviewer wants a
  belt-and-suspenders golden-plan case that exercises `ANALYZE`, that's a clean follow-up, not a
  gap in this ticket's own claims.
- The `IndexSeekNode.computePhysical` `NOTE:` is exactly the ticket's suggested wording,
  condensed; I did not change the `Math.min(this.source.estimatedRows || 1000, 100)` expression
  itself (ticket explicitly says leave it — the `||` there is a separate pre-existing quirk, not
  this ticket's scope).
- Stale-statistics behavior (rows written after the last `ANALYZE` are invisible to the estimate)
  is pre-existing for selectivity and now also true for cardinality — recorded as a `NOTE:` in
  `table-cardinality.ts`'s doc comment per the ticket, not filed as a ticket.
- Two downstream tickets (`debt-join-rows-from-physical-children`,
  `debt-store-analyze-row-count`) list this ticket as a `prereq:` and assume it landed as
  specified. I did not touch `JoinNode.computePhysical` or add `getStatistics` to `StoreTable` —
  left for those tickets as instructed.
