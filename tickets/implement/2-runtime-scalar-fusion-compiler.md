---
description: Small expressions like "price * quantity > 100" are currently run through the query engine's general-purpose step-by-step machinery for every single row, which costs far more than the arithmetic itself; compile them into one direct function instead.
prereq: runtime-scalar-op-spec-factoring
files:
  - packages/quereus/src/runtime/scalar-fusion.ts         # NEW — the fusion compiler
  - packages/quereus/src/runtime/emitters.ts              # emitCallFromPlan — the single front door
  - packages/quereus/src/runtime/emission-context.ts      # new emit-time `fuseScalars` flag
  - packages/quereus/src/core/database.ts                 # register the `runtime_fuse_scalars` option (near `trace_plan_stack`, ~line 392)
  - packages/quereus/src/core/statement.ts                # `_emitUnfused` internal flag; getEmissionContext; getDebugProgram
  - packages/quereus/src/func/builtins/explain.ts         # scheduler_program() + execution_trace() must stay unfused
  - packages/quereus/src/runtime/emit/case.ts             # buildCaseMatcher (from the prereq ticket)
  - packages/quereus/src/runtime/emit/filter.ts           # first and hottest beneficiary (no code change needed)
  - docs/runtime.md                                       # § Scheduler Execution Model (~line 387) — document the second tier
difficulty: hard
---

# Fuse pure scalar expression subtrees into single closures

## The cost being removed

A scalar expression that runs per row — a filter conjunct, an aggregate argument, a sort
or join key, a projection — is emitted as a **sub-program**: its own `Scheduler`, invoked
once per row through `emitCall`. Each invocation of `Scheduler.run`:

- allocates a fresh array-of-arrays (`instrArgs`, one array per instruction) — `scheduler.ts:190`,
- loops every instruction with a spread call `instruction.run(ctx, ...args)`,
- checks each output for `instanceof Promise`, looks up a destination, and pushes the
  result into the destination's array.

For `price * quantity > 100` that is five "instructions" — two column references, a
literal, `*`, `>` — so roughly ten heap allocations and ten dynamic dispatches per row to
perform three operations. The literal is "executed" once per row.

A one-off measurement recorded in `tickets/backlog/debt-bench-per-instruction-scalar-cost.md`
put a bare column-reference instruction at ~143 ns/row and a comparison or arithmetic
expression at ~210–226 ns/row (10k rows, node 24.2, Windows). Those are the numbers this
ticket targets. They are a single ad-hoc measurement on one machine, not a standing
benchmark — do not quote them as established.

## What this ticket builds

A second execution tier that sits beside the instruction graph rather than replacing it.

New file `packages/quereus/src/runtime/scalar-fusion.ts`:

```ts
/** A fused scalar expression: evaluates a whole pure, synchronous subtree with direct
 *  calls — no scheduler, no per-row allocation, no dynamic dispatch. */
export type FusedScalar = (rctx: RuntimeContext) => SqlValue;

/**
 * Compile `plan` into a single closure, or return undefined if any node in the subtree
 * cannot be fused (an unsupported node type, a subquery, anything that can return a
 * Promise, or a subtree deeper than MAX_FUSION_DEPTH). Undefined is the normal answer for
 * most of the plan tree; the caller falls back to the sub-program path unchanged.
 */
export function tryFuseScalar(plan: PlanNode, ctx: EmissionContext): FusedScalar | undefined;
```

Composition is bottom-up and by arity, so the common cases allocate nothing and stay
monomorphic:

```ts
switch (spec.operands.length) {
	case 0: return (rctx) => run(rctx);
	case 1: { const a = fuse(spec.operands[0]); return a && ((rctx) => run(rctx, a(rctx))); }
	case 2: { /* a, b */ }
	case 3: { /* a, b, c */ }
	default: /* fuse all, then an args array + spread — still far cheaper than a sub-program */
}
```

Closure composition only. No `new Function`, no `eval` — they are unavailable under a
Content-Security-Policy and under React Native.

## Node coverage in this ticket

