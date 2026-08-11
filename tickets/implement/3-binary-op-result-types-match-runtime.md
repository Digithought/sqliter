---
description: The engine mislabels the result type of several two-operand expressions — comparisons written with a double equals sign, "like", and "xor" are reported as whatever their left-hand side was instead of true/false, and arithmetic mixing text with a number is reported as text even though it produces a number.
prereq:
files:
  - packages/quereus/src/planner/nodes/scalar.ts   # BinaryOpNode.generateType — the operator switch that is missing cases
  - packages/quereus/src/runtime/emit/binary.ts    # buildBinaryOpSpec — the complete, case-normalized dispatch to mirror
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts  # precedent for "no principled common type ⇒ ANY"
  - packages/quereus/test/logic/03-expressions.sqllogic
  - packages/quereus/test/logic/10-distinct_datatypes.sqllogic
  - packages/quereus/test/logic/14-utilities.sqllogic
  - docs/types.md
difficulty: medium
repro: verified
---

# Problem

`BinaryOpNode.generateType` decides the announced result type of every binary expression with
a `switch` on `this.expression.operator`. Two defects, both at that one switch.

## Missing operators fall through to the left operand's type

The switch lists `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN`, `AND`, `OR`, `IS`, `IS NOT` as
boolean-producing, and `+ - * / %` and `||` for the rest. Anything else takes the initial
`logicalType = leftType.logicalType` and is announced as its left operand's type.

The runtime emitter (`buildBinaryOpSpec` in `runtime/emit/binary.ts`) has the complete list —
and, unlike `generateType`, it uppercases the operator first, so it matches keywords
case-insensitively. Everything in the emitter's dispatch that the planner's switch misses is
announced wrong. Verified:

| expression | announced | actually produces |
|---|---|---|
| `select 'a' == 'a'` | TEXT | boolean `true` |
| `select 1 xor 0` | REAL | boolean `true` |
| `select 'ab' like 'a%'` | TEXT | boolean `true` |
| `select 'a' <> 'b'` | BOOLEAN | boolean — correct |
| `select 3 between 1 and 5` | BOOLEAN | boolean — correct |

(`<>` and `between` are fine because the parser normalizes / desugars them before the planner
sees them; `==` and the keyword operators are not.)

## Arithmetic over non-numeric operands is announced as the left operand's type

For `+ - * / %`, when the temporal operation table has no case and the two operands are not
both numeric, `generateType` falls back to `logicalType = leftType.logicalType`. That is
simply not what the runtime does: `buildCoercingArithmeticRun` sniffs for a temporal shape,
then coerces both sides to numbers. Verified:

| expression | announced | actually produces |
|---|---|---|
| `select '123' + 0` | TEXT | number `123` |
| `select 'abc' + 0` | TEXT | number `0` |

There is no single right concrete answer here: a TEXT operand may hold a duration string, in
which case the runtime returns a TIMESPAN string, or an ordinary string, in which case it
returns a number. The honest announcement is `ANY` — the same conclusion
`mergeSetOpAdvertisedType` reaches for an irreconcilable operand pair, and for the same
reason. `ANY` imposes no R2 constraint, its `parse` is pass-through, and it is never identical
to a declared column type, so every downstream consumer converts rather than trusting it.

# Fix

Make the announcement and the evaluation read from **one** operator classification, so they
cannot drift again. The emitter's `switch` in `buildBinaryOpSpec` is already the complete and
correct one; extract the classification (comparison / logical / concat / like / arithmetic)
into a shared helper — with the uppercase normalization — and have both `generateType` and
`buildBinaryOpSpec` dispatch on it. Adding the missing cases to `generateType` by hand would
fix today's list and leave the next added operator to be forgotten again.

Then:

- Every comparison, logical and pattern-matching operator announces BOOLEAN.
- Arithmetic keeps its existing two precise arms — the temporal operation table's result
  type, and numeric promotion when both operands are numeric — and announces `ANY` for the
  remaining fallback instead of the left operand's type.

Note `generateType` also has a `isComparisonOperator(...)` collation-resolution block below
the switch. Check whether that predicate has the same gaps (a `LIKE` or `==` whose collation
conflict currently goes unreported would be a second, quieter instance of the same drift) and
fold it into the shared classification if so.

# Risk to check

Announcing `ANY` where TEXT was announced changes downstream behavior wherever the type is
read:

- **Ordering.** `order by ('123' + 0)` previously sorted under TEXT's comparator; `ANY`'s is
  storage-class-then-BINARY. For a column that actually yields numbers this is a
  *correction*, but it is a visible behavior change — check the ordering tests and state the
  new behavior rather than re-baselining silently.
- **DML writes.** `ANY` never identity-matches a declared column type, so a cell sourced from
  such an expression now always converts on the write path. That is the safe direction.
- **Nested arithmetic.** `('123' + 0) + 1` now sees an `ANY` left operand instead of TEXT, so
  it takes the generic coercing path rather than the temporal-fallback path. Confirm the
  result is unchanged.

Announcing BOOLEAN where the left operand's type was announced is the safer of the two: a
boolean is what the expression already returns.

# Acceptance

- The five expressions in the first table and the two in the second announce a type their
  values inhabit.
- The following currently-failing-under-measurement cases stop reporting a representation
  mismatch when the statement-egress check is widened (see
  `remaining-scalar-result-types-and-repr-net`, which owns that widening):
  `test/logic/03-expressions.sqllogic` (`t == 'world'`),
  `test/logic/07.7-and-or-short-circuit.sqllogic` and `test/and-or-short-circuit.spec.ts`
  (XOR), `test/runtime/scalar-fusion.spec.ts` "operator sweep: cast, collate, between, like,
  concat, xor, unary", `test/logic/06.5.3-undeclared-return-type-comparison.sqllogic`,
  `test/logic/44.1-nondeterministic-schema.sqllogic`,
  `test/logic/10-distinct_datatypes.sqllogic` (`'123' + 0`),
  `test/logic/14-utilities.sqllogic` (`'abc' + 0`).
- `yarn test`, `yarn test:store`, `yarn lint`, `yarn typecheck` pass.

# TODO

- [ ] Extract the binary-operator classification out of `buildBinaryOpSpec` into a shared
      helper (uppercase-normalized) and dispatch both it and `BinaryOpNode.generateType` from
      it.
- [ ] Announce BOOLEAN for every comparison / logical / `LIKE` operator.
- [ ] Announce `ANY` for the arithmetic fallback (neither a temporal case nor two numeric
      operands); leave the temporal-table and numeric-promotion arms alone.
- [ ] Check `isComparisonOperator` for the same gaps; unify or document why not.
- [ ] Add planner-level assertions on the announced type for each row of both tables above
      (`test/function-return-type.spec.ts` and `test/cast-static-type.spec.ts` are the
      nearest existing homes for this shape of test).
- [ ] Re-run the ordering / plan-shape suites and account for any diff explicitly.
- [ ] Update `docs/types.md` where it describes binary-operator result types.
- [ ] Run `yarn test`, `yarn test:store`, `yarn lint`, `yarn typecheck`.
