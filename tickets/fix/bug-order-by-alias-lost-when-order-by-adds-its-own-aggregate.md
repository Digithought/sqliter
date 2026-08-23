---
description: A summary query that sorts by two things at once — a summary the query does not otherwise display, plus one of its own result column names — fails with "Column not found" instead of returning rows.
files:
  - packages/quereus/src/planner/building/select.ts            # the early-vs-late ORDER BY placement fork (~line 229)
  - packages/quereus/src/planner/building/select-aggregates.ts # hasOrderByOnlyAggregates, which selects the early placement
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic # where the coverage belongs
difficulty: medium
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The shapes that hit it are narrow (an ORDER BY that both introduces an aggregate the SELECT list lacks *and* names a select-list alias of a computed aggregate), and the fix moves where the sort sits for every aggregate query — a maintainer may reasonably judge that re-plumbing against a rare spelling.
---

# ORDER BY can see the query's aggregates or its own aliases, never both

## What is wrong

An aggregate query's `ORDER BY` is planned in one of two places, and each place can
see names the other cannot:

- **Above the aggregation, below the final projection.** Taken when `ORDER BY` names
  an aggregate that the `SELECT` list does not contain (`order by max(a)` in a query
  that never selects `max(a)`). Those extra aggregates exist only for the sort and the
  final projection strips them, so the sort must run while they are still there. In
  this position the select list's `as` aliases do not exist yet.
- **Above the final projection.** Every other aggregate `ORDER BY`. Here the select
  list's aliases are in scope, but the sort-only aggregates are already gone.

An `ORDER BY` that needs both loses. Verified, on a table
`g (id integer primary key, a text, b text)`:

```sql
select count(*) + 1 as c from g order by max(a), c;
-- QuereusError: Column not found: c

select length(max(a)) as c from g order by min(b), c;
-- QuereusError: Column not found: c

select a, count(*) + 1 as c from g group by a order by max(b), c;
-- QuereusError: Column not found: c
```

SQLite accepts all three.

Only an alias of a **computed** aggregate is affected. When the select list's entry is
a bare aggregate call (`select count(*) as c … order by max(a), c`) the alias also
lands on the aggregation's own output column, so the early placement finds it and the
query works. The gap is exactly: the alias lives only on the final projection.

This predates `bug-ungrouped-aggregate-order-by-cannot-see-its-own-columns`; that
ticket made the *late* placement the default (which is how `order by c` alone works
today) but left the early placement, and its exception, untouched.

## What to build

Prefer retiring the fork over widening one arm of it. The invariant that does it:
**an aggregate query's `ORDER BY` always sorts above the final projection**, and any
column that exists only to be sorted by is carried *through* that projection and
dropped by a stripping projection placed above the sort. One placement, both name sets
in scope, and `hasOrderByOnlyAggregates` stops steering placement — it only decides
what the top projection strips.

Acceptance is behavioural: every combination of {bare aggregate alias, computed
aggregate alias, sort-only aggregate, positional reference, grouped, ungrouped} in one
`ORDER BY` plans and returns SQLite's rows. The three queries above are the minimum.
