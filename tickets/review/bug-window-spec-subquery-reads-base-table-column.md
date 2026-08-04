---
description: Fixed a crash where sorting a window function by a small nested query that referred back to the grouping column died with an internal error instead of returning rows.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # GroupedWindowContext, buildGroupedWindowContext, redirectNode/readsOnlyAggregateInput, assertGroupedWindowCoverage
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowPhase — now calls assertGroupedWindowCoverage
  - packages/quereus/src/planner/building/select.ts               # ~line 247 — the buildGroupedWindowContext call site
  - packages/quereus/test/logic/07.5-window.sqllogic              # ~line 986 onward — 10 new cases
  - docs/window-functions.md                                      # § Grouped queries rewritten
repro: verified
---

# Grouping key named inside a subquery in a window specification

## What was wrong

```sql
select a, row_number() over (order by (select max(t.b) from wg t where t.a = wg.a)) as rn
from wg group by a order by rn;
-- was: QuereusError: No row context found for column a.
-- now: [{"a":"y","rn":1},{"a":"x","rn":2}]
```

Both passes the window phase of a grouped query runs stopped at a relational child, so
a correlated reference living inside a subquery in a window specification was neither
redirected onto the aggregate's output column nor rejected at plan time. It reached the
runtime as a base-table attribute the grouped row never carried.

## What changed

`GroupedWindowContext` gained `aggregateInputAttrIds` — every attribute id produced
anywhere in the AggregateNode's *input* subtree, collected with the existing
`collectDefinedAttrIds` (`planner/analysis/equi-correlation.ts`). That set is exactly
"the columns this query could read before it grouped", and because attribute ids are
minted per relation instance it separates three kinds of reference that can appear
inside a window specification: this query's own pre-grouping columns, a nested
subquery's own columns, and correlated references out to an enclosing query.

Both passes now descend through relational children and key off that set:

- `redirectToGroupKeys` (now `redirectNode` internally, `PlanNode → PlanNode`, rebuilding
  through `withChildren`). The base-attribute-id rule is unconditional at any depth; the
  AST-fingerprint rule is guarded on `readsOnlyAggregateInput` — every column reference
  in the subtree must be a pre-grouping column of this query.
- `assertGroupByCoverage` at the window site was replaced by a new
  `assertGroupedWindowCoverage`, which flags a `ColumnReferenceNode` only when its
  attribute id is in `aggregateInputAttrIds` and not in the aggregate's output ids. Same
  error message. `assertGroupByCoverage` / `findUngroupedColumnRef` were left untouched
  for their other two callers (select-list validation, HAVING).

`GroupedWindowContext.coverage: GroupByCoverage` became `outputAttrIds: ReadonlySet<number>`
— the old field's `fingerprints` half was always empty and nothing read it.

The two stale `NOTE:`s named in the ticket are gone (the one at the assert site claiming
enclosing-relation correlation is rejected, and the one at the end of `redirectToGroupKeys`
pointing at this bug). `docs/window-functions.md` § "Grouped queries" was rewritten to
describe the descending passes.

## Use cases to exercise

All ten are now in `test/logic/07.5-window.sqllogic` (search `bug-window-spec-subquery-`),
over `create table wg (a text, b text); insert into wg values ('x','1'),('y','2'),('x','3');`

| shape | expected |
|---|---|
| `over (order by (select max(t.b) from wg t where t.a = wg.a))` | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| `exists (…)` correlated on the grouping key | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| `wg.a in (select … where t.a = wg.a and t.b > '2')` | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| correlated subquery as a window function ARGUMENT | `[{"a":"x","s":5},{"a":"y","s":5}]` |
| correlated subquery in `partition by` | `[{"a":"x","c":1},{"a":"y","c":1}]` |
| subquery-local BARE `a` under `group by a` (must NOT redirect) | `[{"a":"x","c":2},{"a":"y","c":2}]` |
| correlated `wg.b` (not a grouping key) in a subquery | plan-time `Column 'wg.b' must appear in the GROUP BY clause …` |
| `where t.a = wg.b` — ungrouped only on one side | same plan-time message |
| UNCORRELATED subquery in the spec | `[{"a":"x","rn":1},{"a":"y","rn":2}]` |
| grouped subquery whose window spec correlates to the ENCLOSING query | `[{"a":"x","c":2},{"a":"y","c":1}]` |

