description: When a WHERE clause combines a cheap test with an expensive one using AND, run the cheap test first so the expensive one is skipped for rows the cheap test already rules out.
prereq: feat-filter-conjunct-early-exit
files: packages/quereus/src/planner/rules/predicate/, packages/quereus/src/planner/cost/, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/test/plan/, docs/optimizer.md, docs/optimizer-rules.md
difficulty: hard

## Background

With `feat-filter-conjunct-early-exit` landed, a `Filter` stops evaluating its
conjuncts as soon as one rejects the row. That makes conjunct **order**
load-bearing — and today nothing orders them. A `Filter`'s conjuncts sit in the
order the user typed them (modulo whatever rewriting rules did to the AND tree),
so writing the expensive test first costs the expensive test on every row.

Measured on `main` (12-row table, `sidefx()` counting UDF, 4 rows have `k = 2`,
3 rows have `v % 5 = 2`):

| query | `sidefx()` calls | after this ticket |
|---|---|---|
| `where v % 5 = 2 and sidefx() = 1` | 12 → 3 (ticket 1) | 3 |
| `where sidefx() = 1 and v % 5 = 2` | 12 | **3** |
| `where (select sidefx()) = 1 and k = 2 and v % 5 = 2` | 4 | **1** |
| `where k = 2 and v % 5 = 2 and (select sidefx()) = 1` | 1 | 1 |

Each pair is the same query written in a different order. The engine should not
care.

### What is already handled — do not re-solve it

`rule-predicate-pushdown` splits a `Filter` into a *supported* portion (pushed
into the `Retrieve` pipeline, where it becomes an index seek / scan predicate) and
a *residual* portion left above. Only simple `column op literal` shapes are ever
"supported", so a subquery or UDF conjunct is always residual and always ends up
**above** the pushed cheap conjunct. That layering is already cheap-first and is
not the problem. Verified: `where (select sidefx()) = 1 and k = 2` plans as
`Filter[(select sidefx()) = 1] → Filter[k = 2] → IndexScan` regardless of written
order.

The gap is **within one `Filter` node**, among the residual conjuncts that share
it.

## What to build

A new optimizer rule that reorders the top-level conjuncts of a single
`FilterNode` predicate by estimated evaluation cost, cheapest first.

### Cost model for a conjunct

A plain `getTotalCost()` comparison is not enough. Measured conjunct costs:

| conjunct | `getTotalCost()` | contains subquery |
|---|---|---|
| `v % 5 = 2` | 0.022 | no |
| `(select sidefx()) = 1` | 0.051 | yes |
| `(select max(id) from t) = 1` | 1101.04 | yes |
| `v + v * 3 - v * 7 = 2` | 0.053 | no |

A tableless subquery (`(select sidefx())`) costs barely more than a modulo, and
*less* than a three-term arithmetic expression — so pure cost would order the
subquery **before** the arithmetic, which is backwards. Node-count-derived cost
does not model "this opens a whole sub-program per row".

So order on a two-part key: a coarse **tier** first, subtree cost as tiebreak.

```ts
// packages/quereus/src/planner/cost/conjunct-cost.ts  (NEW FILE)
// Do NOT re-export from cost/index.ts: nodes/filter.ts imports cost/index.ts,
// and this module imports plan-node + characteristics, so re-exporting would
// create an import cycle.

/** How expensive a WHERE conjunct is to evaluate once, coarsest signal first. */
export enum ConjunctCostTier {
  /** Pure, deterministic scalar arithmetic / comparison. */
  Pure = 0,
  /** Contains a non-deterministic (volatile) scalar — e.g. a volatile UDF. */
  Volatile = 1,
  /** Contains a relational descendant — a scalar / IN / EXISTS subquery. */
  Subquery = 2,
}

export interface ConjunctCost {
  tier: ConjunctCostTier;
  subtreeCost: number;   // node.getTotalCost()
}

export function classifyConjunctCost(node: ScalarPlanNode): ConjunctCost;

/** (tier, subtreeCost) lexicographic. Ties resolve to 0 — callers keep
 *  source order for ties via a stable sort. */
export function compareConjunctCost(a: ConjunctCost, b: ConjunctCost): number;
```

