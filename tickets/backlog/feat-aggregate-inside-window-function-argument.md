---
description: A common reporting query — a running total of per-group counts — is rejected with a confusing message about aggregates not being allowed, even though it is standard SQL that other engines accept.
files:
  - packages/quereus/src/planner/building/expression.ts            # the `windowFunction` case builds arguments with aggregates disallowed
  - packages/quereus/src/planner/building/select-projections.ts    # analyzeSelectColumns — where that build happens, before the aggregate phase
  - packages/quereus/src/planner/building/select-window.ts         # buildWindowPhase / rejectUncollectedAggregates — where the check would belong
  - packages/quereus/test/logic/07.5-window.sqllogic               # grouped + window coverage
---

# An aggregate cannot be a window function's argument

## What is not supported

Feeding an aggregate result into a window function is standard SQL and a very
common reporting shape — a running total of per-group counts:

```sql
create table wg (a text, b text);
insert into wg values ('x','1'), ('y','2'), ('x','3');

select a, count(*) as c, sum(count(*)) over () as total
from wg group by a;
-- QuereusError: Aggregate function count not allowed in this context

select a, count(*) as c,
       sum(count(*)) over (order by a rows between unbounded preceding and current row) as running
from wg group by a;
-- same
```

PostgreSQL and SQLite both accept these; the window runs over the grouped rows, so
`sum(count(*)) over ()` is the total across all groups.

## Why it fails today

The engine already supports the *sibling* shape — an aggregate inside a window
function's `OVER (…)` clause, e.g.
`row_number() over (order by count(*) desc)` — because that clause is built late,
in the window phase, after the aggregate node exists and after its computed
columns are resolvable.

A window function's **arguments** are built much earlier. `analyzeSelectColumns`
builds the whole select-list expression, and the `windowFunction` case in
`expression.ts` builds each argument once to learn its type, against the
pre-aggregate context and with aggregates explicitly disallowed. That throws
before the aggregate phase has collected anything, so no later check ever sees the
query.

A consequence worth knowing when picking this up: the `arguments` arm of
`rejectUncollectedAggregates` in `select-window.ts` — which exists to produce a
*named* limitation message for exactly this shape — is unreachable today for the
same reason, and is marked as such in a `NOTE:` at that site. It becomes live the
moment the early argument build stops rejecting aggregates.

## Expected behavior

`select a, count(*) c, sum(count(*)) over () total from wg group by a` should
return one row per group with `total` = the sum of the per-group counts (here
`x,2,3` and `y,1,3`), the same as the equivalent
`select a, c, sum(c) over () from (select a, count(*) c from wg group by a)`.

If full support is not the outcome, the minimum acceptable result is a message
that names the limitation — the way the `OVER (…)` case already does — rather than
the generic "Aggregate function count not allowed in this context", which reads
like a bug.

## Where this came from

Noticed while reviewing `bug-window-function-over-grouped-query-crashes`, which
made window functions work in grouped queries. It is a pre-existing limitation
that change did not touch, not a regression from it.
