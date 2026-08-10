---
description: Three SQL functions that pick and return one of their arguments used to hand back a converted number instead of the value the user passed in, and could even return zero — a value that was never an argument. They now compare converted copies and return the original.
files:
  - packages/quereus/src/types/comparison-coercion.ts            # the pure "which operand converts to what" decision
  - packages/quereus/src/types/cast-semantics.ts                 # castedScalarType; lenientCast NOTE
  - packages/quereus/src/planner/building/coercion.ts            # thin rewrite layer over the above
  - packages/quereus/src/planner/nodes/scalar.ts                 # CastNode.generateType delegates to castedScalarType
  - packages/quereus/src/runtime/emit/operand-comparator.ts      # makeComparisonGroup / ComparisonGroup
  - packages/quereus/src/schema/function.ts                      # BaseFunctionSchema.returnsArg
  - packages/quereus/src/func/registration.ts                    # returnsArg passthrough
  - packages/quereus/src/planner/building/function-call.ts       # gates coerceComparisonGroup on !returnsArg
  - packages/quereus/src/func/builtins/scalar.ts                 # emitNullif, emitExtremum, extremumReturnType
  - packages/quereus/test/comparison-group-coercion.spec.ts      # NEW (review) — both coercion halves at plan/unit level
  - packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - docs/functions.md
  - docs/types.md
---

# Complete: comparison coercion no longer changes the value a builtin returns

## What shipped

`nullif`, `greatest` and `least` each **return one of their arguments** while also
declaring a comparison group so their comparison agrees with `=`. That declaration
used to make the planner replace the argument plan nodes with `CastNode` wrappers,
so the cast's output was the returned value: `nullif('3', 1)` gave the integer `3`,
and `least('abc', 1)` gave `0` — a value that was never an argument.

The conversion moved from a plan-time argument rewrite to an emit-time key
conversion: **compare converted copies, return the original argument.**

- `types/comparison-coercion.ts` holds the type-level decision (`crossTypeCoercion`,
  `comparisonGroupCoercions`, `comparisonGroupIndices`), lifted out of
  `planner/building/coercion.ts` so plan-time and emit-time consumers cannot drift.
- `planner/building/coercion.ts` now only maps those targets onto `wrapInCast`.
- `types/cast-semantics.ts` gained `castedScalarType`, extracted from
  `CastNode.generateType`, so an emit-time comparison key resolves collation and
  comparator routing off exactly the types a plan-time cast would have produced.
- `runtime/emit/operand-comparator.ts` gained `makeComparisonGroup`, returning
  `{ types, key(index, value) }`; `key` runs the same `lenientCast` a `CastNode`
  runs per row, so the comparison is unchanged.
- `BaseFunctionSchema.returnsArg` marks a function that returns an argument
  verbatim; `buildFunctionCall` skips the plan-time group rewrite for it.
- `emitNullif` compares keys and returns raw `x`; `emitExtremum` folds over keys
  tracking the winning **index** and returns `args[bestIndex]`.
- `extremumReturnType` declares `ANY` for a `greatest`/`least` group with no type
  covering every argument it could pick.

## Review findings

### Checked

- **The implement diff read fresh, before the handoff summary** — all 13 source,
  test and doc files.
- **Fold equivalence.** Re-derived `emitExtremum` against the old
  `reduce(..., args[0])` by hand for: the old first-iteration self-comparison
  no-op (why the new loop starts at 1), a NULL first argument, a first argument
  whose *key* is null from a non-null operand (`greatest('', 1)` — `cast('' as
  integer)` is null), `least(1, null, 3)` staying order-dependent at `3`, and
  3-argument mixed groups. Equivalent in every case.
- **The comparison did not move.** `nullif(int_col, '1')` and `nullif(int_col,
  '1.9')` both still NULL; `greatest(1,'2')` → `'2'`, `least(1,'2')` → `1`;
  `nullif(json_col, '{ "a" : 1 }')` still matches structurally; TIMESPAN still
  ranks by elapsed time. Confirmed by the sqllogic files plus ad-hoc queries
  through `db.eval` over blob/real/collated/multi-argument shapes not in the
  suite.
- **Collation path.** `emitNullif` swapped `effectiveComparisonCollation(x, y)`
  for `effectiveCollationOfTypes(group.types[0], group.types[1])`. Verified
  equivalent: the old operands were the cast nodes, whose type came from the same
  `castedScalarType` the group now calls. Same for `effectiveGroupCollation` in
  `emitExtremum`.
- **Reachability of the `implementation` fallbacks.** The handoff called them
  unreachable; confirmed independently — `emitScalarFunctionCall` returns
  `customEmitter(...)` before ever reaching `emitScalarFunctionCallDefault`, and
  `planner/analysis/const-evaluator.ts` does not evaluate function calls, so
  `scalar-function.ts:34` is the only call site.