`classifyConjunctCost` walks the conjunct's subtree once (iteratively, no
recursion — matching `PlanNodeCharacteristics.subtreeHasSideEffects`) and
reports the **highest** tier it finds: `Subquery` if any strict descendant
satisfies `isRelationalNode`, else `Volatile` if any node reports
`PlanNodeCharacteristics.isDeterministic(n) === false`, else `Pure`.

### The rule

`packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts`,
exporting `ruleFilterConjunctOrdering(node, context)`:

- Bail unless `node.nodeType === PlanNodeType.Filter`.
- Split with `splitConjuncts` (returns conjuncts in left-to-right source order).
  Bail if `< 2` conjuncts.
- **Refuse when any conjunct's subtree has side effects**
  (`PlanNodeCharacteristics.subtreeHasSideEffects`). Predicates are pure today,
  but reordering with early exit changes evaluation counts, so gate explicitly
  and register the rule `sideEffectMode: 'safe'` honestly on the back of that
  guard.
- Classify each conjunct, **stable-sort** by `compareConjunctCost` (JS
  `Array.prototype.sort` is stable, so equal-cost conjuncts keep source order —
  this is the determinism requirement; do not shuffle or hash).
- **Return `null` when the sorted sequence is element-wise reference-identical to
  the input.** This is not an optimization — it is what stops the fixed-point
  loop. A split/recombine that unconditionally rebuilds would flip conjunct order
  forever.
- Otherwise rebuild with `combineConjuncts` and return a new `FilterNode`.

**Preserve the stamped selectivity.** Construct the replacement directly —
`new FilterNode(filter.scope, filter.source, reordered, undefined, filter.selectivity)`
— rather than via `withPredicate`, which drops `selectivity` on any predicate
change. Reordering does not change the conjunct *set*, so the estimate stamped by
`rule-filter-selectivity` (Physical pass) remains exactly as valid. Losing it
would perturb `estimatedRows` and, through it, later PostOptimization decisions.

### Registration

Register in `RULE_MANIFEST` (`src/planner/optimizer.ts`) as
`pass: PassId.PostOptimization`, `nodeType: PlanNodeType.Filter`,
`phase: 'rewrite'`, `id: 'filter-conjunct-ordering'`, `sideEffectMode: 'safe'`,
placed **at the end** of the manifest's PostOptimization block, after
`scalar-subquery-cache`.

Rationale to put in the registration comment: every rule that reshapes a
predicate (`sargable-range-rewrite`, `predicate-pushdown`, `filter-merge`,
`predicate-inference-equivalence` — all Structural) has finished, and
`filter-selectivity` (Physical) has stamped its estimate, so the conjunct set is
final and ordering it once is stable. PostOptimization is bottom-up, so a
conjunct's subquery subtree has already been through `scalar-subquery-cache` when
the `Filter` above it is visited — the cost read is the final one.

## Deliberately out of scope

- **Selectivity-aware ranking.** The textbook rank is `(1 - selectivity) / cost`,
  not cost alone, and `rule-filter-selectivity` already estimates per-conjunct
  selectivity on the multi-relation path. Cost-only ordering is what this ticket
  delivers; the selectivity refinement is parked in
  `backlog/feat-conjunct-ordering-selectivity`.
- **Join `ON` conditions.** `JoinNode` conditions are conjunctions too and would
  benefit from the same treatment, but they interact with join-key extraction and
  physical join selection. Not touched here.

## Edge cases & interactions

- **Idempotence / fixed point** — running the rule on its own output must return
  `null`. Assert directly in a unit test (call the rule twice) as well as via the
  absence of an optimizer non-convergence error.
- **Equal-cost conjuncts keep source order** — two structurally identical
  conjuncts (`a = 1 and b = 1`) must not swap. Plan-level assertion.
