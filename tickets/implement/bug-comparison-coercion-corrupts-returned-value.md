---
description: Functions that pick and return one of their arguments — nullif, greatest, least — can hand back a converted number instead of the value the user passed in, and for non-numeric text they can return 0, a value that was never an argument at all. Fix by comparing converted copies while still returning the original argument.
files:
  - packages/quereus/src/planner/building/coercion.ts          # today's plan-time cast insertion; keeps the =/IN/CASE callers
  - packages/quereus/src/types/cast-semantics.ts               # lenientCast — THE runtime conversion; add the cast result-type helper here
  - packages/quereus/src/types/comparison-coercion.ts          # NEW — the pure "which operand converts to what" decision
  - packages/quereus/src/runtime/emit/operand-comparator.ts    # comparator routing; add the emit-time comparison-group helper
  - packages/quereus/src/planner/nodes/scalar.ts               # CastNode.generateType — source of the result-type rules to share
  - packages/quereus/src/planner/building/function-call.ts     # calls coerceComparisonGroup on a declared comparison group
  - packages/quereus/src/func/builtins/scalar.ts               # emitNullif, emitExtremum, findCommonType, the three registrations
  - packages/quereus/src/schema/function.ts                    # BaseFunctionSchema.comparesArgs
  - packages/quereus/src/func/registration.ts                  # comparesArgs option passthrough
  - packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic  # NOTE + greatest(i,'2') expectation flips
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic                   # JSON section: three expectations flip
  - docs/functions.md                                          # the nullif/greatest/least comparison paragraph documents the bug
  - docs/types.md                                              # "Semantic ordering" → the comparison-builtins paragraph
difficulty: medium
---

# Comparison coercion must not change the value a builtin returns

## Reproduced

Against `1d0f3aa6`, memory module, `t` a TEXT column holding `'3'`:

| query | result now | expected |
|---|---|---|
| `nullif('3', 1)` | `3` (integer) | `'3'` (text) |
| `nullif('abc', 1)` | `0` | `'abc'` |
| `least('abc', 1)` | `0` | `'abc'` |
| `least(1, 'abc')` | `0` | `'abc'` |
| `greatest(t, 1)` | `3` (integer) | `'3'` |
| `greatest(i, '2')` where `i=1` | `2` (integer) | `'2'` (text) |
| `nullif(t, 1)` | `3` (integer) | `'3'` |
| `typeof(greatest(j, '{"a":1}'))` | `json` | text, when the literal wins |
| `coalesce(t, 1)` | `'3'` | `'3'` — unaffected, no comparison group |

## Cause

`buildFunctionCall` (`planner/building/function-call.ts:114`) calls
`coerceComparisonGroup`, which **replaces** the argument plan nodes of a declared
comparison group with `CastNode` wrappers. The three functions that declare a group
(`nullif`, `greatest`, `least`) all *return* one of their arguments, so the cast's
output is what the emitter hands back. `cast('abc' as integer)` is `0`
(`castFallback`, `types/cast-semantics.ts`), which is how a value that was never an
argument leaks out.

The plan-time rewrite has exactly one slot per argument, so comparing and returning
cannot be separated at that layer.

## The fix: coerce comparison keys at emit time, return the original argument

Stop rewriting arguments for functions that return one of them. Instead let their
emitters convert *copies* of the argument values for the comparison, and return the
original.

Three reasons this beats carrying both forms as plan operands:

- Emitting original **and** cast operands as separate instruction params evaluates
  each argument twice — `nullif(random(), 1)` would compare one draw and return
  another.
- `lenientCast(value, logicalType)` (`types/cast-semantics.ts`) is already THE
  definition of "convert the way CAST does" and is what `emitCast` runs per row, so
  an emit-time conversion is byte-identical to today's cast, not a second dialect.
- Return-type inference then sees the arguments the user wrote, which is what
  `nullif(X, Y)`'s "returns X" contract needs.

### Shape

**1. Extract the pure decision.** New `src/types/comparison-coercion.ts` owning the
type-level question `coercion.ts` answers today, over `LogicalType` only (no plan
nodes), so both the plan-time and the emit-time consumer read one rule:

```ts
/** Which side of a pairwise comparison converts, and to what. `null` = neither. */
export function crossTypeCoercion(
	left: LogicalType,
	right: LogicalType,
): { readonly side: 'left' | 'right'; readonly target: LogicalType } | null;

/**
 * Per-operand conversion target for a "one probe against many values" comparison
 * group (an IN value list, a simple CASE, a comparison builtin's argument group).
 * Aligned with the input array; `null` at a position means "leave that operand alone".
 */
export function comparisonGroupCoercions(
	logicals: readonly LogicalType[],
): readonly (LogicalType | null)[];
```