Fusable: `LiteralNode`, `ColumnReferenceNode`, `ParameterReferenceNode`, `CollateNode`
(fuse straight through to its operand, mirroring `emitCollate`), `CastNode`, `UnaryOpNode`,
`BetweenNode`, `BinaryOpNode` (numeric, comparison, concat, LIKE, and the **eager** logical
form), `CaseExprNode`.

Every one of these reads its evaluation body from the `ScalarOpSpec` the prereq ticket
factored out — the fusion compiler must not restate any operator logic.

**Scalar function calls are NOT fused in this ticket** — their sync/async question is
ticket 3 (`runtime-scalar-fusion-function-calls`). A subtree containing any function call
therefore does not fuse yet. That is a real coverage hole (`lower(name) = 'x'` stays
unfused), and it is deliberate: it keeps this ticket's risk to the mechanism itself.

Everything else — scalar/`IN`/`EXISTS` subqueries, window functions, aggregate nodes,
relational nodes, and any node type not listed above — returns undefined. Note that this
falls out for free rather than needing a special case: the `AND`/`OR` short-circuit form
only exists when `hasRelationalDescendant(plan.right)` is true, and a relational descendant
is a subquery node the compiler does not know, so the recursion refuses it on its own.

### CASE keeps its laziness

`CaseExprNode` is the one node that is not a flat `ScalarOpSpec`. Fuse it only when the
base expression (if any) **and every** WHEN / THEN / ELSE fuse; otherwise return undefined
for the whole CASE. All-or-nothing avoids a mixed contract where some branches are closures
and some are sub-programs returning `MaybePromise`.

The fused body keeps SQL's evaluation rules exactly as `emitCaseExpr` has them: WHEN
clauses left to right, stop at the first match, evaluate **only** the selected result, and
never touch a later clause. Because every fused branch is synchronous, the fused CASE is a
plain synchronous loop with no `MaybePromise` handling at all. Match decisions come from
`buildCaseMatcher` (prereq ticket), so a fused CASE and an instruction CASE cannot disagree.

This direction is strictly safe for the materialized-view row-time gate that
`emit/case.ts` documents (`database-materialized-views-analysis.ts` needs CASE to stay
synchronous): fusion only ever makes an expression *more* synchronous, never less.

### Depth cap

Fused closures nest on the JS call stack where the scheduler's linearized loop did not, so
a pathologically deep expression (`a+a+a+…` thousands of terms) could overflow the stack
where it works today. Cap the fused subtree depth at a named constant
(`MAX_FUSION_DEPTH`, start at 32 — far above any real expression) and return undefined
past it. Exceeding the cap unfuses the whole expression, which is correct, just unoptimized.
Count CASE branches toward the depth: a branch closure is invoked from inside the CASE
closure, so its frames stack.

## The front door: `emitCallFromPlan`

One site, transparent to every consumer:

```ts
export function emitCallFromPlan(plan: PlanNode, emissionCtx: EmissionContext): Instruction {
	if (emissionCtx.fuseScalars) {
		const fused = tryFuseScalar(plan, emissionCtx);
		if (fused) {
			return { params: [], run: () => fused, note: `fused(${plan.toString()})` };
		}
	}
	const instruction = emitPlanNode(plan, emissionCtx);
	return emitCall(instruction);
}
```

The ticket's own design note recommended explicit per-consumer opt-in for v1. **Reject
that and go transparent**, because the facts found while planning make explicit opt-in
pure cost: `emitCallFromPlan` has ~30 call sites, all of them consume the result as
`SubProgram = (ctx) => MaybePromise<SqlValue>`, a `FusedScalar` satisfies that type
exactly, and the relational call sites (cache source, join right, view-mutation legs) are
refused by `tryFuseScalar` for free. Explicit opt-in would mean touching every hot consumer
to gain nothing the gate below does not already give. Filter conjuncts, aggregate and
GROUP BY arguments, CASE branches, sort keys, join keys, projections, LIMIT/OFFSET
expressions, INSERT value expressions and CHECK predicates all adopt fusion in this one
change.

