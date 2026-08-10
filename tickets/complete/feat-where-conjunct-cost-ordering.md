description: When a WHERE clause combines a cheap test with an expensive one using AND, the engine now runs the cheap test first so the expensive one is skipped for rows the cheap test already rules out — regardless of the order the user wrote them.
files: packages/quereus/src/planner/cost/conjunct-cost.ts, packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic, packages/quereus/test/filter-conjunct-early-exit.spec.ts, packages/quereus/test/fuzz.spec.ts, docs/optimizer-rules.md, docs/optimizer.md

## What shipped

A PostOptimization rule, `filter-conjunct-ordering`, that sorts the top-level
AND conjuncts of every `FilterNode` predicate cheapest-first, so the conjunct
early exit landed by `feat-filter-conjunct-early-exit` pays off for both written
orders of a query.

- `src/planner/cost/conjunct-cost.ts` — `ConjunctCostTier` (`Pure` <
  `Volatile` < `Subquery`), `classifyConjunctCost` (one iterative subtree walk,
  highest tier wins; `Subquery` = any relational descendant, `Volatile` = any
  non-deterministic node), `compareConjunctCost` ((tier, subtreeCost)
  lexicographic). Not re-exported from `cost/index.ts` — that would close an
  import cycle through `nodes/filter.ts`; a comment at the top says so.
- `src/planner/rules/predicate/rule-filter-conjunct-ordering.ts` — bails on
  non-Filter / < 2 conjuncts / any side-effecting conjunct subtree;
  stable-sorts; returns `null` when the sorted sequence is element-wise
  reference-identical to the input; otherwise rebuilds via `combineConjuncts`
  and constructs the replacement `FilterNode` directly, carrying the original
  `selectivity` through (`withPredicate` drops it).
- `src/planner/optimizer.ts` — registered at the end of the PostOptimization
  manifest block, after `scalar-subquery-cache`; `sideEffectMode: 'aware'`.

Measured effect (12-row table, counting UDF `sidefx`, pinned in the spec):

| query | before | after |
|---|---|---|
| `where v % 5 = 2 and sidefx() = 1` | 3 calls | 3 |
| `where sidefx() = 1 and v % 5 = 2` | 12 calls | **3** |
| `where (select sidefx()) = 1 and k = 2 and v % 5 = 2` | 4 calls | **1** |
| `where k = 2 and v % 5 = 2 and (select sidefx()) = 1` | 1 call | 1 |

## Tests

- `test/where-conjunct-ordering.spec.ts` (20 tests): evaluation counts for all
  four queries above; plan-shape assertions that the optimized Filter orders
  Pure before Volatile before Subquery from every written order, and that the
  pushed `k = 2` Filter survives below the residual; equal-cost conjuncts keep
  source order both ways; tier classification units; direct rule invocation —
  reorder-then-fixed-point, null on already-ordered / single-conjunct / OR
  predicates, selectivity preservation, side-effect refusal.
- `test/logic/07.7.4-where-conjunct-ordering.sqllogic`: row-set parity for both
  written orders (subquery + arithmetic), NULL conjuncts in both positions, the
  `v <> 0` division-guard idiom both ways, HAVING conjunctions both ways, and
  the `a and b` / `b and a` three-valued-logic truth table over all 9
  `{true,false,null}²` pairs.
- `test/fuzz.spec.ts`: the rule joins `PREDICATE_RULES` in the differential
  harness, so every generated schema/query pair is now compared with the
  reorder on and off.
