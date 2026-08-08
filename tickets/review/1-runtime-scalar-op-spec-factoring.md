---
description: Review a pure refactor that pulled the evaluation logic of SQL expression operators out of the query engine's instruction machinery into a shared, reusable shape, so an upcoming faster evaluation path can use exactly the same logic instead of a second copy.
files:
  - packages/quereus/src/runtime/emit/scalar-op.ts        # NEW — ScalarOpRun / ScalarOpSpec / emitScalarOp
  - packages/quereus/src/runtime/emit/binary.ts           # numeric / comparison / concat / LIKE / logical
  - packages/quereus/src/runtime/emit/unary.ts
  - packages/quereus/src/runtime/emit/between.ts
  - packages/quereus/src/runtime/emit/cast.ts
  - packages/quereus/src/runtime/emit/literal.ts
  - packages/quereus/src/runtime/emit/column-reference.ts
  - packages/quereus/src/runtime/emit/parameter.ts
  - packages/quereus/src/runtime/emit/case.ts             # buildCaseMatcher / CaseMatcher
  - docs/runtime.md                                       # new "Scalar emitters" subsection
difficulty: medium
---

# Review: scalar operator bodies factored out of their emitters

## What landed

`packages/quereus/src/runtime/emit/scalar-op.ts` is new and holds three things:

```ts
export type ScalarOpRun = (ctx: RuntimeContext, ...args: SqlValue[]) => SqlValue;

export interface ScalarOpSpec {
	readonly operands: readonly ScalarPlanNode[];
	readonly run: ScalarOpRun;
	readonly note: string;
}

export function emitScalarOp(spec: ScalarOpSpec, ctx: EmissionContext): Instruction {
	return {
		params: spec.operands.map(operand => emitPlanNode(operand, ctx)),
		run: asRun(spec.run),
		note: spec.note,
	};
}
```

Ten emitters split into `buildXxxSpec(plan[, ctx]): ScalarOpSpec` plus a one-line
`emitXxx` that calls `emitScalarOp(...)`. The emitter registration table
(`runtime/register.ts`) is untouched — only the `emitXxx` names are registered.

| emitter | spec builder | operands |
| --- | --- | --- |
| `emitLiteral` | `buildLiteralSpec` (returns `undefined` for a Promise value) | none |
| `emitColumnReference` | `buildColumnReferenceSpec` | none |
| `emitParameterReference` | `buildParameterSpec` | none |
| `emitCast` | `buildCastSpec` | operand |
| `emitUnaryOp` | `buildUnaryOpSpec` | operand |
| `emitBetween` | `buildBetweenSpec` | expr, lower, upper |
| `emitNumericOp` | `buildNumericOpSpec` | left, right |
| `emitComparisonOp` | `buildComparisonOpSpec` | left, right |
| `emitConcatOp` | `buildConcatOpSpec` | left, right |
| `emitLikeOp` | `buildLikeOpSpec` | left (const-pattern path) / left, right |
| `emitLogicalOp` | `buildLogicalOpSpec` (returns `undefined` for short-circuit) | left, right |

`case.ts` exports `CaseMatcher` / `buildCaseMatcher` (replacing the private
`resolveWhenComparison` + the `matches` closure that lived inside `runSimpleCase`);
`emitCaseExpr` now reads `matcher.matches(i, baseValue, w)` and `matcher.collationNames`.

`docs/runtime.md` § *Creating an Emitter* gained a "Scalar emitters: build a
`ScalarOpSpec`, don't build the `Instruction`" subsection.

## Three places the implementation deviates from the ticket — please weigh these

**1. `buildLiteralSpec` returns `ScalarOpSpec | undefined`.** The ticket listed
`emitLiteral` as a plain zero-operand conversion, but `LiteralExpr.value` is
`MaybePromise<SqlValue>` and the async arm is live, not vestigial: the constant-folding
pass (`planner/analysis/const-pass.ts:258`) parks the unawaited result of an async fold
straight into `LiteralExpr.value` and lets the scheduler resolve it. That body is not a
`ScalarOpSpec` body. Rather than widen `ScalarOpSpec.run` to `OutputValue` — which the
ticket explicitly forbade — `buildLiteralSpec` yields `undefined` for a Promise value and
`emitLiteral` builds that one Instruction itself. Note text is shared by both arms via a
`literalNote` helper so it cannot drift.

**2. `buildLogicalOpSpec` returns `ScalarOpSpec | undefined` too**, rather than existing
only for the eager form. Same fallback shape as literal, so a fusion consumer has one
entry point per node type and a uniform "no spec → don't fuse" signal. The short-circuit
branch moved into a sibling `emitShortCircuitLogicalOp`, and `combineLogical` — which the
parity tests guard — is now built by a shared `buildCombineLogical(operator, plan)` called
by both arms, so it is still literally one function body.

**3. No `asScalarRun` cast helper.** I first wrote one mirroring `asRun`, then measured it
unnecessary: a fixed-arity body assigns to the `(ctx, ...args: SqlValue[]) => SqlValue`
rest signature directly under `strictFunctionTypes`, with every declared param and the
return still checked against `SqlValue`. Verified by deleting the cast from `buildCastSpec`
and re-running `tsc -p tsconfig.json --noEmit` clean, then removing the helper.

