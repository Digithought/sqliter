---
description: A SQL function that never said what type it returns used to be assumed to return a number, which silently broke comparisons against text; it is now treated as "unknown type" instead, and the numeric functions were taught to accept an unknown or null argument rather than rejecting it. Reviewed and accepted, with two follow-up tickets filed.
files:
  - packages/quereus/src/func/registration.ts                                  # the default, both sites
  - packages/quereus/src/types/builtin-types.ts                                # isNumericOrUnknownType helper
  - packages/quereus/src/types/index.ts                                        # re-export
  - packages/quereus/src/func/builtins/scalar.ts                               # 6 validateArgTypes sites, clamp null guard, sqrt inference cleanup (review)
  - packages/quereus/src/planner/nodes/window-function.ts                      # tripwire NOTE (review)
  - packages/quereus/test/logic/06.5.3-undeclared-return-type-comparison.sqllogic  # 9 sections (7 implement + 2 review)
  - packages/quereus/test/logic/06.2-math-functions.sqllogic                    # clamp(null,…) expectation changed
  - packages/quereus/test/core-api-features.spec.ts                            # UDF + custom-aggregate cases
  - docs/types.md                                                              # § Polymorphic Function Type Inference
difficulty: medium
---

# Undeclared function return type is ANY, not REAL

## What shipped

`createScalarFunction` and `createAggregateFunction` (`src/func/registration.ts`) filled in
`REAL_TYPE` when the caller declared no `returnType`. `REAL_TYPE.isNumeric` is true, so
`insertCrossTypeCoercion` (`planner/building/coercion.ts`) saw *numeric vs text* on every
comparison against such a function and cast the **text** side to REAL — the literal
`'object'` became `0`, and `json_type(j) = 'object'` was false. Both sites now default to
`ANY_TYPE`, which sets neither `isNumeric` nor `isTextual`, so coercion leaves both
operands alone and the generic runtime comparison decides.

Blast radius of the old default: all of `builtins/datetime.ts` and nearly all of
`builtins/json.ts` / `builtins/string.ts` declare no return type, and
`Database.createScalarFunction` / `createAggregateFunction` never pass one, so every user-
and plugin-registered function was affected.

With an honest ANY default, `abs(some_udf())` would be rejected at plan time, so the six
numeric builtins' argument gate (`argTypes[i].isNumeric === true`, copied six times) became
one shared predicate:

```ts
// src/types/builtin-types.ts, re-exported from src/types/index.ts
export function isNumericOrUnknownType(type: DeepReadonly<LogicalType>): boolean
// accepts: a numeric type, ANY (unclassifiable), or NULL
```

Used by `abs`, the shared `round` base, `sqrt`, `floor`, `ceil`/`ceiling`, and `clamp`
(over all three arguments). Textual/blob/boolean arguments are still rejected at plan time.
Accepting NULL also fixed a separate pre-existing defect — `select abs(null)` raised
`Invalid argument types for function abs` at HEAD — and forced an explicit null
short-circuit into `clamp`, whose three arguments reach `Number()` together
(`Number(null) === 0`, so `clamp(null, 1, 2)` returned the lower bound `1`).
`06.2-math-functions.sqllogic` had been pinning that bug and now expects `null`.

## Review findings

Read the implement diff (`da8ceedf`) before the handoff summary. Checked: the default at
both registration sites; every consumer of `isNumeric` and of scalar `nullable` that an
ANY-typed function result now reaches (`coercion.ts`, `emit/binary.ts` arithmetic and
comparison specialization, `emit/aggregate-setup.ts` coercion skipping,
`emit/operand-comparator.ts`, `scalar-invertibility.ts`, `rule-monotonic-window.ts`,
`set-op-type-merge.ts`, `planner/nodes/scalar.ts` monotonicity/injectivity,
`partial-unique-extraction.ts`, `filter.ts`); every `validateArgTypes` site in the engine;
all six implementations' null handling; the temporal types' flags; both public registration
paths and the plugin registration path; `docs/types.md`, `docs/plugins.md`,
`docs/window-functions.md`.

**Major — filed as tickets (2):**

- `fix/plugin-function-return-type-contract` — the ANY default lives in the
  `createScalarFunction` *helper*, not in registration, so `Database.registerFunction` (the
  path every plugin takes via `registerPlugin`) still accepts a scalar schema with no
  `returnType`, or with a `returnType` missing its `logicalType`, and fails later with
  `Planning error: Cannot read properties of undefined (reading 'typeClass' | 'physicalType')`
  — no function name, no hint. Reproduced both shapes. The malformed shape is not
  hypothetical: `docs/plugins.md` still documents `returnType: { typeClass: 'scalar',
  sqlType: 'TEXT' }` in five places (`sqlType` appears nowhere in the engine source) and
  gives relation columns a bare `type: 'INTEGER'` string. Following the docs yields a
  function that works in a bare `select` and throws an internal error the moment its value
  is compared.
