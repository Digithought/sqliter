# Function and Operator Result Types

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

How the planner decides the type of a value it has not seen: a polymorphic function's return
type, and a binary operator's result type. Both answers are announced at plan time and must
match what the evaluator actually produces. A satellite of [Quereus Type System](types.md).

## Polymorphic Function Type Inference

Quereus supports polymorphic functions that work over multiple type signatures without duplicating implementations.

### Type Inference API

Functions can define type inference logic at planning time:

```typescript
export interface ScalarFunctionSchema {
  name: string;
  numArgs: number;

  // Option A: Fixed return type
  returnType?: ScalarType;

  // Option B: Type inference function (for polymorphic functions)
  inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;

  // Optional: Validate argument types at planning time
  validateArgTypes?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => boolean;

  implementation: ScalarFunc;
}
```

### Examples

**Simple case: Fixed types**
```typescript
export const sqrtFunc = createScalarFunction({
  name: 'sqrt',
  numArgs: 1,
  returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false }
}, sqrtImpl);
```

**Polymorphic case: Type inference**
```typescript
export const absFunc = createScalarFunction({
  name: 'abs',
  numArgs: 1,
  inferReturnType: (argTypes) => ({
    typeClass: 'scalar',
    logicalType: argTypes[0], // Return same type as input
    nullable: false
  }),
  validateArgTypes: (argTypes) => isNumericOrUnknownType(argTypes[0])
}, absImpl);
```

### Omitting the return type

Declaring neither `returnType` nor `inferReturnType` yields `ANY_TYPE` — the engine's
"unknown scalar type". This is safe but not free:

- `ANY_TYPE` sets neither `isNumeric` nor `isTextual`, so `insertCrossTypeCoercion`
  (`planner/building/coercion.ts`) leaves both operands of a comparison alone and the
  generic runtime comparison decides. That is the correct answer for an unknown type, but
  it forfeits plan-time typing and comparison specialization (the `compare-fast` path in
  `runtime/emit/binary.ts`).
- So **declare the real type whenever you know it**. A wrong declared type is worse than
  none: while the default was `REAL_TYPE`, the planner believed every undeclared function
  returned a number and cast the *other* side of a comparison to REAL, so
  `my_text_func(x) = 'abc'` silently became `… = 0` and was always false.
- `Database.createScalarFunction` / `createAggregateFunction` never pass a `returnType`, so
  every function registered through *those* two lands on this default. A plugin that builds
  its own schema and registers it through `Database.registerFunction` declares its own.
- Omitting the return type is the only accepted way to say "unknown". A `returnType` that is
  *present but malformed* is rejected at registration with a `MisuseError` naming the
  function and the offending field — it is never quietly downgraded to `ANY_TYPE`. The one
  contract, shared by `Database.registerFunction` and all the `create*` helpers, lives in
  `normalizeFunctionSchema` (`func/registration.ts`); `docs/plugins.md`
  § Declaring return types states it for plugin authors.
- Every **built-in** scalar function now declares a `returnType` or an `inferReturnType`,
  with one deliberate exception: `json_extract`, whose result shape depends on the data
  rather than on the argument types, declares `ANY_TYPE` explicitly. The shared shape
  constants live in `func/builtins/return-types.ts` (`TEXT_RETURN`, `INTEGER_RETURN`,
  `REAL_RETURN`, `NUMERIC_RETURN`, `BOOLEAN_RETURN`, `BLOB_RETURN`, `JSON_RETURN`,
  `ANY_RETURN`, plus `_NOT_NULL` variants and the `scalarReturn(type, nullable)` builder
  for the types with no constant). Every built-in scalar, aggregate and window function declares through
  them — use them rather than re-spelling the four-field literal. They are re-exported from
  the package index, so plugins outside this repo can use them too.
