---
description: In a query that groups rows, sorting a window function by a small nested query that refers back to the grouping column crashes with an internal error instead of returning results.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # redirectToGroupKeys / findUngroupedColumnRef — both stop at a relational child
  - packages/quereus/src/planner/building/select-window.ts       # buildWindowPhase — applies the redirect, then the coverage assert
  - packages/quereus/test/logic/07.5-window.sqllogic             # grouped + window section, ~line 909 onward
repro: verified
---

# A grouping key named inside a subquery in a window specification still dies at runtime

## What happens

```sql
create table wg (a text, b text);
insert into wg values ('x','1'), ('y','2'), ('x','3');

select a, row_number() over (order by (select max(t.b) from wg t where t.a = wg.a)) as rn
from wg group by a order by rn;
-- QuereusError: No row context found for column a. The column reference must be
-- evaluated within the context of its source relation.
```

The same query without `group by a` works. So does the same query when the
correlated reference is written bare (`where t.a = a`) instead of qualified
(`where t.a = wg.a`), because the bare spelling resolves through the aggregate
output scope rather than falling through to the base table.

Verified by hand at the current HEAD (a scratch script against `Database.eval`).

## Why

A grouped, windowed query's window specification runs over the aggregate's rows,
which carry only the grouping keys and the aggregate results. Two passes in the
window phase exist to keep that honest:

- `redirectToGroupKeys` rewrites any subtree that *is* a grouping key onto the
  aggregate's own output column, so legal spellings work;
- `assertGroupByCoverage` then rejects anything still naming a base-table column,
  so illegal ones fail at plan time with a clear message.

Both walks stop at a **relational** child (`findUngroupedColumnRef` skips relational
children explicitly; `redirectToGroupKeys` recurses into scalar children only), on
the reasoning that a subquery resolves its own scope. That is true for the
subquery's *own* columns but not for a **correlated** reference out of it: `wg.a`
above is a reference to the outer, grouped relation, and it is neither redirected
nor rejected. It reaches the runtime as a base-table attribute the grouped row
never had, which is the exact internal error the sibling ticket
`bug-window-spec-reads-base-table-column` removed for the non-subquery spellings.

Same shape is expected to reach the same place through `exists (…)` and
`x in (select …)` inside a window specification; only the scalar-subquery form
above was run.

## Expected behavior

- The query above returns `[{"a":"x","rn":1},{"a":"y","rn":2}]` — the correlated
  reference to the grouping key resolves to the aggregate's group output column,
  exactly as `order by wg.a` already does.
- A correlated reference to a genuinely **ungrouped** column in the same position
  (`where t.b = wg.b` with `group by a`) is rejected at plan time with the standard
  `Column 'wg.b' must appear in the GROUP BY clause or be used in an aggregate
  function` message — not with an internal row-context error.
- The same for a window function's *arguments*, not only its `partition by` /
  `order by`.
- Whatever the outcome, no query shape in this area may terminate with an internal
  "No row context found" error; that message means the plan-time guard was
  bypassed.

## Note on the correlated-outer case

There is a second, adjacent gap recorded as a `NOTE:` at the assert site in
`buildWindowPhase`: a window specification inside a *grouped subquery* that
correlates to an **enclosing** relation is also rejected, because the coverage set
admits only the aggregate's own output attribute ids and cannot distinguish an
enclosing-relation reference from an ungrouped local one. That predates this
ticket and is a different direction of the same weakness (this ticket is about a
reference that escapes *downward* into a subquery; that one is about a reference
reaching *upward* out of one). Whoever touches the coverage set should decide
whether to solve both at once.
