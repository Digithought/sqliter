---
description: A query that groups rows and asks only for a count also handed back the column it grouped on, and grouped queries could return their columns in the wrong order; both are fixed in the working tree and need verification.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts          # aggregateOutputIsSelectList + needsFinalProjection
  - packages/quereus/src/planner/building/select.ts                     # passes starProjectionsByColumn into buildAggregatePhase
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic   # new: result coverage
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts         # new: column-name/order + plan-shape coverage
  - packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic  # updated: had pinned the buggy shape
  - packages/quereus/test/incremental/delta-aggregate.spec.ts           # the routing that constrained the fix
difficulty: medium
repro: verified
---

# Grouped query returns exactly its select list

The fix from `fix/1-bug-grouped-aggregate-only-select-returns-extra-column` is
**already applied in the working tree**, with tests, and validated (see
*Validation* below). This ticket exists so the change gets an independent
verification pass before review.

## What was wrong

An `AggregateNode` advertises exactly its grouping keys (in `GROUP BY` order)
followed by its aggregate results. When the planner built no projection above it,
the aggregate node *was* the query root, so its shape became the statement's
declared result shape instead of the select list's.

`needsFinalProjection` (in `buildAggregatePhase`) decided whether to build that
projection from questions like "does any select-list expression need rebuilding?"
and "does an alias rename a column?". Nothing asked whether the aggregate's output
actually *matched* the select list. So the projection was skipped in cases where
the two disagreed.

The reported symptom was the extra column:

```sql
select count(*) as n from t group by g;   -- returned columns (g, n), not (n)
```

Reproducing that turned up the same defect in column **order**, from the same
site — the aggregate publishes keys-then-aggregates regardless of how the select
list interleaves them:

| query (table `nk(a, b)`, no primary key) | was | correct |
| --- | --- | --- |
| `select count(*) c, a from nk group by a` | `c` after `a` | `c`, `a` |
| `select b, a, count(*) c from nk group by a, b` | `a`, `b`, `c` | `b`, `a`, `c` |
| `select a, count(*) c, b from nk group by a, b` | `a`, `b`, `c` | `a`, `c`, `b` |
| `select a, b, count(*) c from nk group by b, a` | `b`, `a`, `c` | `a`, `b`, `c` |

All of it is one code site and one decision, so it is one arm.

## The constraint that shaped the fix

The obvious fix — always build the final projection for a grouped query — is
wrong. A grouped materialized-view body of the form
`select k, count(*) c, sum(a) s from src group by k` relies on staying a bare
aggregate-over-scan; adding a projection re-routes its incremental maintenance
from `residual-recompute` to `full-rebuild` and breaks
`test/incremental/delta-aggregate.spec.ts`. That body's select list happens to
*already agree* with the aggregate's output (keys in `GROUP BY` order, then
aggregates), which is exactly the property the fix keys off.

## What changed

`select-aggregates.ts` gained `aggregateOutputIsSelectList(...)`, and
`needsFinalProjection` now also fires when it answers "no". The predicate walks
`stmt.columns` in select-list order and requires:

- every non-aggregate item to claim the next `GROUP BY` key, matched by
  **attribute id** (so `select t.k … group by k` still counts as agreement);
- every aggregate item to come after all key items;
- no key and no aggregate left unclaimed at the end.

`SELECT *` items are handled through the expanded star projections, which meant
threading `starProjectionsByColumn` from `select.ts` into `buildAggregatePhase`
(it was already being passed to `buildFinalAggregateProjections`).

The pre-existing `hasGroupBy && !hasAggregates && projections.length > 0` term is
untouched — the aggregate-free grouped path keeps forcing its projection exactly
as before.

Small DRY cleanup rode along: `orderByContainsAggregates` now uses the extracted
`containsAggregateFunction` helper.

## A test had pinned the bug

The source ticket said no test asserted the wrong shape. That was wrong:
`test/logic/07.7-scalar-agg-decorrelation.sqllogic` asserted that

```sql
select p.id, (select count(*) from cc where cc.pid = p.id group by cc.pid) as n from p where p.id = 1;
```

fails with *"Scalar subquery must return exactly one column"* — an error that only
existed because the subquery leaked its grouping key as a second column. It is a
legal one-column scalar subquery and now runs. The file was updated (not deleted)
to assert the correct results, plus two cases that were previously unreachable:
an outer row matching no inner row yields `null` (no group is formed at all, so
the "count bug" 0 does not apply), and grouping on a column the correlation does
not pin still raises *"Scalar subquery returned more than one row"*.

## Validation already run

- `yarn test` — 0 failing across all workspaces (quereus: 8636 passing, 13 pending).
- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` and `run typecheck` — clean.
- `test/incremental/delta-aggregate.spec.ts` passes, including its create-time
  routing pins.

`yarn test:store` was **not** run (LevelDB-backed re-run of the logic suite; too
slow for an agent turn). This change is planner-only and storage-agnostic, so it
is unlikely to matter, but it is an honest gap.

## Notes for whoever picks this up

- The `!hasAggregates` term and `aggregateOutputIsSelectList` now overlap: for an
  aggregate-free grouped query whose select list already agrees with the group
  keys (`select g from gk group by g`), the shape check would permit dropping the
  projection but the older term forces it anyway. Collapsing the two would remove
  a plan node from those queries. Deliberately not done here — it narrows behavior
  that `test/planner/groupby-key-completeness.spec.ts` and
  `test/plan/grouped-projection-shape.spec.ts` currently depend on, and it is a
  separate change from fixing the bug.
- `containsAggregateFunction` resolves function schemas while walking each
  select-list expression. This runs once per prepare of a grouped query, on top of
  the walk `analyzeSelectColumns` already does. Not measured — flagged as a cost
  that exists, not as one that is known to matter.

## TODO

- Re-run `yarn build`, `yarn test`, `yarn workspace @quereus/quereus run lint`
  and `run typecheck` against the current tree and confirm all clean.
- Read `aggregateOutputIsSelectList` against `analyzeSelectColumns`
  (`select-projections.ts`) and confirm the projections/aggregates split it
  assumes still holds: expanded star columns first in `projections`, then
  non-aggregate select-list columns in order; `aggregates` in select-list order.
- Confirm the cases where the predicate's answer is *irrelevant* really are
  short-circuited by an earlier `needsFinalProjection` term — wrapped aggregates
  (`select count(*) + 1 … group by g`), window functions in a grouped select list,
  and `HAVING`-only / `ORDER BY`-only aggregates.
- Spot-check that a select-list item which is a scalar subquery containing an
  aggregate (`select (select count(*) from u), count(*) from t group by g`) is
  classified as a non-aggregate item and still projects correctly.
- Hand off to `review/` with the two notes above carried forward.
