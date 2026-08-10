description: A constant subquery like "where x > (select max(y) from t)" used to re-run for every row; now it computes once per execution and is reused.
files: packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts
----

# Complete: cache uncorrelated scalar subqueries so they run once per execution

## What shipped

`emitScalarSubquery` re-drained its inner pipeline on every evaluation, so an
uncorrelated scalar subquery in a WHERE / projection / ORDER BY / HAVING
expression re-executed its full source scan once per outer row (N outer rows →
N inner scans).

New planner rule **`ruleScalarSubqueryCache`**
(`packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts`), a
near-mirror of `ruleInSubqueryCache`, wraps a `ScalarSubqueryNode`'s `subquery`
child in a `CacheNode` when the inner is uncorrelated + functional + not-already
-cached. Registered in `optimizer.ts` as `scalar-subquery-cache`
(`PassId.PostOptimization`, `nodeType: PlanNodeType.ScalarSubquery`,
`sideEffectMode: 'aware'`), directly after `in-subquery-cache`. No emit change:
`emitScalarSubquery` already emits `plan.subquery` via `emitPlanNode`, so the
injected `CacheNode` is emitted transparently.

The `CacheNode` is built **non-eager** (streaming), the deliberate contrast with
the IN rule's eager mode. `emitScalarSubquery` has no short-circuit — its pure
consumer reads every input row (it must, to detect the ">1 row" error) — so a
streaming cache is fully drained and committed on the first evaluation and
replays thereafter.

## Review findings

Reviewed the implement-stage diff (commit `58e06be3`) against the source it
touches and the paths it should have touched. Ran full lint + test suite.

### Correctness — verified, no defects

- **Non-eager crux holds.** Traced `emitScalarSubquery`'s pure `run`
  (`runtime/emit/subquery.ts`): it iterates the entire input, only aborting early
  by *throwing* on a second row. So `streamWithCache`'s streaming-first path
  yields each row while buffering and commits `state.cachedResult` after the
  source drains — which always happens for a valid (≤1-row) scalar subquery.
  Later evaluations replay from the buffer. The eager-vs-non-eager reasoning in
  the module header is correct.
- **>1-row error stays transparent.** Streaming-first yields the second row to
  the consumer, which throws before the cache commits; the query aborts. Cache
  never masks the error. Covered by the existing `>1-row` test.
- **Type / attribute passthrough intact.** `CacheNode.getType()` and
  `getAttributes()` mirror their source, so `ScalarSubqueryNode`'s first-column
  type inference is unaffected by the wrap. `withChildren` threads `eager`
  through and type-checks the child is relational.
- **Gate consistency.** The `isFunctional(inner)` gate excludes impure
  (DML-bearing) inners, which therefore skip the cache and keep their existing
  run-once `executionMemo` path in `emitScalarSubquery` (untouched). The
  already-cached gate makes the rule idempotent under the fixpoint pass.
- **Rebuild via `withChildren`** (vs the IN rule's manual `new InNode(...)`) is
  the more robust choice — future constructor fields can't be silently dropped.

### Minor — fixed inline this pass

- **Coverage was WHERE-only.** The implementer flagged that no test asserted the
  scan-count win for a scalar subquery outside a WHERE predicate, even though the
  rule fires on node type (position-agnostic). Added two scan-count tests to
  `scalar-subquery-cache-scan-count.spec.ts`: one for a **projection-list**
  scalar subquery (`select id, (select max(k) from counting) as m from probe`)
  and one for an **ORDER BY** scalar subquery. Both build the cache once and
  replay (scan count 1), confirming the win is not WHERE-specific. Suite now 7
  cases (was 5); all pass.

### Checked — acceptable as-is, no action

- **Over-threshold test uses `threshold: 0`.** This is inherent to scalar
  semantics: a valid scalar subquery buffers ≤1 row, so the abandon path is only
  reachable at threshold 0. Not a rule bug; the degenerate value still exercises
  the abandon-and-stream branch of `streamWithCache`. Acceptable.
- **DRY vs `ruleInSubqueryCache`.** The two rules share ~30 lines of gate logic
  but diverge on the parts that matter (eager vs non-eager, `InNode.source` vs
  `ScalarSubqueryNode.subquery`, manual rebuild vs `withChildren`) and each
  carries a detailed per-rule header documenting its eager/non-eager rationale.
  Extracting a shared helper would obscure that documentation and matches no
  existing pattern — the sibling `rule-*-cache.ts` files are each self-contained.
  Left as-is, consistent with house style.
- **HAVING position** remains behaviorally untested, but projection + ORDER BY +
  WHERE now prove position-agnosticism through the same emit path; HAVING adds no
  new mechanism. Not worth an additional case.
- **Impure (DML-in-scalar-position) path** has no new direct test; it relies on
  existing coverage. Full suite passes with the impure path untouched, so no
  regression. Acceptable — the gate provably excludes it from the new rule.
- **Decorrelation interplay.** `scalar-agg-decorrelation` /
  `subquery-decorrelation` goldens did not regress; only surviving
  `ScalarSubqueryNode`s reach this PostOptimization rule. Interaction order sound.

### Tripwires

None. The over-threshold degeneracy is inherent to scalar semantics (buffer ≤1
row), not a conditional future concern, so it is documented above rather than
parked as a `NOTE:` at a code site.

### No major findings — no new tickets filed.

## Validation

- `yarn workspace @quereus/quereus test` → **7061 passing, 0 failing, 13 pending**
  (was 7059; +2 new position tests).
- `yarn workspace @quereus/quereus lint` → clean (exit 0; includes tsc over test
  files).
- `git status` → only the 3 intended files touched; no golden plans in
  `test/plan/` or `test/optimizer/` regressed.