Two of these are the load-bearing negative controls and deserve the reviewer's attention
first, because they are what separates a correct fix from one that silently changes query
meaning:

- **subquery-local bare `a`.** Written as `partition by (select max(t.b) from wg t where
  t.a = a)`, the bare `a` names the subquery's own `t.a`, so the predicate is the
  tautology `t.a = t.a` and every group sees the same global `max(b)` — ONE partition
  holding two grouped rows, hence `c = 2, 2`. If the fingerprint guard were dropped, this
  would redirect to the outer group column and give `c = 1, 1`. The assertion is written
  as a `count(*) over (partition by …)` precisely so the two outcomes differ; a
  `row_number()` spelling would have produced an arbitrary tie order that hides the bug.
- **enclosing-correlated grouped subquery.** This was rejected at HEAD with `Column 'o.a'
  must appear in the GROUP BY clause…`; it now returns rows. That is the adjacent gap the
  ticket predicted the same change would close, and it is confirmed.

## Validation run

- `yarn test` (repo root, memory vtab): **8693 passing, 13 pending, 0 failing** in
  `packages/quereus`, and every other workspace green. No pre-existing failures observed.
- `yarn lint` (repo root) clean; `yarn typecheck` clean.
- New assertions confirmed to actually execute: one expectation was temporarily corrupted,
  the file failed, and it was restored.
- Working tree contains only the five files listed above.

## Known gaps — treat the tests as a floor

- **The `partition by` / arithmetic-tie shapes are asserted on small data.** `wg` has three
  rows in two groups. Nothing here exercises a correlated window-spec subquery over a
  multi-table FROM, over a join, or with more than one grouping key. Those paths are
  believed fine (the fix is keyed on attribute ids, which are per relation instance) but
  are unasserted.
- **The rule-1 fingerprint residue is not closed.** The guard rules out mis-redirecting a
  subquery's own column. What remains is a subtree of *enclosing*-query references that
  happens to fingerprint identically to a grouping key — the pre-existing text-matching
  limitation `GroupKeyIndex` already carries for the select list. Recorded as a `NOTE:` on
  `redirectToGroupKeys`; not filed as a ticket because it is the same root cause as the
  select list's, and fixing it means switching both callers to resolved-attribute identity.
- **No plan-shape test.** The redirect now rebuilds relational subtrees through
  `withChildren`. `ProjectNode` and `AggregateNode` preserve attribute ids across that
  (verified by reading their implementations), and the whole suite is green, but nothing
  asserts the rebuilt subquery plan's shape directly. A reviewer wanting more confidence
  could add a `test/plan/` case.
- **Interaction with the optimizer's own subquery rules is untested in isolation.** The
  decorrelation rules (`rule-subquery-decorrelation`, `rule-scalar-agg-decorrelation`) now
  see a subquery predicate containing a reference to an AggregateNode *output* attribute.
  The full suite passes, including the optimizer specs, but no test was written that pins
  a decorrelated plan for one of the new shapes.
- **Build-time cost was not measured.** The walk now renders an identity fingerprint at
  every scalar node inside window-specification subqueries, and each fingerprint hit walks
  that subtree again for the guard. Parked as a `NOTE:` tripwire on `redirectNode` with the
  two ways out (memoize the fingerprint, or bail on subtrees with no aggregate-input
  reference). Nothing suggests it matters at current expression sizes.

## Correction to the source ticket

The ticket's result table listed shape 10 (subquery-local bare `a`) as
`[{"a":"y","rn":1},{"a":"x","rn":2}]` "unchanged from HEAD". At HEAD that query actually
returns `[{"a":"x","rn":1},{"a":"y","rn":2}]` — as the ticket itself notes elsewhere, that
spelling makes every group share one `max(b)`, so the row numbers are an arbitrary tie
order and the recorded value was not reproducible. The sqllogic case was rewritten as the
`count(*) over (partition by …)` form described above, which is deterministic *and*
diagnostic.
