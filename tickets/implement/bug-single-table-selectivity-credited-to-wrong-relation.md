description: When a WHERE or HAVING clause sits on top of something that reshapes its input — a recursive query, or a grouped aggregate — the planner guesses how many rows survive using statistics that describe a different set of rows, sometimes even a different column. Make it decline instead of guessing.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/util/column-origins.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts
difficulty: medium
----

## Reproduced

Both shapes confirmed against `main` (temporary spec, since removed; re-create the two
queries as permanent tests — see TODO). Table `o` has 100 rows, `cat` with 4 distinct
values, `qty` with 7 distinct values (0..6), ANALYZEd.

**Aggregate.** The estimate is decided by whether the aggregate's output alias happens to
collide with a base-table column name:

```sql
select cat, count(*) as qty from o group by cat having qty > 2   -- FilterNode.selectivity = 0.75
select cat, count(*) as ct  from o group by cat having ct  > 2   -- FilterNode.selectivity = 0.10
```

Both queries are the same query. The group counts are 91, 3, 3, 3, so `> 2` keeps **all
four** groups — the true selectivity is 1.0. The first number, 0.75, is the fraction of
`o`'s *rows* whose `o.qty > 2`: `CatalogStatsProvider` resolves a column reference by its
AST **name** (`catalog-stats.ts` `extractColumnFromPredicate`, ~line 517), so the alias
`qty` on `count(*)` reads `o.qty`'s histogram. The second, 0.10, is the naive flat guess for
a `BinaryOp` — the same shape, no collision, a completely different answer.

The plan shape is `Filter → HashAggregate → IndexScan → TableReference`, and
`extractTableSchema` walks straight through `HashAggregate` because it has exactly one
relational child.

**Recursive CTE.**

```sql
with recursive c(qty) as (
  select qty from o
  union all
  select qty + 1 from c where qty < 50)
select * from c where qty = 3          -- FilterNode.selectivity = 0.142857 = 1/7 = 1/ndv(o.qty)
```

`RecursiveCTENode.getRelations()` returns only `[baseCaseQuery]`
(`nodes/recursive-cte-node.ts:123`), so the walk descends into the seed's `Project → IndexScan
→ TableReference` and hands back `o`. The CTE emits far more rows than `o` has, drawn from a
different value distribution, and `1/ndv(o.qty)` describes neither.

Both are mis-estimates, not wrong results.

## What is *not* broken

- **A `having` predicate on a group key** is pushed below the aggregate by
  `rule-aggregate-predicate-pushdown` before selectivity runs, so it is estimated against
  the base table while genuinely sitting over the base table. Confirmed:
  `select cat, count(*) as c from o group by cat having cat = 'a'` plans as
  `HashAggregate → Filter(sel=0.25) → IndexScan`.
- **A filter inside the recursive case** (`where qty < 50` above `InternalRecursiveCTERef`)
  is already unstamped — that node reports no relations.
- **A set operation** already declines, because `getRelations()` returns two relations and
  the walk only descends when there is exactly one.

## Fix

Two callers want two different questions answered, and today they share one walk:

- *"Which table's schema does this subtree ultimately read?"* — FK→PK alignment in
  `rule-join-elimination`, `rule-fanout-lookup-join`, `rule-join-key-inference`. These want
  the permissive walk; leave them on it.
- *"Whose statistics describe the rows arriving here?"* — `rule-filter-selectivity`. This
  needs a walk that stops at any operator whose output rows are not its source's rows.

### New shared predicate

Add `packages/quereus/src/planner/util/row-population.ts`. Decide by `node.nodeType`
against the `PlanNodeType` enum rather than `instanceof` — `plan-node-type.ts` is a leaf
module, so this cannot introduce an import cycle into `key-utils.ts` (which today uses duck
typing on `nodeType` for exactly that reason).

```ts
/** Publishes one branch's attribute ids over rows drawn from several branches. */
export function isRowMerging(node: RelationalPlanNode): boolean;      // SetOperation, RecursiveCTE

/** Emits one row per group rather than one row per input row. */
export function isRowRegrouping(node: RelationalPlanNode): boolean;   // Aggregate, StreamAggregate, HashAggregate

/** Either of the above: the output rows are not the source relation's rows. */
export function changesRowPopulation(node: RelationalPlanNode): boolean;
```

`column-origins.ts` has a private `isRowMerging` with the same meaning (`instanceof
SetOperationNode || instanceof RecursiveCTENode`). Replace it with the import so the two
files cannot drift; its behaviour must not change.

### Strict walk in `key-utils.ts`

Keep `extractTableSchema` exactly as it is. Add a sibling that shares the recursion:

```ts
/**
 * The base table whose rows actually reach `node` — declines at any operator that
 * changes the row population (aggregate, recursive CTE, set operation) rather than
 * walking through it. Use this when the question is "whose statistics describe these
 * rows"; use `extractTableSchema` when the question is "which table does this subtree
 * read" (FK/key analysis).
 */
