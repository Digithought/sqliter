description: A HAVING clause written inside a subquery cannot compare against a column of the surrounding query — the engine rejects it as an ungrouped column even though the column belongs to a different query. The same comparison written in WHERE works fine.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildHavingFilter's coverage check (~line 1117-1135); isPreGroupingReference (~line 601); findUngroupedPostAggregateRef (~line 718); buildGroupedRedirectContext (~line 393); buildGroupByCoverage (~line 269)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # `wg` fixture at line 241; HAVING coverage pins follow it
  - packages/quereus/test/logic/07.5-window.sqllogic              # lines 1372-1377 pin the HAVING rejection message — must not move
  - docs/sql-select.md                                            # §3.4 HAVING (line 656+); §3.3 line 621 already states the general correlated-reference rule
----

# HAVING rejects a reference to the enclosing query's column

## What is wrong

A subquery may correlate to the query that contains it. Quereus supports this in
`where` but not in `having`: the HAVING coverage check flags **any** column reference
that is not one of *this* query's grouping keys or aggregates, and a reference to an
enclosing query's column is neither.

Verified 2026-08-23 against `create table wg (a text, b text)` /
`insert into wg values ('x','1'),('y','2'),('x','3')`:

```sql
-- rejected: HAVING references non-grouped column 'b'; HAVING may only reference
--           GROUP BY columns or aggregate expressions
select w.b, (select count(*) from wg t group by t.a having t.a = w.a) as c from wg w;

-- rejected the same way when the outer column is compared against an aggregate
select w.b, (select count(*) from wg t group by t.a having max(t.b) = w.b) as c from wg w;

-- ALSO rejected, and NOT named in the original report: the same correlation in a
-- HAVING with no GROUP BY at all (implicit single group)
select w.b, (select count(*) from wg t having count(*) = 3 and w.b = '2') as c from wg w;

-- works: the same correlation in WHERE
select w.b, (select count(*) from wg t where t.a = w.a group by t.a) as c from wg w;
```

`w.a` / `w.b` are the **outer** query's columns. They are legal HAVING operands in SQL
and in PostgreSQL/SQLite; the inner query's own grouping restriction has nothing to say
about them.

Pre-existing — the check predates the `grouped-post-aggregate-redirect-boundary-check`
work and that ticket did not change it.

## Root cause

One site: the coverage test at the end of `buildHavingFilter`
(`select-aggregates.ts`, ~line 1117):

```ts
const coverage = buildGroupByCoverage(
	groupByExpressions,
	aggregateAttributes.slice(0, groupByExpressions.length + aggregates.length),
);
const ungrouped = findUngroupedColumnRef(havingExpression, coverage);
```

`findUngroupedColumnRef` asks *"is this attribute id in the allow-list"* and answers
"ungrouped" for everything it does not recognise — including ids that belong to some
other query entirely. Attribute ids are minted per relation instance, so the outer
query's `w` scan and the inner `wg t` scan never share one; the outer id simply is not
in the set, and out comes the rejection.

The engine already has the predicate that draws the right line.
`isPreGroupingReference(node, context)` (same file, ~line 601) is

```ts
context.aggregateInputAttrIds.has(attrId) && !context.outputAttrIds.has(attrId)
```

— true **only** for a column of *this* query's pre-grouping input that the grouped row
no longer carries. A subquery's own columns and an enclosing query's columns fall
outside it by construction. It is what the finished-plan check
(`assertGroupedPlanCoverage` → `findUngroupedPostAggregateRef`) already uses, and
routing HAVING through it makes the two checks agree instead of HAVING carrying its own
blunter rule.

## The fix

### The grouped path

Replace HAVING's `buildGroupByCoverage` + `findUngroupedColumnRef` pair with a walk
whose per-reference test is `isPreGroupingReference`.

That walk is `findUngroupedPostAggregateRef` **except that it must NOT descend into
relational children** — HAVING's existing check skips subqueries, and a correlated
reference to this query's ungrouped column buried inside a HAVING subquery is already
caught by the finished-plan check with the *other* message:

```sql
select a, count(*) from wg group by a having (select max(t.a) from wg t where t.a = wg.b) = 'x';
-- error: Column 'wg.b' must appear in the GROUP BY clause or be used in an aggregate function
```

That behaviour is unpinned by tests but **is** documented at `docs/sql-select.md:621`
("`having`'s own bare references keep their dedicated message"). Keep it: make HAVING's
walk skip relational children, so the subquery case keeps reaching the plan-level check
and keeps today's wording.

Suggested shape — add a `skipSubqueries` parameter to `findUngroupedPostAggregateRef`
rather than cloning it, so the aggregate-exemption rule stays in one place:

```ts
function findUngroupedPostAggregateRef(
	node: PlanNode,
	context: GroupedRedirectContext,
	insideSubquery = false,
	skipSubqueries = false,
): ColumnReferenceNode | null
```

With `skipSubqueries` the child loop `continue`s on `isRelationalNode(child)` instead of
recursing with `insideSubquery = true`.

Note the coverage allow-list becomes genuinely unnecessary, not merely narrowed:
`redirectPostAggregate` has already run over `havingExpression` by this point, so a
grouping key reached by any spelling the redirect handles (bare, qualified, nested,
whole-subtree fingerprint) is already an AggregateNode-**output** reference, which
`isPreGroupingReference` returns false for. The fingerprint and group-key-source-attrId
arms of `buildGroupByCoverage` were covering exactly the references the redirect now
rewrites.

### The no-GROUP-BY path (this ticket's third arm)

