---
description: In a query that groups rows, sorting or partitioning a window function by a grouping key written in certain ways — qualified with the table name, or built from an expression — crashes with an internal error instead of returning results.
files:
  - packages/quereus/src/planner/building/select-window.ts       # buildWindowPhase — builds the window spec / argument expressions
  - packages/quereus/src/planner/building/select.ts              # buildSelectStmt — assembles the coverage object handed to the window phase
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildGroupByCoverage; createAggregateOutputScope; buildFinalAggregateProjections' group-key redirect
  - packages/quereus/test/logic/07.5-window.sqllogic             # grouped + window coverage lives here
repro: verified
---

# A window specification in a grouped query can resolve to a base-table column the window cannot read

## What happens

These are legal SQL and each dies with an internal runtime error:

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

-- (1) grouping key named with its table qualifier inside the OVER clause
select a, row_number() over (order by wg.a) as rn from wg group by a;
-- QuereusError: No row context found for column a. The column reference must be
--   evaluated within the context of its source relation.

-- (2) same, through a table alias
select a, row_number() over (order by w.a) as rn from wg w group by a;
-- same error

-- (3) grouping key that is an expression rather than a bare column
select a || '!' as k, row_number() over (order by a || '!') as rn
from wg group by a || '!';
-- same error

select a || '!' as k, count(*) over (partition by a || '!') as c
from wg group by a || '!';
-- same error
```

Verified by running them against the current HEAD in a scratch mocha spec.

The equivalent shapes **without** a window function all work
(`select a, wg.a from wg group by a`, `select (a || '!') || 'x' from wg group by a || '!'`),
and so does the bare-name form of the same window query
(`select a, row_number() over (order by a) …`), which is what the existing tests cover.

## Why

The plan for a grouped, windowed query is

```
  Aggregate  →  [HAVING Filter]  →  Window  →  Project(select list)
```

A `ProjectNode` sitting directly on the aggregate can still read the *source*
columns of the group's representative row — the aggregate's runtime row context
carries them, which is what makes `select a, wg.a from wg group by a` work. The
`WindowNode` cannot: it evaluates its partition / order-by / argument expressions
over the aggregate's own output row, which carries only the grouping keys and the
aggregate results. Any expression that resolves to a base-table attribute id
therefore has nothing to read at runtime.

Three things must line up for a reference inside an `OVER (…)` clause to survive,
and today only the bare-name-over-a-bare-key case does:

- `createAggregateOutputScope` registers a *qualified* name (`wg.a`) only when the
  GROUP BY key was itself written qualified. `group by a` + `over (order by wg.a)`
  therefore falls through to the pre-aggregate select scope and lands on the base
  attribute. (`group by wg.a` + either spelling works — that pair is now asserted
  in `07.5-window.sqllogic`.)
- A non-bare grouping key (`group by a || '!'`) is registered only under a
  synthetic `group_N` name, so a select-list or window-spec occurrence of the same
  expression has to be recognised by matching the whole expression.
  `buildFinalAggregateProjections` does exactly that for the select list (its
  `groupByFingerprints` map redirects a matching subtree to the aggregate's group
  output column); the window phase has no equivalent, so it rebuilds the
  expression over base columns.
- The plan-time guard added for this shape, `assertGroupByCoverage`, accepts both
  of the above: `buildGroupByCoverage` deliberately admits the *base* attribute id
  of every column grouping key (the select-list check needs that, because the
  select list is built against the pre-aggregate scope), and it accepts any
  subtree whose canonical text matches a GROUP BY expression. Both are exactly the
  cases that then fail at runtime.

So the guard is right for its original caller and wrong for the window phase, and
the window phase is missing the group-key redirect the select-list builder has.

## Expected behavior

Every one of the queries above should return the same rows as its bare-name
equivalent — the window runs over the grouped rows and orders/partitions them by
the grouping key:

| query | expected |
|---|---|
| `select a, row_number() over (order by wg.a) rn from wg group by a` | `x,1` / `y,2` |
| `select a, row_number() over (order by w.a) rn from wg w group by a` | `x,1` / `y,2` |
| `select a \|\| '!' k, row_number() over (order by a \|\| '!') rn from wg group by a \|\| '!'` | `x!,1` / `y!,2` |
| `select a \|\| '!' k, count(*) over (partition by a \|\| '!') c from wg group by a \|\| '!'` | `x!,1` / `y!,1` |

A reference that is genuinely not covered by the GROUP BY must keep failing at
plan time with the existing message
(`Column 'b' must appear in the GROUP BY clause or be used in an aggregate function`) —
that behavior is already asserted and must not regress.

Whatever the fix, no reference reaching a `WindowNode` over an aggregate should be
able to survive planning while pointing at an attribute the aggregate does not
publish. A cheap backstop worth considering alongside the real fix: after building
the window specification expressions for a grouped query, assert that every column
reference in them names an attribute the aggregate node actually outputs. Note that
a legitimately *correlated* reference to an enclosing query would also fail such a
check, so it needs to distinguish those.

## Scope note

Discovered during review of `bug-window-function-over-grouped-query-crashes`,
which made grouped + window queries work for the first time; these are the shapes
it did not reach, not a regression from it (before that change every grouped +
window query failed with `No emitter registered for WindowFunctionCall`).
