---
description: Small per-row expressions like "price * quantity > 100" now compile into one direct function instead of running through the query engine's general step-by-step machinery; this needs a code-review pass over the new compiler and its wiring.
prereq: runtime-scalar-op-spec-factoring
files:
  - packages/quereus/src/runtime/scalar-fusion.ts         # NEW — the fusion compiler
  - packages/quereus/src/runtime/emitters.ts              # emitCallFromPlan front door
  - packages/quereus/src/runtime/emission-context.ts      # fuseScalars flag + constructor override
  - packages/quereus/src/runtime/emit/scalar-op.ts        # assertSpecArity now exported
  - packages/quereus/src/core/database.ts                 # runtime_fuse_scalars option (default true)
  - packages/quereus/src/core/statement.ts                # _emitUnfused; getEmissionContext; getDebugProgram
  - packages/quereus/src/func/builtins/explain.ts         # scheduler_program + execution_trace stay unfused
  - packages/quereus/test/runtime/scalar-fusion.spec.ts   # NEW — 20 tests
  - packages/quereus/bench/fusion-slope.mjs               # NEW — ad-hoc slope measurement tool
  - docs/runtime.md                                       # § Scalar fusion: the second execution tier
difficulty: hard
---

# Review: fused scalar expression subtrees (second execution tier)

## What was built

`runtime/scalar-fusion.ts` — `tryFuseScalar(plan, ctx)` compiles a pure, synchronous
scalar subtree into one closure `(rctx) => SqlValue`; returns `undefined` for anything
it cannot prove pure and synchronous. Composition is bottom-up, arity-specialized
(0/1/2/3/spread), closure-only (no `new Function` — CSP/React-Native safe). Every
fused body is the node's own `ScalarOpSpec` body from the prereq factoring, so fused
and instruction forms share semantics, error messages, and evaluation counts by
construction. CASE is fused bespoke: all-or-nothing over base/WHEN/THEN/ELSE, lazy
branch selection via the shared `buildCaseMatcher`. Depth cap `MAX_FUSION_DEPTH = 32`
(CASE branches count); past it the whole expression falls back.

Covered nodes: Literal (declines on unresolved async fold), ColumnReference,
ParameterReference, Collate (fused through, no frame), Cast, UnaryOp, Between,
BinaryOp (declines for the AND/OR short-circuit form via `buildBinaryOpSpec`
returning undefined), CaseExpr. **Function calls do not fuse** — deliberate; that is
ticket `runtime-scalar-fusion-function-calls` (already in implement/). Everything
else declines as an unknown node type, which is also what keeps the ~27 relational
`emitCallFromPlan` call sites (cache sources, join legs, view-mutation programs) on
the sub-program path with no per-consumer opt-in.

Front door: `emitCallFromPlan` tries fusion first when `EmissionContext.fuseScalars`
is set, else emits the sub-program exactly as before. The fused instruction is
`{ params: [], run: () => fused, note: 'fused(<expr>)' }` — same callback contract
(`FusedScalar` is a strict narrowing of `SubProgram`), transparent to all ~30
consumers, per the plan-time decision recorded in the implement ticket (explicit
per-consumer opt-in was rejected as pure cost).

Off switches, resolved once in the `EmissionContext` constructor:
`trace_plan_stack = true` disables fusion (fused frames would vanish from
`ctx.planStack`); new `runtime_fuse_scalars` boolean option (default `true`) is the
kill switch. Both baked at emit time into the statement's cached context — the
pre-existing `trace_plan_stack` caching comment in `core/statement.ts` was extended
to say so.

Unfused debug surfaces: `scheduler_program()` builds its context with
`{ fuseScalars: false }`; `execution_trace()` sets the new
`Statement._emitUnfused` internal flag right after `db.prepare` (race-free, compile
deferred — same pattern as `_schemaPathOverride`); `Statement.getDebugProgram()`
builds its own fresh unfused context instead of reusing the cached one. `row_trace()`
was deliberately left alone: it reports only `row` events, which come from relational
instructions that never fuse, so its output is fusion-invariant.

## Validation run (all from `packages/quereus`)

- `yarn lint` — clean. `yarn typecheck` + `yarn typecheck:test` — clean.
- `yarn test` — **9130 passing, 25 pending, 0 failing** (includes the sqllogic
  suites; the `scheduler_program()` note-count assertions in 06.5.4 and 03.5 pass
  unchanged, as required).
