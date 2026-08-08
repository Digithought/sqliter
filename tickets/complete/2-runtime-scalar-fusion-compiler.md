---
description: Small per-row expressions like "price * quantity > 100" now compile into one direct function instead of running through the query engine's general step-by-step machinery. Reviewed and landed.
files:
  - packages/quereus/src/runtime/scalar-fusion.ts         # the fusion compiler
  - packages/quereus/src/runtime/emitters.ts              # emitCallFromPlan front door
  - packages/quereus/src/runtime/emission-context.ts      # fuseScalars flag + constructor override
  - packages/quereus/src/runtime/emit/scalar-op.ts        # assertSpecArity exported
  - packages/quereus/src/core/database.ts                 # runtime_fuse_scalars option (default true)
  - packages/quereus/src/core/statement.ts                # _emitUnfused; getEmissionContext; getDebugProgram
  - packages/quereus/src/func/builtins/explain.ts         # scheduler_program + execution_trace stay unfused
  - packages/quereus/test/runtime/scalar-fusion.spec.ts   # 27 tests (20 from implement + 7 added in review)
  - packages/quereus/bench/fusion-slope.mjs               # ad-hoc slope measurement tool
  - docs/runtime.md                                       # § Scalar fusion: the second execution tier
  - docs/usage.md                                         # § Available Options
---

# Fused scalar expression subtrees (second execution tier)

## What shipped

`runtime/scalar-fusion.ts` — `tryFuseScalar(plan, ctx)` compiles a pure, synchronous
scalar subtree into one closure `(rctx) => SqlValue`, returning `undefined` for anything
it cannot prove pure and synchronous. Composition is bottom-up, arity-specialized
(0/1/2/3/spread), closure-only (no `new Function` — safe under a Content-Security-Policy
and under React Native). Every fused body is the node's own `ScalarOpSpec` body from the
prereq factoring, so fused and instruction forms share semantics, error messages, and
evaluation counts by construction. CASE is fused bespoke: all-or-nothing over
base/WHEN/THEN/ELSE, lazy branch selection via the shared `buildCaseMatcher`. Depth cap
`MAX_FUSION_DEPTH = 32`.

Covered nodes: Literal (declines on an unresolved async constant-fold), ColumnReference,
ParameterReference, Collate (fused through, no frame), Cast, UnaryOp, Between, BinaryOp
(declines for the AND/OR short-circuit form), CaseExpr. Function calls deliberately do not
fuse — that is `runtime-scalar-fusion-function-calls`. Everything else declines as an
unknown node type, which is what keeps the ~27 relational `emitCallFromPlan` call sites on
the sub-program path with no per-consumer opt-in.

Front door is `emitCallFromPlan`, which tries fusion first when `EmissionContext.fuseScalars`
is set. Off switches, resolved once in the `EmissionContext` constructor: `trace_plan_stack
= true` disables fusion, and the new `runtime_fuse_scalars` boolean option (default `true`)
is the kill switch. Both are baked at emit time into the statement's cached context.

Debug introspection reports the unfused graph: `scheduler_program()` builds its context with
`{ fuseScalars: false }`, `execution_trace()` sets `Statement._emitUnfused` right after
`db.prepare`, and `Statement.getDebugProgram()` builds its own fresh unfused context.

Measured (isolated, `bench/fusion-slope.mjs`, Windows 11 / node 24.2, 10k-row memory table,
median of 25 iterations, each mode a separate process): per-extra-projection slope dropped
from ~105–119 ns/row to ~41–45 ns/row, a reproducible ~2.4–2.6x reduction in per-expression
cost. Whole-suite `yarn bench` deltas were indistinguishable from run-to-run noise on this
machine — no speedup is claimed from the suites (the noise is separately tracked in
`tickets/backlog/debt-bench-per-instruction-scalar-cost.md`).

## Review findings

Read the implement diff (`58604df9`) before the handoff summary, then read every file it
touched plus the spec builders it composes (`emit/{literal,column-reference,parameter,cast,
unary,between,binary,case,collate,scalar-op}.ts`), `runtime/scheduler.ts`,
`runtime/types.ts`, `core/database-options.ts`, and the ~30 `emitCallFromPlan` consumers.