## Deliberately NOT converted

- **`emitScalarFunctionCallDefault`** — its `run` returns `OutputValue` (a UDF may be
  async), which does not fit `ScalarOpSpec`. Left building its `Instruction` through
  `createValidatedInstruction`, exactly as before, per the ticket's stated preference.
  Its async question is ticket 3's. `createValidatedInstruction` therefore still has its
  six uniform call sites and `emitScalarOp` does not route through it.
- **`emitCaseExpr`** — invokes lazy branch callbacks; keeps its own emitter. Only the
  match test was extracted.
- **`emitCollate`** — already a pass-through to `emitPlanNode(plan.operand)`, no body.

## Verification performed

- `yarn lint` (repo root) — clean. For `packages/quereus` this is eslint **plus** a
  `tsc -p tsconfig.test.json --noEmit` pass over test files.
- `yarn build` (repo root) — clean.
- `yarn typecheck` (repo root, after build) — clean.
- `yarn test` (repo root, full suite) — green.
  - `packages/quereus`: **9087 passing, 25 pending, 0 failing** — byte-identical to the
    baseline I captured on a clean tree before touching anything.
  - Every other workspace unchanged; the only `failing`-matching string in the log is a
    stack frame from an intentionally-throwing mock inside a *passing* `quereus-sync` test.
- Note-text spot check beyond the suite: dumped `scheduler_program()` descriptions for one
  query per converted emitter and confirmed each tag still appears —
  `+(numeric-fast)`, `>(compare-fast)`, `||(concat)`, `LIKE(like-const)`, `LIKE(like)`,
  `BETWEEN`, `NOT`, `-(numeric-fast)`, `~(numeric-fast)`, `cast(integer)`, `literal(42)`,
  `param(#1)`, `column(a)`, `AND(logical)`, `XOR(logical)`,
  `case(short-circuit, 1 when clauses, else)`, and — using the shape from
  `test/and-or-short-circuit.spec.ts` — `AND(logical short-circuit)`.
- Diff-level check that every `note:` expression is character-identical to before. The
  only two that changed *form* are `literal(...)` (now via the shared `literalNote`, same
  template, same argument) and CASE's collation suffix (`whenCollationNames` →
  `matcher.collationNames`, same array).

## Known gaps — treat these as the starting line, not the finish

- **The async-literal fallback branch in `emitLiteral` has no test.** Neither did the code
  it replaced: `test/plan/constant-folding.spec.ts` and `test/optimizer/const-pass.spec.ts`
  are entirely synchronous, so the `const-pass.ts:258` → `literal.ts` async path is
  untested end to end today and was before this ticket. My change adds a *branch* on that
  untested path. It is a pure move (same closure value, same note), but nothing in the
  suite would catch it if I got it wrong. Worth an adversarial read, and worth deciding
  whether a `debt-` ticket for an async-const-fold test belongs in `backlog/` — I did not
  file one, since the gap predates this work and the ticket said no scope creep.
- **Spec arity vs `operands.length` is not type-checked.** A spec declaring two operands
  with a one-arg body compiles and silently drops the second value at runtime.
  `emitLikeOp` varies its arity between paths on purpose, so this cannot be made static in
  general. Parked as a `NOTE:` tripwire on `ScalarOpRun` in `emit/scalar-op.ts` with the
  escalation (a runtime assert comparing `spec.operands.length` to `spec.run.length`).
- **Emission-order argument is by inspection, not by test.** Several emitters mint symbols
  or capture schema during `emitPlanNode`, so the *order* operands are emitted in is
  observable. I traced each converted emitter and the order is unchanged (`emitScalarOp`
  maps `operands` left-to-right; the pre-emit specialization work all happens before, as
  it did). The one case worth a second pair of eyes is `emitLikeOp`, where `emitPlanNode
  (plan.left)` used to run *before* `compileLikeMatcher`, and now runs after — I judged
  `compileLikeMatcher` to be pure (no `EmissionContext` touch), but I did not prove it.
- **No fusion consumer exists yet**, so the claim "both consumers agree exactly" is
  currently unexercised by construction. Ticket 2 is what actually tests the shape.
- **`buildComparisonOpSpec` and `buildBetweenSpec` take `ctx: EmissionContext`** (they
  resolve collations through it). The other builders do not. If ticket 2 wants a uniform
  `(plan, ctx)` builder signature, that is a trivial widening but I did not pre-emptively
  do it.

## Suggested review focus

1. Read the `binary.ts` diff as a pure move — every body should be character-identical to
   its predecessor. If any condition changed, that is a bug, not a judgment call.
2. Confirm the AND/OR eager-vs-short-circuit split still shares exactly one `combineLogical`
   (the parity tests in `test/and-or-short-circuit.spec.ts` are the guard).
3. Confirm `buildCaseMatcher`'s searched-CASE arm (`neverMatches`, empty `collationNames`)
   matches the old `resolveWhenComparison` early return in both note output and behavior.
4. Sanity-check the two `ScalarOpSpec | undefined` builders against what ticket 2 will
   actually want from them.
