---
description: Pulled the evaluation logic of SQL expression operators out of the query engine's instruction machinery into a shared, reusable shape, so an upcoming faster evaluation path can use exactly the same logic instead of a second copy.
files:
  - packages/quereus/src/runtime/emit/scalar-op.ts        # NEW — ScalarOpRun / ScalarOpSpec / emitScalarOp / assertSpecArity
  - packages/quereus/src/runtime/emit/binary.ts           # buildBinaryOpSpec front door + numeric / comparison / concat / LIKE / logical
  - packages/quereus/src/runtime/emit/unary.ts
  - packages/quereus/src/runtime/emit/between.ts
  - packages/quereus/src/runtime/emit/cast.ts
  - packages/quereus/src/runtime/emit/literal.ts
  - packages/quereus/src/runtime/emit/column-reference.ts
  - packages/quereus/src/runtime/emit/parameter.ts
  - packages/quereus/src/runtime/emit/case.ts             # buildCaseMatcher / CaseMatcher
  - packages/quereus/src/runtime/emit/filter.ts           # comment repoint only
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts  # NEW — arity invariant + note contract + async-literal arm
  - packages/quereus/test/and-or-short-circuit.spec.ts    # comment repoint only
  - docs/runtime.md                                       # "Scalar emitters" subsection
---

# Scalar operator bodies factored out of their emitters

## What landed

`packages/quereus/src/runtime/emit/scalar-op.ts` holds the shared shape:

```ts
export type ScalarOpRun = (ctx: RuntimeContext, ...args: SqlValue[]) => SqlValue;

export interface ScalarOpSpec {
	readonly operands: readonly ScalarPlanNode[];
	readonly run: ScalarOpRun;
	readonly note: string;
}

export function emitScalarOp(spec: ScalarOpSpec, ctx: EmissionContext): Instruction;
```

`emitScalarOp` asserts the spec's arity, then maps each operand through `emitPlanNode`
into `Instruction.params` and hands the body to the scheduler as `run`.

Every synchronous scalar emitter now splits into a `buildXxxSpec(plan[, ctx])` plus a
short `emitXxx` that calls `emitScalarOp`. One spec builder per **registered node type**:

| registered emitter | spec builder | operands |
| --- | --- | --- |
| `emitLiteral` | `buildLiteralSpec` (`undefined` for a Promise value) | none |
| `emitColumnReference` | `buildColumnReferenceSpec` | none |
| `emitParameterReference` | `buildParameterSpec` | none |
| `emitCast` | `buildCastSpec` | operand |
| `emitUnaryOp` | `buildUnaryOpSpec` | operand |
| `emitBetween` | `buildBetweenSpec` | expr, lower, upper |
| `emitBinaryOp` | `buildBinaryOpSpec` (`undefined` for AND/OR short-circuit) | per operator |

`buildBinaryOpSpec` owns the operator switch and delegates to `buildNumericOpSpec`,
`buildComparisonOpSpec`, `buildConcatOpSpec`, `buildLikeOpSpec` (one operand on the
constant-pattern path, two otherwise) and `buildLogicalOpSpec`. The AND/OR short-circuit
form has no spec — its right operand is a deferred sub-program, not a value — and
`emitBinaryOp` falls back to `emitShortCircuitLogicalOp`. `combineLogical` is built once
by `buildCombineLogical` and shared by both arms.

`case.ts` exports `CaseMatcher` / `buildCaseMatcher`; `emitCaseExpr` keeps its own emitter
(it invokes lazy branch callbacks) and reads `matcher.matches(i, baseValue, w)` and
`matcher.collationNames`.

Not converted, deliberately: `emitScalarFunctionCallDefault` (its `run` returns
`OutputValue`; ticket 3 settles its async question), `emitCaseExpr`, and `emitCollate`
(already a pass-through with no body of its own).

No behavior change. Every instruction `note`, result value, and error is unchanged.

## Review findings

### Checked

Read the implement diff (`d0a3d5af`) before the handoff summary, treating every moved body
as a claimed pure move and re-deriving it. Specifically: each body against its predecessor
character by character; `emitPlanNode` ordering per converted emitter; the AND/OR
eager-vs-short-circuit split; `buildCaseMatcher`'s searched arm against the old
`resolveWhenComparison` early return; the `ScalarOpSpec` shape against what
`tickets/implement/2-runtime-scalar-fusion-compiler.md` actually consumes; the interaction
between `ScalarOpRun`'s rest signature and `asRun`'s documented `TArgs` inference caveat;
`docs/runtime.md` against the code it describes; and test coverage of the new seam. Ran
`yarn lint`, `yarn build`, `yarn typecheck`, `yarn test`, and `yarn docs:check`.

