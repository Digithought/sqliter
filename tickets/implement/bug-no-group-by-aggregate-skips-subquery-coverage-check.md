---
description: When a query totals something without grouping it, a mistaken column reference in the clauses that filter or trim the result is not reported — the query either answers wrongly or dies with an internal error the user cannot act on. Make it report the same clear message the grouped form already gives.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts     # ~line 139 — the one gate to change; ~line 1130 — the local workaround it retires
  - packages/quereus/src/planner/building/select.ts                # ~line 417 — the call site guarded on that gate
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic      # ~line 370-440 — where the sibling grouped/correlated cases are pinned
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # ~line 381 — one pinned case changes behaviour
  - docs/sql-select.md                                             # ~line 746-748 — the `order by` bullets that describe this shape
---

# Run the whole-plan coverage check for an aggregate query with no `group by`

## Background: the two checks

A query that aggregates has clauses sitting *above* the aggregation step — `having`,
`order by`, `limit`, `offset`. Those clauses can only read what an aggregated row
carries: the grouping columns and the aggregate results. Reading anything else is a
user error, and SQL says so with

```
Column '<name>' must appear in the GROUP BY clause or be used in an aggregate function
```

Two checks enforce that:

- a **per-clause** check, run while the clause is being built. It deliberately does not
  look inside subqueries, because at build time it cannot tell a subquery's own columns
  apart from a reference that reaches back out;
- a **whole-plan** check (`assertGroupedPlanCoverage`), run once the plan is finished.
  It *can* tell those apart, so it is the one that catches a mistaken reference buried
  in a subquery, and it is the one that covers every clause at once — including clauses
  nobody has written a per-clause check for.

## Root cause — one gate, doing two jobs

`packages/quereus/src/planner/building/select-aggregates.ts` ~line 139:

```ts
const groupedRedirectContext = groupByExpressions.length > 0
    ? buildGroupedRedirectContext(groupByExpressions, aggregateNode.getAttributes(), aggregateNode.getRelations()[0])
    : undefined;
```

That one value answers two different questions:

1. *"What does an aggregated row of this query carry?"* — needed by the whole-plan
   coverage check. Every aggregate query has an answer, `group by` or not.
2. *"Are there grouping keys to rewrite post-aggregate expressions onto?"* — needed by
   `redirectPostAggregate`. Only a query **with** `group by` has any.

Because the value is `undefined` when there is no `group by`, and because
`select.ts` ~line 417 guards the whole-plan check on that same value, an aggregate
query with no `group by` never reaches the check at all. It is still a grouped query —
it has exactly one, implicit group — so the check is exactly as applicable to it.

Pre-existing, not a regression. Found while reviewing
`complete/bug-having-rejects-correlated-outer-column`, which left both checks' subquery
behaviour exactly as it found it.

## What is actually broken (all verified)

Setup used throughout:

```sql
create table wg (a text, b text);
insert into wg values ('p','1'),('q','2'),('r','3');
```

**1 — `having` with a subquery reading an ungrouped column: silently wrong answer.**

```sql
select count(*) as c from wg having (select max(t.a) from wg t where t.b = wg.b) = 'x';
→ []                    -- no error
```

`wg.b` is neither grouped nor inside an aggregate, so the subquery is answered off an
arbitrary representative row of the table. The identical mistake under `group by a`
raises the coverage error today.

**2 — `order by` when the sort is forced above the aggregate: accepted, should be rejected.**

```sql
select count(*) as c from wg order by c, (select max(t.a) from wg t where t.b = wg.b);
→ [{"c":3}]             -- accepted
select count(*) as c from wg order by count(*), (select max(t.a) from wg t where t.b = wg.b);
→ [{"c":3}]             -- accepted
```

A no-`group by` aggregate query returns one row, so the wrong sort cannot reorder
anything — the defect here is a legality gap, not a wrong answer. See "not a bug" below
for the `order by` shapes that must stay legal.

**3 — `limit` / `offset`: internal runtime error instead of the user-facing message.**
This one is new; the original fix ticket did not have it.

```sql
select count(*) as c from wg limit b;
-- No row context found for column b. The column reference must be evaluated
-- within the context of its source relation.

select count(*) as c from wg limit (select count(*) from wg t where t.b = wg.b);
-- same internal error

select count(*) as c from wg limit 1 offset (select count(*) from wg t where t.b = wg.b);
-- same internal error
```

The grouped form (`select a, count(*) from wg group by a limit b`) reports
`Column 'b' must appear in the GROUP BY clause...` at plan time. The ungrouped form
compiles a plan that cannot run and reports an engine-internal message the user cannot
act on. This is precisely the failure mode the whole-plan check exists to convert into
the user-facing message — see its own doc comment in `select-aggregates.ts`.

## NOT a bug — the original fix ticket got this one wrong

The fix ticket claimed this should be rejected:

```sql
select count(*) as c from wg order by (select max(t.a) from wg t where t.b = wg.b);
```