- `test/filter-conjunct-early-exit.spec.ts` (ticket 1's suite): two tests
  updated for the new ordering, as that suite's comments anticipated.

## Review findings

### Checked

Read the implement diff (`9a39ea7e`) cold before the handoff summary, then
verified each mechanism against its surrounding code rather than its comment:

- **Rule mechanics** — fixed point, stable sort, selectivity carry-through,
  side-effect refusal, and direct `FilterNode` construction instead of
  `withPredicate`. Cross-checked every `new FilterNode(` site: none passes a
  non-`undefined` `estimatedCostOverride`, so dropping that argument is a no-op.
- **Framework interaction** — `PassManager.applyPassRules` marks a rule applied
  on the old node id and inherits that set onto the rewrite's output, so a rule
  is never re-offered its own result. The rule's own already-ordered `null`
  return is therefore belt-and-braces for the engine loop, and load-bearing for
  direct invocation; both are fine. Placement checked against the other
  PostOptimization Filter rule (`monotonic-range-access-filter`, registered
  earlier) and `scalar-subquery-cache`.
- **Node freshness** — `PlanNode.physical` is a lazy getter with a post-order
  fill, so a FilterNode minted during PostOptimization computes real physical
  properties rather than inheriting stale ones.
- **Row-set soundness** — three-valued logic, NULL conjuncts, HAVING, correlated
  conjuncts, and the guard idiom, all pinned in the sqllogic; plus the new fuzz
  differential.
- **Docs** — read `docs/optimizer-rules.md` and `docs/optimizer.md` against the
  code they describe; `node scripts/check-docs.mjs` clean; word budgets measured
  directly (`optimizer-rules.md` 11,998 against a 12,000 cap, `optimizer.md`
  8,984, neither ratcheted).
- **Validation** — `yarn workspace @quereus/quereus run lint`, `typecheck`,
  `node scripts/check-docs.mjs`, and full `yarn test` across all workspaces:
  0 failing (quereus 7671 passing). The `test/plan` golden corpus passes against
  the committed goldens, which is the direct confirmation of the implementer's
  zero-churn claim.

### Fixed in this pass (minor)

- **`sideEffectMode` was declared `'safe'`; changed to `'aware'`.** The rule
  moves conjunct subtrees relative to an early-exit emitter and leans on an
  explicit `subtreeHasSideEffects` refusal — which is the definition of
  `'aware'` in `framework/registry.ts`. Concretely, the OPT-003 static guard in
  `test/optimizer/side-effect-audit.spec.ts` only audits `'aware'` rules, so the
  `'safe'` declaration exempted this rule from the check that its refusal guard
  still exists. Deleting the guard would now fail the audit.
- **A ticket-1 test lost coverage in the handoff.** The async-interleave test's
  trailing conjunct was changed to `(select max(id) from t t2) >= 10`, which is
  true for every row — so nothing after the awaited conjunct ever rejected, and
  the test's stated purpose ("still stop at the first non-true conjunct") went
  untested for that position. Changed to `(select max(id) from t t2) - 10 < v`:
  still Subquery tier so it still sorts last and keeps the volatile call in the
  middle, but it rejects id 2 again. Expected rows back to `[7, 12]`.
- **Added the rule to the fuzz differential** (`PREDICATE_RULES` in
  `test/fuzz.spec.ts`). Reorder-on vs reorder-off row-set parity is exactly what
  this harness exists to prove, and the rule was not enrolled. Passes.
- **Added a plan-shape test** covering all three tiers from all three written
  orders; the suite previously only pinned two-tier pairs.

### Recorded as a tripwire, not a ticket

- **Reordering preserves values, not raised errors.** The implementation's
  soundness argument ("AND commutes under three-valued logic") is a claim about
  row sets. It does not cover a conjunct that *throws*: a guard idiom
  (`v <> 0 and 10 / v > 1`) is only safe while no scalar expression raises.
  Inert today — every arithmetic edge quereus defines returns NULL rather than
  throwing, division by zero included, and that is pinned in the new sqllogic —
  and a cheap guard sorts first anyway. It only becomes real if a scalar
  function that throws on bad input ships *and* a query guards it with a
  conjunct in a more expensive tier. Parked as a `NOTE:` in the rule's docstring
  (`rule-filter-conjunct-ordering.ts`) and as a paragraph in `docs/optimizer.md`
  § Conjunct cost tiers, each naming the two ways out (a per-function "may
  raise" trait, or requiring CASE for guarding as PostgreSQL does).

### Filed as a new ticket (major)

- **`backlog/debt-split-optimizer-rules-doc`** — `docs/optimizer-rules.md` is at
  11,998 words against a hard 12,000-word cap. Landing this rule's one-line
  catalog entry required deleting explanatory prose from three unrelated
  entries. That is not repeatable: the next rule author cannot document their
  rule without either gutting something load-bearing or performing an unplanned
  doc split mid-ticket. The doc already names its own split point; the ticket is
  to do it before it blocks someone.

### Explicitly not found

- **No correctness defect in the rule itself.** The reorder is sound for row
  sets, converges, preserves the stamped selectivity, and does not disturb the
  Retrieve pipeline's already-decided pushdown (access-path selection completes
  in the Physical pass, before this rule runs).
- **No re-report of the pre-existing wrong-results bug.**
  `tickets/fix/bug-filter-conjunct-lost-under-index-order` is already tracked;
  the implementer's `order by id desc` dodges, `NOTE:` comments, and the
  three-conjunct data point appended to that ticket are the right handling and
  were verified as such.
- **One piece of dead-but-harmless code left alone.** `classifyConjunctCost`'s
  `current !== node` check can never fire for a scalar conjunct root. It costs
  nothing and reads as defensive; not worth a diff.

### Deferred

- `yarn test:store` was not run — its wall clock exceeds the agent budget, and
  this change is planner-side and storage-agnostic. Same deferral as the two
  preceding tickets in this chain.
