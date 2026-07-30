description: A grouped query that sorts by the column it grouped on used to fail with an internal error whenever that column only appeared in the output wrapped in an expression; the planner fix is already written and passing, and this ticket adds the regression tests that lock it in.
files:
  - packages/quereus/src/planner/building/select.ts                 # branch selection + star capture (already edited)
  - packages/quereus/src/planner/building/select-aggregates.ts      # needsFinalProjection + SELECT * expansion (already edited)
  - packages/quereus/src/planner/building/select-modifiers.ts       # shouldApplyOrderByBeforeProjection — the trigger, unchanged
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic       # home for the regression cases
  - packages/quereus/test/plan/aggregates/                          # home for a plan-shape assertion
difficulty: medium

----

# `order by <group key>` in a `group by` query with no aggregate functions

## Status: fix already applied in the working tree

The planner change described below is **already written and validated** (see
*What was changed*). Full monorepo `yarn test` is green (8098 passing in
`packages/quereus`, 0 failing overall), and `yarn lint` + `yarn typecheck` for
`packages/quereus` are clean. What is **not** done is the regression-test
coverage — that is the work of this ticket. Do not re-derive the fix; verify it,
then lock it in with tests.

## The bug (for context)

```sql
create table i (v integer primary key, g text);
insert into i values (1,'a'),(2,'b'),(3,'a');

select cast(v as text) x from i group by v order by v;
-- was: QuereusError: No row context found for column v.
```

Three conditions had to combine: a `group by`, an `order by` naming a grouping
key as a **bare column**, and a select list containing **no aggregate function
at all** (so `count(*)` alongside made it work). Sorting by the output alias
instead of the key was the workaround.

## Root cause

`buildSelectStmt` decided which final-projection path to take from
`hasAggregates` — "does the select list contain an aggregate function" — not
from "did a grouping phase actually run". A `group by` with no aggregate
functions has `hasAggregates === false`, so **both** projection paths ran:

1. `buildAggregatePhase` built the `AggregateNode`, and (when
   `needsFinalProjection`) a correct `ProjectNode` whose expressions were
   rebuilt against the aggregate output scope.
2. Then, because `hasAggregates` was false, the non-aggregate branch called
   `buildFinalProjections` again — which reused the `projections` array built
   way back by `analyzeSelectColumns` against the **pre-aggregate** input. Those
   column references still carried base-table attribute ids that the
   `AggregateNode` does not output.

Observed plan for the failing query (attribute ids in brackets):

```
Project [x#12]              <- second, stale projection; its ColumnReference is attr #8
  Sort [x#11]                  ORDER BY v  (refs attr #10, the group key)
    Project [x#11]             correct aggregate projection (refs attr #10)
      StreamAggregate [v#10]
        IndexScan [v#8,g#9]    <- attr #8 lives only down here
```

The stale projection normally got away with it: at run time the base-table row
context was still on the stack while the aggregate streamed, so attribute #8
resolved to the last-read source row of the current group. Because
`validateAggregateProjections` restricts a grouped select list to group-key
expressions, every row in a group carries the same value, so the answer came out
right — by luck, and at the cost of computing every select-list expression
twice.

What broke that luck was `shouldApplyOrderByBeforeProjection` in
`select-modifiers.ts`: it fires only for a **bare column** `order by` that is not
in the projection alias list, and inserts a blocking `SortNode` *underneath* the
stale projection. The sort consumes the aggregate fully, the source row context
is gone, and `resolveAttribute` (in `src/runtime/context-helpers.ts`) throws
`No row context found for column …`. That also explains why
`order by upper(g)` and `order by lower(g)` worked while `order by g` did not:
non-column `order by` expressions never triggered the pre-projection sort.

## What was changed

Three edits, all in the planner's select builders:

- **`select.ts`** — the branch now keys off whether a grouping phase ran
  (`hasGrouping = Boolean(aggregateResult.aggregateScope)`) instead of
  `hasAggregates`, so a grouped query never re-enters `buildFinalProjections`.
- **`select-aggregates.ts`, `needsFinalProjection`** — force a final projection
  when `hasGroupBy && !hasAggregates && projections.length > 0`. Without this,
  a grouped query with no aggregates and a trivially-shaped select list would
  emit no projection at all and the output would be the raw group keys in
  `GROUP BY` order (wrong names, wrong order, e.g.
  `select v, g from i group by g, v`).
  The `!hasAggregates` guard matters: an unconditional force changed the plan
  shape of `create materialized view mv as select k, count(*) c, sum(a) s from
  src group by k` and knocked its incremental-maintenance routing from
  `residual-recompute` to `full-rebuild`, failing
  `test/incremental/delta-aggregate.spec.ts`. Keep the guard.
