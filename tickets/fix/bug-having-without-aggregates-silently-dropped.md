---
description: A query that filters with `having` but does no counting or grouping has its filter ignored completely — every row comes back, as if the clause had not been written.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildAggregatePhase, ~line 93-107 — the early return and the unreachable branch behind it
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # where the HAVING coverage cases live today
---

# `having` with no aggregate and no `group by` is dropped from the plan

## What happens

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

select a from wg having a = 'x';
-- returns [{"a":"x"},{"a":"x"},{"a":"y"}]  — all three rows, unfiltered
select a from wg having b = '1';
-- returns all three rows as well
```

The predicate is parsed, then never reaches the plan. No error is raised and no
warning is logged; the query just answers as though the clause were absent. Verified
by running the statements above against the current build.

The clause works normally as soon as the query has an aggregate or a `group by` —
`select count(*) from wg having count(*) > 5` filters correctly. Only the shape with
**neither** is affected.

## Where it comes from

`buildAggregatePhase` computes a flag for this shape and then returns before the flag
can ever be read:

```ts
const shouldPushHavingBelowAggregate = Boolean(stmt.having && !hasAggregates && !hasGroupBy);

if (!hasAggregates && !hasGroupBy) {
    return { output: input, needsFinalProjection: false, preAggregateSort: false };
}
```

The flag's condition is the early return's condition plus `stmt.having`, so the branch
it guards further down (which builds the predicate as an ordinary pre-aggregate filter)
is unreachable. `select-aggregates.ts` is the only builder that reads `stmt.having`, so
nothing else picks the clause up. This has been the shape of the function since the
select builder was split into multiple files, so the drop is long-standing rather than
newly introduced.

## What the answer should be

This needs deciding before the fix, and the two candidates disagree:

- **SQLite's rule**: a `having` with no `group by` makes the query an aggregate query
  over one implicit group, so it returns at most one row. Under that reading
  `select a from wg having a = 'x'` is either one row or a coverage error, since `a` is
  not carried by an aggregated row.
- **The dead branch's own intent**, per the comment above it: treat the predicate as an
  ordinary filter evaluated *before* aggregation, i.e. `where`-like, returning the two
  `'x'` rows.

Either is defensible; returning all three rows is not. Pick one, state it in
`docs/sql-select.md` § 3.4 (which currently describes only the grouped and
aggregate-with-implicit-group cases), and make the code and the docs agree.

## Guard the class, not just this instance

The failure mode here is not "a wrong predicate" but "a clause the parser accepted
never reached the plan, silently". That is worth catching generally: a canary test per
SELECT clause (`where`, `having`, `group by`, `order by`, `limit`, `offset`, `distinct`)
that runs a query where the clause *must* change the answer and fails if the answer
matches the clause-free version. One such test would have caught this the day it
appeared and will catch the next clause that gets orphaned by a guard reordering.
Please include it with the fix rather than only the single-case regression.