- `backlog/feat-user-function-declared-return-type` — `docs/types.md` now says "declare the
  real type whenever you know it", but neither `Database.createScalarFunction` nor
  `createAggregateFunction` has a parameter for it; the underlying helpers do. The only
  route is the low-level `registerFunction`. Cheap gap to close.

**Minor — fixed in this pass (3):**

- Two behavior changes the handoff flagged as unpinned are now pinned in
  `06.5.3-…sqllogic` § 8 and § 9. § 8 is the one the handoff undersold: under the REAL
  default, arithmetic over an undeclared-return function was not merely unspecialized but
  *wrong*. `emitArithmeticOp`'s numeric-fast path applies the JS operator to the raw value,
  so `strftime('%Y', d) + 1` concatenated `'2024' + 1` to `'20241'`, failed
  `Number.isFinite` and returned NULL; it is 2025 now. Confirmed by registering a function
  that returns text while declaring REAL — it reproduces the old NULL exactly. § 8 also
  pins `abs(strftime(...))` and `sum`/`avg` over an ANY-typed argument (which no longer
  skip `coerceForAggregate`). § 9 pins the deliberate loss the handoff asked a reviewer to
  rule on: `json_extract('{"n":5}', '$.n') = '5'` was true and is now false. Verdict —
  pin it. It is the priced cost of not guessing, it matches `int_col in ('1')` today
  (`bug-numeric-text-coercion-skips-in-and-case`), and an unpinned deliberate change is
  indistinguishable from a regression six months out.
- `sqrt`'s `inferReturnType` carried `argTypes[0].name === 'INTEGER' ? argTypes[0] :
  argTypes[0]` — a tautological ternary under a comment claiming sqrt returns REAL, which
  it does not declare. Collapsed to `argTypes[0]`, comment corrected to say why the
  declared type stays the input's. Behavior identical.
- Nothing else in the diff needed changing. The helper's home in `types/builtin-types.ts`
  is right where it is: it names two type singletons and is re-exported for plugin authors,
  neither of which `func/builtins/scalar.ts` can offer.

**Tripwires — parked, not ticketed (2):**

- `planner/nodes/window-function.ts:54` is the last "guess REAL when the type is unknown"
  default left in the engine. It is unreachable (`planner/building/expression.ts` rejects an
  unregistered window function name before the node is built), so it is not a defect —
  `NOTE:` parked at the site saying to make it `ANY_TYPE` if window functions ever resolve
  from anything but the static registry.
- The implementer's own `NOTE:` at `isNumericOrUnknownType` (identity comparison against
  the `ANY_TYPE` / `NULL_TYPE` singletons breaks if a plugin registers a distinct type
  object named `'ANY'`/`'NULL'`) is correctly scoped and left as-is.

**Checked and deliberately unchanged (3):**

- `pow`/`power` ride the default and declare no `validateArgTypes`, as the handoff noted.
  Their implementation returns null for non-numeric input, so `pow('abc', 2)` is null while
  `abs('abc')` raises. That inconsistency predates this ticket and gating them would be a
  behavior change (null → error) that deserves its own decision, not a review-pass edit.
- `round`'s gate only inspects `argTypes[0]`, so `round(1.5, 'x')` passes plan-time
  validation and returns null from the implementation's `isNaN` check. Pre-existing and
  harmless; the second argument was never gated.
- `abs`/`round`/`floor`/`ceil` declare `nullable: false` while returning null for null
  input — pre-existing, and no optimizer rule folds `is null` on a scalar type's
  nullability (checked every `getType().nullable` consumer), so it misleads nothing today.
  `select abs(null) is null` is true.

**Not run:** store mode (`yarn test:store`), same as the implement stage — AGENTS.md keeps
it out of the agent loop, and its wall-clock is not agent-runnable. The new `.sqllogic`
deliberately omits `using memory` so a store run exercises it. No pre-existing failures
surfaced, so `tickets/.pre-existing-error.md` was not written.

## Validation

- `yarn workspace @quereus/quereus run test` — 8079 passing, 13 pending, 0 failing (before
  and after the review edits; the added sqllogic cases live inside one existing per-file
  test, so the count is unchanged)
- the new file alone: `node --import ./packages/quereus/register.mjs
  node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "06.5.3"` —
  1 passing
- `yarn lint` (all workspaces) and `yarn workspace @quereus/quereus run lint` — clean
- `yarn workspace @quereus/quereus run typecheck` — clean

## Docs

`docs/types.md` § "Polymorphic Function Type Inference" gained an "Omitting the return
type" subsection: what omitting `returnType` yields, why a wrong declared type is worse
than none (with the REAL-default failure as the example), that
`Database.createScalarFunction` always lands on this default, and that `validateArgTypes`
must let an unclassifiable argument through. Reviewed against the code as shipped — it is
accurate. `docs/plugins.md` is stale on this exact topic and is covered by
`fix/plugin-function-return-type-contract` rather than patched here, because its examples
need to be run against the engine, not edited by eye.