`comparisonGroupCoercions` must reproduce `coerceComparisonSet`'s existing arms
exactly (index 0 is the probe, the rest the value list):

- an object-physical (JSON) operand anywhere ⇒ every non-object, non-NULL-typed
  operand converts to that object type;
- else numeric probe ⇒ every *textual* value converts to the probe's type, the probe
  and non-textual values unchanged;
- else textual probe with **every** non-NULL value numeric ⇒ the probe converts to
  the shared numeric type name (`commonNumericTypeName`, NUMERIC when they differ),
  values unchanged;
- else nothing converts.

Rewrite `planner/building/coercion.ts`'s `insertCrossTypeCoercion` /
`coerceComparisonSet` to map those targets onto `wrapInCast` rather than re-deciding.
Their behavior for `=`, BETWEEN, IN and simple CASE must not move.

**2. Share the cast result type.** `CastNode.generateType`
(`planner/nodes/scalar.ts:705`) derives the ScalarType a cast advertises — nullability
via `castCanYieldNull`, and collation kept only when the target is textual. Extract it
as `castedScalarType(operandType: ScalarType, target: LogicalType): ScalarType` in
`types/cast-semantics.ts` and have `CastNode.generateType` call it, so the emit-time
path resolves collation off exactly the types the plan-time cast produced. (All
current coercion targets are numeric or JSON, i.e. non-textual, so a coerced operand
contributes no collation — matching today.)

**3. Emit-time helper.** In `runtime/emit/operand-comparator.ts`:

```ts
export interface ComparisonGroup {
	/** Effective operand types after coercion — collation and comparator routing read these. */
	readonly types: readonly ScalarType[];
	/** The comparison key for the operand at `index`; the value itself when it does not convert. */
	key(index: number, value: SqlValue): SqlValue;
}

export function makeComparisonGroup(
	operandTypes: readonly ScalarType[],
	comparesArgs: 'all' | readonly number[],
): ComparisonGroup;
```

Positions outside the group are identity in both `types` and `key`, so a future
function with a partial group works without another code path.

**4. Rewire the two emitters** (`func/builtins/scalar.ts`):

- `emitNullif` — build the group from `plan.operands.map(op => op.getType())`, resolve
  the collation with `effectiveCollationOfTypes(group.types[0], group.types[1],
  plan.expression)` and the comparator from `group.types[*].logicalType`; compare
  `group.key(0, argX)` against `group.key(1, argY)`; **return `argX`**, the raw first
  argument.
- `emitExtremum` — resolve `effectiveGroupCollation(group.types, …)` and
  `makeGroupComparator(group.types.map(t => t.logicalType), …)` as today, then fold
  over *keys* while tracking the winning **index**, and return the raw argument at
  that index. Keep the NULL semantics byte-identical: today's `best === null` test
  ran on the cast output, so the new test is on the running **key**, not the raw
  value (`cast('' as integer)` is null from a non-null operand). `greatest` skips
  NULLs, `least`'s NULL wipes the running minimum — both stay exactly as they are;
  `bug-least-null-handling-order-dependent` is a separate backlog ticket and must not
  be "fixed" here.
- Ties under a non-BINARY comparator keep the same latitude: which argument survives
  a tie is unspecified, but it must be one of the arguments.

**5. Distinguish the two kinds of comparison group** — the ticket's open question.
`comparesArgs` currently means both "these positions are compared" *and* "rewrite them
with casts". A function that returns a *fresh* value (a third-party
`same_value(a, b)`) can keep the plan-time rewrite; a value-returning one cannot. Add
the distinguishing flag next to it in `schema/function.ts` and pass it through
`func/registration.ts`:

```ts
/** The function returns one of its arguments verbatim, so the comparison group must
 *  NOT be rewritten with plan-time casts — its emitter compares coerced keys and
 *  returns the raw argument. See planner/building/coercion.ts. */
readonly returnsArg?: boolean;
```

`nullif`, `greatest`, `least` set it; `function-call.ts` skips
`coerceComparisonGroup` when it is set. Third-party functions that declare only
`comparesArgs` keep today's behavior.

