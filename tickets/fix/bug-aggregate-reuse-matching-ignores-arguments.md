---
description: When a query summarizes data two different ways and then sorts or filters by one of those summaries, the engine can silently use the wrong one and return wrong numbers, with no error.
files:
  - packages/quereus/src/planner/building/function-call.ts        # findMatchingAggregate — the loose comparison
  - packages/quereus/src/planner/building/select-aggregates.ts    # buildHavingFilter / collectOrderByAggregates — consumers
  - packages/quereus/src/planner/building/select-window.ts        # rejectUncollectedAggregates — third consumer
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # nearest existing HAVING / grouped coverage
repro: verified
---

# An aggregate written in HAVING / ORDER BY / a window specification can bind to a *different* aggregate

## What happens

A clause that runs above the aggregation step — `HAVING`, a top-level `ORDER BY`,
or a window function's `OVER (…)` clause in a grouped query — may spell out an
aggregate the SELECT list already computes. That spelling is supposed to mean
"read the already-computed column" rather than "aggregate again", and
`findMatchingAggregate` decides whether two spellings are the same aggregate.

It compares the function name, the argument count and the `DISTINCT` flag exactly,
and then compares the arguments — but only when both are bare column references or
both are literals. **Any other argument shape is treated as matching**, so two
aggregates over different expressions are considered the same:

```sql
create table wg (a text, b text);
insert into wg values ('x','1'), ('y','2'), ('x','3');

select a, sum(b+0) as s from wg group by a order by sum(a+0);
-- returns rows ordered by sum(b+0): [{"a":"y","s":2},{"a":"x","s":4}]
-- `sum(a+0)` is 0 for every group (the values are non-numeric text), so a
-- correct engine leaves the groups in their original order.

select a, sum(b+0) as s from wg group by a having sum(a+0) > 3;
-- returns [{"a":"x","s":4}] — the predicate was evaluated as sum(b+0) > 3.
-- sum(a+0) is 0 for every group, so no row should come back.

select a, sum(b+0) as s, row_number() over (order by sum(a+0)) as rn
from wg group by a;
-- same substitution inside the window specification
```

Verified by running these against the current HEAD in a scratch mocha spec.

There is no error and no warning — the answer is simply wrong.

## Why it matters now

The looseness is long-standing (it predates the window work; the HAVING and
ORDER BY cases above are the original ones). The reason to fix it rather than
keep noting it: `findMatchingAggregate` was extracted from `buildFunctionCall`
during `bug-window-function-over-grouped-query-crashes` and now has a third
consumer, `rejectUncollectedAggregates`, which uses it to decide whether an
aggregate inside an `OVER (…)` clause is legal at all. So the same looseness now
also lets an *unsupported* construct through the gate that was added to reject it
with a clear message.

## Expected behavior

Two aggregate spellings should be treated as the same computed column only when
their arguments are genuinely the same expression. The canonical-AST fingerprint
the planner already uses elsewhere (`expressionToString`, used by
`buildGroupByCoverage` and by `collectInnerAggregates`' dedup key) is the obvious
comparison to reuse — it is what makes `group by id+1` recognise a select-list
`id+1`.

Cases that must keep working after the change:

- `select a, count(*) c from wg group by a having count(*) > 1` — same aggregate,
  still reads the computed column.
- `select a, count(*) c, row_number() over (order by count(*) desc) rn from wg group by a`
  — asserted in `07.5-window.sqllogic`.
- `select a, count(distinct b) from wg group by a having count(distinct b) > 1` —
  `DISTINCT` participates.

Cases that must change:

- The three queries at the top must stop substituting. Whether an *unmatched*
  aggregate in `HAVING` / `ORDER BY` gets collected into the aggregate node (so it
  is computed for real) or is rejected is the decision this ticket has to make;
  `collectHavingAggregates` / `collectOrderByAggregates` in `select-aggregates.ts`
  already collect new aggregates for exactly those two clauses, so the collect
  path likely already covers them once the false match stops shadowing it. In the
  window-specification case the existing named limitation
  (`Aggregate function … is only supported when the same aggregate also appears in
  the SELECT list`) is the correct outcome.
