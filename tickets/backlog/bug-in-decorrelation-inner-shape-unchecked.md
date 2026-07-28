---
description: A WHERE clause that tests a column against a related subquery fails at runtime with a confusing "no row context" error whenever the subquery selects a computed value, or uses DISTINCT or LIMIT. The query is valid SQL and returns the right answer if the optimizer rule is disabled.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts   # extractInCorrelation — both defects live here
  - packages/quereus/src/planner/cache/correlation-detector.ts                   # collectExternalReferences — the missing backstop
difficulty: medium
---

# Correlated `IN (subquery)` decorrelation ignores the subquery's shape

`ruleSubqueryDecorrelation` rewrites a correlated `where col in (select …)` into a semi
join. Its helper `extractInCorrelation` makes two assumptions about the subquery that are
not checked, and each produces a runtime error on ordinary SQL.

Reproduced against the in-memory virtual table with:

```sql
create table a (id integer primary key, x integer) using memory;
create table b (id integer primary key, x integer) using memory;
```

## Defect 1 — the join key may not exist on the chosen right side

`extractInCorrelation` builds the join condition from `subqueryRoot.getAttributes()[0]` —
the subquery's first *output* column — but then descends past `Project` / `Alias` nodes and
uses the node underneath as the join's right side. When the projection is a bare column
reference the two agree (the projection preserves the column's attribute id), which is why
the common case works. When the projection is computed, the output column carries a fresh
attribute id that the descended right side does not expose, and the join condition ends up
referencing an attribute no side defines.

```sql
select a.x from a where a.x in (select b.x + 0 from b where b.id = a.id);
-- Error: No row context found for column x. The column reference must be evaluated
--        within the context of its source relation.
```

The plan shows the rewrite firing (`SEMI MERGE JOIN`) over a raw scan of `b`.

The sibling SELECT-list rule (`ruleExistsInSelectDecorrelation`) already guards exactly this
— it looks the key attribute up in the right side's attributes and bails when absent — so
the fix has a precedent in the same file.

## Defect 2 — the correlation may survive inside the right side

The descent only steps through `Project` and `Alias`. When the subquery's root is anything
else (`DISTINCT`, `LIMIT`, a set operation), the walk stops immediately, no inner
`FilterNode` is found, and the code takes its "no inner filter" branch: it emits a semi join
whose condition is only `outer.col = inner.col0` and whose right side is the whole subquery
subtree — with the correlation predicate still buried inside it. The right side is then
driven as if it were uncorrelated.

```sql
select a.x from a where a.x in (select distinct b.x from b where b.id = a.id);
-- Error: No row context found for column id.

select a.x from a where a.x in (select b.x from b where b.id = a.id limit 1);
-- Error: No row context found for column id.
```

The `LIMIT` case is additionally not decorrelatable on semantics alone: a `LIMIT` inside a
correlated subquery applies per outer row, which a single semi join cannot express.

The same rule's SELECT-list sibling has the backstop this arm lacks — it re-checks
`collectExternalReferences(rightSide)` after building and declines when anything remains.

## Expected behavior

Both queries return the same rows they would with the decorrelation rule disabled
(`alpha`/`gamma`-style row sets, i.e. ordinary correlated-`IN` semantics). Whether the rule
rewrites them or declines and leaves the per-row path is an implementation choice — but it
must never emit a plan that cannot execute.

Minimum bar for a fix:

- Verify the inner join-key attribute is exposed by whatever node becomes the join's right
  side; decline otherwise.
- After building the right side, verify it has no remaining external references; decline
  otherwise.
- Decline `LIMIT`/`OFFSET`-bearing correlated subqueries outright.

## Notes

- Found while planning `feat-uncorrelated-in-semijoin`. That ticket deliberately does **not**
  reuse `extractInCorrelation` — its uncorrelated arm uses the subquery root verbatim, so it
  cannot hit either defect — which is why this is filed separately rather than folded in.
- Cosmetic, same function, worth fixing in passing: the inner column reference is built by
  reusing the *outer* column's AST expression, so `EXPLAIN` renders every decorrelated IN
  condition as the nonsense `a.x = a.x`. Fixing it will move golden plans.
