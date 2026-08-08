---
description: Every small piece of an expression like "price * quantity > 100" is executed through the query engine's general-purpose instruction machinery on every row, with real bookkeeping overhead; compile pure expressions into single direct functions instead.
prereq: runtime-scalar-op-emit-time-specialization
files:
  - packages/quereus/src/runtime/scheduler.ts        # Scheduler.run / runSyncLoop — the per-invocation cost being bypassed (instrArgs allocation, per-instruction dispatch)
  - packages/quereus/src/runtime/emitters.ts         # emitCall / emitCallFromPlan — the sub-program wrapper fusion replaces
  - packages/quereus/src/runtime/emit/filter.ts      # conjunct sub-programs — first consumer
  - packages/quereus/src/runtime/emit/binary.ts      # specialized run builders to reuse as fused node bodies
  - packages/quereus/src/runtime/emit/aggregate.ts   # arg-evaluation sub-programs — second consumer
  - packages/quereus/src/runtime/emit/case.ts        # branch callbacks — lazy-invocation precedent to preserve
  - docs/runtime.md                                  # execution model doc — must describe the fusion tier when it lands
difficulty: hard
---

# Fuse pure scalar expression subtrees into single closures

## The cost being removed

Each scalar plan node emits one `Instruction`; scalar expressions invoked per row (filter
conjuncts, aggregate arguments, CASE branches, join key extractors, projections) run as
sub-programs — each invocation calls `Scheduler.run`, which **allocates a fresh
`instrArgs` array-of-arrays per call**, then loops instructions with a megamorphic spread
call (`instruction.run(ctx, ...args)`), a promise check, a destination lookup, and an
array push per instruction. For `price * quantity > 100` that is 5 "instructions"
(two column refs, a literal, `*`, `>`) — ~10 heap allocations and ~10 dynamic dispatches
per row to do 3 operations. A literal is "executed" per row.

## The proposal

An emit-time `tryFuseScalar(plan, ctx): ((rctx) => SqlValue) | undefined` that composes a
pure, synchronous scalar subtree bottom-up into one closure chain — direct calls, zero
scheduler involvement, zero per-row allocation, monomorphic and inlinable. Nodes that
cannot fuse (scalar subqueries, async UDFs, unknown node types) return undefined and the
caller falls back to today's `emitCallFromPlan` path unchanged. Closure composition only —
no `new Function` / eval (CSP, React Native).

Integration points, in payoff order: filter conjuncts, aggregate/GROUP BY argument
evaluation, CASE/AND-OR branch callbacks (fused as lazily-invoked closures, preserving
short-circuit semantics), sort key and join key extractors, projection expressions.

## Design questions to resolve

1. **Node coverage for v1.** Literal, ColumnReference (via `resolveAttribute`), BinaryOp,
   UnaryOp, Between, Case, Cast, Collate (pass-through), scalar function calls with
   synchronous implementations. Decide the sync-UDF question: `ScalarFunc` returns
   `MaybePromise` — fuse only functions the schema marks synchronous, or accept a
   returned-Promise check inside the fused closure? (A promise check per UDF call is
   still far cheaper than a sub-program; but it changes the fused-function contract from
   "SqlValue" to "MaybePromise" and infects the whole chain. Likely: fuse only
   provably-sync nodes in v1, treat MaybePromise UDFs as non-fusable.)
2. **Run-builder factoring.** The specialized run bodies currently built inline in
   emitters (`emitNumericOp`, `emitComparisonOp`, unary after its specialization ticket)
   must be callable both as instruction runs and as fused-node bodies without
   duplication. The prereq ticket's refactor should expose them; confirm and specify the
   shared signature.
3. **Tracing and metrics granularity.** A fused subtree is opaque to per-instruction
   tracing (`--show-trace`, `scheduler_program()`, instruction `runtimeStats`). Emission
   happens before run-time mode is known. Options: (a) fuse always, instruction `note`
   records the fused expression text; (b) compile statements with tracing/metrics
   requested through the unfused path (statement-level flag at prepare time); (c) emit
   both and select at run start. Resolve this — it is the main product decision. Note
   `bug-execution-trace-hangs-forever` (backlog) touches the tracing TVFs; don't couple,
   but don't break `row_trace`/`scheduler_program` output contracts.
4. **Error attribution.** Instruction-level errors currently carry the instruction note /
   plan location via each emitter's own QuereusError construction. Fused closures must
   not degrade error messages — each fused node body keeps its own error wrapping (they
   already do; verify with error-path logic tests).
5. **Where fusion is decided.** A front-door in `emitCallFromPlan` (transparent to all
   emitters) vs. explicit opt-in per consumer. Transparent is broader but makes the
   tracing decision (Q3) global; explicit lets hot sites adopt first. Recommend explicit
   for v1, transparent later — validate.
6. **Interaction with the CASE/AND-OR short-circuit machinery.** Those emitters build
   `BranchFn` callbacks from sub-programs; fusion replaces the sub-program *inside* the
   callback, keeping the laziness. Confirm the `MaybePromise` sync-fast contract in
   `runShortCircuit` / `step` is preserved when the branch is a plain closure.

## Measurement plan

Before/after `yarn bench` on: full table scan with multi-conjunct filter, aggregate-heavy
queries, sort with computed keys. The performance sentinels (`test/performance-sentinels.spec.ts`)
guard against regression; add a sentinel for filtered-scan throughput if none covers it.

## Expected outputs

Likely two implement tickets: (1) the fusion compiler + filter-conjunct adoption with the
tracing decision implemented; (2) remaining consumers (aggregate args, CASE branches,
sort/join keys). Plus a `docs/runtime.md` section describing the two-tier execution model
(instruction graph for relational/async, fused closures for pure scalar).