- **`select-aggregates.ts`, `buildFinalAggregateProjections`** — it previously
  only handled `column.type === 'column'` and silently skipped `SELECT *`. Now
  it takes the star-expanded projections (captured in `select.ts` and passed in)
  and maps each bare source column to its aggregate group-output column via a
  new `attributeId -> group index` map, so `select * from i group by g, v`
  still emits source-column order rather than `GROUP BY` order.

Resulting plan for the failing query — one projection, sort above it, matching
the shape the `count(*)` variant always had:

```
Sort           ORDER BY v ASC
  Project      SELECT cast(v AS text) AS x
    StreamAggregate  GROUP BY v
      IndexScan
```

`shouldApplyOrderByBeforeProjection` is now unreachable for grouped queries but
is still live for the non-grouped path; leave it alone.

## Expected behavior to lock in

Any expression legal in `GROUP BY` is legal in `ORDER BY` of the same query and
sorts by the grouped value, regardless of how — or whether — the select list
projects it. `asc` and `desc` behave the same.

Shapes verified by hand against the patched build (all correct):

| query | result |
|---|---|
| `select cast(v as text) x from i group by v order by v` | `1,2,3` |
| `select cast(v as text) x from i group by v order by v desc` | `3,2,1` |
| `select v+0 x from i group by v order by v` | `1,2,3` |
| `select upper(g) x from i group by g order by g` | `A,B` |
| `select cast(v as text) x from i group by v having v > 1 order by v` | `2,3` |
| `select upper(g) x from i group by g having g>'a' order by g` | `B` |
| `select distinct upper(g) from i group by g order by g` | `A,B` |
| `select upper(g) x from i group by g order by g limit 1` | `A` |
| `select v, g from i group by g, v` | source-column order preserved |
| `select * from i group by g, v` | source-column order preserved |
| `select i.* from i group by v, g` | source-column order preserved |
| `select x from (select upper(g) x from i group by g order by g) order by x desc` | `B,A` |
| `with c as (select upper(g) x from i group by g order by g) select * from c` | `A,B` |
| `select v from i where v in (select v from i group by v order by v)` | `1,2,3` |
| `select (select upper(g) from i where v=1 group by g) s` | `A` |
| `select upper(g) x from i group by g union all select 'z'` | `A,B,z` |
| `create materialized view mvg as select g from i group by g` then read it | `a,b` |

Note `select upper(g) x from t group by g collate nocase` is rejected by
`validateAggregateProjections` ("Cannot mix aggregate and non-aggregate columns
…") both before and after the fix — out of scope here, don't chase it.

## Unrelated pre-existing failure seen while investigating

`select upper(g) x from i group by 2-1 order by g` fails with "Cannot mix
aggregate and non-aggregate columns in SELECT list without GROUP BY". Confirmed
identical on a clean worktree at `HEAD` (b06d2bfb), so it predates this work:
`group by <non-literal constant expression>` is not recognised as a grouping
key. Not this ticket's scope; no test asserts it today.

## TODO

- Re-read the three edits already in the working tree and satisfy yourself they
  are correct and idiomatic; tighten comments or naming if warranted, but keep
  the `!hasAggregates` guard on the forced `needsFinalProjection`.
- Add the failing shapes to `packages/quereus/test/logic/07.3-group-by-extras.sqllogic`
  (or a new sibling `07.3.1-group-by-order-by-key.sqllogic` if that file is
  getting long): bare-column `order by` over a grouping key with an
  expression-only select list, `asc` and `desc`, `cast`/arithmetic/`upper`
  variants, the `having` + `order by` combination, `distinct`, and
  `order by <key> limit N`.
- Add coverage for the `SELECT *` / column-order path that the new star handling
  in `buildFinalAggregateProjections` introduced: `select * from i group by g, v`
  and `select v, g from i group by g, v` must emit source-column order, not
  `GROUP BY` order. This path had no test before.
- Add a plan-shape test under `packages/quereus/test/plan/aggregates/` asserting
  a grouped query with a bare-column `order by` and no aggregates produces
  exactly **one** `Project` above the aggregate, with the `Sort` above it — this
  is what actually regresses if the branch condition drifts back to
  `hasAggregates`.
- Keep `test/incremental/delta-aggregate.spec.ts` passing; it is the guard that
  caught the over-broad first attempt.
- Run `yarn test`, then `yarn workspace @quereus/quereus run lint` and
  `yarn workspace @quereus/quereus run typecheck`.
- Check whether `docs/optimizer.md` or `docs/sql.md` describe the grouped-query
  projection path; if either states the projection rule, update it to say the
  final projection for a grouped query is built once, over the aggregate output.
