---
description: A WHERE condition mentioning only one of two joined tables is now applied before the join instead of after, so an index on that table can be used and the other table is no longer read in full.
files:
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts
  - packages/quereus/test/optimizer/rule-join-predicate-pushdown.spec.ts
  - packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic
  - docs/optimizer-rules.md
  - docs/optimizer.md
  - docs/optimizer-fd.md
  - docs/mv-maintenance.md
---

# Complete: push single-table WHERE conjuncts below a join

## What shipped

`rule-join-predicate-pushdown` fires on `Filter(predicate, JoinNode)` and **moves** every
conjunct whose column references land entirely on one never-null-extended side of the join
onto that side's branch. Cross-side and refused conjuncts stay in a residual Filter above the
rebuilt join; `rule-predicate-pushdown` then carries each branch Filter across that branch's
`Alias` and into its `Retrieve`, converting a scan into a seek.

Pushable sides: `inner`/`cross` → both, `left`/`semi`/`anti` → left, `right` → right, `full` →
the rule declines. Refusals: no column references; non-functional conjunct; any conjunct whose
whole-subtree attribute walk sees an id outside both branches (every subquery-carrying and
outer-correlated conjunct); and, per branch, any branch whose subtree carries a write.

Two decisions the implement stage took beyond the ticket, both **upheld on review**:

- **Registration moved** to immediately after `predicate-inference-equivalence` (not the
  ticketed position between `aggregate-predicate-pushdown` and `predicate-pushdown`), and
  inference's own branch injection was deleted. Correct: the new rule strictly subsumes the
  injection (more join types, per-branch rather than whole-rule side-effect refusal), and
  keeping both would materialize the same conjunct twice on one branch. Inference's manifest
  entry dropping to `sideEffectMode: 'safe'` follows — it now only ANDs pure `col = value`
  conjuncts into a predicate.
- **Materialized-view maintenance analysis suppresses the new rule** for its two
  classification calls, because two of its plan-shape reads locate the body's `WHERE` at or
  above the join. Right call for this ticket's scope; the real fix is now filed (see below).

## Review findings

### Checked and clean

- **Soundness of the null-extension argument**, by hand for every row of the rule's join-type
  table, plus 12 fresh adversarial queries run against the built engine (self-join, 3-way
  join, `(A ⟕ B) ⋈ C` with the conjunct over B, LEFT-under-LEFT, single-side OR, cross-side
  OR, join inside a correlated `exists`, three-valued `<>` over a nullable column, FULL join
  with a conjunct per side, re-bound parameters, semi join, anti join). **No wrong answer
  found.** The valuable ones were kept as permanent tests rather than discarded.
- **`withChildren` threading** — read `JoinNode.withChildren` directly: `existence` specs are
  passed verbatim and `usingColumns` survives an unchanged condition. The rule's comment is
  accurate.
- **Attribute-id disjointness** of the two branches, which `attributeSide` depends on —
  confirmed at the source: `CTEReferenceNode.buildAttributes` mints fresh ids per reference,
  so even two references to one CTE cannot collide.
- **`optimizeForAnalysis({disabledRules})`** — `OptimizerTuning` is a plain readonly
  interface, so the spread clone is safe; the other four `optimizeForAnalysis` callers
  (assertions, change-scope, row-specific classification, explain) pass no disables and their
  own specs pass.
- **Test churn** — every re-shaped assertion in `filter-selectivity`, `join-row-estimates`,
  `column-origins`, `fd-equivalence` and the two regenerated plan goldens was re-derived, not
  loosened; each keeps its original claim one level down.
- **Conjunct reordering** when a side-effect refusal appends refused conjuncts to the residual
  is not a semantic concern: `rule-filter-conjunct-ordering` already reorders top-level
  conjuncts by selectivity in a later pass, so AND order is not load-bearing anywhere.

### Fixed in this pass (minor)

- **`buildMaintenancePlan`'s doc comment was orphaned.** The new `ANALYSIS_DISABLED_RULES`
  block was inserted *between* the function's long JSDoc and the function, so the JSDoc
  documented the constant. Moved the constant above.
- **Dead struct after the injection deletion.** `InferredConjunct.sourceColIdx` and `.value`
  became write-only once `tryBranchInjection` was removed; the accumulator is now a plain
  `ScalarPlanNode[]`.
- **Stale doc.** `docs/optimizer-fd.md` still claimed inference "emits a `u.k = 5` conjunct on
  the u-branch". It ANDs it into the Filter above the join now.
