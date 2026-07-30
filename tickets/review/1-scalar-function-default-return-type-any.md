---
description: A SQL function that never said what type it returns used to be assumed to return a number, which silently broke comparisons against text; it is now treated as "unknown type" instead, and the numeric functions were taught to accept an unknown or null argument rather than rejecting it.
files:
  - packages/quereus/src/func/registration.ts                                  # the default, both sites
  - packages/quereus/src/types/builtin-types.ts                                # new isNumericOrUnknownType helper
  - packages/quereus/src/types/index.ts                                        # re-export
  - packages/quereus/src/func/builtins/scalar.ts                               # 6 validateArgTypes sites + clamp null guard
  - packages/quereus/test/logic/06.5.3-undeclared-return-type-comparison.sqllogic  # new
  - packages/quereus/test/logic/06.2-math-functions.sqllogic                    # clamp(null,…) expectation changed
  - packages/quereus/test/core-api-features.spec.ts                            # UDF + custom-aggregate cases
  - docs/types.md                                                              # § Polymorphic Function Type Inference
difficulty: medium
---

# Undeclared function return type is now ANY, not REAL

## What landed

**The default.** `createScalarFunction` and `createAggregateFunction`
(`src/func/registration.ts`) filled in `REAL_TYPE` when the caller declared no
`returnType`. `REAL_TYPE.isNumeric` is true, so `insertCrossTypeCoercion`
(`planner/building/coercion.ts`) saw *numeric vs text* on every comparison against such
a function and cast the **text** side to REAL — the literal `'object'` became `0`, and
`json_type(j) = 'object'` was false. Both sites now default to `ANY_TYPE`, which sets
neither `isNumeric` nor `isTextual`, so coercion leaves both operands alone and the
generic runtime comparison decides. Each site carries a comment explaining why the
honest unknown beats a guess.

Blast radius of the old default was wide: all of `builtins/datetime.ts` and nearly all of
`builtins/json.ts` / `builtins/string.ts` declare no return type, and
`Database.createScalarFunction` / `createAggregateFunction` never pass one, so every
user- and plugin-registered function was affected.

**The argument gate.** Six numeric builtins gated their argument on
`argTypes[i].isNumeric === true`. With an honest ANY default, `abs(some_udf())` would be
rejected at plan time. One shared predicate now replaces all six copies:

```ts
// src/types/builtin-types.ts, re-exported from src/types/index.ts
export function isNumericOrUnknownType(type: DeepReadonly<LogicalType>): boolean
// accepts: a numeric type, ANY (unclassifiable), or NULL
```

Used by `abs`, the shared `round` base (round/1 and round/2), `sqrt`, `floor`,
`ceil`/`ceiling`, and `clamp` (via `argTypes.every(...)`, covering all three arguments).
Textual/blob/boolean arguments are still rejected at plan time — `abs('abc')` still
raises `Invalid argument types for function abs`.

Accepting NULL also fixes a pre-existing, separately-reproduced defect: `select abs(null)`
threw `Invalid argument types for function abs` at HEAD, though `abs(<null column>)`
returned null. Folded in here because it is the same six lines.

**One change beyond the ticket's text.** The ticket asserted that all six implementations
already short-circuit a null argument. `clamp` did **not** — its three arguments reach
`Number()` together and `Number(null)` is `0`, so once NULL passed the plan-time gate
`clamp(null, 1, 2)` returned the lower bound `1` instead of null. `clamp` now returns null
if any argument is null, which also makes it agree with the NULL-propagation block just
above it in `06.2-math-functions.sqllogic`. That file asserted `clamp(v, 0, 10) → 0` for a
null column — it was pinning the bug; the expectation is now `null`, with a comment saying
why it changed.

## How to test / validate

