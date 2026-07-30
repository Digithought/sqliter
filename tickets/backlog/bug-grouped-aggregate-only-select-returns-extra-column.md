description: A query that groups rows and asks only for a count (or other summary value) also hands back the column it grouped on, so callers get one more column than they asked for.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildAggregatePhase → needsFinalProjection
  - packages/quereus/src/planner/building/select.ts              # branch that decides whether a final projection is built
  - packages/quereus/test/logic/07.3.1-group-by-order-by-key.sqllogic  # sibling coverage for the no-aggregate case
difficulty: medium

----

# Grouped query whose select list is only aggregates leaks the grouping column

## Symptom

```sql
create table t (v integer primary key, g text null);
insert into t values (1,'a'),(2,null),(3,'b'),(4,null);

select count(*) as n from t group by g;
```

returns **two** columns — `g` then `n`:

```
[{"g":"a","n":1},{"g":null,"n":2},{"g":"b","n":1}]
```

SQLite (and every other engine) returns one column, `n`. The same happens for
`select sum(v) s from t group by g`, for `select count(*) from t group by g`
(unaliased), and with a `having` clause attached. A scalar aggregate with no
`group by` (`select count(*) n from t`) is correct — one column.

## Why it matters

The extra column is part of the statement's declared result shape, so it reaches
every consumer: `getColumnNames()`, row objects built by name, `select *` over a
view whose body has this form, compound-select arity checks, and anything that
positionally indexes the row. A caller asking for one summary value gets a
second, unrequested column whose value is one arbitrary group key.

## What is going on

The grouped plan for this shape has **no projection at all** — the aggregate
node is the root of the query:

```
StreamAggregate/HashAggregate   GROUP BY g  AGG count() AS n
  IndexScan t
```

An `AggregateNode` advertises exactly its grouping keys followed by its
aggregate results, so with no projection above it the grouping key is part of
the output. The planner decides whether to build that final projection in
`needsFinalProjection` (`buildAggregatePhase`, `select-aggregates.ts`), which
today answers "no" for a select list made only of aggregates, because the
aggregate node already advertises each aggregate under its select-list alias
and no expression needs rebuilding. Nothing in that check accounts for the
*extra* columns the aggregate publishes.

## Expected behavior

A grouped query returns exactly the columns in its select list, in select-list
order. Grouping keys appear in the output only when the select list names them.

## Notes for whoever picks this up

- The sibling case — a `group by` with **no** aggregate function anywhere — was
  fixed under `bug-order-by-group-key-not-in-select-list` by forcing a final
  projection. That fix is deliberately guarded with `!hasAggregates`: an earlier,
  unguarded attempt changed the plan shape of
  `create materialized view mv as select k, count(*) c, sum(a) s from src group by k`
  and knocked its incremental-maintenance routing from `residual-recompute` to
  `full-rebuild`, failing `packages/quereus/test/incremental/delta-aggregate.spec.ts`.
  Whatever fixes this case has to keep that spec passing — expect to reconcile
  the projection with how incremental maintenance recognises a maintainable
  aggregate body, not just to widen the condition.
- No test asserts the current (wrong) shape, so nothing needs unwinding first;
  the shape is simply untested today.
- Reproduced on `main` at commit 6f915362.
