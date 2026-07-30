---
description: When guessing how many rows a WHERE clause keeps, the planner matches the filtered column to table statistics by name alone, so a computed column that reuses a real column's name silently borrows that column's statistics. Match by column identity instead.
files:
  - packages/quereus/src/planner/stats/index.ts                              # StatsProvider interface — add the resolver parameter here
  - packages/quereus/src/planner/stats/catalog-stats.ts                      # extractColumnFromPredicate / extractEquiJoinColumns — the name-based lookups
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # the only production caller; builds the resolver
  - packages/quereus/src/planner/util/column-origins.ts                      # collectColumnOrigins — the identity map to reuse (no change needed)
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # where the regression tests belong
difficulty: medium
---

# Resolve a filtered column by attribute identity, not by name

## Confirmed repro

Table `o(id integer primary key, cat text, qty integer)`, 100 rows, `qty` holding
7 distinct values, `cat` holding 4, `ANALYZE`d. Selectivity read off the optimized
plan's `FilterNode.selectivity`:

| query | today | should be |
|---|---|---|
| `select * from (select cat, id * 7 as qty from o) x where x.qty = 3` | `0.142857` (= 1/ndv(o.qty)) | `0.1` (no statistics → naive default) |
| `select * from (select cat, id * 7 as zz from o) x where x.zz = 3` | `0.1` | `0.1` (unchanged) |
| `select * from (select cat, row_number() over (order by id) as qty from o) x where x.qty = 3` | `0.142857` | `0.1` |
| `select * from (select cat as qty from o) x where x.qty = 'a'` | `0.1` | `0.25` (= 1/ndv(o.cat), recovered) |
| `select * from (select cat, qty from o) x where x.qty = 3` | `0.142857` | `0.142857` (unchanged) |
| `select * from o where qty = 3` | `0.142857` | `0.142857` (unchanged) |

The cross-relation path is affected too. With `o(… qty integer /*3 distinct*/,
rid integer /*20 distinct*/)` and `r(… qty integer /*5 distinct*/)`:

```sql
select * from (select id, rid as qty from o) x join r on x.id = r.id where x.qty = r.qty
--   today: 0.2   = 1/max(ndv(o.qty)=3, ndv(r.qty)=5)   ← looked up by the alias name `qty`
--   right: 0.05  = 1/max(ndv(o.rid)=20, ndv(r.qty)=5)  ← the column the alias actually is
```

Only the *estimate* is wrong in every case; returned rows are always correct. The
visible symptom is that renaming a column alias changes the planner's row estimate,
and so can change which plan is chosen.

## Root cause

`CatalogStatsProvider` identifies the filtered column off the predicate's syntax:

- `extractColumnFromPredicate` reads `ColumnReferenceNode.expression.name` and looks
  it up in `TableStatistics.columnStats` (keyed by lowercase base-column name).
- `extractEquiJoinColumns` does the same for both sides of a cross-relation equality.

Nothing checks that the column bearing that name *is* the base table's column.

`collectColumnOrigins` (`planner/util/column-origins.ts`) already builds the correct
map — attribute id → `{ref, table, columnIndex, columnName}` — for every base-table
column reachable under a relational subtree, and already stops at row-merging
operators (set operations, recursive CTEs, the async gather). `rule-filter-selectivity`
already uses it on its multi-relation path to pick the *relation*; it just never
reaches the *column* lookup inside the provider.

Note `ProjectNode` preserves the source attribute id for a bare column-reference
projection (`project-node.ts` ~line 188) and mints a fresh id for a computed one.
That is exactly the distinction wanted: a rename keeps identity, a computation does
not.

## Design (prototyped — see "Validation" below)

Thread an optional **column resolver** from the rule into the provider.

```ts
// planner/stats/index.ts
/**
 * Resolves the attribute id of a column reference appearing in a predicate to the
 * name of the base-table column whose statistics describe it.
 */
export type ColumnStatsResolver = (attributeId: number) => string | undefined;
```

Interface additions (all optional trailing parameters, so `NaiveStatsProvider` and
any external provider keep compiling unchanged):

```ts
selectivity(table, predicate, resolve?: ColumnStatsResolver): number | undefined;
statsOnlySelectivity?(table, predicate, resolve?: ColumnStatsResolver): number | undefined;
joinSelectivity?(leftTable, rightTable, joinCondition, resolve?: ColumnStatsResolver): number | undefined;
```

`CatalogStatsProvider` threads `resolve` down through `estimate` → `estimateNode` →
`estimateConjunction` / `estimateDisjunction` / `leafEstimate` → `estimateLeaf` →
`extractColumnFromPredicate`, and into `extractEquiJoinColumns` from
`joinSelectivity`.

```ts
// extractColumnFromPredicate, inside the ColumnReference branch:
if (resolve) {
    // Identity path: an attribute minted above the base table resolves to nothing
    // and the estimate declines rather than borrowing whichever base column happens
    // to share its AST name.
    const resolved = resolve(col.attributeId);
    return resolved === undefined ? undefined : { columnName: resolved };
}
const name = col.expression.name;      // no-plan-context path, unchanged
if (name) return { columnName: name };
```

Same shape in `extractEquiJoinColumns` for each side.

`rule-filter-selectivity` builds the map once per fire and hands down a resolver
narrowed to the right origin:

```ts
const origins = collectColumnOrigins(filter.source);
const sel = tableSchema
    ? singleTableSelectivity(tableSchema, filter, origins, context)
    : multiRelationSelectivity(filter, origins, context);

function makeResolver(
    origins: ReadonlyMap<number, ColumnOrigin>,
    accept: (origin: ColumnOrigin) => boolean,
): ColumnStatsResolver {
    return (attributeId) => {
        const origin = origins.get(attributeId);
        return origin && accept(origin) ? origin.columnName : undefined;
    };
}
```