`packages/quereus/test/logic/06.5.3-undeclared-return-type-comparison.sqllogic` (new, 7
sections). Run just it:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "06.5.3"
```

It covers: the four reproducing builtin comparisons (`json_type`, `json_extract`,
`strftime`, `json_quote` against a text literal), the mirrored-literal and `<>` forms, a
true-negative, WHERE position, agreement across IN / simple CASE / BETWEEN / LIKE,
ANY-vs-number, both directions of ANY-vs-JSON, the non-comparison uses of an ANY-typed
value (`||`, `length`, `coalesce`, `nullif`, `cast`, `typeof`), the identity sites (ORDER
BY / GROUP BY / DISTINCT / min / max), `abs(<undeclared function>)`, null propagation
through all six numeric builtins including all three `clamp` positions, and four
still-rejected textual arguments.

`packages/quereus/test/core-api-features.spec.ts` holds the user-defined-function half (a
`.sqllogic` file cannot register one): a text-returning UDF compared against a text
literal in both directions, the four comparison sites, ANY-vs-JSON both ways, all six
numeric builtins over a UDF argument, and a text-returning **custom aggregate** compared
against a text literal (the aggregate-site half of the default).

Ran and green:

- `yarn workspace @quereus/quereus run test` — 8079 passing, 13 pending, 0 failing
- `yarn test` (all workspaces) — 0 failing anywhere
- `yarn lint` — clean
- `yarn workspace @quereus/quereus run typecheck` — clean
- `test/materialized-view-replicable.spec.ts` → "rejects a non-replicable UDF nested
  inside a built-in call" passes (it now reaches the intended `cannot be materialized`
  error, because `abs` accepts the ANY-typed UDF)

## Known gaps — please poke at these

- **A deliberate behavior change with no test pinning it.** A numeric-looking *string*
  compared against an undeclared-return function flipped from true to false:
  `my_numeric_udf(n) = '10'` was true (the string was cast to REAL) and is now false. Same
  class as `int_col in ('1')` being false today
  (`bug-numeric-text-coercion-skips-in-and-case`), and it is the unavoidable cost of not
  guessing. Undecided whether it deserves a pinned expectation or is better left unpinned
  until the numeric↔text story is settled; a reviewer should make that call. Declaring the
  real `returnType` restores the coercion, which is exactly what ticket 2
  (`builtin-scalar-function-declared-return-types`) does for the builtins.
- **Comparison specialization is not asserted anywhere.** An ANY operand no longer
  qualifies for the `compare-fast` path in `runtime/emit/binary.ts` and lands on generic
  `compare`. Correctness improves, per-row cost rises slightly, and no plan-shape golden
  test noticed (nothing failed). Ticket 2 restores the fast path for builtins by declaring
  their real types; nothing restores it for user-defined functions that decline to declare
  one, which is the intended incentive.
- **Store mode not run.** `yarn test:store` was skipped per AGENTS.md guidance. The new
  `.sqllogic` deliberately omits `using memory` so store mode exercises it, but that run
  has not happened.
- **Coverage of the aggregate site is one test.** No built-in aggregate rides the default
  (audited: `count`→INTEGER, `avg`/`sum`/`total`/`stddev_*`/`var_*`→REAL,
  `group_concat`/`string_concat`→TEXT, `json_group_*`→JSON, `min`/`max` use
  `inferReturnType`), so the aggregate change is purely a guardrail for user-defined
  aggregates and has exactly one test behind it.
- **`pow`/`power` ride the default but declare no `validateArgTypes`**, so they were never
  affected by the gate and are untouched. Worth a glance for whether they *should* gate.
- **`isNumericOrUnknownType` compares by identity** against the `ANY_TYPE` / `NULL_TYPE`
  singletons, matching how `coercion.ts` tests `NULL_TYPE`. Tripwire parked as a `NOTE:` at
  the helper (`src/types/builtin-types.ts`): if a plugin ever registers its own distinct
  type object named `'ANY'` or `'NULL'` through `types/registry.ts`, the check stops
  recognizing it and should switch to a `name` comparison. Not reachable today.
- **The helper's home is a judgment call.** It sits in `types/builtin-types.ts` (next to
  the types it names, re-exported from `types/index.ts` so plugin authors can reach it)
  rather than in `func/builtins/scalar.ts` where all six call sites live. If a reviewer
  prefers it local, it is a two-line move.

## Docs

`docs/types.md` § "Polymorphic Function Type Inference" gained an "Omitting the return
type" subsection: what omitting `returnType` yields, why a wrong declared type is worse
than none (with the REAL-default failure as the example), that
`Database.createScalarFunction` always lands on this default, and that `validateArgTypes`
must let an unclassifiable argument through — pointing at `isNumericOrUnknownType`. The
`abs` example in the same section was updated to use the helper instead of a bare
`isNumeric` check.
