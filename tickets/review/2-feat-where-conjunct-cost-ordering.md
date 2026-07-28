description: When a WHERE clause combines a cheap test with an expensive one using AND, the engine now runs the cheap test first so the expensive one is skipped for rows the cheap test already rules out — regardless of the order the user wrote them.
prereq: feat-filter-conjunct-early-exit
files: packages/quereus/src/planner/cost/conjunct-cost.ts, packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic, packages/quereus/test/filter-conjunct-early-exit.spec.ts, docs/optimizer-rules.md, docs/optimizer.md, tickets/fix/bug-filter-conjunct-lost-under-index-order.md

## What shipped

A new PostOptimization rule, `filter-conjunct-ordering`, that sorts the
top-level AND conjuncts of every `FilterNode` predicate cheapest-first, so the
conjunct early exit landed by `feat-filter-conjunct-early-exit` pays off for
both written orders of a query.

- `src/planner/cost/conjunct-cost.ts` (new) — `ConjunctCostTier` (`Pure` <
  `Volatile` < `Subquery`), `classifyConjunctCost` (one iterative subtree walk,
  highest tier wins; `Subquery` = any strict relational descendant, `Volatile` =
  any non-deterministic node), `compareConjunctCost` ((tier, subtreeCost)
  lexicographic, ties → 0). Deliberately NOT re-exported from `cost/index.ts`
  (import cycle via `nodes/filter.ts`; comment at the top explains).
- `src/planner/rules/predicate/rule-filter-conjunct-ordering.ts` (new) — bails
  on non-Filter / < 2 conjuncts / any side-effecting conjunct subtree
  (`subtreeHasSideEffects`); stable-sorts; returns `null` when the sorted
  sequence is element-wise reference-identical to the input (the fixed point
  that stops the rewrite loop); otherwise rebuilds via `combineConjuncts` and
  constructs the replacement `FilterNode` directly with the original
  `selectivity` carried through (NOT `withPredicate`, which drops it).
- `src/planner/optimizer.ts` — registered at the END of the PostOptimization
  manifest block, after `scalar-subquery-cache`, `sideEffectMode: 'safe'`
  (honest on the back of the explicit refusal guard); placement rationale in
  the registration comment.

Measured effect (12-row table, counting UDF `sidefx`, pinned in the spec):

| query | before | after |
|---|---|---|
| `where v % 5 = 2 and sidefx() = 1` | 3 calls | 3 |
| `where sidefx() = 1 and v % 5 = 2` | 12 calls | **3** |
| `where (select sidefx()) = 1 and k = 2 and v % 5 = 2` | 4 calls | **1** |
| `where k = 2 and v % 5 = 2 and (select sidefx()) = 1` | 1 call | 1 |

## Tests

- `test/where-conjunct-ordering.spec.ts` (new, 19 tests): evaluation counts for
  all four queries above; plan-shape assertions that the optimized Filter's
  detail puts the pure conjunct before the volatile/subquery one (both written
  orders) and that the pushed `k = 2` Filter survives below the residual;
  equal-cost conjuncts keep source order both ways; tier classification units
  (Pure / Volatile / Subquery, subquery-outranks-volatile, tier dominates raw
  cost for the tableless-subquery-vs-arithmetic case from the ticket); direct
  rule invocation — reorder-then-fixed-point (idempotence), null on
  already-ordered / single-conjunct / OR predicates, selectivity preservation,
  and the side-effect refusal (simulated by shadowing a conjunct's `physical`
  with `readonly: false` on an expensive-first predicate the rule would
  otherwise swap).
- `test/logic/07.7.4-where-conjunct-ordering.sqllogic` (new): row-set parity
  for both written orders (subquery + arithmetic), NULL conjuncts in both
  positions, the `v <> 0` division-guard idiom both ways, HAVING conjunctions
  both ways, and the `a and b` / `b and a` three-valued-logic truth table over
  all 9 `{true,false,null}²` pairs.
- `test/filter-conjunct-early-exit.spec.ts` (ticket 1's suite) — two tests
  updated exactly as that suite's comments anticipated: the pinned
  "expensive conjunct written FIRST runs for every row" now asserts 3 calls
  (reordered), and the async-interleave test's trailing conjunct became a
  subquery so the volatile async call stays in the MIDDLE position the test
  exists to exercise (a trailing pure conjunct now sorts ahead of it).

## Validation performed

- `yarn test` (repo root, all workspaces) — green; quereus 7670 passing, 0
  failing.
- `yarn workspace @quereus/quereus run test:context-strict` — 7673 passing, 0 failing.
- `yarn workspace @quereus/quereus run test:fork-strict` — 7661 passing, 0 failing.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc) — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `node scripts/check-docs.mjs` — clean.
- Golden plans: **zero churn** — the full `test/plan` suite (230 tests,
  including the golden corpus) passes untouched; no golden exercises a
  misordered multi-conjunct residual Filter, so no regeneration was needed.
  A reviewer wanting belt-and-braces can re-run `UPDATE_PLANS=true yarn
  test:plans` and confirm an empty diff.
- `yarn test:store` NOT run (wall clock exceeds the agent budget; the change is
  planner-side and storage-agnostic — same deferral ticket 1 made).

## Honest flags for the reviewer

- **Pre-existing wrong-results bug encountered, not caused.** The ticket's
  headline 3-conjunct queries with `order by id` (ascending, satisfied by the
  PK scan) silently LOSE the pushed `k = 2` conjunct — reproduced with this
  rule disabled via `disabledRules`, and it is the already-tracked
  `tickets/fix/bug-filter-conjunct-lost-under-index-order`. New data point
  discovered and appended to that ticket: in the 3-conjunct shape the bug fires
  even when the filtered column IS selected (that near-miss only holds for 2
  conjuncts). The new spec and sqllogic use `order by id desc` (a documented
  non-triggering variant, verified) with `NOTE:` comments; the fix ticket's
  regression list now names both spots to restore.
- **`docs/optimizer-rules.md` is at its 12,000-word cap.** Fitting the new
  catalog bullet required trimming stale text (the retired IN-subquery-cache
  bullet, the MaterializationAdvisory/constant-folding bullets, and the cap
  NOTE — which falsely claimed ~1,700 words of headroom). The doc now sits at
  11,998 words and its NOTE says the NEXT addition must split it at the
  `src/planner/rules/` subdirectory boundary. The mechanism detail (tier
  rationale, cost numbers, cycle note) lives in `docs/optimizer.md` § Cost
  Model Integration → "Conjunct cost tiers", which the bullet links.
- **Tier model is deliberately coarse.** Cost-only ranking; the
  `(1 - selectivity) / cost` refinement is parked in
  `backlog/feat-conjunct-ordering-selectivity` (pre-existing). A cheap volatile
  UDF always sorts behind an expensive pure expression — acceptable for v1 and
  covered by the parked ticket. Join `ON` conjunct ordering is out of scope per
  the ticket.
- **Side-effect refusal test is simulated.** No SQL today plans a
  side-effecting predicate conjunct (predicates are pure), so the guard test
  shadows a conjunct's `physical` property (`readonly: false`) rather than
  constructing a real side-effecting plan. The shadowed shape is
  expensive-first, so without the guard the rule would demonstrably swap.
