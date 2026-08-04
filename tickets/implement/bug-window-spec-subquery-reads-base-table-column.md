---
description: In a query that groups rows, sorting a window function by a small nested query that refers back to the grouping column crashes with an internal error instead of returning results.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # GroupedWindowContext, buildGroupedWindowContext, redirectToGroupKeys, findUngroupedColumnRef/assertGroupByCoverage
  - packages/quereus/src/planner/building/select-window.ts        # buildWindowPhase — applies the redirect, then the coverage assert (and the NOTE at the assert site)
  - packages/quereus/src/planner/building/select.ts               # ~line 245 — the one buildGroupedWindowContext call site
  - packages/quereus/src/planner/analysis/equi-correlation.ts     # collectDefinedAttrIds — reuse, don't re-write
  - packages/quereus/test/logic/07.5-window.sqllogic              # grouped + window section, ~line 909 onward
repro: verified
difficulty: medium
---

# A grouping key named inside a subquery in a window specification dies at runtime

## What happens

```sql
create table wg (a text, b text);
insert into wg values ('x','1'), ('y','2'), ('x','3');

select a, row_number() over (order by (select max(t.b) from wg t where t.a = wg.a)) as rn
from wg group by a order by rn;
-- QuereusError: No row context found for column a. The column reference must be
-- evaluated within the context of its source relation.
```

Verified at HEAD (scratch script against `Database.eval`). Every shape below fails
the same way — a scalar subquery, an `exists (…)`, an `x in (select …)`, in
`order by`, in `partition by`, and in a window function's own arguments:

| # | query shape | at HEAD |
|---|---|---|
| 1 | `over (order by (select max(t.b) from wg t where t.a = wg.a))` | internal "No row context found for column a" |
| 4 | same but `where t.b = wg.b` (`b` is **not** a grouping key) | internal "No row context found for column b" |
| 5 | `over (order by (case when exists (select 1 from wg t where t.a = wg.a) then 1 else 0 end))` | internal error |
| 6 | `over (order by (case when wg.a in (select t.a from wg t where t.a = wg.a) then 1 else 0 end))` | internal error |
| 7 | `sum((select max(t.b) from wg t where t.a = wg.a)) over ()` (function **argument**) | internal error |
| 8 | `over (partition by (select max(t.b) from wg t where t.a = wg.a) order by a)` | internal error |

## Two corrections to the `fix/` ticket this replaces

- **The expected result was stated wrong.** For query 1 the subquery yields `max(b)`
  per group: `'3'` for `a='x'`, `'2'` for `a='y'`. Ascending, `y` sorts first, so the
  correct answer is `[{"a":"y","rn":1},{"a":"x","rn":2}]`, *not* `x` then `y`.
- **The "bare spelling already works" claim was wrong.** In
  `… where t.a = a`, the bare `a` resolves to the subquery's **own** `t.a`, not to the
  outer grouping key — the predicate is the tautology `t.a = t.a`, so every group gets
  the same global `max(b)` and the row numbers are an arbitrary tie order. It is a
  different query that happens not to crash, not a working spelling of this one.

## Root cause

Both passes the window phase relies on stop at a **relational** child:

- `redirectToGroupKeys` (select-aggregates.ts) recurses into scalar children only, so
  a correlated reference living inside a subquery is never rewritten onto the
  aggregate's output column;
- `findUngroupedColumnRef` (behind `assertGroupByCoverage`) does `if
  (isRelationalNode(child)) continue`, so the same reference is never rejected either.

The reference therefore reaches the runtime as a base-table attribute the grouped row
never carried. The rationale for stopping — "a subquery resolves its own scope" — holds
for the subquery's own columns and fails for a correlated reference out of it.

Descending naively is not enough: once inside a subquery the walk also meets the
subquery's *own* column references, which are legitimately absent from the grouped
row and must not be rewritten or rejected.

## The fix

Give the grouped-window context one more fact — **which attribute ids the
AggregateNode's input produces** — and key both walks off it. That set is exactly "the
columns this grouped query could have read before grouping", so:

- a reference to an id in the set that survived redirection is a genuinely ungrouped
  local column → reject at plan time;
- a reference to an id *not* in the set is either the subquery's own column or a
  correlated reference to an enclosing query → leave alone, at any depth.

Attribute ids are globally unique per relation instance, so the two never collide: the
subquery's `wg t` scan and the outer `wg` scan mint different ids for `a`.

### Shape

`GroupedWindowContext` (select-aggregates.ts) gains:

```ts
/** Every attribute id produced anywhere in the AggregateNode's input subtree. */
readonly aggregateInputAttrIds: ReadonlySet<number>;
```

`buildGroupedWindowContext` takes the aggregate's source relation and fills it with
the existing `collectDefinedAttrIds` from `planner/analysis/equi-correlation.ts` — do
not write a second walk. The single call site in select.ts (~line 245) already has
`aggregateResult.aggregateNode`; pass `aggregateNode.getRelations()[0]`.

`redirectToGroupKeys` walks **all** children, relational included, rebuilding through
`withChildren` (relational nodes support it; the optimizer rewrites this way
routinely). Its two match rules change asymmetrically:

- **Rule 2 (base attribute id)** applies everywhere unchanged — ids are unique, so it
  cannot mismatch.
- **Rule 1 (AST fingerprint)** must be guarded, or it corrupts queries: with `group by
  a`, a bare `a` written *inside* the subquery refers to the subquery's own table and
  has the same fingerprint `a` as the grouping key, and would be silently redirected to
  the outer group column. Guard it on "every column reference in this subtree names an
  `aggregateInputAttrIds` attribute" — i.e. the whole subtree is an outer reference.
  At the top level that guard is satisfied by construction, so nothing that works today
  changes.

