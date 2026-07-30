---
description: The planner used to guess how many rows a filter keeps by matching the filtered column to table statistics by name, so a computed column that reused a real column's name borrowed that column's statistics. It now matches by column identity instead.
files:
  - packages/quereus/src/planner/stats/index.ts                              # new ColumnStatsResolver type + optional `resolve` params
  - packages/quereus/src/planner/stats/catalog-stats.ts                      # EstimateContext threading; both extract* helpers
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # hoisted origins map, makeResolver, three narrowings
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # 7 new tests
  - docs/optimizer.md                                                        # Statistics Abstraction + filter-selectivity sections
difficulty: medium
---

# Review: filter selectivity now resolves columns by attribute identity

## What the change does

A `where` clause's estimated selectivity used to be looked up by the **name** written
in the predicate's column reference. Any column carrying that name got that name's
statistics, whether or not it was actually the base table's column. So
`select id * 7 as qty from o` — an arithmetic expression that merely happens to be
aliased `qty` — was charged `o.qty`'s distinct count, and renaming the alias changed
the planner's row estimate (and so could change the chosen plan).

The fix threads an optional **column resolver** from `rule-filter-selectivity` into
`CatalogStatsProvider`. The resolver maps a column reference's *attribute id* — the
planner's identity token for a column — back to the base-table column it actually is,
using the `collectColumnOrigins` map that already existed for routing conjuncts to
relations. When an attribute has no base-table origin, the estimate declines instead
of borrowing a same-named column's statistics.

`ProjectNode` already forwards the source attribute id for a bare column-reference
projection and mints a fresh one for a computed expression, which is exactly the
distinction wanted: a rename keeps identity, a computation does not.

## Confirmed behaviour (measured on this tree, after the change)

`o(id integer primary key, cat text /*4 distinct*/, qty integer /*7 distinct*/)`,
100 rows, `ANALYZE`d. Numbers read off the optimized plan's `FilterNode.selectivity`:

| query | before | after |
|---|---|---|
| `select * from (select cat, id * 7 as qty from o) x where x.qty = 3` | `0.142857` | `0.1` |
| `select * from (select cat, id * 7 as zz from o) x where x.zz = 3` | `0.1` | `0.1` |
| `select * from (select cat, row_number() over (order by id) as qty from o) x where x.qty = 3` | `0.142857` | `0.1` |
| `select * from (select cat as qty from o) x where x.qty = 'a'` | `0.1` | `0.25` |
| `select * from (select cat, qty from o) x where x.qty = 3` | `0.142857` | `0.142857` |
| `select * from o where qty = 3` | `0.142857` | `0.142857` |

Every row matches the fix ticket's predicted table exactly. `0.1` is the naive
BinaryOp guess — i.e. "no statistics apply", not "undefined".

Cross-relation path, with `o(… qty /*3 distinct*/, rid /*20 distinct*/)` and
`r(… qty /*5 distinct*/)`:

```sql
select * from (select id, rid as qty from o) x join r on x.id = r.id where x.qty = r.qty
--   before: 0.2   = 1/max(ndv(o.qty)=3, ndv(r.qty)=5)
--   after:  0.05  = 1/max(ndv(o.rid)=20, ndv(r.qty)=5)
```

**Only the estimate ever changed. Returned rows were always correct**, before and
after — this is a plan-choice-quality bug, not a wrong-answers bug.

## How it was built

**`planner/stats/index.ts`** — new exported type:

```ts
export type ColumnStatsResolver = (attributeId: number) => string | undefined;
```

`selectivity`, `statsOnlySelectivity` and `joinSelectivity` each gained a trailing
optional `resolve?: ColumnStatsResolver`. Optional, so `NaiveStatsProvider`, the
`createStatsProvider` factory and any external provider keep compiling untouched. The
interface doc states that a caller holding a plan tree **must** pass one.

**`planner/stats/catalog-stats.ts`** — rather than adding a seventh parameter to six
private methods, `stats` and `resolve` are bundled into a private
`EstimateContext { stats; resolve? }` threaded in place of the bare `TableStatistics`.
Both syntactic extractors take the resolver:

- `extractColumnFromPredicate` — with a resolver, the **first** `ColumnReference`
  child that fails to resolve returns `undefined` outright rather than trying the next
  child. Deliberate, and it is what makes `computed = realcol` decline. Without a
  resolver the old behaviour (skip a child with no `.name`, keep looking) is unchanged.
- `extractEquiJoinColumns` — both sides go through a shared `columnStatsName` helper.

**`planner/rules/predicate/rule-filter-selectivity.ts`** — `collectColumnOrigins` was
hoisted out of `multiRelationSelectivity` to the top of the rule so both paths get it.
`makeResolver(origins, accept)` narrows the map per call site:

| call site | `accept` | why |
|---|---|---|
| single-table path | `origin.table === tableSchema` | the strict walk proved exactly this table's rows arrive |
| single-relation conjunct | `origin.ref === ref` | **reference** identity — `from t a join t b` shares one `TableSchema`, so schema equality would merge the sides |
| cross-relation conjunct | `() => true` | both origins were already resolved and stats-checked by identity immediately above |

## Validation performed

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) — clean.
- `yarn test` (all workspaces) — **quereus 8124 passing, 13 pending, 0 failing**;
  every other package green; exit 0.

8117 → 8124 is exactly the 7 tests added. **Zero plan-snapshot churn**: no existing
test in `test/plan/`, `test/logic/108-cardinality-estimation.sqllogic`, or anywhere
else needed touching — matching the fix ticket's prediction, which is the signal that
the narrowing predicates are the intended ones.

## What to exercise when reviewing

New tests are in `test/optimizer/filter-selectivity.spec.ts`. Treat them as a floor:

- `single-table selectivity matches columns by identity, not by name` (new describe) —
  computed alias, window-function alias, plain rename, pass-through projection, bare
  base table.
- Two added to the existing `multi-relation filter selectivity` describe — the renamed
  base column on the cross-relation path, and a single-relation conjunct over one side
  of a self-join (this one pins the `origin.ref === ref` narrowing; if that predicate
  were wrong the conjunct would silently stop estimating).

Worth trying by hand: nested subqueries with several rename layers; a rename that
collides across a join (`select cat as qty from o` joined to `r.qty`); `having` over a
group key that was renamed; `in` / `between` / `is null` leaves over a renamed column
(only `=` and `>` shapes are covered by the new tests).

## Known gaps — flagged, not fixed

- **The name fallback is still reachable and nothing enforces the resolver.** All
  three production call sites pass one, so the defect is closed today, but a future
  caller that forgets silently gets the old name-matching behaviour. Making `resolve`
  required would break the direct-provider unit tests
  (`test/planner/stats/catalog-stats.spec.ts`,
  `test/optimizer/statistics-edge-cases.spec.ts`), which build mock nodes with no
  meaningful attribute ids. Deliberate per the ticket's scope decision; if the reviewer
  wants compile-time enforcement it is a separate change.
- **`indexSelectivity` does not thread a resolver** — it delegates to
  `this.selectivity(table, predicate)` with no third argument. It has no production
  caller at all right now (only its own tests), so nothing is wrong today, but if one
  appears it would land on the name path.
- **`distinctValues(table, columnName)` is still name-keyed by design** — its contract
  is a column name, not an attribute; untouched.
- **Pre-existing and untouched:** a column-vs-column comparison on ONE table
  (`where x = y`) still picks the first column reference and reports `1/ndv(x)`,
  modelling "x equals a constant". The existing `NOTE:` on
  `extractColumnFromPredicate` covers it. Identity resolution does not change this —
  it only changes *which* column's statistics get read, not that one side is ignored.
- **New tests are all end-to-end through the optimizer.** There is no direct
  provider-level test that passes a hand-built resolver to `selectivity` /
  `statsOnlySelectivity` / `joinSelectivity`, so the optional-parameter contract itself
  is only covered indirectly.
- **`crossRelationConjunct` allocates a resolver closure even for the `<` `<=` `>` `>=`
  branch, which returns a constant and never uses it.** One closure per cross-relation
  conjunct; not worth restructuring the branch order for.

## Tripwire parked in code

`NOTE:` at the `collectColumnOrigins` call in `ruleFilterSelectivity`
(`rule-filter-selectivity.ts`): the origins walk now runs for **every** Filter, not
only filters over joins, so a stack of N filters over one large subtree is
O(N·subtree). Cheap per node and filter stacks are shallow, so nothing to do now; the
note records the two escape hatches if it ever shows up in an optimizer profile (cache
the map per pass on `OptContext`, or build the single-table resolver from the one
`TableReferenceNode` the strict walk already found, which is O(columns)). The older,
narrower version of this note on `multiRelationSelectivity` was folded into it rather
than left duplicated.

## Docs updated

`docs/optimizer.md` — three edits, all in the cost-model chapter:

- the `StatsProvider` interface snippet now shows `ColumnStatsResolver` and the
  `resolve` parameters;
- a new **"Column identity, not column name"** paragraph after the
  `statsOnlySelectivity` description, plus the minted-above-base-table case added to
  that description's list of ways a predicate can be out of reach of statistics;
- the **"Which source qualifies for the single-table path"** paragraph no longer
  justifies the strict walk by name resolution (which is now false) — it gives the
  real reason: an aggregate's output rows are a different population, so no fraction of
  the base table describes them at all. Same correction was made to the
  `rule-filter-selectivity.ts` file doc-comment.
