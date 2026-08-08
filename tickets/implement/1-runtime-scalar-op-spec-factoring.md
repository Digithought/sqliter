---
description: Reshape the code that builds SQL expression operators so the same evaluation logic can be reused two ways instead of being written once and locked inside the query engine's instruction machinery; pure refactor, no behavior change.
files:
  - packages/quereus/src/runtime/emit/scalar-op.ts        # NEW — ScalarOpSpec type + emitScalarOp helper
  - packages/quereus/src/runtime/emit/binary.ts           # emitNumericOp / emitComparisonOp / emitConcatOp / emitLikeOp / emitLogicalOp
  - packages/quereus/src/runtime/emit/unary.ts            # emitUnaryOp
  - packages/quereus/src/runtime/emit/between.ts          # emitBetween
  - packages/quereus/src/runtime/emit/cast.ts             # emitCast
  - packages/quereus/src/runtime/emit/literal.ts          # emitLiteral
  - packages/quereus/src/runtime/emit/column-reference.ts # emitColumnReference
  - packages/quereus/src/runtime/emit/parameter.ts        # emitParameterReference
  - packages/quereus/src/runtime/emit/scalar-function.ts  # emitScalarFunctionCallDefault
  - packages/quereus/src/runtime/emit/case.ts             # export the simple-CASE match test for reuse
  - packages/quereus/test/logic/06.5.4-declared-return-type-builtins.sqllogic  # asserts instruction note text via scheduler_program()
difficulty: medium
---

# Factor scalar operator bodies out of their emitters

## Why

Two ticket-2 consumers need the *same* evaluation body: the instruction emitter (which
wraps it as an `Instruction` the scheduler dispatches) and the upcoming scalar-fusion
compiler (which calls it directly from a closure chain). Today each body is built inline
inside its emitter and is unreachable from anywhere else, so fusion would have to
duplicate every specialization the prior `runtime-scalar-op-emit-time-specialization`
pass introduced — and the two copies would drift.

This ticket introduces the shared shape and moves the existing bodies onto it. **No
behavior changes and no new capability.** The visible contract — every instruction's
`note` string, every result value, every error — must be byte-identical afterwards.

## The shape

New file `packages/quereus/src/runtime/emit/scalar-op.ts`:

```ts
/**
 * Emit-time description of one scalar node's evaluation: the operand plan nodes whose
 * values it consumes, and the synchronous body that combines them.
 *
 * Two consumers read this. `emitScalarOp` emits each operand as an `Instruction` param
 * and hands the body to the scheduler as the instruction's `run` — today's behavior. The
 * scalar-fusion compiler instead composes each operand's own fused closure into a direct
 * call, with no scheduler and no per-row allocation. Both must agree exactly, which is
 * why the body lives here and not inside either one.
 *
 * `operands` is the list that becomes `Instruction.params` — NOT the plan node's
 * children. `emitLikeOp`'s constant-pattern fast path bakes its right operand into the
 * closure and declares one operand; the spec describes what is actually evaluated.
 */
export interface ScalarOpSpec {
	readonly operands: readonly ScalarPlanNode[];
	readonly run: (ctx: RuntimeContext, ...args: SqlValue[]) => SqlValue;
	readonly note: string;
}

/** Emit a spec as the `Instruction` its emitter returned before this factoring. */
export function emitScalarOp(spec: ScalarOpSpec, ctx: EmissionContext): Instruction;
```

`emitScalarOp` is exactly:

```ts
return {
	params: spec.operands.map(operand => emitPlanNode(operand, ctx)),
	run: asRun(spec.run),
	note: spec.note,
};
```

Each emitter splits into a `buildXxxSpec(plan, ctx): ScalarOpSpec` plus a one-line
`emitXxx` that calls `emitScalarOp(buildXxxSpec(plan, ctx), ctx)`. The emitter registration
table is untouched.

## Nodes to convert

| emitter | spec builder | operands |
| --- | --- | --- |
| `emitLiteral` | `buildLiteralSpec` | none |
| `emitColumnReference` | `buildColumnReferenceSpec` | none |
| `emitParameterReference` | `buildParameterSpec` | none |
| `emitCast` | `buildCastSpec` | operand |
| `emitUnaryOp` | `buildUnaryOpSpec` | operand |
| `emitBetween` | `buildBetweenSpec` | expr, lower, upper |
| `emitNumericOp` | `buildNumericOpSpec` | left, right |
| `emitComparisonOp` | `buildComparisonOpSpec` | left, right |
| `emitConcatOp` | `buildConcatOpSpec` | left, right |
| `emitLikeOp` | `buildLikeOpSpec` | left (+ right only on the dynamic path) |
| `emitScalarFunctionCallDefault` | `buildScalarFunctionSpec` | plan.operands |

`emitCollate` stays as-is — it already delegates to `emitPlanNode(plan.operand)` and has no
body of its own.

### Two emitters that do NOT get a spec