export function extractRowSourceTableSchema(node: RelationalPlanNode): TableSchema | undefined;
```

Implement both over one private recursive helper taking a `strict: boolean`. `TableReference`
and `Retrieve` still resolve directly; the single-relation descent additionally checks
`!changesRowPopulation(node)` when strict.

### Rule change

`rule-filter-selectivity.ts` calls `extractRowSourceTableSchema(filter.source)` instead of
`extractTableSchema`. Update the two comment blocks that name `extractTableSchema` (the file
header's "Two paths" list and the inline comment above the call).

### Expected outcome for the two repro queries

The single-table path declines, so control falls through to `multiRelationSelectivity`:

- **Recursive CTE** — `collectColumnOrigins` already stops at `RecursiveCTENode`, so the
  origin map is empty and the rule returns `undefined`. Filter keeps
  `DEFAULT_FILTER_SELECTIVITY` (0.5).
- **Aggregate** — the origin map does contain `o`'s group-key columns (`collectColumnOrigins`
  walks through the aggregate on purpose; see below), but the `count(*)` attribute id is not
  in it, so the conjunct is unattributable and the rule returns `undefined`. Also 0.5.

## Deliberately out of scope

- **Modelling aggregate or recursive-CTE output cardinality.** Declining is the whole fix.
- **`collectColumnOrigins` walking through an aggregate.** It forwards group-key attribute
  ids to their base-table columns, which `rule-filter-selectivity` documents as imprecise but
  intentional (the base-table fraction applied to post-aggregate cardinality). That stays.
  The disagreement the original ticket flagged — one path stopping at a recursive CTE while
  the other walked through it — is resolved by this fix; the group-key difference is a
  separate, documented modelling choice, not drift.
- **`DistinctNode`.** Its output rows are a *subset* of the base table's rows, not a
  different population, so the base-table fraction stays a defensible approximation and it is
  not in `changesRowPopulation`. Record this as a `NOTE:` tripwire in `row-population.ts`:
  *if a filter over a `distinct` ever shows a bad estimate, a heavily-skewed column is the
  reason (the row fraction and the distinct-row fraction diverge), and `Distinct` should join
  `isRowRegrouping`.*
- **`LimitOffset` / `OrdinalSlice` / physical access nodes.** Same reasoning: subsets of the
  base rows.

## Investigate, do not fix here

`rule-join-elimination.tryEliminate` and `rule-fanout-lookup-join.recognizeBranch` pass a
join side's **output** column indices to `checkFkPkAlignment` against the `TableSchema` that
`extractTableSchema` walked down to. If an aggregate or recursive CTE can sit between the
join and that table, the output indices are not that table's column indices, and a spurious
FK→PK "alignment" would eliminate a join it must not. The INNER path is partly guarded by
`isRowPreservingPathToTable`; the LEFT/RIGHT path is not. Spend a bounded amount of time
deciding whether a plan of that shape is reachable. **If it is, file a separate `fix/` ticket
— do not widen this one.** If it is not, note the conclusion in the review handoff.

## TODO

- Add `packages/quereus/src/planner/util/row-population.ts` with `isRowMerging`,
  `isRowRegrouping`, `changesRowPopulation`, and the `Distinct` tripwire `NOTE:`.
- Switch `column-origins.ts` to the shared `isRowMerging`; drop its local copy and the now
  unused `SetOperationNode` / `RecursiveCTENode` imports.
- Add `extractRowSourceTableSchema` to `key-utils.ts` over a shared private recursion; leave
  `extractTableSchema`'s behaviour untouched and document the split at both call sites.
- Point `rule-filter-selectivity.ts` at the strict variant and refresh the comments naming
  `extractTableSchema`.
- Tests in `test/optimizer/filter-selectivity.spec.ts` (new describe block, reusing the
  existing `optimizedFilter` / ANALYZE-seeded fixtures):
  - a filter over a recursive CTE is left unstamped, and specifically is not `1/ndv` of the
    seed table's column;
  - the aliased-aggregate pair — `having qty > 2` and `having ct > 2` over the same
    `count(*)` — are both unstamped, i.e. the answer no longer depends on whether the alias
    collides with a base-table column name;
  - control: a filter over `Project` / `Sort` / `Limit` / `Distinct` over a base table is
    still stamped from that table's statistics (the permissive-walk shapes must not regress);
  - control: `having` on a *group key* still reaches the base table (it is pushed below the
    aggregate) and is still stamped.
- Direct unit coverage that `extractTableSchema` still resolves through an aggregate and a
  recursive CTE while `extractRowSourceTableSchema` returns `undefined` for both.
- Run `yarn test` and `yarn lint` from the repo root. Watch `test/logic/108-cardinality-estimation.sqllogic`
  and the `test/plan/` snapshots for row-estimate churn above aggregates; any diff there is
  expected to be a filter moving to 0.5 — confirm each one before updating a snapshot.