### Found and fixed in this pass

- **There was no spec entry point for `BinaryOpNode`, the node type that needs one most.**
  `emitBinaryOp`'s operator switch dispatched to five `Instruction`-returning `emitXxx`
  wrappers, so the fusion compiler in ticket 2 would have had to restate which operator
  routes to which body — the exact drift this ticket exists to prevent, and something
  ticket 2 forbids in as many words ("the fusion compiler must not restate any operator
  logic"). Added `buildBinaryOpSpec(plan, ctx): ScalarOpSpec | undefined` holding the
  switch; `emitBinaryOp` is now two lines over it. Deleted the five wrappers
  (`emitNumericOp`, `emitComparisonOp`, `emitConcatOp`, `emitLogicalOp`, `emitLikeOp`),
  which nothing else imported and which my change would otherwise have orphaned. This also
  retires the asymmetry the handoff flagged — `buildComparisonOpSpec` and
  `buildBetweenSpec` take `ctx` while the others do not: it is now internal detail behind
  one `(plan, ctx)` front door per registered node type. Repointed the two comments that
  named `emitLogicalOp` (`emit/filter.ts`, `test/and-or-short-circuit.spec.ts`).
- **Promoted the spec-arity tripwire to an enforced invariant.** The handoff parked "a spec
  declaring two operands with a one-arg body compiles and silently drops the second value"
  as a `NOTE:`, on the grounds that `emitLikeOp` varies its arity so a check "cannot be
  made static in general". That conflates static with runtime: LIKE varies its declared
  operands and its body arity *together*, and all eleven specs satisfy
  `run.length === operands.length + 1`. The tripwire's own stated escalation was
  implementable today, so `emitScalarOp` now calls `assertSpecArity`, throwing
  `StatusCode.INTERNAL` on a mismatch (same emit-time-assert pattern as
  `emitScalarFunctionCallDefault`'s arity check). Rewrote the `NOTE:` to cover what is
  genuinely still conditional (below).
- **The note-text contract had no test.** Notes are a visible contract and the ticket said
  so, but verification was a one-off manual `scheduler_program()` dump — nothing durable.
  `test/logic/06.5.4-declared-return-type-builtins.sqllogic` pins only the three `=`
  comparison tags. Added `test/runtime/scalar-op-spec.spec.ts` with 19 note assertions
  covering every converted emitter, including four shapes the manual pass did not touch
  (`NOT BETWEEN`, `OR(logical)`, searched CASE, and the async-literal arm below), plus two
  tests for the new arity invariant.
- **The async-literal fallback branch now has a test, and its reachability is
  demonstrated.** The handoff flagged this branch as untested and asked whether to file a
  ticket. It is reachable from ordinary SQL: `select n + asyncdouble(3) from t`, where
  `asyncdouble` is an async deterministic scalar function and `n` is a column, folds the
  function call on its own into a `LiteralNode` whose `value` is an unresolved Promise —
  observed as `literal({})` in the program dump, evaluating correctly to `16`. A relational
  fold swallows the case when *every* operand is constant, which is why the row-dependent
  operand matters. Both the note and the resolved value are now pinned. No ticket filed;
  the gap is closed rather than queued.
- Minor hygiene: trailing blank line at the end of `binary.ts`; `docs/runtime.md` claiming
  every spec builder takes `(plan, ctx)` when six take only `plan`; `scalar-op.ts` doc
  comments naming `emitLikeOp` after it was deleted. All corrected, and `docs/runtime.md`
  gained the one-builder-per-node-type rule and the arity invariant.

### Verified, and NOT defects

- **`emitLikeOp`'s emission reorder is safe** — the handoff called this out as judged but
  unproven. `compileLikeMatcher` is `memoizeCompile(compileLike)` (`util/patterns.ts:140`):
  a pure pattern→RegExp compile behind a module-level memo, with no `EmissionContext`
  touch. Moving it ahead of `emitPlanNode(plan.left)` cannot be observed. Every other
  converted emitter's operand order is unchanged.
- **The async-literal fallback cannot behave differently from the spec arm.** Both produce
  `{ params: [], run: () => value, note: literalNote(value) }` over the same captured
  value, and `asRun` is an identity cast — so the new branch was equivalent by
  construction, not merely untested. It is now covered anyway.
- **AND/OR really do share one combine.** `buildCombineLogical` is called by
  `buildLogicalOpSpec` and by `emitShortCircuitLogicalOp` and by nothing else;
  `selectLogicalCombine` still throws for an unsupported operator on both paths. The 3VL
  parity tests in `test/and-or-short-circuit.spec.ts` pass.
- **`buildCaseMatcher`'s searched arm matches the old early return.** `neverMatches` is
  never called (the searched runner does not consult it) and the empty `collationNames`
  produces the same `formatOperandCollationNote('')` suffix — now pinned by the
  searched-CASE note test. The `matches` closure also moved from per-row to per-emit, which
  is strictly fewer allocations with the same result.
- **`docs:check` passes**, which the handoff did not verify despite adding 29 lines to a
  ratcheted doc. `docs/runtime.md` has no ratchet entry and is under the 12000-word cap
  with room; the four notices reported are unrelated docs, unchanged, and pre-existing.

### Filed as new tickets

None. Two candidates were considered and both resolved without one:

- The async-const-fold coverage gap the handoff asked about — closed inline with a test
  rather than queued, since the repro turned out to be three lines of SQL.
- `Database.createScalarFunction` types its callback as synchronous while the engine's
  `ScalarFunc` accepts a promise, so the async-literal test cannot use the public API. The
  site is already claimed: `tickets/backlog/feat-udf-registration-surface-gaps.md` arm B
  names this exact signature, cites `test/filter-conjunct-early-exit.spec.ts` as the
  precedent, and lists open decisions a reviewer should not pre-empt. Not re-filed; the new
  test takes the same internal-factory route that ticket documents, with a comment pointing
  at it.

### Tripwires (recorded, not ticketed)

- `emit/scalar-op.ts`, `assertSpecArity` doc comment: a body with a rest signature
  (`(ctx, ...args)`) or a defaulted parameter reports a `Function.length` that stops short
  and would trip the new assert. No spec is variadic today —
  `emitScalarFunctionCallDefault`, the one variadic scalar body, deliberately stays off
  `ScalarOpSpec`. If ticket 3 gives it a spec, that needs an explicit opt-out at the assert,
  not a weakened check for everyone.

### Not found

- No behavior change anywhere in the diff. Every moved body is character-identical to its
  predecessor; the only `note` expressions that changed *form* are `literal(...)` (now via
  a shared `literalNote` helper, same template and argument) and CASE's collation suffix
  (`whenCollationNames` → `matcher.collationNames`, same array).
- No resource-cleanup or error-handling regressions: no spec body allocates anything the
  old emitter did not, `emitParameterReference`'s throw stayed inside the body where the
  binding is resolved, and `selectLogicalCombine`'s and `buildNumericOpSpec`'s emit-time
  throws still fire on the same inputs.
- No stale docs. `docs/runtime.md` is the only doc describing emitter construction;
  `docs/architecture.md` and `packages/quereus/README.md` describe the pipeline at a level
  this change does not reach, and were re-read to confirm that.
- No registration drift: `runtime/register.ts` is untouched and still maps node types to
  the `emitXxx` names.

## Verification performed

- `yarn lint` (repo root) — clean.
- `yarn build` (repo root) — clean.
- `yarn typecheck` (repo root, after build) — clean. Also
  `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit` directly in
  `packages/quereus` — clean.
- `yarn docs:check` — `Docs OK`.
- `yarn test` (repo root, full suite) — green. `packages/quereus`: **9110 passing,
  25 pending, 0 failing** (9087 at the implement handoff, +23 from the new spec file).
  Every other workspace unchanged; the only `failing`-matching string in the log is a stack
  frame from an intentionally-throwing mock inside a *passing* `quereus-sync` test.

## Known gaps carried forward

- **No fusion consumer exists yet**, so "both consumers agree exactly" is still unexercised
  by construction. `tickets/implement/2-runtime-scalar-fusion-compiler.md` is what tests the
  shape. It now has one spec builder per registered node type and a uniform "`undefined` →
  do not fuse" signal, which is what it asks for.
- **`emitScalarFunctionCallDefault` still builds its own `Instruction`** through
  `createValidatedInstruction`, so that helper keeps its six uniform call sites and
  `emitScalarOp` does not route through it. Its async question is ticket 3's.