- **Docs.** `docs/types.md` and `docs/functions.md` re-read against the code and
  are accurate. `docs/usage.md` / `docs/determinism.md` describe only the 3-argument
  `db.createScalarFunction` convenience API, which never exposed `comparesArgs`, so
  nothing there went stale.
- **Full validation, foreground:** `lint` clean, `typecheck` clean, quereus `test`
  8098 passing / 13 pending / 0 failing, `test:plans` 297 passing, root `yarn test`
  and root `yarn lint` clean.

### Minor — fixed in this pass

- **`extremumReturnType` degraded a NULL-typed argument into a mixed-category
  group.** `greatest(int_col, null)` declared `ANY` where it used to declare
  `INTEGER`. A NULL-typed argument can only win with NULL, which the declaration is
  already nullable for, so it contributes nothing the declared type must cover.
  Fixed by dropping NULL-typed arguments before the all-same / all-numeric test
  (`func/builtins/scalar.ts`, `extremumReturnType`); `docs/types.md` updated; pinned
  by a new test. Runtime values were never wrong — this was declared-type precision
  the change lost by accident.
- **Two untested paths the handoff flagged, now covered** by new
  `packages/quereus/test/comparison-group-coercion.spec.ts` (12 tests):
  - `coerceComparisonGroup`, the plan-time rewrite that has had **no in-repo caller
    and no test** since all three builtins moved to `returnsArg`. The spec registers
    a comparison function that returns a fresh value (`seen_args`, `comparesArgs`
    without `returnsArg`) whose implementation reports the argument values it
    actually received, pinning both orientations and the `'abc'` → `0` fallback that
    is precisely why a value-returning function must not take this path. The
    extension point is now exercised rather than merely preserved.
  - `makeComparisonGroup`'s partial-group form (`comparesArgs: [0, 2]`), its
    identity form (fewer than two declared positions), and its clamping of a
    declared index past the call's arity — none of which any builtin reaches.
  - Plus plan-shape assertions no test made: that a `returnsArg` builtin's operands
    contain no `CastNode`, and the declared return type of `nullif` / `greatest` /
    `least` (the handoff noted `extremumReturnType` was asserted only indirectly
    through runtime values).

### Major — none

No finding warranted a new ticket. The behavior changes are confined to the
returned value of three builtins, the comparison itself is provably unchanged, and
every alternative path the change touches (plan-time rewrite, `CastNode` typing)
now has a direct test.

### Checked and deliberately left alone

- **Tie behavior stays unpinned.** Which argument survives a comparator tie is
  contractually unspecified; the new fold keeps the first, same as the old one. Not
  asserting it keeps the latitude real — agreed with the implementer's reasoning.
- **`greatest`/`least` are argument-order-sensitive over a mixed list.**
  `greatest('abc', 1, 'def')` is `'def'` while `greatest(1, 'abc', 'def')` is `1`,
  because `comparisonGroupCoercions` treats argument 0 as the probe and a textual
  probe only converts over an all-numeric value list. Verified this predates the
  change (the plan-time rewrite used the identical rule) and is the gap already
  documented in `comparisonGroupCoercions`. Not introduced here, so not re-filed.
- **`greatest(5, 2.5)` declares REAL but returns the integer `5`.** Same shape of
  over-claim as the bug that was fixed, but numeric-only and pre-existing — two
  numeric operands were never coerced, before or after — and storage classes
  `integer`/`real` interconvert. Left with the `findCommonType` tripwire below.
- **`db.createScalarFunction` (the 3-argument convenience API) forwards neither
  `comparesArgs` nor `returnsArg`.** Only `db.registerFunction(createScalarFunction(
  ...))` can declare a comparison group. Pre-existing and out of scope; the new spec
  uses and therefore documents the working route.
- **`test:store` not run** — nothing in the diff touches storage, and the LevelDB
  path is materially slower.

### Tripwires parked

- **`returnsArg` without a `customEmitter` turns a declared comparison group OFF
  rather than moving it** — the plan-time rewrite is skipped and nothing replaces
  it. Impossible to hit today (the three builtins all supply emitters, and nothing
  validates the pairing), so parked as a `NOTE:` on `BaseFunctionSchema.returnsArg`
  in `schema/function.ts` saying to reject the pairing in
  `Database.registerFunction` if third-party registrations start using it.
- Carried forward from implement, re-read and still accurate: the `findCommonType`
  first-argument fallback being dishonest for `coalesce`/`iif`/`choose`
  (`func/builtins/scalar.ts`), `lenientCast`'s per-row exception cost gaining a
  third caller (`types/cast-semantics.ts`), and the now-uncoerced `implementation`
  fallbacks for the three builtins (`func/builtins/scalar.ts`).

### Pre-existing failures

None. No test failed at any point in this pass, so `tickets/.pre-existing-error.md`
was not written.