`buildAggregatePhase` builds `groupedRedirectContext` only when
`groupByExpressions.length > 0`, so an aggregate query with no `group by` reaches
`buildHavingFilter` with `undefined` — and that path has the same bug (third example
above).

`buildHavingFilter` already holds both inputs the context needs:
`aggregateAttributes = input.getAttributes()` and
`sourceInput = input.getRelations()[0]` — the exact pair `buildAggregatePhase` passes to
`buildGroupedRedirectContext`. So build the fallback locally:

```ts
const coverageContext = groupedRedirectContext
	?? buildGroupedRedirectContext([], aggregateAttributes, sourceInput);
```

With no grouping keys, `outputAttrIds` is just the aggregate results, so
`isPreGroupingReference` keeps rejecting this query's own columns (the existing
restriction) while letting an enclosing query's columns through.

**Use `coverageContext` for the coverage check only.** Do not pass it to
`redirectPostAggregate` — that call must keep receiving `groupedRedirectContext`, so a
non-grouped query still takes the pass-through branch and no redirect walk runs where
there is nothing to redirect onto.

### Error message

Unchanged: `HAVING references non-grouped column '<name>'; HAVING may only reference
GROUP BY columns or aggregate expressions`, still built from
`ungrouped.expression.name` and the same `loc`. The pins at
`test/logic/07.5-window.sqllogic:1372-1377` must stay green untouched.

### Cleanup that falls out

`buildGroupByCoverage`'s second parameter (`groupedOutputAttributes`) exists only for
the HAVING call site; `validateAggregateProjections` calls it with one argument. Once
HAVING stops using it the parameter is dead — drop it and simplify the doc comment
rather than leaving an unused arm.

## Expected behaviour

- A HAVING reference to a column of an **enclosing** query plans and evaluates, exactly
  like the same reference in WHERE — with or without `group by` on the inner query.
- A HAVING reference to an ungrouped column of **its own** query keeps today's rejection
  and today's message.
- An aggregate query with no `group by` keeps its own restriction: only aggregates (and
  now enclosing-query columns) are legal in its HAVING.
- The error text for an ungrouped reference buried in a HAVING **subquery** does not
  change (still the `must appear in the GROUP BY clause` wording, from the
  finished-plan check).

## Test expectations

Add to `test/logic/07.3-group-by-extras.sqllogic`, after the existing `wg` fixture at
line 241 (`('x','1'),('y','2'),('x','3')`). Values below are hand-derived from that
fixture; `→` rows are what the fix must produce. The first case's result was
cross-checked against its WHERE-equivalent, which already returns `c` = 2, 1, 2.

```sql
-- Correlated HAVING: the inner query's HAVING names a column of the ENCLOSING query.
select w.b, (select count(*) from wg t group by t.a having t.a = w.a) as c
from wg w order by w.b;
→ [{"b":"1","c":2},{"b":"2","c":1},{"b":"3","c":2}]

-- Same, with the outer column compared against one of the inner query's aggregates.
select w.b, (select count(*) from wg t group by t.a having max(t.b) = w.b) as c
from wg w order by w.b;
→ [{"b":"1","c":null},{"b":"2","c":1},{"b":"3","c":2}]

-- Same, in a HAVING with no GROUP BY (implicit single group).
select w.b, (select count(*) from wg t having count(*) = 3 and w.b = '2') as c
from wg w order by w.b;
→ [{"b":"1","c":null},{"b":"2","c":3},{"b":"3","c":null}]

-- Negative, grouped: the inner query's OWN ungrouped column keeps its rejection.
select w.b, (select count(*) from wg t group by t.a having t.b = '1') as c from wg w;
-- error: HAVING references non-grouped column 'b'

-- Negative, no GROUP BY: same restriction, same message.
select w.b, (select count(*) from wg t having t.b = '1') as c from wg w;
-- error: HAVING references non-grouped column 'b'
```

An empty inner result yields `null` for the scalar subquery — confirmed against this
engine on the WHERE-equivalent shape.

## Docs

`docs/sql-select.md` §3.4 (HAVING, line 656+) states the restriction without excluding
enclosing-query columns. Add one sentence: a `having` in a subquery may name a column of
an enclosing query, the same as `where` may — the restriction is about *this* query's
own ungrouped columns. §3.3 line 621 already makes the equivalent statement for the
general post-grouping restriction; keep the two consistent and cross-reference rather
than restating.

## TODO

- Add the `skipSubqueries` parameter to `findUngroupedPostAggregateRef` and update its
  doc comment to say why HAVING wants it (the subquery case belongs to the finished-plan
  check, which has its own message).
- In `buildHavingFilter`: derive `coverageContext` from `groupedRedirectContext ??
  buildGroupedRedirectContext([], aggregateAttributes, sourceInput)`; replace the
  `buildGroupByCoverage` / `findUngroupedColumnRef` pair with the new walk; leave the
  thrown `QuereusError` text and `loc` exactly as they are.
- Confirm `redirectPostAggregate` still receives `groupedRedirectContext`, not the
  fallback.
- Drop `buildGroupByCoverage`'s now-unused `groupedOutputAttributes` parameter and trim
  its doc comment. `findUngroupedColumnRef` keeps its other caller
  (`assertGroupByCoverage`, for the SELECT list) — leave that path alone.
- Add the five cases above to `test/logic/07.3-group-by-extras.sqllogic` under a short
  header comment naming this ticket.
- Update `docs/sql-select.md` §3.4.
- Run `yarn workspace @quereus/quereus test` (full logic suite — the HAVING/window pins
  in `07.5-window.sqllogic` and the alias pins in `07.3` are the ones at risk) and
  `yarn lint`.
