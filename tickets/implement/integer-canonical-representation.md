---
description: Whole numbers can arrive in the engine in either of two JavaScript forms, and which one you get depends on how the value got there — pin down one form per value, convert to it wherever values enter, and write the rule down.
files:
  - packages/quereus/src/types/builtin-types.ts        # INTEGER_TYPE.parse / NUMERIC_TYPE.parse — the conversion that must produce canonical form
  - packages/quereus/src/util/numeric-canonical.ts     # NEW — the canonicalization helper both halves share
  - packages/quereus/src/runtime/emit/binary.ts        # mixedBigIntArithmetic — narrow a bigint result back when it fits
  - packages/quereus/src/runtime/emit/unary.ts         # unary minus / bitwise-not bigint arms — same narrowing
  - packages/quereus/src/func/builtins/aggregate.ts    # addWithPromotion / sum step — promotes, never narrows
  - packages/quereus/src/core/statement.ts             # bind / bindAll / constructor — the three parameter-ingress sites
  - packages/quereus/src/util/key-tuple-codec.ts       # the NOTE whose "not reachable today" this turns into a guarantee
  - docs/types.md                                      # § Physical Types — where the contract text goes
  - packages/quereus/test/property.spec.ts             # fast-check is already wired up here
difficulty: hard
prereq:
---

# One JavaScript form per integer value

## Background: what this is and is not for

`docs/types.md` says every expression has a known type at plan time. That is true of the
*logical* type and false of the *JavaScript value*: the whole number 5 can be the JS
`number` `5` or the JS `bigint` `5n`, and which one you get depends on how it entered —
literal size, bound parameter, stored row, arithmetic result, aggregate promotion.

**This is not a performance ticket.** The sibling plan pass
`tickets/complete/runtime-guarded-comparison-specialization.md` measured the per-row
branches a representation invariant would let us delete, and they are worth 0–2 ns against
a ~143 ns/instruction dispatch floor. Those branches stay, and the accepted-tradeoff
`NOTE:`s recording that decision (on `compareSqlValuesFast` in `util/comparison.ts`, and
at the `numeric-fast` / `compare-fast` branches in `runtime/emit/binary.ts`) must be left
in place. Do not delete a `typeof` dispatch anywhere on the strength of this invariant.

What it buys, concretely:

