----
description: Two remaining query shapes still re-run an inner lookup once per row instead of doing it in one pass; extend the existing one-pass rewrite to cover them both.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/building/select-modifiers.ts
----

# Decorrelate the two remaining per-row subquery sites

## Why these are one ticket

Quereus rewrites a correlated subquery — one that references the outer query's current row —
into a join, so the inner table is scanned once instead of once per outer row. That rewrite
already covers the SELECT list, WHERE, HAVING, ORDER BY (scalar-aggregate → grouped left join)
and EXISTS/IN in WHERE and the SELECT list (→ semi/anti or existence-flag join).

Both arms below **add a new match site to the same rule pair** —
`packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts` and
`rule-subquery-decorrelation.ts` — following the pattern the already-shipped anchors
established. Same files, same helper vocabulary (`decorrelateAll`, `decorrelateOne`,
`extractExistsCorrelation`, `capToAttributes`), same class of column-index bookkeeping risk.
Splitting them means two passes over the same code learning the same context twice.

They are still separable slices of work inside the ticket: Arm B is the cheaper one and is a
reasonable first cut on its own.

## Gate: cost model comes after, not with, this ticket

`backlog/feat-decorrelation-cost-model` — a cost/statistics gate so a query with very few
outer rows and a huge indexed inner table can keep the cheaper per-row plan — **should run
after this ticket, not be merged into it.** Adding two new match sites first, then gating all
of them once, is strictly less work than gating a moving target; and a gate designed before
the last sites exist would have to be revisited anyway. Treat it as the follow-up that closes
the decorrelation work, not as a prerequisite.

## Arm A — correlated subquery in a join's ON condition

```sql
select *
from a join b on b.x = (select max(c.v) from c where c.k = a.k)
```

Here the subquery is evaluated for every `(a, b)` candidate pair the join considers —
potentially far more times than once per outer row.

This site is materially harder and lower-value than the others:

- **Correlation can reach either side of the join** (`a` and/or `b`), not a single "outer".
  Which relation the grouped/decorrelated subtree must join against, and where in the join
  tree the new join lands, depends on which side(s) the subquery references — a genuinely
  different placement problem than the single-outer sites.
- **The subquery lives inside a join predicate**, not a Filter/Project/Sort/Aggregate
  expression tree, so the anchor and the rewrite (splitting the ON condition, re-associating
  joins) are new machinery, not a reuse of the existing `decorrelateAll` /
  `extractExistsCorrelation` helpers.
- **Interaction with join reordering / physical selection** is unexplored: a decorrelated
  subquery-join nested inside another join's ON condition may block or complicate hash/merge
  selection and equi-pair extraction.

**What a plan pass should resolve for Arm A:**

- Which correlation topologies to support first (correlate to one side only is the tractable
  slice; both-sides correlation may stay per-pair).
- Where the new join lands relative to the enclosing join (below the referenced side? above
  the whole join with a rewritten condition?).
- Whether to restrict to scalar-aggregate subqueries (reuse the grouped-join rewrite)
  initially and defer EXISTS/IN-in-ON separately.
- Cost/benefit: how often this shape occurs in practice vs the plumbing cost — it may warrant
  a narrower first cut or remaining low-priority.

## Arm B — ORDER BY scalar-agg subquery whose correlation column is projected away

`feat-decorrelate-scalar-subquery-order-by` added the Sort anchor
(`ruleScalarAggDecorrelationSort`): a correlated scalar-aggregate subquery in an ORDER BY key
is rewritten into a grouped LEFT join. That rewrite fires only when the **correlation column
is present in the Sort's own source**. Two common shapes satisfy that:

- identity projections — `select o.* from o order by (select count(*) from c where c.fk = o.k)`
- any query that also selects the correlation column — `select o.id, o.k from o order by (select count(*) from c where c.fk = o.k)`

When the SELECT list projects the correlation column **away**, the Sort sits above a
*stripping* Project:

```
select o.id from o order by (select count(*) from c where c.fk = o.k)
```

```
Sort[ key = ScalarSubquery(... c.fk = o.k ...) ]
  Project[ o.id ]          -- o.k stripped here
    Scan o                 -- o.k lives here, below the Project
```

`decorrelateOne` requires `o.k` to be an attribute of the Sort's immediate source, but the
Project's output no longer carries it, so the rule **bails** and the subquery stays
correlated. The result is still **correct** — at runtime the correlated `o.k` resolves from
the still-live base-scan row context below the Project (Quereus resolves correlated column
refs by attribute id off a live context stack, not off the Sort's input row) — it is merely
**not optimized**: the inner pipeline re-runs once per outer row.

Fixing it means getting the grouped **value** column from a join that must reference `o.k`
(available only *below* the stripping Project) up to the Sort key that lives *above* the
Project. Two routes:

- **Rule-level threading:** insert the LEFT join below the stripping Project, extend the
  Project (and any intervening pass-through nodes) to carry the value (and CASE-guard
  group-key) column up to the Sort, substitute in the Sort key, then cap back to the original
  output shape. The delicate part is physical **column-index** bookkeeping through a Project
  that subsets/reorders columns — exactly where these rewrites are easy to get subtly wrong. A
  same-node subquery that ALSO appears in the SELECT list (decorrelated by the Project site)
  makes the threading interact with an already-rewritten Project.
- **Builder-level:** teach `shouldApplyOrderByBeforeProjection` (`select-modifiers.ts`) to
  place the Sort *below* the final projection when an ORDER BY key is an expression (not just
  a bare column) that references non-projected columns — as it already does for a bare
  `order by o.k`. Simpler for the rule but broadens plan shape for **all** such expression
  ORDER BYs (e.g. `order by o.k + 1`) and risks reordering interactions with a Project-site
  join over a sorted input; needs a plan pass to bound the blast radius.

**What a plan pass should resolve for Arm B:**

- Rule-level threading vs builder-level Sort placement (and the ordering-safety proof if a
  join lands over/under the Sort).
- Whether to restrict the first cut to a single bare pass-through Project (the overwhelmingly
  common `select <subset of columns>` case) and bail on computing/aliasing Projects.
- How it composes with the Project-site rule when the same subquery shape is in both the
  SELECT list and the ORDER BY.

**Prior art / anchors for Arm B:**

- `ruleScalarAggDecorrelationSort` and `capToAttributes` in
  `packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts` (see the
  `SCOPE:` note in the module header and the `NOTE:` at the rule site).
- The bail is pinned by tests: `test/plan/scalar-agg-decorrelation.spec.ts` ("leaves the
  subquery correlated when the correlation column is projected away") and a case in
  `test/logic/07.7-scalar-agg-decorrelation.sqllogic`. Both must be updated, not deleted, when
  the bail goes away.

## Promotion

Promote to `plan/` when either shape is observed to matter. Until then both queries are
correct, just not decorrelated.
