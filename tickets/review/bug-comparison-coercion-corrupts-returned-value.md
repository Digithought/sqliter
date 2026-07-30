---
description: Fixed three SQL functions that pick and return one of their arguments — they used to hand back a converted number instead of the value the user passed in, and could even return zero, a value that was never an argument. They now compare converted copies and return the original.
files:
  - packages/quereus/src/types/comparison-coercion.ts            # NEW — the pure "which operand converts to what" decision
  - packages/quereus/src/types/cast-semantics.ts                 # NEW castedScalarType; lenientCast doc updated
  - packages/quereus/src/planner/building/coercion.ts            # now a thin rewrite layer over the new module
  - packages/quereus/src/planner/nodes/scalar.ts                 # CastNode.generateType delegates to castedScalarType
  - packages/quereus/src/runtime/emit/operand-comparator.ts      # NEW makeComparisonGroup / ComparisonGroup
  - packages/quereus/src/schema/function.ts                      # NEW BaseFunctionSchema.returnsArg
  - packages/quereus/src/func/registration.ts                    # returnsArg passthrough
  - packages/quereus/src/planner/building/function-call.ts       # gates coerceComparisonGroup on !returnsArg
  - packages/quereus/src/func/builtins/scalar.ts                 # emitNullif, emitExtremum, extremumReturnType, NOTEs
  - packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic  # new section 6; greatest(i,'2') flipped
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic  # JSON section: three expectations flipped
  - docs/functions.md
  - docs/types.md
difficulty: medium
---

# Review: comparison coercion no longer changes the value a builtin returns

## What was wrong

`nullif`, `greatest` and `least` each **return one of their arguments**. They also
declare a comparison group so their comparison agrees with `=` — and that
declaration made `buildFunctionCall` **replace** the argument plan nodes with
`CastNode` wrappers. The cast's output was therefore the returned value:

| query | before | now |
|---|---|---|
| `nullif('3', 1)` | `3` (integer) | `'3'` (text) |
| `nullif('abc', 1)` | `0` | `'abc'` |
| `least('abc', 1)` / `least(1, 'abc')` | `0` | `'abc'` |
| `greatest(text_col, 1)` over `'3'` | `3` (integer) | `'3'` |
| `greatest(int_col, '2')` over `1` | `2` (integer) | `'2'` (text) |
| `greatest(json_col, '{"a":2}')` | parsed `{"a":2}` | the text `'{"a":2}'` |

`0` is the worst case: `cast('abc' as integer)` is `0`, so a value that was never
an argument leaked out as the result.

## What changed

**Compare converted copies; return the original argument.** The conversion moved
from a plan-time argument rewrite to an emit-time key conversion.

- **`src/types/comparison-coercion.ts` (new)** — the pure type-level decision,
  over `LogicalType` only: `crossTypeCoercion(left, right)` for a pair,
  `comparisonGroupCoercions(logicals)` for a probe-against-values group (returns
  a per-position conversion target, `null` = leave alone), plus
  `comparisonGroupIndices`. Lifted verbatim out of `planner/building/coercion.ts`
  — same arms, same order, same documented gap.
- **`planner/building/coercion.ts`** — now only maps those targets onto
  `wrapInCast`. `=`, BETWEEN, IN, simple CASE and the two IN-decorrelation
  rewrites are unchanged.
- **`types/cast-semantics.ts`** — new `castedScalarType(operandType, target)`,
  extracted from `CastNode.generateType` (which now calls it). So an emit-time
  comparison key resolves collation and comparator routing off exactly the types a
  plan-time cast would have produced.
- **`runtime/emit/operand-comparator.ts`** — new `makeComparisonGroup(operandTypes,
  comparesArgs)` returning `{ types, key(index, value) }`. `key` runs
  `lenientCast` — literally what a plan-time `CastNode` runs per row — so the
  comparison is byte-identical to the old one. Positions outside the group are
  identity in both.
- **`BaseFunctionSchema.returnsArg`** (+ registration passthrough) marks a function
  that returns an argument verbatim; `buildFunctionCall` skips
  `coerceComparisonGroup` for it. `nullif`, `greatest`, `least` set it.
- **`emitNullif`** compares `group.key(0, x)` vs `group.key(1, y)`, returns raw `x`.
  **`emitExtremum`** folds over keys tracking the winning **index**, returns
  `args[bestIndex]`.
- **`extremumReturnType`** — `greatest`/`least` now declare `ANY` for a group that
  is neither all-one-type nor all-numeric, instead of `findCommonType`'s
  first-argument fallback (which would advertise INTEGER for a returned text).
  `findCommonType` itself is unchanged; `coalesce`/`iif`/`choose` keep the old
  fallback (see the tripwire below).

## What to test / poke at

Everything below is covered by the two sqllogic files, but these are the shapes
worth re-deriving by hand rather than trusting:

**The comparison must not have moved.** Over-correcting is the real risk — it
would be easy to "fix" the return value by dropping the coercion entirely.
- `nullif(int_col, '1')` and `nullif(int_col, '1.9')` must both still be NULL over
  `int_col = 1` (INTEGER cast truncates, same as `int_col = '1.9'`).
- `greatest(1, '2')` is `'2'` and `least(1, '2')` is `1` — the numeric ranking
  still crosses the category boundary.
- `nullif(json_col, '{ "a" : 1 }')` still matches structurally (whitespace-
  insensitive) against a stored `{"a":1}`.

**Both orientations.** Argument order decides which side converts (a hoisted probe
conversion vs a per-value conversion), so a fix that only covers one side is a real
failure mode: `least('abc', 1)` and `least(1, 'abc')` must BOTH return `'abc'`.

**Storage class, not just the number.** `typeof(...)` is asserted on several of
these, because returning the right number with the wrong storage class is the
regression a value-only assertion would miss.

**NULL semantics must be byte-identical.** `greatest` skips NULLs; `least`'s NULL
wipes the running minimum (order-dependent — `least(1, null, 3)` is `3`). That is
`bug-least-null-handling-order-dependent`, deliberately NOT fixed here. The subtle
bit: the old fold's `best === null` test ran on the *cast* value, so the new test
rides on the running **key**, not the raw argument (`cast('' as integer)` is null
from a non-null operand). Worth confirming the fold rewrite (`emitExtremum` in
`func/builtins/scalar.ts`) really is equivalent to the old
`reduce(..., args[0])` — including that the old reduce's first iteration was a
self-comparison no-op, which is why the new loop starts at index 1.

**TIMESPAN must not have moved.** `greatest(timespan_col, 'PT30M')` never coerced
(it routes through the runtime duration check, not a cast) and still ranks by
elapsed time. `15.1`'s TIMESPAN half is unchanged.

## Validation run

All green, all in foreground:

- `yarn workspace @quereus/quereus run typecheck` — clean
- `yarn workspace @quereus/quereus run lint` — clean
- `yarn workspace @quereus/quereus run test` — 8086 passing, 13 pending, 0 failing
- `yarn workspace @quereus/quereus run test:plans` — 297 passing
- `yarn test` (root, all workspaces) — all passing
- `yarn lint` (root) — clean

`test:store` was not run (slower LevelDB path; nothing here touches storage).

## Known gaps — treat the tests as a floor

- **`coerceComparisonGroup` is now unreachable in-tree.** All three builtins that
  declare `comparesArgs` also declare `returnsArg`, so the plan-time group rewrite
  has no in-repo caller and no test exercising it. It is kept deliberately (per the
  fix ticket: a comparison function returning a *fresh* value should keep the
  plan-time rewrite, and third-party registrations may want it), but it is now an
  untested extension point. A reviewer could reasonably argue for either a unit
  test that registers such a function or for deleting the path.
- **Tie behavior is unpinned.** Which argument survives a comparator tie
  (`greatest(text_col, 1)` where the column holds `'1'`) is contractually
  unspecified. The new fold keeps the first argument, same as the old one, but no
  test asserts it — deliberately, so the latitude stays real.
- **`makeComparisonGroup` is only exercised through `nullif`/`greatest`/`least`.**
  Its partial-group path (`comparesArgs` naming a subset of positions) has no
  caller and no test; only the `[0,1]` and `'all'` forms run.
- **`extremumReturnType` is asserted only indirectly**, through the runtime values
  and `typeof(...)` in `03.6.1`. Nothing inspects the declared `ScalarType` of a
  `greatest`/`least` node directly, so a regression that declared the wrong type
  but happened to return the right value would not fail.
- `test:store` not run (see above).

## Tripwires parked

- **`findCommonType`'s first-argument fallback is dishonest for `coalesce`, `iif`
  and `choose` too** — `coalesce(int_col, text_col)` advertises INTEGER while it
  can return text. Left alone because it is pre-existing and currently benign (the
  write path converts or rejects rather than storing the wrong storage class, and
  no reader trusts the declared type over the runtime value). Parked as a `NOTE:`
  at `findCommonType` in `func/builtins/scalar.ts` saying what would make it real:
  a consumer that trusts a declared type without re-checking the value.
- **`lenientCast` now has a third per-row caller.** Its parse-failure path costs a
  thrown exception per row, so `least(free_text_col, 1)` over prose pays V8
  exception construction on every row. Existing `NOTE:` on `lenientCast`
  (`types/cast-semantics.ts`) updated to name the new caller.
- **The `implementation` fallbacks for these three are now BINARY *and*
  uncoerced.** They used to receive already-cast arguments. Unreachable today
  (`emitScalarFunctionCall` always prefers `customEmitter`), so parked as a `NOTE:`
  on `nullif`'s implementation in `func/builtins/scalar.ts` telling a future caller
  to route through the emitter rather than duplicate the coercion.