The coverage assert becomes a window-phase-specific check that descends into relational
children and flags a `ColumnReferenceNode` only when its attribute id is in
`aggregateInputAttrIds` and not in `coverage.attrIds`, raising the existing
`Column '…' must appear in the GROUP BY clause or be used in an aggregate function`
message. Leave `assertGroupByCoverage` / `findUngroupedColumnRef` as they are for their
other two callers (select-list validation and HAVING) — they are checking expressions
built against a different scope and are not part of this defect.

### This also closes the adjacent gap recorded at the assert site

The `NOTE:` in `buildWindowPhase` says a window specification inside a **grouped
subquery** that correlates to an *enclosing* relation is wrongly rejected, because the
coverage set (aggregate output ids only) cannot tell an enclosing reference from an
ungrouped local one. Keying on `aggregateInputAttrIds` answers exactly that question,
so the same change fixes it. Confirmed on the prototype:

```sql
select o.a,
       (select count(*) from (select row_number() over (order by i.b, o.a) rn
                              from wg i where i.a = o.a group by i.b) z) c
from wg o group by o.a order by o.a;
-- HEAD:  Column 'o.a' must appear in the GROUP BY clause or be used in an aggregate function
-- after: [{"a":"x","c":2},{"a":"y","c":1}]
```

Delete that `NOTE:` when the change lands; do not leave it claiming a limitation that
no longer exists.

## Prototype evidence

A prototype of exactly the above was built and run at HEAD, then reverted — the working
tree is clean. Under it every failing shape above returns rows or a plan-time error, and
`yarn test` in `packages/quereus` was green: **8693 passing, 13 pending, 0 failing**.
Treat these as the acceptance results, not as speculation:

| # | query shape | after |
|---|---|---|
| 1 | correlated grouping key in a scalar subquery | `[{"a":"y","rn":1},{"a":"x","rn":2}]` |
| 4 | correlated **ungrouped** `wg.b` in a scalar subquery | plan-time `Column 'wg.b' must appear in the GROUP BY clause …` |
| 5 | `exists (…)` | `[{"a":"x","rn":1},{"a":"y","rn":2}]` |
| 6 | `in (select …)` | `[{"a":"x","rn":1},{"a":"y","rn":2}]` |
| 7 | window function argument | `[{"a":"x","s":5},{"a":"y","s":5}]` |
| 8 | `partition by` subquery | `[{"a":"x","rn":1},{"a":"y","rn":1}]` |
| 10 | subquery-local bare `a` under `group by a` (must **not** redirect) | `[{"a":"y","rn":1},{"a":"x","rn":2}]` — unchanged from HEAD |
| 13 | `over (order by wg.a)`, `group by a` (regression guard) | `[{"a":"x","rn":1},{"a":"y","rn":2}]` |
| 14 | `over (order by wg.b)`, `group by a` (regression guard) | plan-time GROUP BY message |
| 19 | `over (order by count(*) desc, a)` (regression guard) | `[{"a":"x","c":2,"rn":1},{"a":"y","c":1,"rn":2}]` |

## Out of scope — do not widen

- **Qualified whole-expression vs a grouped expression.** `group by a || '!'` with
  `over (order by wg.a || '!')` is rejected — the fingerprint carries the qualifier, so
  `wg.a || '!'` does not match `a || '!'`. It is rejected identically at top level and
  inside a subquery, both before and after the prototype, so it is a pre-existing
  fingerprint limitation and not a regression of this work. The plan-time message names
  `wg.a`, which is confusing but is not the internal error this ticket is about.
- **The select-list path.** `select a, (select max(t.b) from wg t where t.b = wg.b) x
  from wg group by a` does not error at HEAD; it binds `wg.b` to a representative row
  the way SQLite's permissive bare-column rule does. Different behaviour, no crash,
  not this defect. Leave `validateAggregateProjections` alone.
- Do not touch `groupWindowFunctionsBySpec` / `compareWindowSpecs` — their `loc`-bearing
  `JSON.stringify` keys are load-bearing (see their own NOTEs).

## Acceptance

No query shape in this area may terminate with an internal `No row context found`
error. That message means the plan-time guard was bypassed.

## TODO

- Add `aggregateInputAttrIds` to `GroupedWindowContext` and populate it in
  `buildGroupedWindowContext` via `collectDefinedAttrIds`, passing the aggregate's
  source relation from the select.ts call site.
- Make `redirectToGroupKeys` descend through relational children, keeping the
  attribute-id rule unconditional and guarding the fingerprint rule on "every column
  reference in the subtree is an aggregate-input attribute".
- Replace the window phase's `assertGroupByCoverage` calls with a check that descends
  into relational children and rejects only aggregate-input attribute ids absent from
  the coverage set; leave the shared `assertGroupByCoverage` intact for its other
  callers.
- Delete the now-stale `NOTE:` about enclosing-relation correlation at the assert site
  in `buildWindowPhase`, and refresh the `NOTE:` at the end of `redirectToGroupKeys`
  that points at this ticket.
- Extend `test/logic/07.5-window.sqllogic` (grouped + window section, ~line 909) with
  the shapes in the tables above: scalar subquery, `exists`, `in (select …)`,
  `partition by`, window-function argument, the ungrouped-column rejection, the
  subquery-local-bare-column non-redirect, and the enclosing-correlated grouped
  subquery.
- Run `yarn test` and `yarn lint` from the repo root; both must be green.