- A function whose result is not closed over its argument's type must declare the wider
  type rather than infer the argument's. `sqrt`, `pow` and `power` all declare REAL for
  this reason: `sqrt(int_col)` claiming INTEGER would make the write path skip conversion
  and store `1.4142135623730951` in an INTEGER column. `sum()` declares `NUMERIC` for the
  same reason, and deliberately does *not* narrow to its argument's type: its exact/approx
  accumulator split routes per **value**, so even a REAL-typed column whose rows happen to
  hold safe integers can finalize a `bigint` past 2^53.

Because of that default, **`validateArgTypes` must let an argument through whose type the
planner cannot classify** — rejecting `ANY` at plan time makes the function unusable over
any user-defined function's result. Use the shared
`isNumericOrUnknownType` predicate (`types/builtin-types.ts`) rather than a bare
`isNumeric` check: it accepts a numeric type, `ANY`, or `NULL`, and defers the decision to
the implementation, which returns null for input it cannot use. (Accepting `NULL` is also
what makes `abs(null)` return null instead of raising `Invalid argument types`.)

### Built-in Polymorphic Functions

The following built-in functions use type inference:

- **Numeric functions**: `abs()`, `round()`, `nullif()`, `sqrt()`, `floor()`, `ceil()`, `ceiling()`, `clamp()`
- **Common type resolution**: `coalesce()`, `iif()`, `greatest()`, `least()`, `choose()` — all five return one of their arguments *verbatim*, so their declared type must cover every argument they could pick. That is exactly a set operation's output column, so the fold is `mergeSetOpAdvertisedType` (`findCommonType` in `func/builtins/scalar.ts`): identical types keep theirs, a NULL argument yields to the other side (`greatest(int_col, null)` stays INTEGER), differing builtin numerics merge to `NUMERIC`, and an irreconcilable pair is `ANY` (`coalesce(int_col, text_col)`). See "Semantic ordering".
- **String functions**: `length()`, `upper()`, `lower()`, `trim()`, `ltrim()`, `rtrim()`, `substr()`, `substring()`, `replace()`, `reverse()`, `lpad()`, `rpad()`, `instr()`
- **Aggregate functions**: `MIN()`, `MAX()`
- **Window navigation**: `LAG()`, `LEAD()` — arg[0] passed through, folded with the optional default arg[2] through the same merge, since the default is emitted verbatim when the offset runs off the partition. arg[1] (the offset) never surfaces in the result.
- **Arithmetic operators**: `+`, `-`, `*`, `/`, `%` — see the promotion table below

---

## Binary operator result types

**One classification, read by the planner and the evaluator.** Which operator spellings
behave which way lives in a single table, `classifyBinaryOperator` in
`src/planner/analysis/binary-operator-class.ts`. Every consumer dispatches on it — the
announced result type (`BinaryOpNode.generateType`), the per-row body (`buildBinaryOpSpec`,
`runtime/emit/binary.ts`), collation-lattice validation (`isComparisonOperator`),
cross-type coercion insertion (`building/expression.ts`) and the object-valued parameter
guard (`analysis/scalar-param-usage.ts`) — so an operator cannot be *evaluated* as one thing
and *announced* as another, nor be recognized by one analysis and missed by the next.
Matching is case-insensitive — internally synthesized ASTs do not always uppercase keyword
operators (`util/mutation-statement.ts` builds `operator: 'and'`).

| Class | Operators | Announced result type |
|---|---|---|
| comparison | `=` `==` `!=` `<>` `<` `<=` `>` `>=` | `BOOLEAN` |
| is | `IS` `IS NOT` | `BOOLEAN`, never NULL |
| in | `IN` | `BOOLEAN` |
| logical | `AND` `OR` `XOR` | `BOOLEAN` |
| like | `LIKE` | `BOOLEAN` |
| concat | `\|\|` | `TEXT` |
| arithmetic | `+` `-` `*` `/` `%` | see below |
| *(unclassified)* | anything else | `ANY` — `buildBinaryOpSpec` raises `UNSUPPORTED`, so no value exists to describe |