- **Ordering never changes results** — every reordered query returns the same
  rows in the same order. Cover `NULL` conjuncts specifically: `where null and
  k = 2` and `where k = 2 and null` must both return zero rows before and after.
- **3VL under reordering** — reordering `a and b` to `b and a` is sound because
  SQL `AND` is commutative under three-valued logic *and* a `Filter` rejects on
  both `false` and `NULL`. Pin with an end-to-end truth-table case rather than
  asserting it in prose only.
- **Guard idioms** — `where v <> 0 and 10 / v > 1` must still work. It does
  regardless of order (Quereus division by zero yields `NULL`, it does not
  raise), and cost ordering happens to leave the simpler guard first anyway.
  Include the case so a future cost-model change cannot silently break it.
- **Side-effecting conjunct** — the refusal guard must actually fire; construct
  or simulate a `Filter` whose predicate subtree reports
  `physical.readonly === false` and assert the rule returns `null`.
- **Single conjunct / non-AND predicate** — rule returns `null`, plan byte-identical.
- **`HAVING` filters** — `select-aggregates.ts` builds `FilterNode`s for `HAVING`
  too, so the rule applies there as well. Confirm a `having a and b` query still
  returns correct results.
- **Filters inside a `Retrieve` pipeline** — the pushed-down inner `Filter` is
  also a `FilterNode` and will be visited. Reordering it is harmless (it is a
  residual over the module's own predicate handling) but must not disturb the
  `Retrieve` bindings; verify with a vtab-backed plan test.
- **Correlated conjuncts** — a conjunct correlated to an outer row must produce
  identical results when moved later or earlier; no conjunct depends on another
  conjunct having run.
- **Golden plans churn** — reordering changes `detail` strings in
  `packages/quereus/test/plan/**/*.plan.json`. Regenerate with
  `UPDATE_PLANS=true` on the golden spec and **review the diff by eye**: every
  changed golden should show only a conjunct permutation, never a structural
  change. A structural diff means the rule did more than reorder — stop and fix.
- **`splitConjuncts` is source-ordered** — there is one splitter and it preserves
  left-to-right order (the earlier scrambling variant was removed in review of
  ticket 1). "Already ordered?" comparisons can rely on that.

## TODO

- Add `packages/quereus/src/planner/cost/conjunct-cost.ts`
  (`ConjunctCostTier`, `ConjunctCost`, `classifyConjunctCost`,
  `compareConjunctCost`), with the iterative subtree walk and the "do not
  re-export from cost/index.ts" comment explaining the cycle.
- Add `packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts`
  with the side-effect refusal, stable sort, already-ordered `null` return, and
  selectivity-preserving `FilterNode` construction.
- Register it in `RULE_MANIFEST` at the end of the PostOptimization block, with
  the placement rationale in a comment.
- Tests — new `packages/quereus/test/where-conjunct-ordering.spec.ts`:
  - counting-UDF evaluation counts for all four table rows above, asserting both
    written orders of each query converge on the same low count;
  - plan-level assertion (via `test/plan/_helpers.ts` `planRows` / `db.getPlan`)
    that the `Filter` detail shows the cheap conjunct first;
  - equal-cost conjuncts keep source order;
  - the rule returns `null` on its own output (idempotence) and on a
    single-conjunct filter;
  - the side-effect refusal guard.
- Tests — new `packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic`:
  end-to-end row-set parity for both written orders, `NULL` conjuncts, the
  `v <> 0` guard idiom, and a `HAVING` conjunction.
- Regenerate golden plans (`UPDATE_PLANS=true`) and review the diff.
- Run `yarn test` from the repo root (stream with `tee`), then
  `yarn workspace @quereus/quereus run lint`.
- Docs: add the rule to the catalog in `docs/optimizer-rules.md` (match/guards/
  soundness argument, in the same shape as its neighbours), and add a short
  paragraph under `docs/optimizer.md` § "Cost Model Integration" describing the
  conjunct cost tier and why raw `getTotalCost()` alone misorders a tableless
  subquery. Do not add a new doc file.
