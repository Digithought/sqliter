description: Running the query planner twice on the same query produces a simpler plan the second time — it leaves two WHERE-clause steps stacked on top of each other that it knows how to combine into one, but never gets a second chance to do so.
files: packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts
difficulty: medium
----

## What was observed

Found while reproducing `bug-filter-row-estimate-lost-when-predicate-rewritten`; separate
concern, filed on its own.

`Optimizer.optimize()` is not idempotent in plan *shape*. For

```sql
select * from o where o.qty = (select max(qty) from r r2) and o.cat = 'a';
```

the first `optimize()` returns two directly-stacked filter steps:

```
Filter  WHERE o.qty = (select max(qty) from r as r2)
  Filter  WHERE o.cat = 'a'
    IndexScan  o USING _primary_
```

Feeding that plan back through `optimize()` collapses them into one filter carrying both
conditions. So the rule that merges adjacent filters (`filter-merge`) *can* handle this pair —
it simply never sees it, because the pair only becomes adjacent during a later stage than the
one that rule runs in.

## Why it happens (working theory, needs confirming)

`filter-merge` runs in the **Structural** pass. At that point the two filters are not
adjacent: predicate pushdown has put `o.cat = 'a'` inside the table-access pipeline, with a
`Retrieve` boundary node between it and the outer filter. The **Physical** pass then replaces
that `Retrieve` with a concrete access node (`IndexScan`) and the residual filter surfaces
directly under the outer one — after `filter-merge` has had its only look.

Anyone picking this up should confirm that story before acting on it (a plan dump before and
after the Physical pass is enough).

## Why it matters

- Two filter steps instead of one means two predicate-evaluation frames per row at runtime and
  an extra plan node for every downstream analysis to walk.
- Row estimates compound: each filter multiplies its own selectivity into the source
  cardinality, so a split pair and a merged single filter can disagree about the same
  predicate set — which then feeds different physical choices upstream.
- "Optimize twice and diff" is a natural debugging and testing technique, and it currently
  reports a *shape* change that has nothing to do with whatever is being investigated. The
  fix ticket above had to explicitly warn against using a second `optimize()` as the oracle
  for what the first pass should have produced.

## Expected

One `optimize()` should be enough: a query whose plan the optimizer would further simplify on
a second run should be simplified on the first. Concretely, no plan handed to emission should
contain two directly-stacked `FilterNode`s that `filter-merge` would collapse.

Whoever picks this up will need to decide *where* the merge gets its second look — an extra
`filter-merge` registration in a later pass, a Physical-pass rule that avoids surfacing the
residual as a separate node, or a general "re-run the structural fixpoint after lowering"
mechanism — and weigh that against the golden-plan churn any of them causes (`test/plan/`
captures plan shape and row estimates).

## Worth checking while in here

Whether stacked filters like this are the only shape where the first `optimize()` differs from
the second, or whether the non-fixpoint is broader. A cheap way to find out: a test-mode sweep
that optimizes every query in the existing plan/logic suites twice and reports any plan whose
shape changes.
