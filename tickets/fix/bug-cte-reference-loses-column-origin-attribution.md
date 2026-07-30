---
description: When a query reads from a `with` clause, the planner can no longer tell that the filtered column is a real table column, so it guesses how many rows the filter keeps instead of using the collected statistics. Queries return correct results but may get a worse plan.
files:
  - packages/quereus/src/planner/util/column-origins.ts                      # the walk that stops short; "Known gap" section
  - packages/quereus/src/planner/nodes/cte-reference-node.ts                 # mints fresh attribute ids (line ~47)
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # the consumer, both paths
  - packages/quereus/test/optimizer/column-origins.spec.ts                   # existing CTE test is only a consistency check
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts               # where the end-to-end assertion belongs
  - docs/optimizer.md                                                        # "Column identity, not column name"
difficulty: medium
---

# CTE columns lose their base-table attribution

## Symptom

With an analysed table, a filter written directly over the table gets a real
statistics-derived estimate; the same filter written over a `with` clause gets the
naive fallback guess.

```
o(id integer primary key, cat text, qty integer)  -- 100 rows, qty has 7 distinct values, ANALYZEd

select * from o where qty = 3                                     -- FilterNode.selectivity = 0.142857  (1/7, correct)
with c as (select cat, qty from o) select * from c where c.qty = 3 -- FilterNode.selectivity = 0.1       (naive guess)
with c as (select * from o)        select * from c where c.qty = 3 -- FilterNode.selectivity = 0.1       (naive guess)
```

A subquery (`select * from (select cat, qty from o) x where x.qty = 3`) and a view
(`create view v as select cat, qty from o`) both still give 0.142857 — only the `with`
form is affected.

Results are unaffected; only the planner's row estimate is, which can change which
plan is chosen.

## When it started

This is a regression introduced by `bug-selectivity-matches-columns-by-name-not-identity`
(commit `04304a9d`). Before that change the estimator matched a predicate's column to
statistics by the *name* written in the query, and "qty" happened to name the right
column of `o` even through a CTE, so the estimate was right by luck. The change
(correctly) switched to matching by the planner's internal column identity, and the
identity map has a hole at the CTE boundary.

## Why the map has a hole

`collectColumnOrigins` (`planner/util/column-origins.ts`) maps each of a subtree's
output columns back to the base-table column that produced it. It walks down through
single-input operators until it reaches a table reference. `CTEReferenceNode` is one of
those operators it walks through — but unlike a projection or a sort, it does **not**
republish its input's column identities: `cte-reference-node.ts` allocates a brand-new
identity for every column it exposes. So nothing above a CTE reference can be traced
back to the table, and the filter rule reads that as "this column has no statistics".

## Why the obvious fix is not enough

The columns line up positionally, so it is tempting to just pair the CTE reference's
new identities with its body's, one for one. That alone would misattribute a self-join
over a CTE. Two references to the same `with` clause **share one instance of the CTE's
plan subtree** — confirmed on this tree: the plan for

```sql
with c as (select * from o) select * from c a join c b on a.id = b.id where a.qty > b.qty
```

contains two `CTEReference` nodes but only **one** underlying table reference. A naive
positional pairing would therefore resolve `a.qty` and `b.qty` to the same origin, and
`rule-filter-selectivity` — which counts distinct origins to decide whether a condition
compares two relations or one column to a constant — would classify `a.qty > b.qty` as a
single-relation predicate and estimate it as if `qty` were being compared to a constant.
That is exactly the misattribution `column-origins.ts` documents as the reason it keys on
the *instance* of a table reference rather than on the table's schema.

So the fix needs a per-reference identity for columns republished by a CTE reference,
not just a positional remap. `ColumnOrigin.ref` is currently typed as a table-reference
node and is used for two things — identity comparison, and reaching the table's schema —
so one plausible shape is to separate those two roles. That is a design call for the
implementer; the requirement is only that the two arms of a CTE self-join stay distinct.

## Expected behaviour

- A filter over a CTE column that is a plain base-table column estimates from that
  column's statistics, exactly as the equivalent subquery form does.
- A filter over a CTE column that is *computed* inside the CTE body estimates nothing
  from base-table statistics, exactly as the equivalent subquery form does — renaming
  the alias must not move the estimate.
- Two references to the same CTE are treated as two relations: a condition comparing a
  column of one to a column of the other must not collapse into a single-relation
  estimate.
- No change to query results anywhere.

## Scope notes

`CTEReferenceNode` is the only operator with this shape. Every other node that allocates
new column identities either is already excluded from the walk (aggregates, set
operations, recursive CTEs) or allocates only for genuinely new columns (computed
projections, window function outputs) — verified by inspecting every use of the
identity allocator in `planner/nodes/`. So this is one gap, not a class of them.

Also worth checking while in here: recursive CTEs are excluded from the walk for a
different, valid reason (their rows come from several branches), so they should stay
excluded — the fix should not accidentally reach through them.