**6. Declared return type of `greatest`/`least`.** With the casts gone, `argTypes`
reaching `inferReturnType` are the originals, and `findCommonType`
(`func/builtins/scalar.ts:28`) falls back to *the first type* when the arguments are
neither all-same nor all-numeric — so `greatest(i, '2')` would advertise INTEGER while
returning the text `'2'`. That is a node advertising a type it does not produce. Give
`greatest`/`least` an honest inference: when the group is not all-same and not
all-numeric, declare `ANY_TYPE`. Do **not** change `findCommonType` itself in this
ticket — `coalesce`, `iif` and `choose` share the same conservative fallback and the
same latent dishonesty, but theirs is pre-existing and unchanged by this fix (the
write path converts or rejects rather than storing the wrong storage class — verified:
`insert into int_col select coalesce(null, text_col)` converts, and a VALUES insert of
an unconvertible text raises `Type conversion failed`). Leave a `NOTE:` at
`findCommonType` recording the general case instead.

`nullif` already infers `argTypes[0]`, which becomes *more* honest once the cast is
gone — no change needed there.

## Expectations that flip (they pin today's bug)

- `test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic:42-48` — the NOTE
  pointing at this ticket goes away and `greatest(i, '2')` becomes the text `"2"`.
- `test/logic/15.1-semantic-ordering.sqllogic` JSON section (~line 440-451):
  - `nullif('{ "a" : 2 }', doc)` returns the original text `'{ "a" : 2 }'`, not the
    parsed `{"a":2}` — and the comment above it, which documents the probe-cast
    behavior as intended, must be rewritten to say the comparison is still structural
    while the returned value is the argument as written.
  - `greatest(doc, '{"a":2}')` — the winner is the text literal, so `g` becomes the
    string `'{"a":2}'`; `least` still returns the column's parsed document.

Everything else in the corpus uses these builtins on same-category arguments and must
not move — verified across `03-expressions`, `06.2`, `06.4.2`, `06.5`, `06.5.3`,
`10.3`, `24-builtin-branches`, `101-builtin-mutation-kills` and the TIMESPAN half of
`15.1`. In particular the TIMESPAN group never coerced (it routes through the runtime
duration check, not a cast), so `greatest(d, 'PT30M')` is unchanged.

## New coverage to add

In `03.6.1` (it already owns the "every spelling of the same comparison agrees" job),
a section pinning **comparison answers unchanged, returned values original**:

- `nullif('3', 1)` → `'3'`; `nullif('abc', 1)` → `'abc'`; `nullif(t, 1)` → `'3'`.
- `nullif(i, '1')` → NULL and `nullif(i, '1.9')` → NULL — the comparison must still
  match (this is the regression guard for over-correcting).
- `least('abc', 1)` and `least(1, 'abc')` — both orientations; the result must be one
  of the arguments, never `0`. The reverse order is the hoisted-probe-vs-value-cast
  asymmetry the fix must cover on both sides.
- `greatest(1, '2')` → `'2'` and `least(1, '2')` → `1` — the comparison still picks
  the numerically larger/smaller argument.
- `typeof(...)` assertions on at least one of these, so a future regression that
  returns the right *number* with the wrong storage class still fails.
- A control that `coalesce` is untouched.

In `15.1`, alongside the flipped JSON expectations, pin that
`nullif(doc, '{ "a" : 1 }')` still matches structurally (whitespace-insensitive) —
i.e. the JSON arm's comparison behavior survives the change.

## TODO

- Add `src/types/comparison-coercion.ts` with `crossTypeCoercion` and
  `comparisonGroupCoercions`; move the decision out of
  `planner/building/coercion.ts` and have that file consume it, with no behavior
  change for `=`, BETWEEN, IN and simple CASE.
- Extract `castedScalarType` into `types/cast-semantics.ts` and call it from
  `CastNode.generateType`.
- Add `makeComparisonGroup` to `runtime/emit/operand-comparator.ts`.
- Add `returnsArg` to `BaseFunctionSchema` + `func/registration.ts`; set it on
  `nullif`, `greatest`, `least`; gate `coerceComparisonGroup` on it in
  `planner/building/function-call.ts`.
- Rewrite `emitNullif` to compare keys and return the raw first argument.
- Rewrite `emitExtremum` to fold over keys, track the winning index and return the raw
  argument at that index, preserving the existing NULL behavior exactly.
- Make `greatest`/`least` infer `ANY_TYPE` for a mixed-category argument group; add
  the `NOTE:` at `findCommonType` about the shared conservative fallback.
- Update `03.6.1` (flip `greatest(i,'2')`, drop the NOTE, add the new section) and
  `15.1` (flip the three JSON expectations and rewrite the comment above them).
- Update `docs/functions.md` (the paragraph currently *documents* the bug — replace it
  with the compare-converted / return-original rule) and `docs/types.md`
  ("Semantic ordering" → the comparison-builtins paragraph, which says the plan-time
  object-physical coercion applies to these three).
- Run `yarn workspace @quereus/quereus run test`, `test:plans`, `lint` and
  `typecheck`, then `yarn test` and `yarn lint` at the root.
