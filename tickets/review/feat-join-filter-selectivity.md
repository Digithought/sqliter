description: A WHERE clause sitting above a join used to get a flat 50% row-count guess; it now estimates each condition against whichever table that condition's columns actually come from, but only when those tables have had ANALYZE run on them.
prereq: feat-conjunction-selectivity
files: packages/quereus/src/planner/util/column-origins.ts (new), packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/column-origins.spec.ts (new), packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md
difficulty: medium
----

## What landed

`ruleFilterSelectivity` gained a second path for a filter whose source spans several base tables.
Previously `extractTableSchema` returned `undefined` on any join and the rule declined outright,
leaving the flat `DEFAULT_FILTER_SELECTIVITY` of 0.5.

**New module `planner/util/column-origins.ts`** — `collectColumnOrigins(node)` walks a relational
subtree via `getRelations()` and maps every reachable attribute id back to the base-table column
that minted it (`{ ref, table, columnIndex, columnName }`). Keyed on the `TableReferenceNode`
*instance*, not the `TableSchema`, so the two sides of a self-join stay distinct. Dedupes visited
nodes by identity (plan trees are DAGs). Attributes minted above a base table — computed
projections, aggregate outputs, `values` rows, join existence flags — are deliberately absent.

**`rule-filter-selectivity.ts`** now branches: `singleTableSelectivity` (unchanged behaviour) or
`multiRelationSelectivity`. The latter splits the predicate with `splitConjuncts`, attributes each
conjunct via the origin map, estimates per conjunct, and folds with `combineConjunctive`:

- one origin relation → `context.stats.selectivity(table, conjunct)`
- two origin relations, plain binary comparison with a bare column reference on each side →
  `=` uses `joinSelectivity`, `!=`/`<>` uses `1 - joinSelectivity`, `<` `<=` `>` `>=` use the
  exported constant `CROSS_RELATION_INEQUALITY_SELECTIVITY` (1/3)
- everything else (three+ relations, no column refs, any non-base attribute) → skipped
- no conjunct estimable → return `null`, filter stays unstamped exactly as before