- **`emitLogicalOp`'s short-circuit form** (`AND`/`OR` whose right operand has a relational
  descendant) takes a `SubProgram` param, not a value, and returns `MaybePromise`. Only the
  **eager** form (`run` → `combineLogical(v1, v2)`) becomes `buildLogicalOpSpec`; the
  short-circuit branch keeps building its `Instruction` directly. Keep `selectLogicalCombine`
  and `combineLogical` shared between the two exactly as they are now — the parity tests in
  `test/and-or-short-circuit.spec.ts` guard that they cannot drift.
- **`emitCaseExpr`** invokes lazy branch callbacks; it does not fit the eager-operand shape.
  It keeps its own emitter. What it *does* owe ticket 2 is its per-clause match test, so the
  fused CASE decides matches identically. Export from `case.ts`:

  ```ts
  /** Per-clause match test of a simple CASE, resolved once at emit time: collation +
   *  type routing per WHEN operand, and the rule that a NULL base matches nothing.
   *  Shared by the instruction emitter and the fusion compiler so a fused CASE and an
   *  instruction CASE can never disagree about which branch fires. */
  export interface CaseMatcher {
      readonly collationNames: readonly string[];
      readonly matches: (clauseIndex: number, baseValue: SqlValue, whenValue: SqlValue) => boolean;
  }
  export function buildCaseMatcher(plan: CaseExprNode, ctx: EmissionContext): CaseMatcher;
  ```

  `emitCaseExpr` then uses `matcher.matches(i, baseValue, w)` where it currently has its
  local `matches` helper, and `matcher.collationNames` where it currently has
  `whenCollationNames`. A searched CASE (no `baseExpr`) yields empty arrays and a `matches`
  that is never called, matching today's `resolveWhenComparison` early return.

## Edge cases & interactions

- **Note strings are the contract.** `test/logic/06.5.4-declared-return-type-builtins.sqllogic`
  asserts `scheduler_program()` rows equal `'=(compare-fast)'`, `'=(compare-typed)'` and
  `'=(compare)'`; `test/logic/03.5-tvf.sqllogic` asserts exact `description` text for
  `SELECT 1`. Any drift in a `note` fails the suite. Do not "tidy" note text.
- **`emitLikeOp` arity varies.** The constant-pattern path emits ONE param while the plan
  has two children. The spec must carry `[plan.left]` there and `[plan.left, plan.right]`
  otherwise, or the runtime gets a `pattern` arg it does not expect.
- **`emitScalarFunctionCallDefault` is variadic** (`run(_rctx, ...args)`) and its emit-time
  arity assert plus the `REPR_STRICT` return-type check must stay where they are — the
  assert before the spec is built, the check inside the body. Its `run` returns
  `MaybePromise<SqlValue>` (declared `OutputValue`), which does **not** fit `ScalarOpSpec`'s
  `SqlValue` return. Either widen this one spec's return to `OutputValue` in a separate
  `ScalarOpSpec`-shaped local type, or keep `emitScalarFunctionCallDefault` building its
  `Instruction` directly and defer its spec to ticket 3 (which is where its async question
  gets settled anyway). **Prefer the latter** — do not widen `ScalarOpSpec` to `OutputValue`,
  because the fusion compiler's whole contract is that a spec body returns a plain value.
  Note the deferral in the handoff.
- **`emitParameterReference` throws** on a missing parameter (`StatusCode.RANGE` /
  `NOTFOUND`). Keep the throw inside the body, not at build time — the binding is not known
  at emit time.
- **`createValidatedInstruction`** (used only by `emitScalarFunctionCallDefault`) is a
  pass-through today; if that emitter does get a spec, `emitScalarOp` must still route
  through it so its six call sites stay uniform. Since the recommendation above defers that
  emitter, this should not come up.
- **Emitter registration.** `runtime/register.ts` maps node types to emitters. Only the
  `emitXxx` names are registered; the spec builders are internal. Do not change the map.
- **Closure capture.** Several bodies capture `plan` (e.g. `plan.expression.not` in BETWEEN,
  `plan.expression.operator` in the temporal arithmetic arm). That capture is fine and must
  survive the move — the spec builder closes over the same `plan`.

## Verification

- `yarn lint` and `yarn typecheck` from the repo root.
- `yarn test` — full suite green, same pass/pending/fail counts as before the change
  (record both numbers in the handoff).
- Spot-check that `scheduler_program('select a > b from t')`-style notes are unchanged; the
  06.5.4 logic file does this for you.
- Diff review discipline: every moved body should be a pure move. If you find yourself
  changing a condition, stop — that is a separate ticket.

## TODO

- Add `packages/quereus/src/runtime/emit/scalar-op.ts` with `ScalarOpSpec` and `emitScalarOp`.
- Convert `literal.ts`, `column-reference.ts`, `parameter.ts` (zero-operand specs).
- Convert `cast.ts`, `unary.ts`, `between.ts`.
- Convert `binary.ts`: numeric, comparison, concat, LIKE (both arities), logical **eager**
  form only; leave the short-circuit branch building its own `Instruction`.
- Export `buildCaseMatcher` / `CaseMatcher` from `case.ts` and rewire `emitCaseExpr` onto it.
- Leave `emitScalarFunctionCallDefault` unconverted (its `OutputValue` return is ticket 3's
  problem); say so in the handoff.
- Run lint, typecheck, and the full test suite; confirm identical counts and identical
  `scheduler_program` note text.