Only the comparison and `IS` classes resolve a collation across their operands
(`isComparisonOperator`, [Comparison collation resolution](types.md#comparison-collation-resolution)).
`LIKE` is deliberately excluded: `buildLikeOpSpec` ignores collation entirely, so a conflict
raised there would be about a collation the operator never applies.

Arithmetic takes the first of three arms:

1. **A temporal operation table case** — `date - date` → `TIMESPAN`, `timespan / timespan`
   → `REAL`. See [Temporal arithmetic](types.md#temporal-types) for the table.
2. **Both operands numeric** — promotion, first match wins:

   | Operand pair | Operator | Result | Why |
   |---|---|---|---|
   | either side `NUMERIC` | any | `NUMERIC` | a `NUMERIC` operand is already `number \| bigint`; nothing narrower can be promised |
   | `REAL` + `REAL` | any | `REAL` | both value spaces are `number` only, and the number path yields a `number` or null |
   | `INTEGER` + `REAL` (mixed) | any | `NUMERIC` | `mixedBigIntArithmetic` keeps a `bigint` INTEGER operand in the bigint domain when the REAL side holds an integral value, so `int_col + real_col` over `(9007199254740993, 2.0)` returns a `bigint` — outside what `REAL` claims |
   | `INTEGER` + `INTEGER` | `/` | `NUMERIC` | real division on the number path (`1/2` → `0.5`), truncating on the bigint path |
   | `INTEGER` + `INTEGER` | `+ - * %` | `INTEGER` | |
3. **Otherwise** → `ANY`. The declared types settle nothing, so
   `buildCoercingArithmeticRun` decides per row: a TEXT operand holding a duration string
   yields a TIMESPAN string, an ordinary string coerces to a number (`'123' + 0` → `123`,
   `'abc' + 0` → `0`). No concrete type describes both. `ANY` is the same answer
   `mergeSetOpAdvertisedType` gives an irreconcilable operand pair, for the same reason: it
   imposes no R2 constraint, its `parse` is pass-through, and it is never identical to a
   declared column type, so every consumer converts rather than trusting it. Ordering is
   unaffected: neither `ANY` nor the concrete types this arm could otherwise name carries
   [semantic ordering](types-ordering.md#semantic-ordering), so `order by ('123' + 0)` ranks by storage
   class and collation either way.

**Arithmetic nullability.** Arithmetic announces `nullable` even over two non-nullable
operands, because it can *produce* NULL from non-null input: `buildNumericOpSpec` nulls a
non-finite result (`1/0`, `%` by zero, REAL overflow to `Infinity`) and `runTemporalCase`
nulls a value its declared kind cannot parse. The one exception is `+ - *` over two
`INTEGER`s — the only shape with no non-finite path — where the operands' own nullability
stands. That exception is load-bearing: the lens prover uses expression nullability to
prove a computed `v + 1` column NOT NULL. The announced `nullable` flag is *not* yet
consistent engine-wide; the remaining classes are tracked in
`backlog/debt-announced-nullability-disagrees-with-produced-nulls`.

## Unary operator result types

| Operator | Operand | Announced result type |
|---|---|---|
| `NOT` | any | `BOOLEAN`, nullability preserved |
| `IS [NOT] NULL/TRUE/FALSE` | any | `BOOLEAN`, never NULL |
| `~` | any | `INTEGER` |
| `- +` | numeric or `TIMESPAN` | the operand's own type (negation/pass-through stays in it) |
| `- +` | anything else | `ANY`, nullable |

The last row matters: `runtime/emit/unary.ts` value-sniffs a non-numeric operand per row —
a duration string yields a TIMESPAN string, numeric text yields its number, anything else
yields null — so the operand's type is not one of the answers. `select -'42'` used to
announce `TEXT` while producing the number `-42`.