- **Undocumented coupling.** `docs/mv-maintenance.md` § `'join-residual'` described the two
  shape reads but not that the analyzer suppresses an optimizer rule to keep them working.
  Added, with a pointer to the follow-up ticket.
- **Doc list order.** `ruleJoinPredicatePushdown`'s bullet in `docs/optimizer-rules.md` sat
  *before* `rulePredicateInferenceEquivalence`'s although it registers after it; moved so the
  Predicate family list reads in registration order.
- **Refusal under-documented.** The rule header framed the "id in neither branch" refusal as
  the subquery case only. An outer-correlated reference hits the same branch; documented.

### Test gaps closed (the handoff called its own tests a floor — they were)

Nine cases added to `rule-join-predicate-pushdown.spec.ts` (19 → 27, all passing):

- **`semi` / `anti` are reachable and now pinned.** The handoff recorded them as "encoded but
  untested … unobservable from SQL". Half wrong: `subquery-decorrelation` turns `x in (…)`
  into a `SEMI HASH JOIN` and `not exists (…)` into an `ANTI HASH JOIN`, and the rule does
  push the left conjunct below both. Two tests now assert the join kind and the push. (What
  genuinely stays unobservable is the *right-side* restriction, since those joins expose no
  right attributes.)
- **Rule-level idempotence**, the other named gap: the rule function is now called directly on
  the residual Filter it produced and must return `null`. The pre-existing pass-level fixed
  point could not distinguish "declined" from "fired and was undone".
- 3-way join push to the innermost branch; a conjunct over a LEFT sub-join's null-extended
  side (relocated onto the inner join's branch, then correctly refused by the sub-join);
  single-side vs cross-side OR; three-valued logic for a pushed conjunct over a nullable
  column; self-join side attribution.

### Filed as a new ticket (major)

- `backlog/debt-mv-shape-analysis-blind-to-pushed-predicates` — make the materialized-view
  maintenance analyzer read the body's `WHERE` wherever the optimizer put it, so
  `ANALYSIS_DISABLED_RULES` can be deleted. Root cause is two sites:
  `bodyWhereReferencesLookup` (mechanical) and the coverage prover's lookup-side strictness in
  `resolveFullScanTableRef` (a soundness decision, which is why it is a ticket and not an
  inline fix). Today's suppression is correct and guarded; the liability is that it is a
  standing coupling with a silent failure mode, and that the blind spot it hides is now
  unexercised. The implementer flagged this and asked for a second opinion — this is it.

### Tripwires (recorded in code, not filed)

- **Outer-correlated conjuncts are refused pessimistically.** When a `Filter(Join)` is itself
  the body of a correlated subquery, a conjunct like `x.a = <outer>.b` sees an id in neither
  branch and stays above, even though it would be safe on the `x` branch. Recovering it means
  telling a genuinely-outer id apart from a subquery-internal one, which the current walk does
  not do. `NOTE:` in the rule header's refusal list; revisit if a real correlated body is
  measured losing a seek.
- **The MV analysis rule-disable list is a shape coupling**, not a general escape hatch — any
  future Structural rule that relocates a body's `WHERE` belongs on it. `NOTE:` already at
  `ANALYSIS_DISABLED_RULES`, kept and extended with the follow-up ticket slug.

### Deliberately not pursued

- **No performance measurement.** The handoff's claim of fewer base-table rows read rests on
  an `INDEXSEEK` replacing an `INDEXSCAN` in the plan, not on a measured I/O count. That is
  the right evidence for the mechanism and the review did not re-time the 4-way reporting
  query; a timing harness is out of scope for a review pass.
- **`yarn test:store` not run** (LevelDB module path). The new logic cases exercise join
  semantics that are module-independent, and no store-facing file changed.

## Validation

| command | result |
|---|---|
| `yarn workspace @quereus/quereus run test` | 8324 passing, 13 pending, 0 failing |
| `yarn test` (all workspaces) | green (3m 25s) |
| `yarn typecheck` | green |
| `yarn lint` | green |
| `yarn build` | green |
| `yarn docs:check` | 1 failure — `docs/sync.md` word ratchet, untouched by this ticket and owned by `debt-doc-size-ratchet-red-at-head` (`tickets/.pre-existing-known.md`). No doc this ticket edited trips its ratchet. |

## Still out of scope

`ON`-clause conjunct pushdown, null-rejecting outer→inner conversion, and widening the
subquery refusal remain parked in `backlog/feat-join-on-condition-pushdown` and
`backlog/feat-outer-join-to-inner-on-null-rejecting-filter`.
