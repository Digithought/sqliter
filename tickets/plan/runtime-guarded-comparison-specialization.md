---
description: Comparisons still inspect what kind of value they received on every row even when the compiler knew both sides were, say, text; establish a shared "fast path with a safety check" pattern and apply it to the hottest comparison and arithmetic paths.
prereq: runtime-scalar-op-emit-time-specialization
files:
  - packages/quereus/src/util/comparison.ts        # compareSqlValuesFast / getStorageClass — the per-row classification; createTypedComparator — the existing guard-with-fallback precedent
  - packages/quereus/src/runtime/emit/binary.ts    # compare-fast and numeric-fast paths — first consumers
  - packages/quereus/src/runtime/emit/operand-comparator.ts  # makeGroupComparator — same-category branch, second consumer
  - packages/quereus/test/property.spec.ts         # comparison-property suites that pin semantics
difficulty: medium
---

# Guarded specialization for comparison and arithmetic hot paths

## The residual cost

After emit-time path selection, the "fast" comparison path (`compare-fast` in
`emit/binary.ts`) still calls `compareSqlValuesFast`, which per row runs
`getStorageClass` on both operands plus a switch — even when both operand logical types
are statically TEXT (or both numeric). Similarly `numeric-fast` arithmetic still runs a
`typeof === 'bigint'` dispatch per operand per row even when neither side can produce a
bigint.

The engine already contains the correct pattern in one place: `createTypedComparator`
wraps a type's own compare with a **storage-class mismatch guard** that falls back to
generic cross-type ordering when a runtime value doesn't match the declared type. That
"trust the static type, verify cheaply, fall back soundly" shape is exactly what the hot
paths need — it just isn't factored for reuse.

## Proposed specializations (to be validated in this plan pass)

- **Both TEXT** → run is: null checks, then `typeof a === 'string' && typeof b === 'string'
  ? collationFunc(a, b) : compareSqlValuesFast(a, b, collationFunc)`. One typeof pair
  replaces two getStorageClass calls + switch; the fallback keeps ANY-value drift sound.
- **Both numeric** → guard `typeof number` (the dominant case) → inline three-way compare;
  bigint/boolean drift falls to the generic path.
- **Arithmetic, both non-INTEGER numeric (REAL/FLOAT)** → if the representation rules say
  a REAL-typed expression can never yield a bigint, drop the bigint dispatch behind a
  typeof-number guard. This arm depends on what
  `runtime-physical-representation-invariant` concludes — design so the guard is
  droppable later, but do not wait for that ticket (the guarded form is sound today).

## Design questions to resolve

1. **Helper shape.** A shared `guardedRun(fastGuard, fastRun, genericRun)` combinator vs.
   hand-written guards per site. Weigh readability against closure-depth cost (V8 inlines
   small monomorphic closures well; measure, don't assume).
2. **Deopt caching.** Optionally swap the instruction's run to the generic version after
   the first guard miss (inline-cache style) so a drifting workload doesn't pay
   guard+fallback per row. Decide whether the added mutability is worth it — instructions
   are currently immutable after emit, and plan caching shares instructions across
   executions. Likely answer: skip deopt in v1, note as tripwire.
3. **Where the guard belongs.** In the emitters (per-site) vs. new factory functions in
   `util/comparison.ts` next to the existing comparator factories. The latter keeps ONE
   routing-rule home, consistent with `makeGroupComparator`'s "THE one copy" doc claim.
4. **Which sites are actually hot.** Confirm with `yarn bench` (the BINARY collation
   comparator is documented as the engine's hottest path — the both-TEXT arm is the
   likely payoff; the ORDER BY / BTree comparator paths already pre-resolve and may not
   need changes).

## Constraints

- The property test suites (comparison antisymmetry/transitivity, ORDER BY collation
  consistency, key soundness) pin semantics — all fast paths must be observationally
  identical to `compareSqlValuesFast` for values matching their guard, and fall back for
  everything else. No behavior change, only branch count.
- Do not touch `compareSqlValues` / `compareSqlValuesFast` public exports (plugin API
  surface, `test/exports.spec.ts`).

## Expected outputs

Implement ticket(s) naming: the factory/helper additions, the emitter sites converted,
the bench evidence gathered in planning (before/after on comparison-heavy benchmarks),
and the tripwire note for deopt caching if declined.