A fused instruction returns the **same** closure on every invocation, where `emitCall`
allocates a fresh arrow each time. That is strictly more stable, but confirm nothing keys a
`Map`/`Set` on sub-program function identity before relying on it.

## When fusion is off

`EmissionContext` gains `readonly fuseScalars: boolean`, resolved once in its constructor
next to the existing `tracePlanStack`:

```ts
fuseScalars = override ?? (!this.tracePlanStack && db.options.getBooleanOption('runtime_fuse_scalars'))
```

- **`trace_plan_stack = true` disables fusion.** `emitPlanNode` wraps each instruction with
  `instrumentRunForTracing` to push/pop `ctx.planStack`; a fused subtree bypasses that
  wrapper, so its frames would silently vanish from the plan stack. Since that option
  already exists precisely to get deep per-node visibility, it is the natural switch, and
  `test/logic.spec.ts` already has an env-gated mode that sets it — which gives the whole
  logic suite a free unfused pass.
- **`runtime_fuse_scalars`** (new boolean db option, default `true`, registered beside
  `trace_plan_stack` in `core/database.ts`) is the explicit kill switch for bisecting a
  suspected fusion bug.
- The emission context — and therefore this decision — is cached on a prepared `Statement`
  along with its scheduler, so toggling either option mid-life is ignored until the plan
  recompiles. That is the documented pre-existing behavior of `trace_plan_stack`
  (`core/statement.ts` ~line 380); extend that comment rather than inventing new machinery.

### Debug introspection stays unfused

`scheduler_program()` and `execution_trace()` exist to show the instruction graph, and
`explain_query` (`func/builtins/explain.ts` ~line 449) **joins them by instruction index** —
so they must agree with each other. Emit both unfused:

- `scheduler_program()` builds its own `new EmissionContext(db)`; pass the override so it
  emits unfused. Its output then stays byte-identical, which matters: four assertions in
  `test/logic/06.5.4-declared-return-type-builtins.sqllogic` count rows whose
  `description` equals `'=(compare-fast)'` / `'=(compare-typed)'` / `'=(compare)'`, and
  those instructions live in **projection sub-programs** that fusion would otherwise
  dissolve.
- `execution_trace()` goes through `db.prepare(sql)` + `iterateRowsWithTrace`. Add an
  `@internal _emitUnfused?: boolean` field to `Statement`, read by `getEmissionContext()`.
  Set it right after `db.prepare(...)` in the TVF — compilation is deferred, so that is
  race-free, exactly as `_schemaPathOverride` documents.
- `Statement.getDebugProgram()` re-emits a fresh instruction tree for a human-readable
  dump; give it its own unfused `EmissionContext` rather than reusing the cached one.

Document in `docs/runtime.md` that these surfaces report the *unfused* graph — the
faithful description of what the query computes — and that a normal execution runs the
fused form.

## Documentation

Add a section under `docs/runtime.md` § Scheduler Execution Model describing the two-tier
model: the instruction graph for relational and asynchronous work, fused closures for pure
synchronous scalar subtrees; which node types fuse; what turns fusion off and why; and the
note that debug introspection reports the unfused graph. Do not add a new doc file.

## Edge cases & interactions

- **`scheduler_program()` note assertions** (06.5.4, and `03.5-tvf.sqllogic`'s exact
  `description` strings for `SELECT 1`) must pass **unchanged**. If they fail, the unfused
  plumbing above is wrong — do not edit the assertions.
- **Row context timing.** A fused conjunct reads columns via `resolveAttribute(rctx, …)`,
  the same call the column-reference instruction makes, using the same `rctx` the
  sub-program was handed. `emitFilter` sets its row slot *before* invoking any conjunct;
  that ordering is unchanged. Test a correlated predicate over a nested-loop join to pin it.
- **Short-circuit parity.** `test/and-or-short-circuit.spec.ts` and
  `test/case-short-circuit.spec.ts` are the existing guards. Add cases that prove a fused
  CASE still evaluates exactly one THEN — e.g. a branch that would divide by zero or raise
  an error must not run when its WHEN is false.