- `yarn test:repr-strict` — 9139 passing, 16 pending, 0 failing.
- `QUEREUS_TEST_TRACE_PLAN_STACK=true yarn test` — 9130 passing, 25 pending, 0
  failing (the whole logic suite on the unfused + traced path).
- All other workspace packages: `yarn workspaces foreach -A --exclude
  @quereus/quereus run test` — exit 0, all green.

New suite `test/runtime/scalar-fusion.spec.ts` (20 tests): unit-level fuse/decline
(arithmetic over params, function-call decline, depth-cap decline-vs-fuse, option and
trace_plan_stack gating); fused-CASE laziness proven with an unbound-parameter branch
that would throw if touched; fused/unfused end-to-end parity across filter conjuncts,
an operator sweep (cast/collate/between/like/concat/xor/unary/simple-CASE), mixed
fusable + IN-subquery siblings, CASE-with-subquery-branch (declines whole, stays
lazy), past-depth-cap expressions, a correlated predicate over a nested-loop join,
error-message parity, prepared-statement re-binding; and the debug surfaces
(getDebugProgram / scheduler_program show no `fused(`, while a default statement's
trace **does** contain `fused(` — positive proof fusion engages at runtime).

## Measurements

Whole-suite `yarn bench` before/after (fusion off via temporarily-flipped default,
separate processes): **deltas indistinguishable from run-to-run noise** on this
machine — e.g. parser/planner medians swing 40–60% between runs with no relevant
change. This is exactly the complaint recorded in
`tickets/backlog/debt-bench-per-instruction-scalar-cost.md`; no speedup claim is made
from the suites.

Isolated slope (the thing actually changed), Windows 11 / node 24.2, 10k-row memory
table, median of 25 iterations, each mode a separate process, run twice each:

```
node bench/fusion-slope.mjs off   → slope 118.7, 104.6 ns/row per extra projection
node bench/fusion-slope.mjs on    → slope  40.7,  45.0 ns/row per extra projection
```

(`select n from t` vs `select n, n, …×8`; slope = (wide − narrow) / 7 / rows.)
Reproducible ~2.4–2.6× reduction in per-expression cost; the 8-wide whole query
dropped ~20.4 ms → ~13.5 ms. The script is kept at
`packages/quereus/bench/fusion-slope.mjs` (outside `bench/suites/`, so the bench
runner does not pick it up).

Performance sentinel: `test/performance-sentinels.spec.ts` already has a
filtered-scan-throughput sentinel ("filtered scan (1000 rows, ~10 matches) under
200 ms"), so none was added — judgment call, revisit if you disagree.

## Known gaps / reviewer notes

- **`execution_trace()` could not be exercised end-to-end**: the TVF deadlocks on
  the exec mutex on every call, with or without this change (nested `db.eval` inside
  an outer `db.eval`). Already tracked with a verified repro in
  `tickets/backlog/bug-execution-trace-hangs-forever.md` — not re-filed. The
  `_emitUnfused` mechanism it relies on is instead pinned directly: a statement with
  the flag traces the full sub-program graph via `iterateRowsWithTrace`; once the
  deadlock ticket lands, the TVF will emit unfused without further work here.
- **Coverage hole by design**: `lower(name) = 'x'` and any other subtree containing
  a function call stays unfused until `runtime-scalar-fusion-function-calls`.
- The >3-operand spread arm in `fuseSpec` is dead code today (no spec is wider than
  3) and is untested; the code comment says so.
- `assertSpecArity` is now exported from `emit/scalar-op.ts` and runs on every fused
  composition too (emit-time only, not per row).
- Sub-program function identity: a fused instruction returns the same closure every
  invocation where `emitCall` allocated a fresh arrow. Checked the runtime for
  Map/Set/WeakMap keyed on sub-program functions — the WeakMaps found key on
  RuntimeContext/context objects, not callbacks; tracers stringify functions.
- `EmissionContext` gained an optional `options?: { fuseScalars?: boolean }` second
  constructor parameter; all other construction sites (const-evaluator, MV plan
  builders, assertions, property tests) intentionally inherit the default-on
  behavior — fusion only ever makes an expression *more* synchronous, which the MV
  row-time gate requires.