It should not. With no `group by`, and with no sort key naming a select-list alias or
an aggregate, the whole `order by` sorts the **input** rows *before* aggregation — a
documented Quereus extension (`docs/sql-select.md`, the "sorts the **input** rows
before aggregation" bullet), which exists to give an order-sensitive aggregate a
deterministic input order. The sort key is evaluated once per input row, so a
correlated subquery in it is well defined, not an arbitrary row. Verified observable:

```sql
select group_concat(a) as g from wg order by (select max(t.b) from wg t where t.b = wg.b) desc;
→ [{"g":"r,q,p"}]
select group_concat(a) as g from wg order by (select max(t.b) from wg t where t.b = wg.b) asc;
→ [{"g":"p,q,r"}]
```

That sort sits **below** the aggregate, so the whole-plan check — which stops walking at
the aggregate — leaves it alone for free. No special-casing is needed to preserve it.

## The fix

Split the one value into two, so each answers only its own question:

```ts
// always — every aggregate query has an answer to "what does an aggregated row carry"
const groupedCoverageContext = buildGroupedRedirectContext(
    groupByExpressions, aggregateNode.getAttributes(), aggregateNode.getRelations()[0]);
// undefined now means exactly one thing: no grouping keys, so nothing to rewrite onto
const groupedRedirectContext = groupByExpressions.length > 0 ? groupedCoverageContext : undefined;
```

Return both from `buildAggregatePhase`; every existing consumer of
`groupedRedirectContext` (the select-list rebuild, the window phase, `applyOrderBy`,
`buildHavingFilter`'s call to `redirectPostAggregate`) keeps receiving the gated one and
is unchanged. Only the whole-plan check in `select.ts` switches to the coverage one, and
its guard becomes "an AggregateNode exists".

`buildHavingFilter` currently builds this same context on the spot for its own coverage
check (`groupedRedirectContext ?? buildGroupedRedirectContext([], aggregateAttributes,
sourceInput)`, with a comment explaining it cannot hand the result to the rewrite). Pass
the coverage context in instead and delete the workaround — it is the same value, and
the two-binding split is exactly the distinction its comment was describing in prose.

This is the whole change. It retires the class rather than patching the three clauses
that expose it today: any future clause built above the aggregate is covered for free.

### The trap named in the fix ticket, and why the split is still the right shape

Making the value always present must not make the grouping-key rewrite start walking
expressions it should leave alone. Measured: with an empty `groupByExpressions` list
`indexGroupKeys` produces empty maps, so `redirectNode` can match nothing and returns
every node unchanged — the rewrite would be a no-op, not a hazard. But it would still
*walk* every post-aggregate expression of every ungrouped aggregate query for nothing,
and it would leave `undefined` meaning two things at once. Keep the two bindings.

## Behaviour change to an existing pinned test

`packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic` ~line 381:

```sql
-- Composes with a second sort key and with LIMIT
select count(*) as c from g order by c, id;
→ [{"c":3}]
```

This starts erroring (`Column 'id' must appear in the GROUP BY clause or be used in an
aggregate function`) — it is defect 2 above. The case's stated intent is "composes with
a second sort key"; the choice of `id` for that second key is incidental. Change the key
to a legal one (`order by c, max(a)` verified working) and add a negative case next to
it pinning that a bare source column as the second key is now rejected.

That is the only test in the suite that changes: measured, one prototype run of
`yarn workspace @quereus/quereus test` gave 3502 passing / 1 failing, that case.

### The user-visible asymmetry this creates, and the doc fix it needs

`order by` placement for a no-`group by` aggregate query is **all-or-nothing across the
whole list**, not per term. If every term is pre-aggregate-eligible, the entire list
sorts the input (legal). If *any* term names a select-list alias or an aggregate, the
entire list moves above the aggregate, and then *every* term must be covered:

```sql
select count(*) as c from g order by id;        -- legal: input sort
select count(*) as c from g order by c, id;     -- rejected after this fix
select count(*) as c from g order by id, c;     -- rejected after this fix
```

`docs/sql-select.md` (the "An unqualified name that IS a select-list alias outranks a
same-named source column, ... which turns the extension off for **that term**" bullet)
says *that term*. It is the whole list. Correct the wording and state the consequence —
before this fix the difference was invisible, after it the second and third queries
above are errors.

## TODO

- Split `groupedRedirectContext` into `groupedCoverageContext` (always built) and
  `groupedRedirectContext` (gated on `groupByExpressions.length > 0`) in
  `buildAggregatePhase`; return both.
- Update the doc comment above the split — it currently reads "An aggregate query with
  no GROUP BY has no grouping keys to redirect onto and gets none", which stays true of
  the redirect binding but must now say what the coverage binding is for.
- Pass `groupedCoverageContext` into `buildHavingFilter` and delete its local
  `?? buildGroupedRedirectContext([], ...)` workaround plus the paragraph of its comment
  that exists only to explain that workaround.
- Switch `select.ts`'s `assertGroupedPlanCoverage` guard to the coverage context; extend
  the NOTE block above it to say the check now covers the implicit single group too, and
  that the pre-aggregate sort stays legal because it sits below the aggregate.
- Add cases to `07.3-group-by-extras.sqllogic`, in the correlated-HAVING section
  (~line 370-440, table `wg (a text, b text)` with `('x','1'),('y','2'),('x','3')`):
  - negative: `having` with a subquery reading `wg.b`, no `group by` — expect the
    coverage message, alongside the existing `group by a` twin
  - negative: `order by c, (select ... where t.b = wg.b)` and
    `order by count(*), (select ... where t.b = wg.b)`
  - negative: `limit b` and `limit (select count(*) from wg t where t.b = wg.b)` with no
    `group by` — these currently reach the runtime, so they pin the plan-time conversion
  - positive, guarding against over-rejection: a subquery reading only its own columns
    (`having (select max(t.a) from wg t) = 'y'`); a correlated reference to an
    **enclosing** query from an ungrouped inner aggregate; `order by count(*)`;
    `order by (select max(t.a) from wg t)`
  - positive, guarding the documented extension: `group_concat` with a correlated
    pre-aggregate sort key, asserted in both directions so the ordering is observable
- Fix the `28.2-orderby-expression-extras.sqllogic` ~line 381 case as described, and add
  the negative twin next to it.
- Correct the "that term" wording in `docs/sql-select.md` to "the whole `order by` list"
  and state the all-or-nothing consequence with the three example queries above.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
