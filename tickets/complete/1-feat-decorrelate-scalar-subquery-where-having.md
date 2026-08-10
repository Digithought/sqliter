description: Correlated "value" subqueries in a WHERE or HAVING comparison now compile to a single grouped join (scanned once) instead of re-running the inner query per row. Reviewed and shipped.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/logic/07.7.1-scalar-agg-decorrelation-filter.sqllogic, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts, docs/optimizer-rules.md, docs/todo.md
----

# Complete: decorrelate correlated scalar-aggregate subqueries in Filter predicates (WHERE + HAVING)

## What shipped

Third anchor `ruleScalarAggDecorrelationFilter` (id `scalar-agg-decorrelation-filter`,
`nodeType: Filter`) added to the existing `rule-scalar-agg-decorrelation.ts`. A correlated
scalar-aggregate subquery anywhere in a Filter predicate (WHERE, or HAVING — which plans
as a FilterNode over an AggregateNode) is rewritten to
`Filter[pred'](LeftJoin(outer, groupedAgg))`, capped by a pass-through Project that
re-exposes the Filter's original attributes so the join's appended aggregate columns don't
leak to the query output. Inner table scanned once, not once per outer row. Empty-input
semantics preserved by LEFT join + existing empty-value replacement. Reuses the shared
`decorrelateAll` / `decorrelateOne` machinery unchanged. Registered after
`subquery-decorrelation` so EXISTS/IN semi/anti joins materialize first.

## Review findings

Ran the implement-stage diff (`git show e02ed7c6`) fresh before reading the handoff, then
scrutinized the rule, optimizer registration, the cap, and all tests. **No major defects
found; no new tickets filed.** Build gate green: `yarn workspace @quereus/quereus test`
→ 7074 passing / 0 failing; `yarn workspace @quereus/quereus lint` → exit 0.

**Checked — correctness of the cap (the implementer's flagged deviation).** The cap's
soundness rests on the LEFT join keeping outer attributes at indices `0..N-1` with their
original (non-null-extended) types, and the value/key column reads indexing past them.
Verified end-to-end:
- `ProjectNode` constructor param order confirmed (`…, predefinedAttributes,
  preserveInputColumns`) — the cap passes `[...filterAttrs]` then `false` correctly, so
  `getAttributes()` returns the original Filter signature verbatim.
- `buildJoinAttributes` (join-utils.ts) confirms a `left` join emits `[leftAttrs…(unchanged),
  rightAttrs…(null-extended)]`. So cap indices `0..N-1` map to outer attrs and `attr.type`
  is correct (left side never null-extended); `decorrelateOne`'s value/key colrefs correctly
  wrap their types with `nullable()` (right side is null-extended) at indices
  `leftWidth` / `leftWidth + groupAttrs.length`. Column-index and attribute-id soundness
  hold for single, stacked, joined-source, and Aggregate-source (HAVING) filter sources.

**Checked — infinite-loop / re-fire safety.** Rule returns `Project(Filter(Join))`; the
cap's projections are bare column refs (no subqueries), so neither the Project-site rule
nor a re-visit of the inner Filter re-fires productively. No loop.

**Checked — partial decorrelation.** When some candidates decorrelate and others bail, the
surviving correlated subqueries still resolve their outer refs on the join's left side. Added
a test for this path (below) — passes.

**Checked — docs.** `docs/optimizer-rules.md` (Filter site described on the
`ruleScalarAggDecorrelation` bullet) and `docs/todo.md` (subquery-optimization shipped list)
are accurate and reflect the new reality. No other doc enumerates rule ids, so nothing else
needed updating.

**Found — coverage gaps (minor; fixed inline this pass).** The implementer flagged two
gaps; both closed by adding sqllogic cases to
`test/logic/07.7.1-scalar-agg-decorrelation-filter.sqllogic` (both pass):
- Two stacked scalar-agg subqueries in one HAVING predicate (stacking was covered only for
  WHERE) — anchor-agnostic path, now exercised for HAVING.
- Mixed decorrelate + bail in one WHERE predicate — exercises the surviving-correlated-
  subquery-over-join-source path that no prior test hit.

**Tripwires (recorded, not ticketed):**
- *Redundant cap Project* for a WHERE filter already under a SELECT Project — one extra
  pass-through node, correct output; already tagged `NOTE:` at `capToFilterAttributes` in
  `rule-scalar-agg-decorrelation.ts`. Only becomes work if it shows in plan-shape noise or
  profiling. No change.
- *HAVING correlating to the aggregate result* is tested for result-equivalence only, not
  for a structural decorrelate-vs-bail guarantee. It computes correctly either way (verified
  — it does decorrelate, grouping the inner by the correlated cap value, and matches the
  baseline). A structural plan-shape assertion is speculative; left as result-equivalence.
- *Side-effecting inner* is guarded and tested planning-only (`query_plan()` never fires the
  INSERT); no runtime test asserts per-row firing when decorrelation is refused. The gate is
  shared with the sibling anchors (which have the same coverage shape). Low risk. No change.
- *Cost model unchanged* — the rule is unconditional (no cost gate), matching the sibling
  anchors; the tiny-outer/huge-inner tradeoff remains tracked in
  `backlog/feat-decorrelation-cost-model`.

**Not found:** no correctness, type-safety, resource-cleanup, or source-hygiene issues.
The rule file stays cohesive (short single-purpose functions, comments explain *why* not
*what*), the three anchors share one rewrite path (DRY), and the cap is a small,
well-documented function.