- **Filter conjunct early exit.** `emitFilter` splits `a and b and c` and drops a row at the
  first failing conjunct. Fusion happens *below* that split (one fused closure per
  conjunct), so a later side-effecting conjunct must still never run for a rejected row.
- **Error attribution.** Fused bodies are the same functions, so the same `QuereusError`s
  with the same messages and source locations. Verify with an error-path test: a cast or
  arithmetic failure inside a fused filter conjunct must report identically to the unfused
  form (compare with `runtime_fuse_scalars = false`).
- **Mixed fusable/unfusable siblings.** `case when <fusable> then <subquery> end` must not
  fuse at all; `a > 1 and b in (select …)` must fuse the first conjunct and leave the second
  as a sub-program. Assert both produce the same rows as with fusion disabled.
- **Deep nesting.** An expression past `MAX_FUSION_DEPTH` must fall back cleanly and still
  answer correctly. Include a generated deep-expression test.
- **Volatile and impure expressions.** A fused closure evaluates its operands exactly once
  per invocation, exactly as the sub-program did — so a volatile expression is called the
  same number of times. `emitCallFromPlan` sites that carry DML (`view-mutation.ts`,
  `dml-executor.ts`) pass relational or subquery-bearing plans that refuse to fuse; confirm
  the DML and constraint suites are green.
- **Parameter binding.** A fused `ParameterReferenceNode` reads `rctx.params` per
  invocation, so re-binding and re-executing a prepared statement must pick up new values.
  The instruction tree is cached across executions; the fused closure is too.
- **`REPR_STRICT` builds.** `QUEREUS_REPR_STRICT` adds representation assertions to some
  bodies. Run at least one pass with it on, since function calls (its main site) are not
  fused here but casts and comparisons are.
- **`test/property.spec.ts`** mentions `scheduler_program`; check it does not assume
  sub-program shape.

## Measurement

- `yarn bench` (`packages/quereus/bench/run.mjs`) before and after; report the execution
  suite deltas. Expect a modest whole-query number — the suites mix storage and async
  iteration with dispatch, which is exactly the complaint filed in
  `tickets/backlog/debt-bench-per-instruction-scalar-cost.md`.
- Also take one ad-hoc isolated measurement of the thing actually changed: time
  `select n from t` against `select n, n, …` (8 wide) over a 10k-row memory table with
  `runtime_fuse_scalars` on and off, in **separate processes** (that ticket records
  single-process runs inflating one shape by 2–3×), and report the per-expression slope
  both ways. Record the numbers and the exact command in the handoff. If you cannot get a
  stable number, say so plainly rather than quoting a speedup.
- `test/performance-sentinels.spec.ts` guards against catastrophic regression. Add a
  filtered-scan-throughput sentinel there if none covers it, with the same generous
  headroom as its neighbors.

## TODO

- Add `runtime/scalar-fusion.ts`: `FusedScalar`, `MAX_FUSION_DEPTH`, `tryFuseScalar`,
  arity-specialized composition, and per-node-type dispatch over the covered nodes.
- Fuse `CaseExprNode` bespoke (all-or-nothing, lazy branches, `buildCaseMatcher`).
- Add `fuseScalars` to `EmissionContext` with a constructor override.
- Register the `runtime_fuse_scalars` boolean option in `core/database.ts`.
- Hook the front door in `emitCallFromPlan`.
- Keep debug introspection unfused: `Statement._emitUnfused` + `getEmissionContext`,
  `getDebugProgram`'s own context, `scheduler_program()`, `execution_trace()`.
- Extend the emission-context caching comment in `core/statement.ts` to cover the new option.
- Document the two-tier model in `docs/runtime.md` § Scheduler Execution Model.
- Tests: fused/unfused result parity across the edge cases above; CASE short-circuit under
  fusion; error-message parity; deep-expression fallback; correlated predicate over a join.
- Run `yarn lint`, `yarn typecheck`, `yarn test`; record pass/pending/fail counts.
- Run `yarn bench` plus the isolated slope measurement; record both.
