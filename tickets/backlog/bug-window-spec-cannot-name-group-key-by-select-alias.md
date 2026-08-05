---
description: In a query that groups rows, a window function can sort by an aggregate's output name but not by a grouping column's output name, even though both are ordinary result columns — the second spelling fails with "column not found".
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope — registers aggregate aliases but not grouping-key aliases
  - packages/quereus/test/logic/07.5-window.sqllogic             # line ~906 asserts the aggregate-alias case works
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The query is rejected, not answered wrongly, and naming the grouping column instead of its alias works - so this is an ergonomics gap in one scope-building function rather than a defect in results.
---

# A window specification can name an aggregate by its select-list alias, but not a grouping key

## What happens

Given `create table wg (a text, b text)`:

```sql
-- works today (asserted at 07.5-window.sqllogic:906)
select a, count(*) as c, row_number() over (order by c) as rn from wg group by a;

-- fails
select a as k, row_number() over (order by k) as rn from wg group by a;
-- QuereusError: Column not found: k
```

Both `c` and `k` are ordinary output columns of the same grouped query, named the
same way. Only one of them can be used inside an `over (…)` clause.

## Why

The scope a grouped query's window specification resolves against is built by
`createAggregateOutputScope`. It registers each **aggregate** under its select-list
alias, and each **grouping key** under the key's own column name (plus its
qualified name when the key was written qualified) — never under the select-list
alias the query gave that key. So `c` resolves and `k` does not.

## Expected behavior

Undecided, and that is the point of filing it rather than fixing it inline:

- Strict SQL (and PostgreSQL) allows a select-list alias only in the statement's
  top-level `ORDER BY`, not inside a window specification. Under that reading the
  *aggregate* case is the outlier and `order by c` should arguably fail too — but
  it already ships and is asserted by a test, so removing it is a behavior break.
- SQLite resolves output aliases far more freely. Under that reading `order by k`
  should work and the grouping-key registration is simply missing.

Making the two consistent is the deliverable; which direction is a judgement call
about how closely this engine tracks SQLite here. The cheap direction is to also
register each grouping key under its select-list alias, which makes `order by k`
work and leaves everything that passes today passing.

## Scope note

Found while fixing `bug-window-spec-reads-base-table-column` (qualified and
expression-shaped grouping keys crashing inside `over (…)`). That fix redirects
grouping-key *expressions* onto the aggregate's output columns; it does not touch
name resolution, so it neither fixes nor worsens this.