- **A decided rule for two open bugs.** `backlog/bug-integer-column-rejects-large-real` is
  fixed outright here (see *Subsumed ticket* below), and
  `backlog/bug-text-coercion-in-arithmetic-and-aggregates` arm A ("what should the text
  →number conversion produce for a large whole number") gets the target form it is missing.
- **A guarantee where there is currently an observation.** `util/key-tuple-codec.ts` keys
  `5` and `5n` as *distinct* change-log entries and its `NOTE:` says an
  INSERT/DELETE pair would fail to coalesce if one row's primary key were ever presented
  in both forms — "not reachable today (a table's PK storage type is stable per row)".
  After this lands that is a rule, not a hope, and the NOTE should say so.
- **A checkable statement.** The follow-on ticket `representation-strict-checker` can only
  assert something once there is something to assert.

## The rule

Two invariants. Write them into `docs/types.md` in these words (or better ones), under a
new *Physical representation* subsection of § Physical Types.

**R1 — canonical numeric form (holds for every `SqlValue` anywhere in the engine,
whatever its declared type, including `ANY` columns):**

> A `SqlValue` is a JS `bigint` only when its magnitude is outside the safe-integer range
> (|v| > 2^53 − 1 = 9007199254740991). Every integer value inside that range is a JS
> `number`.

**R2 — per-declared-type value space (holds for a value in a position of that declared
type; `null` is always admissible and nullability is a separate contract):**

| declared type | admissible JS forms |
|---|---|
| INTEGER | `number` that is a safe integer, or `bigint` (necessarily outside safe range, by R1) |
| REAL | `number` |
| NUMERIC | `number`, or `bigint` under R1 |
| BOOLEAN | `boolean` |
| TEXT and the temporals (DATE/TIME/DATETIME/TIMESPAN) | `string` |
| BLOB | `Uint8Array` |
| JSON | native JS object/array, or a JSON scalar (`string`/`number`/`boolean`) |
| ANY | any of the above, each obeying R1 |

Note what R2 does **not** say: nothing here constrains a *probe* value handed to a
comparator. `REAL_TYPE.compare` tolerating a `bigint` operand (an integer literal past
2^53 compared against a `real` column) is comparator robustness against a value that is
not a REAL, and it stays exactly as it is.

**BOOLEAN stays a first-class runtime value.** The alternative considered — canonicalize
booleans to 0/1 at ingress and make BOOLEAN purely logical — was rejected: `boolean` is a
user-visible result value with its own `PhysicalType`, its own `compare` and its own JSON
round-trip, and the only thing the change would buy is deleting the boolean arms in
`getStorageClass` / `compareSameType`, which the measurement above says are worth nothing.
Those arms are also **not** debt and must not be removed for a different reason: an `ANY`
column may legitimately hold a boolean, so a numeric comparison can meet one no matter
what the invariant says about declared BOOLEAN positions. Say that in the doc, so the next
reader does not file it.

**Why the safe-integer boundary and not "exactly representable as a double".** 2^53 itself
(9007199254740992) is exactly representable but is not a *safe* integer — `2^53 + 1` is
not representable, so arithmetic around the boundary stops round-tripping. The lexer
(`parser/lexer.ts`, `number()`), `INTEGER_TYPE.parse`'s string arm and `NUMERIC_TYPE.parse`
already use `Number.isSafeInteger`, so this rule is the one they were already written
against. R1 makes 9007199254740992 a `bigint`.

## Where canonicalization happens

The engine converts a write's cells to the declared column type **once**, at the top of
the DML pipeline — and `buildRowCoercion` (`types/validation.ts`) deliberately *skips* a
cell whose producing expression already declares the target type (see docs/types.md
§ "Where coercion happens (and why exactly once)"). A parameter bound as `5n` is inferred
as INTEGER, so the DML skip rule leaves it alone and `5n` is stored verbatim. **The write
path therefore cannot be the place this is enforced.** Canonicalize at the points where a
value is *born*:

- **Conversion** — `INTEGER_TYPE.parse` and `NUMERIC_TYPE.parse`. Covers `cast(…)`, the
  conversion builtins, `lenientCast`/`castFallback`, DML coercion of a differently-typed
  cell, and the ALTER backfill paths (`foldDefaultToType`), all of which funnel here.
- **Literals** — already canonical: the lexer emits `number` below the safe boundary and
  `BigInt(lexeme)` above it. Verify with a test; no code change expected.
- **Bound parameters** — the three write sites in `core/statement.ts` (the constructor's
  positional loop, `bind`, `bindAll`). Canonicalize the value as it is stored into
  `boundArgs`. This is per-bind, not per-row.
- **Arithmetic and aggregation results** — the bigint arms in `runtime/emit/binary.ts`
  (`mixedBigIntArithmetic`), `runtime/emit/unary.ts` (negation, bitwise-not) and
  `func/builtins/aggregate.ts` (`addWithPromotion`, the SUM step) promote into `bigint`
  and never come back, so `9007199254740993 - 3` is a `bigint` holding a safe-range value.
  Narrow the result. Costs one bigint range compare **on the bigint arm only** — the
  `number`/`number` fast path is untouched.

Explicitly **not** canonicalized here (they are the follow-on ticket's business, and are
handled by contract + debug assertion rather than by per-row coercion): rows returned from
a virtual-table `query()`, and values returned from user-defined functions. Coercing those
per row would put a cost exactly where the measurement says there is nothing to win, for
values every consumer already tolerates.

## Subsumed ticket

`tickets/backlog/bug-integer-column-rejects-large-real.md` is fixed by the
`INTEGER_TYPE.parse` change: `insert into t(int_col) values (1e20)` currently parses to a
whole `number` that `INTEGER_TYPE.validate` then rejects; under R2 `parse` returns
`BigInt(1e20)`, which validate already accepts. That ticket's open question — should
`cast(1e20 as integer)` likewise return an exact integer — is answered yes by the same
change. **Take its repro into this ticket's tests and delete the backlog file.**
`INTEGER_TYPE.validate` needs no change.

## API surface change (call this out in the commit and in docs/types.md)

Values handed back to embedders through `eval` / `iterateRows` / UDF arguments / vtab
`update()` inputs are API surface, and two shapes change:

- A parameter bound as a small `bigint` (`stmt.bind(1, 5n)`) is now used, stored and
  returned as the `number` `5`. An embedder relying on a `bigint` round-trip for
  safe-range values must re-widen on its own side.
- A bigint arithmetic or `sum()` result that lands back inside the safe range is now a
  `number` rather than a `bigint`.

Neither changes a *value*; both change a JS `typeof`. The repo's stated position is that
backwards compatibility is not yet a constraint (AGENTS.md), and both changes move toward
the form the same value would have had if written as a literal.

## Edge cases & interactions

- **Boundary values.** 2^53 − 1 (9007199254740991) is a `number`; 2^53 (9007199254740992)
  and −2^53 are `bigint`. Narrowing `9007199254740991n` yields the `number`; narrowing
  `9007199254740992n` leaves it a `bigint`. Test both signs, both directions.
- **Range test on huge bigints.** Compare against `bigint` constants
  (`±9007199254740991n`), never via `Number(v)` — `Number(hugeBigint)` is lossy and can be
  `Infinity`.
- **`BigInt()` throws on non-integers and non-finites.** In `INTEGER_TYPE.parse`'s number
  arm, truncate first (`Math.trunc`) and widen only a *finite* whole value. `NaN` /
  `±Infinity` keep today's behavior exactly: they fall through and `validate` rejects them
  at a write with the existing MISMATCH message. Do not turn that into a `RangeError`.
- **Negative zero.** `Number.isSafeInteger(-0)` is true, so `-0` stays a `number` and is
  *not* normalized to `0` or widened. R1 must not be written in a way that makes `-0` a
  violation. (`encodeNumeric` in `@quereus/store` and `canonicalNumeric` in
  `util/key-serializer.ts` already fold `-0` for key purposes; leave that alone.)
- **Truncating bigint division.** `9n / 2n` is `4n` in JS; after narrowing it is `4`. The
  value is unchanged, the `typeof` is not — cover it, since `/` is the one arithmetic
  operator whose bigint arm is not the same function as its number arm.
- **`mixedBigIntArithmetic`'s `catch` arms** return `null` (division by zero, RangeError);
  narrowing must sit on the success paths only and must not swallow those.
- **Aggregate retraction.** `addWithPromotion` is used by merge/negate for materialized-view
  maintenance as well as by the SUM step. A sum that promotes to `bigint` and then retracts
  back into the safe range must narrow, or a maintained view's stored partial and a direct
  evaluation of the same query disagree on representation. Test a promote-then-retract fold.
- **`min`/`max` over a mixed column.** These return one of the input values unchanged; they
  neither promote nor narrow, and must keep doing so.
- **Memory vs store parity.** `@quereus/store`'s `serializeRow` round-trips a `bigint`
  faithfully through a `$bigint` marker, so a canonical value written to a store table
  comes back canonical. Assert the same representation from both backends — this is one of
  the few things worth running `yarn test:store` for.
- **`ANY` columns are in scope for R1, out of scope for R2.** An `ANY` column may hold a
  boolean, a blob, a string and an integer in the same column; only the last is constrained,
  and only by R1.
- **The change log's numeric distinction is deliberate.** `util/key-tuple-codec.ts` and
  `runtime/delta-executor.ts`'s `tupleKey` key `5` and `5n` separately **on purpose** and
  must stay that way. Do not "fix" them to unify numerics — R1 is what makes the split safe.
  Update the codec's NOTE to cite R1 instead of the current "not reachable today" wording.
- **`.sqllogic` cannot test this.** `normalizeBigInts` in `test/logic.spec.ts` converts an
  actual `bigint` to a `number` before the assertion (see
  `backlog/debt-sqllogic-bigint-assertions-lossy`), so a `.sqllogic` expectation can
  distinguish neither the values nor the representations. **Representation assertions go in
  `.spec.ts` files** against `db.eval` / `iterateRows`, using `typeof`.

## Key tests

- Unit table over `INTEGER_TYPE.parse` / `NUMERIC_TYPE.parse`: each of `5`, `5n`, `1e20`,
  `9007199254740991`/`n`, `9007199254740992`/`n`, `'9007199254740993'`, `-0`, `1.9`,
  `Infinity`, `NaN` → expected value **and** expected `typeof`.
- `insert into t(v integer) values (1e20); select v` → exact `100000000000000000000n`
  (the `bug-integer-column-rejects-large-real` repro, as a spec assertion).
- Round-trip representation: bind `5n` → stored → `select` returns `typeof 'number'`.
- Arithmetic: `select 9007199254740993 - 3` → `9007199254740990`, `typeof 'number'`;
  `select 9007199254740993 + 1` → `9007199254740994n`, `typeof 'bigint'`.
- `sum()` promote-then-retract lands back as a `number`.
- A **fast-check property** in `test/property.spec.ts` (fast-check is already imported
  there): for arbitrary integers spanning the boundary, `insert` → `select` → the returned
  value satisfies R1 and equals the input numerically. This is the general test that keeps
  the class closed — write it before the point fixes if you like TDD.

## TODO

- Add `util/numeric-canonical.ts` (or fold into an existing numeric util if one fits):
  `canonicalizeInteger(v: number | bigint): number | bigint` (widen a finite whole number
  past the safe boundary, narrow an in-range bigint) and `isCanonicalNumeric(v: SqlValue):
  boolean` for the follow-on checker. Document R1/R2 on the module.
- Apply in `INTEGER_TYPE.parse` (number and bigint arms) and `NUMERIC_TYPE.parse` (bigint
  arm; the number arm keeps accepting non-integers unchanged).
- Narrow bigint results in `mixedBigIntArithmetic`, the `unary.ts` bigint arms, and
  `addWithPromotion` / the SUM step.
- Canonicalize bound parameter values at the three `boundArgs` write sites in
  `core/statement.ts`.
- Verify literals need no change; add the test that pins the lexer boundary.
- Update the `util/key-tuple-codec.ts` NOTE to cite R1.
- Write the *Physical representation* subsection in `docs/types.md`, including the
  BOOLEAN decision, the "these `typeof` branches are not debt" statement, and the API
  surface change. Update the INTEGER / NUMERIC bullets to reference it.
- Tests above; delete `tickets/backlog/bug-integer-column-rejects-large-real.md` once its
  repro is covered.
- `yarn build && yarn test && yarn lint`; run `yarn test:store` for the backend-parity
  assertion.
