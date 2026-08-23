description: A HAVING clause written inside a subquery cannot compare against a column of the surrounding query — the engine rejects it as an ungrouped column even though the column belongs to a different query. The same comparison written in WHERE works fine.
repro: verified
severity: edge-case
likelihood: unusual
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildHavingFilter's coverage check (~line 1100) and findUngroupedColumnRef; isPreGroupingReference is the predicate that already answers the missing question
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # where the HAVING coverage pins live
  - docs/sql-select.md                                            # §3.4 HAVING — states the restriction without excluding outer-query columns
tradeoffs: Correlated HAVING is rare and the current check is deliberately strict, so a maintainer may prefer the false rejection over any risk of letting a genuinely ungrouped local column slip through if the "belongs to this query" test is drawn wrong.
----

# HAVING rejects a reference to the enclosing query's column

A subquery may correlate to the query that contains it. Quereus supports this in
`where` but not in `having`: the HAVING coverage check flags **any** column reference
that is not one of *this* query's grouping keys or aggregates, and an outer-query
reference is neither.

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');

-- rejected: "HAVING references non-grouped column 'b'; HAVING may only reference
-- GROUP BY columns or aggregate expressions"
select w.b, (select count(*) from wg t group by t.a having t.a = w.b) as c from wg w;

-- rejected the same way when the outer column is compared against an aggregate
select w.b, (select count(*) from wg t group by t.a having max(t.b) = w.b) as c from wg w;

-- works: the same correlation in WHERE
select w.b, (select count(*) from wg t where t.a = w.a group by t.a) as c from wg w;
```

`w.b` is the outer query's column. It is a legal HAVING operand in SQL and in
PostgreSQL/SQLite; the inner query's own grouping restriction has nothing to say about
it.

Verified by running the three statements above (2026-08-12). Pre-existing — the check
predates the `grouped-post-aggregate-redirect-boundary-check` work and that ticket did
not change it; found while reviewing it.

## Root cause and the shape of the fix

One site: the coverage test in `buildHavingFilter`. It asks "is this attribute id one of
the grouped query's allowed ids", and answers "no" for everything it does not recognise
— including ids that belong to some other query entirely.

The engine now has the predicate that draws the right line. `isPreGroupingReference`
(added by the boundary-check work, same file) flags a reference **only** when it names a
column of *this* query's pre-grouping input that the grouped row no longer carries.
References to a subquery's own columns and to an enclosing query fall outside it by
construction, because attribute ids are minted per relation instance. Routing HAVING's
check through that one predicate makes HAVING agree with the finished-plan coverage
check rather than carrying its own, blunter, rule — and retires the whole "check
mistakes a foreign reference for an ungrouped one" class rather than this one instance.

`buildHavingFilter` already receives the `GroupedRedirectContext` that carries the
predicate's inputs, so the information is in hand at the site.

## Expected behaviour

- A HAVING reference to a column of an enclosing query plans and evaluates, like the
  same reference in WHERE.
- A HAVING reference to an ungrouped column of *its own* query keeps today's rejection
  and today's message (`HAVING references non-grouped column 'b'; …`) — the existing
  pins for that must not move.
- An aggregate query with no `group by` keeps its own restriction (only aggregates are
  legal in HAVING there); note that no `GroupedRedirectContext` exists on that path, so
  the fix needs an answer for it rather than assuming one is available.
