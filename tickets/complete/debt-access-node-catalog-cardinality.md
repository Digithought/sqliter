description: After ANALYZE records how many rows a table holds, the query planner now uses that number when a query reads the whole table, instead of the zero it used to report — so scan and filter row estimates are real numbers again.
files: packages/quereus/src/planner/stats/table-cardinality.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/test/optimizer/statistics.spec.ts, docs/optimizer.md
----

## What shipped

`TableReferenceNode.estimatedRows` (`planner/nodes/reference.ts:91`) returns
`catalogRowCount(this.tableSchema)` — `table.statistics?.rowCount ?? table.estimatedRows` —
instead of the static `TableSchema.estimatedRows` field, which `SchemaManager` hardcodes to `0`
at CREATE TABLE and never updates. Every physical access node built on the reference
(`SeqScanNode`, `IndexScanNode`, `IndexSeekNode`, `RetrieveNode`) inherits the corrected number
without changes of its own.

Supporting pieces:

- `planner/stats/table-cardinality.ts` — new one-function module holding `catalogRowCount`. Its
  own file (type-only imports) so `reference.ts` can import it as a *value* without pulling in
  `catalog-stats.ts`'s node-module dependencies.
- `TableReferenceNode.getLogicalAttributes()` reports `this.estimatedRows`, so EXPLAIN prints the
  same number the cost model used.
- `CatalogStatsProvider.tableRows()` routes through the same helper, so the base-cardinality
  number cannot drift between the node and the stats provider.
- `IndexSeekNode.computePhysical` carries a `NOTE:` recording that its `min(tableRows, 100)` cap
  is now driven by a real catalog count; expression unchanged.
- `docs/optimizer.md` gained a "Base-table row estimates" paragraph beside the existing
  "Filter row estimates" one.

A never-analyzed table is unaffected — no `statistics` means the helper falls through to the
unchanged static estimate, which is why the golden-plan corpus (which never runs `ANALYZE`) did
not move.

## Review findings

**Checked:** the full implement diff (5 source/doc files + spec) read before the handoff summary;
every `estimatedRows` and `tableRows` call site in `packages/quereus/src` (grep over both symbol
families) for spots that should also have routed through the new helper; every doc that mentions
`estimatedRows` (`docs/optimizer.md`, `docs/module-authoring.md`, `docs/plugins.md`,
`docs/store.md`, `src/vtab/best-access-plan.ts` field docs); the new tests for vacuous assertions
and missing paths; lint and both test backends.

**Minor — fixed in this pass:**

- `CatalogStatsProvider.tableRows` (`catalog-stats.ts:135`) kept its old
  `if (table.statistics) return table.statistics.rowCount` branch *and* added
  `catalogRowCount(table) ?? this.fallback.tableRows(table)` below it. The helper call was
  therefore only ever reached with `statistics === undefined`, where it degenerates to exactly the
  old `fallback.tableRows` result — i.e. the helper was dead in effect and the handoff's
  "cannot drift" claim was cosmetic, since the live branch still duplicated the helper's logic.
  Collapsed to a single `catalogRowCount` call with one log line tagged by source
  (`catalog` / `schema`). Return value is identical for all four input shapes.
- The spec reached `getPlan` through `(db as unknown as { getPlan(s: string): PlanNode })`, though
  `Database.getPlan` is public and a dozen other specs call it directly. Cast removed.
- The "populated but never-analyzed" test asserted
  `scan.physical.estimatedRows === schema?.estimatedRows` — a tautology that passes even if both
  sides are `undefined`, i.e. it could not fail for the reason it exists. Now asserts the three
  facts separately: no `statistics`, static estimate `0`, scan estimate `0`.
- New tests used uppercase SQL keywords; AGENTS.md specifies lowercase. Lowercased the new block
  (the older tests in that file are pre-existing uppercase and were left alone).

**Minor — coverage added:**

- `CatalogStatsProvider.tableRows` had no test at all, though the plan asked to "confirm the value
  is unchanged for all three inputs". Added a unit test over four shapes, including
  neither-source-known → `1000` (the `NaiveStatsProvider` default), which pins that the helper did
  not swallow the fallback.
- The `getLogicalAttributes` change (a plan TODO — EXPLAIN must not print 0 for a table the cost
  model treats as 100) shipped untested. The end-to-end test now asserts
  `TableReferenceNode.getLogicalAttributes().estimates.rows === 100` after `ANALYZE`.

**Major — none.** The change is a one-line semantic swap behind a shared helper; all readers of
`TableReferenceNode.estimatedRows` were reviewed and each already had its own `?? default` /
`|| default` handling, so none can be handed a value it cannot interpret. No resource-cleanup,
error-handling or type-safety issue surfaced — the helper has no failure mode and returns
`number | undefined` with no casts.

**Tripwires (recorded in code, not filed as tickets):**

- `estimatedRows || default` at three cost sites (`rule-select-access-path.ts:263`,
  `rule-grow-retrieve.ts:284,558`, `IndexSeekNode.computePhysical`) collapses a real `0` with
  `undefined`, so an analyzed *empty* table reaches `getBestAccessPlan` as "unknown" (1000) while
  a SeqScan over the same table reports 0. Pre-existing and harmless — any plan over 0 rows is
  cheap — but only reachable now that the count is real. `NOTE:` at
  `planner/stats/table-cardinality.ts`, next to the semantics it depends on.
- Staleness (rows written after the last `ANALYZE` are invisible to the estimate) and the
  `IndexSeekNode` cap already carry `NOTE:`s from the implement pass; both re-read and left as-is.

**Deliberately not done:** no golden-plan fixture exercising `ANALYZE` was added. The corpus
asserts plan *shape*; these estimates are asserted directly and exactly by the new specs, so a
snapshot would only re-test them indirectly. Not a gap, a redundancy avoided.

**Docs:** `docs/optimizer.md`'s new paragraph claims the node getter and
`CatalogStatsProvider.tableRows` share one helper — true only after the `catalog-stats.ts` fix
above, and true now. `docs/module-authoring.md`, `docs/plugins.md` and the
`BestAccessPlanRequest.estimatedRows` field doc ("estimated rows hint from planner, may be
unknown") describe the field without claiming a source, so they stay accurate. No further doc
change needed.

## Verification

- `yarn workspace @quereus/quereus run lint` — clean (exit 0; eslint + `tsc --noEmit` over specs).
- `node test-runner.mjs` (memory) — **8234 passing, 0 failing, 13 pending** (implement handoff:
  8233 passing; +1 is the new `CatalogStatsProvider.tableRows` spec).
- `node test-runner.mjs --store` (LevelDB) — **8226 passing, 0 failing, 21 pending** (implement
  handoff: 8225; same +1).
- No pre-existing failures observed in either run; `tickets/.pre-existing-error.md` not written.

## Downstream

`debt-join-rows-from-physical-children` and `debt-store-analyze-row-count` both list this slug as
a prereq and can assume it landed as specified. Neither `JoinNode.computePhysical` nor
`StoreTable.getStatistics` was touched here.
