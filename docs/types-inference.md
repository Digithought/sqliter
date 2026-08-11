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
  `REAL_RETURN`, `BOOLEAN_RETURN`, `BLOB_RETURN`, `JSON_RETURN`, `ANY_RETURN`, plus
  `_NOT_NULL` variants and the `scalarReturn(type, nullable)` builder for the types with
  no constant). Every built-in scalar, aggregate and window function declares through
  them — use them rather than re-spelling the four-field literal. They are re-exported from
  the package index, so plugins outside this repo can use them too.
- A function whose result is not closed over its argument's type must declare the wider
  type rather than infer the argument's. `sqrt`, `pow` and `power` all declare REAL for
  this reason: `sqrt(int_col)` claiming INTEGER would make the write path skip conversion
  and store `1.4142135623730951` in an INTEGER column.

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
- **Common type resolution**: `coalesce()`, `iif()`, `greatest()`, `least()`, `choose()` — `greatest()`/`least()` fall back to `ANY` for a group that is neither all-one-type nor all-numeric, since they return one of their arguments (see "Semantic ordering")
- **String functions**: `length()`, `upper()`, `lower()`, `trim()`, `ltrim()`, `rtrim()`, `substr()`, `substring()`, `replace()`, `reverse()`, `lpad()`, `rpad()`, `instr()`
- **Aggregate functions**: `MIN()`, `MAX()`
- **Arithmetic operators**: `+`, `-`, `*`, `/`, `%` with numeric type promotion (INTEGER + INTEGER → INTEGER, INTEGER + REAL → REAL, etc.)

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
2. **Both operands numeric** — promotion: `INTEGER op INTEGER` → `INTEGER`, any `REAL`
   operand → `REAL`.
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