### Correctness — nothing found

Traced every way a fused closure could diverge from the sub-program it replaces, and each
one closed:

- **Evaluation order.** `Scheduler` linearizes instructions in post-order DFS over `params`,
  which is exactly the order nested closure calls produce. Operand order, and therefore
  which operands are already evaluated when a later one throws, is identical.
- **Instruction indices.** `emitCall` contributes exactly one instruction to the parent
  scheduler (the sub-program lives in its own `Scheduler`), and so does a fused instruction.
  Top-level indices are unchanged, which is why `row_trace()`'s `instruction_index` output
  stays stable.
- **`row_trace()` is fusion-invariant** as the handoff claimed — verified: it filters to
  `type === 'row'` events, which are emitted only for async-iterable outputs, i.e. relational
  instructions, which never fuse.
- **Schema-dependency capture.** Fusion calls the same `build*Spec` functions the emitters
  do, so the same `ctx.resolveCollation` dependencies are recorded; `emitCollate`, the one
  emitter fusion bypasses entirely, records nothing of its own (it just delegates to its
  operand). A fusion attempt that declines partway records a subset of what the fallback
  then records, and the tracker is a Set, so re-recording cannot diverge.
- **Emit-time throws.** `buildBinaryOpSpec` (unsupported operator) and `buildCaseMatcher`
  (collation conflict) can throw during a fusion attempt rather than during emission. Walked
  both directions — the fallback path reaches the same builder and throws the same error, so
  only the stack differs, not the observable failure.
- **Type-level contract.** `FusedScalar`'s assignability to `SubProgram` is genuinely
  compile-time checked: `emitCallFromPlan` returns `Instruction`, so `run: () => fused` only
  typechecks because `FusedScalar` is assignable to `OutputValue`. It is not a comment-only
  claim.
- **`{ fuseScalars: true }`** would force fusion on even with `trace_plan_stack = true`,
  producing traces missing their fused frames. No caller does this, and the field is
  `readonly`; noted rather than narrowed to `{ fuseScalars?: false }`, since the symmetric
  option reads better and the misuse is internal-only.

### Fixed in this pass (minor)

- **`fuseSpec` arity-0 wrapped its body in a needless closure** (`(rctx) => run(rctx)`),
  adding a call frame per row to the two most common leaves in any query — column references
  and literals. The body already satisfies `FusedScalar`; returns it directly now.
  (`scalar-fusion.ts`)
- **Dead depth guard in `fuseCase`** — `fuseNode` gates on `depth > MAX_FUSION_DEPTH` before
  dispatching, so the re-check could never fire. Removed. (`scalar-fusion.ts`)
- **Wrong depth-cap claim in two places.** Both the `MAX_FUSION_DEPTH` docstring and
  `docs/runtime.md` said a past-cap subtree "declines whole". It declines whole only down to
  the next nested `emitCallFromPlan` seam — a CASE branch or an AND/OR short-circuit right
  leg re-enters fusion at depth 0, so deep trees fuse in pieces. Corrected both, and added a
  parity test over exactly that shape.
- **New `runtime_fuse_scalars` option was missing from the options table** in
  `docs/usage.md`, the one user-facing list of database options. Added, and noted on the
  `trace_plan_stack` row that it also disables fusion.
- **Dead defensive unwrap in `EmissionContext`.** `tracePlanStack` was read through
  `db.getOption(...)` with an `'value' in option` unwrap that can never fire —
  `DatabaseOptions.getOption` returns the stored `OptionValue` directly, and `setOption`
  converts to the registered type on the way in. Now reads
  `db.options.getBooleanOption('trace_plan_stack')`, matching the `runtime_fuse_scalars` line
  immediately below it. (`emission-context.ts`)

### Test coverage added (7 tests, 20 → 27)

The implementer's suite covered the happy path, the decline set, fused-CASE laziness, and
the debug surfaces well. Gaps filled:

- **Depth-cap boundary is now exact** — `chain(MAX_FUSION_DEPTH)` fuses and
  `chain(MAX_FUSION_DEPTH + 1)` declines, both asserted. The old test only probed 10 and
  cap+8, so a one-off shift in the cap would have gone unnoticed.
- **Simple CASE with a NULL base** — matches no WHEN, takes the ELSE; and with no ELSE,
  yields NULL. The NULL-base rule lives in `buildCaseMatcher` and was unexercised on the
  fused path.
- **Simple CASE whose *base* declines** (a function call) — the whole CASE must decline
  rather than half-fuse. The existing decline test only put the unfusable node in a branch.
- **NULL propagation sweep** across fused `+`, BETWEEN (including a NULL bound), `||`,
  unary `-`/NOT, IS NULL, CAST, and a simple CASE — parity fused vs unfused.
- **A CASE nested inside a past-cap expression** — the partial-fusion seam the corrected
  docs describe, pinned by parity.
- **A fused CHECK predicate** rejects and reports identically fused vs unfused — the first
  coverage of fusion on the write/constraint path rather than the read path.

### Recorded as tripwires, not tickets

- **Metrics and db-level tracing see one `fused(...)` instruction**, not the per-operator
  breakdown, for a normally-executed statement. The three debug-introspection surfaces emit
  unfused, but `runtime_stats` metrics and `Database.setInstructionTracer` do not. Both are
  debug telemetry and `execution_trace()` already covers the per-operator view, so this is
  conditional, not a defect. `NOTE:` at `emitCallFromPlan` in `runtime/emitters.ts`, with the
  fix if it ever bites (force `fuseScalars: false` on those two paths).
- **A subtree that declines partway rebuilds its specs.** The fusion attempt resolves
  collations and compiles constant LIKE matchers above the declining node, then the fallback
  `emitPlanNode` builds them again. Emit-time only, bounded by subtree size, and idempotent.
  Common today because function calls decline, and shrinking once
  `runtime-scalar-fusion-function-calls` lands. `NOTE:` on `tryFuseScalar` in
  `scalar-fusion.ts`, with the pre-walk fix if emit latency ever shows up.

### Considered and left alone

- **The `>3` operand spread arm in `fuseSpec` is unreachable and untested.** No spec is wider
  than 3 operands, and `assertSpecArity` would accept a wider one, so the arm is a correct
  forward-compatible default rather than dead weight. Deleting it would silently un-fuse the
  first wide spec someone adds. The existing code comment already says so.
- **`_emitUnfused` is silently ignored if set after the first execution** (the emission
  context is cached by then). The contract — "set right after `db.prepare`" — is stated in
  the field's JSDoc and the one caller honors it; a runtime assertion for a single internal
  caller is not worth the code.
- **`execution_trace()` still cannot be exercised end-to-end** — the TVF deadlocks on the
  exec mutex regardless of fusion. Already tracked with a verified repro in
  `tickets/backlog/bug-execution-trace-hangs-forever.md`; not re-filed. The `_emitUnfused`
  mechanism it depends on is pinned directly by a test that traces the full sub-program graph.

### No major findings

Nothing rose to a new `fix/`, `plan/`, or `backlog/` ticket. The two known coverage holes
already have homes: function-call fusion is `runtime-scalar-fusion-function-calls` (in
`implement/`), and the whole-suite benchmark noise is
`debt-bench-per-instruction-scalar-cost` (in `backlog/`). Every finding above was either
fixed inline or parked as a tripwire at its site.

## Validation

All from `packages/quereus`, after the review edits:

- `yarn lint` — clean (exit 0). `yarn typecheck` and `yarn typecheck:test` — clean.
- `yarn test` — **9137 passing, 25 pending, 0 failing** (up from 9130; the 7 new tests).
- `node test-runner.mjs --trace-plan-stack` — **9137 passing, 25 pending, 0 failing**, i.e.
  the whole suite on the unfused + traced path. Run specifically because the review changed
  how `tracePlanStack` is read.
- Other workspace packages were not re-run: the review diff touches only
  `packages/quereus` source, its tests, and `docs/`. The implement stage validated them green.