Narrowing per call site:

- **single-table path** — `accept = origin => origin.table === tableSchema`.
- **`singleRelationConjunct`** — `accept = origin => origin.ref === ref`. Reference
  identity, not schema: `from t a join t b` gives two `TableReferenceNode`s sharing
  one `TableSchema`, so schema equality would not separate the sides. (`estimateConjunct`
  has already established the conjunct touches exactly this one reference.)
- **`crossRelationConjunct` / `equiJoinSelectivity`** — `accept = () => true`; both
  origins were already resolved and stats-checked by identity right above.

### Why the resolver stays optional

The only production callers of the selectivity family are the three sites in
`rule-filter-selectivity`, and all three pass a resolver, so the defect is fully
closed. The name path survives for callers with no plan context — the direct-provider
unit tests in `test/planner/stats/catalog-stats.spec.ts` and
`test/optimizer/statistics-edge-cases.spec.ts` build mock nodes with no meaningful
attribute ids. Document the parameter as "callers holding a plan tree must pass it";
do not silently leave a second production path on names.

### Behaviour change inside `extractColumnFromPredicate`

Today the loop returns the *first* `ColumnReference` child whose `.name` is set,
skipping ones without a name. With a resolver, the first `ColumnReference` child that
does not resolve returns `undefined` outright rather than trying the next child —
"the compared column has no statistics" is the answer, not a reason to look at the
other operand. Keep that; it is what makes `computed = realcol` decline.

## Validation already performed

The design above was prototyped on this tree and then reverted (no code landed):

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — **8117 passing, 13 pending, 0 failing.**

So the plan-snapshot churn the fix ticket anticipated did **not** materialise: no
existing test in `test/plan/`, `test/logic/108-cardinality-estimation.sqllogic`, or
anywhere else asserts a selectivity that this changes. Every table in the repro above
moved as predicted. If your implementation produces churn, that is a signal the
narrowing predicates differ from the ones described — re-check `accept` before
updating a snapshot.

## Scope decision (was open in the fix ticket)

`select cat as qty from o` — a straight rename of a real column — **should** recover
`o.cat`'s statistics, and does so for free under identity resolution (`0.1 → 0.25` in
the table above). No extra work; just do not filter renames out.

## TODO

- Add `ColumnStatsResolver` to `planner/stats/index.ts` and the optional `resolve`
  parameter to `selectivity`, `statsOnlySelectivity` and `joinSelectivity`. Document
  on the interface that a caller holding a plan tree must pass one, and that omitting
  it falls back to AST names for callers that have no plan context.
- Thread `resolve` through `CatalogStatsProvider`'s private estimate chain. Six
  private methods gain a trailing optional parameter; if the arity growth reads badly,
  fold `stats` and `resolve` into one private `EstimateContext { stats; resolve? }`
  threaded in their place — same behaviour, flatter signatures. Either is acceptable.
- Use the resolver in `extractColumnFromPredicate` and `extractEquiJoinColumns`.
- In `rule-filter-selectivity`, hoist `collectColumnOrigins(filter.source)` to the top
  of `ruleFilterSelectivity`, pass it into both paths, and add `makeResolver` with the
  three narrowing predicates above.
- Update the rule's file doc-comment: the paragraph beginning "The strict walk matters
  because the provider resolves a column reference by its AST **name**" is no longer
  true. The strict walk still matters — an aggregate's output rows are a different
  population, so no base-table fraction describes them at all — but state that reason
  rather than the name-resolution one.
- Update `CatalogStatsProvider.statsOnlySelectivity`'s doc-comment, which lists the
  ways a predicate can be out of reach of the statistics, to include "its column was
  minted above the base table".
- Add a `NOTE:` tripwire at the `collectColumnOrigins` call in
  `ruleFilterSelectivity`: the walk now runs for *every* Filter, not only filters over
  joins, so a stack of N filters over one large subtree is O(N·subtree). If this shows
  up in optimizer profiles, either cache the map per pass on `OptContext` or, for the
  single-table path only, build the resolver from the single `TableReferenceNode` the
  strict walk already found (O(columns) instead of O(subtree)). The existing O(N·subtree)
  note on `multiRelationSelectivity` should be folded into this one rather than left
  in two places.

### Tests (`test/optimizer/filter-selectivity.spec.ts`)

Add a describe block over the existing analyzed `o` table covering:

- a computed projection aliased to a real column's name (`id * 7 as qty`) is NOT
  charged `o.qty`'s statistics — assert the estimate equals the one the same query
  with an unused alias (`as zz`) produces, i.e. renaming the alias no longer changes
  the answer. Asserting the *equality of the two* is the durable form; asserting the
  literal `0.1` pins the naive constant.
- a window function's output aliased to `qty` (`row_number() over (order by id) as qty`)
  likewise declines.
- a bare rename of a real column (`cat as qty`) recovers `1/ndv(o.cat)` — the
  positive half of the fix.
- a pass-through projection (`select cat, qty from o`) still gets `1/ndv(o.qty)` —
  guards against over-declining.
- in the multi-relation describe block: a cross-relation equality where one side is a
  renamed base column (`select id, rid as qty from o` joined to `r`, filtered on
  `x.qty = r.qty`) gets `1/max(ndv(o.rid), ndv(r.qty))`, not `1/max(ndv(o.qty), ndv(r.qty))`.
- a self-join case pinning the `origin.ref === ref` narrowing: a conjunct over one
  side of `from o a join o b` must still estimate, proving the reference-identity
  predicate does not reject legitimate columns.