**Statistics gate — multi-relation path only.** A conjunct counts as known only when the backing
statistics really exist: single-relation needs `TableSchema.statistics.columnStats` for every column
it references; cross-relation needs `statistics` on both tables. Without this, `context.stats`
always answers (falling through to `NaiveStatsProvider`'s flat 0.1) and the rule would have
replaced 0.5 with 0.1 on every filter-over-join in the repo. The single-table path is deliberately
NOT gated — it keeps stamping naive numbers as it always has. **Verified: zero golden-plan churn.**

`docs/optimizer.md` — replaced the stale "join selectivity is still not decomposed" line with the
attribution model, the per-conjunct cases, the gate, and the simplifications.

## Validation run

- `yarn build` — clean
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`)
- `yarn test` — **all green**, 7511 passing in `packages/quereus`, no failures anywhere in the
  monorepo, no pre-existing failures encountered. Working tree shows no modified golden plans.

## Use cases to exercise

Setup for all of these: two tables with different column cardinalities, both `ANALYZE`d.

```sql
create table o (id integer primary key, cat text, qty integer, rid integer) using memory;
create table r (id integer primary key, cat text, qty integer) using memory;
-- o: 100 rows, cat has 4 distinct, qty 3 distinct, rid 20 distinct
-- r:  20 rows, cat has 3 distinct, qty 5 distinct
analyze o; analyze r;
```

| Query | Expected `FilterNode.selectivity` |
|---|---|
| `select * from o join r on o.rid = r.id where o.cat = 'a' and r.cat = 'x'` | `combineConjunctive([1/4, 1/3])` ≈ 0.1443 |
| `select * from o a join o b on a.id = b.id where a.qty > b.qty` | 1/3 (the cross-relation inequality constant) |
| `select * from o a join o b on a.id = b.id where a.qty = b.rid` | `1/max(3, 20)` = 0.05 — **not** `1/3`, which is what collapsing the self-join sides onto one schema would give |
| `select * from o join r on o.id = r.id where o.qty = r.qty` | `1/max(3, 5)` = 0.2 |
| same, but with a table that was never `ANALYZE`d on one side | only the analyzed side's conjunct counts |
| `select o.qty + 1 as s from o join r on o.rid = r.id where o.qty + 1 = 3` | unstamped (computed projection has no base origin) |
| `select c.cc, hasP from ec c left join ep p on p.pp = c.pr exists right as hasP where hasP and c.cv > 100` | existence flag skipped; equals the solo estimate for `cv > 100` |
| any of the above without `ANALYZE` | unstamped |

Re-running `db.optimizer.optimize(plan, db)` over an already-stamped plan must change nothing.

## Tests added

`test/optimizer/column-origins.spec.ts` (6 cases) — two-table join, reaching through the physical
access nodes of a real optimized plan, self-join (two refs / one schema), computed projection
excluded, `values` source giving an empty map, shared-CTE subtree.

`test/optimizer/filter-selectivity.spec.ts` (8 new cases in a new `multi-relation filter
selectivity` block, plus the retargeted un-analyzed case) — see the table above; all assert against
values derived from the recorded distinct counts, not hard-coded numbers.

The old case `leaves selectivity unstamped for a multi-table (join) filter source` was **retargeted,
not deleted**: it now asserts the un-analyzed join stays unstamped, which is the statistics gate.

## Known gaps — treat the tests as a floor

**The estimate does not move row counts yet, and that is the biggest one.** The stamp is visible on
`FilterNode.selectivity`, but `estimatedRows` above a join stays `undefined`, because
`JoinNode.computePhysical` derives its cardinality from its children's *logical* `estimatedRows` and
a physical access node exposes none. So nothing downstream — enclosing join ordering, cache
advisories, sort costs — can see the improvement today. Filed as backlog
`debt-join-rows-from-physical-children` (sibling of the existing `debt-access-node-catalog-cardinality`,
which fixes the base number this one would propagate); a `NOTE:` at the site in
`rule-filter-selectivity.ts` points at it. Nothing in this ticket needs to change when it lands.
Worth a reviewer's judgement call on whether that makes this feature premature.

Untested / unverified behaviour, in rough order of how likely it is to bite:

- **`!=` / `<>` cross-relation leaks a naive number past the gate.** `CatalogStatsProvider.joinSelectivity`
  only handles `=` (its `extractEquiJoinColumns` rejects any other operator), so a `<>` conjunct
  falls through to `NaiveStatsProvider.joinSelectivity` — `min(0.5, 1/max(rowCount))` — and the
  result is `1 - that` ≈ 0.99. Directionally harmless (claims almost no reduction, the safe error
  direction) but it is a fabricated number reaching a path the gate was supposed to keep clean.
  No test covers it.
- **A function-wrapped column passes the gate but yields the naive 0.1.** `where lower(o.cat) = 'x'`
  over an analyzed `o`: the gate sees column stats for `o.cat` and lets it through, then
  `estimateLeaf` cannot find a bare `ColumnReference` child and the provider falls back to 0.1.
  Same behaviour the single-table path has always had, so it is consistent — but it is a naive
  number in the gated path. No test.
- **The documented argument order for `joinSelectivity` is currently unenforceable by test.**
  The rule passes the table owning the conjunct's left child first, as the design requires, but
  `CatalogStatsProvider` happens to be symmetric today (`fkPkSelectivity` tries both directions,
  the ndv path uses `max`), so swapping the arguments would not fail any test. If the provider ever
  becomes order-sensitive, that ordering is unguarded.
- **Multi-column-per-relation gate.** The design said "require column stats for `origin.columnName`";
  the implementation requires them for *every* column of that relation the conjunct references
  (strictly safer, but a wider gate than specified). Not separately tested.
- **Three-or-more-relation conjuncts** are skipped by code inspection only; no test builds one.
- **Outer joins** — the base-table fraction is applied regardless of join type; the NULL-extension
  asymmetry is documented as a deliberate simplification and not tested.
- **Aggregate between the filter and the join** — a group-key predicate is attributed to its base
  table and applied to post-aggregate cardinality. Documented, not tested.
- **Non-join multi-relation shapes** (set operations, a join with a `values` list on one side)
  reach the new path too. Only the `values`-only source is tested (empty origins → unstamped).
- **Correlated subquery inside a conjunct** — the walk reaches column references belonging to
  tables outside `filter.source`, finds them absent from the origin map, and skips the conjunct.
  Reasoned through, not tested.

Performance: `collectColumnOrigins` walks the whole source subtree per `FilterNode`, so N stacked
filters over one subtree cost O(N·subtree). Recorded as a `NOTE:` in the rule with the fix if it
ever shows up in profiles (compute once per pass, cache on `OptContext`). Not a concern at current
plan sizes.
