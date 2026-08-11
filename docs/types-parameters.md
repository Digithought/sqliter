# Parameter Types

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

How a statement's parameters get their types — inferred from the values passed to `prepare()`
or declared explicitly — and what is checked when those parameters are bound on each
execution. Types are established at prepare time and validated on every execution, which buys
type safety without giving up a user-friendly API for JavaScript developers. A satellite of
[Quereus Type System](types.md).

## Two Ways to Specify Parameter Types

Quereus offers two approaches for specifying parameter types:

1. **Type Inference from Values** - Pass initial parameter values to `prepare()` and types are inferred
2. **Explicit Type Hints** - Pass a Map of explicit type hints to `prepare()`

## Type Inference Rules

When you pass parameter values, Quereus automatically infers the logical type based on the JavaScript type:

| JavaScript Type | Logical Type | Example |
|----------------|--------------|---------|
| `null` | NULL | `null` |
| `number` (integer) | INTEGER | `42`, `0`, `-100` |
| `number` (float) | REAL | `3.14`, `2.5`, `-0.5` |
| `bigint` | INTEGER | `9007199254740991n` |
| `boolean` | BOOLEAN | `true`, `false` |
| `string` | TEXT | `'hello'`, `''` |
| `Uint8Array` | BLOB | `new Uint8Array([1, 2, 3])` |
| `object` (plain) | JSON | `{ x: 1 }`, `[1, 2, 3]` |

**Note**: Strings are always inferred as TEXT type. Plain objects and arrays are inferred as JSON type. To use date/time types, either:
- Use conversion functions in your query: `date(:param)`, `time(:param)`, `datetime(:param)`
- Or pass the value through a conversion function before binding

## Type Resolution and Validation

Parameter types are established during the **planning phase** and validated on each execution:

1. **At prepare time**: Types are inferred from initial values or set via explicit parameter types
2. **At execution time**: Parameter values are validated against the established types
3. **No recompilation**: Prepared statements are NOT recompiled when parameter values change (only when types would change)
4. **Type safety**: Attempting to execute with incompatible types throws an error

## Examples

**Option 1: Type inference from initial values**

```javascript
// Prepare with initial INTEGER parameters
const stmt = db.prepare('INSERT INTO users (id, age) VALUES (?, ?)', [1, 30]);

// Execute with the initial values
await stmt.run();

// Execute with different INTEGER values (no recompilation)
await stmt.run([2, 25]);
await stmt.run([3, 40]);

// This would throw an error - type mismatch (REAL vs INTEGER)
// await stmt.run([4, 25.5]); // Error: Parameter type mismatch

await stmt.finalize();
```

**Option 2: Explicit parameter types**

```javascript
import { INTEGER_TYPE, TEXT_TYPE } from '@quereus/quereus';

// Create explicit parameter types
const parameterTypes = new Map();
parameterTypes.set(1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false });
parameterTypes.set(2, { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false });

// Prepare with explicit parameter types
const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', parameterTypes);

// Execute with matching types
await stmt.run([1, 'Alice']);
await stmt.run([2, 'Bob']);

await stmt.finalize();
```

**Named parameters:**

```javascript
// Prepare with named parameters
const stmt = db.prepare(
  'INSERT INTO users (id, name, age) VALUES (:id, :name, :age)',
  { id: 1, name: 'Alice', age: 30 }
);

await stmt.run(); // Uses initial values
await stmt.run({ id: 2, name: 'Bob', age: 25 }); // Different values, same types

await stmt.finalize();
```

**Date/time conversion:**

```javascript
// String parameter converted to DATE in the query
await db.exec(
  'INSERT INTO events (id, event_date) VALUES (?, date(?))',
  [1, '2024-01-15']
);

// Or use conversion functions in WHERE clauses
const rows = [];
for await (const row of db.eval(
  'SELECT * FROM events WHERE event_date = date(?)',
  ['2024-01-15']
)) {
  rows.push(row);
}
```

## Type Checking and Validation

Parameter type validation ensures type safety across executions:

- **Physical type validation**: Validates that JavaScript values are compatible with the **physical type** of the declared logical type
- **Type preservation**: Once established, parameter types are preserved across all executions of a prepared statement
- **Validation on execution**: Each execution validates that parameter values match the established physical types
- **NULL compatibility**: NULL values are compatible with any nullable parameter type
- **Flexible logical types**: Different logical types with the same physical type are compatible (e.g., `number` and `bigint` both work for INTEGER physical type)
- **Canonical form at bind**: A bound value is canonicalized as it is stored (see [Physical representation](types.md#physical-representation)) — a `bigint` inside the safe-integer range narrows to `number`, so `stmt.bind(1, 5n)` is used, stored, and returned as `5`
- **No implicit conversion**: Physical type mismatches are rejected with clear error messages
- **Explicit conversion**: Use conversion functions like `integer()`, `real()`, `text()`, `date()`, etc. in your SQL to convert between types
- **Array/object scalar guard**: A parameter used directly (through `CAST`s) as a comparand in a scalar comparison (`= <> < <= > >=`, `IN`, `BETWEEN`) against a non-object scalar operand may not be bound to a JS array or plain object. The OBJECT storage class sorts above every scalar, so such a binding could never match — instead of silently returning no rows it throws `StatusCode.MISMATCH` at bind time (e.g. `where id = ?` with `[[1, 2]]`). JSON-vs-JSON comparisons (`jsoncol = :p`), function arguments (`json_array_length(?)`), projections (`select ? as v`), and storing into a JSON column are never flagged. Collected by `src/planner/analysis/scalar-param-usage.ts` from the logical plan.

**Examples of physical type compatibility:**
- INTEGER physical type accepts: `number` (integer), `bigint`
- REAL physical type accepts: `number` (any)
- TEXT physical type accepts: `string` (any string, including date-like strings)
- BOOLEAN physical type accepts: `boolean`
- BLOB physical type accepts: `Uint8Array`
- OBJECT physical type accepts: plain objects, arrays (for JSON)

## Performance Benefits

The parameter type system provides significant performance benefits:

1. **No recompilation**: Prepared statements are compiled once and reused, avoiding expensive recompilation
2. **Early validation**: Type errors are caught before execution begins
3. **Optimized plans**: The query planner can optimize based on known parameter types
4. **Future optimizations**: The system is designed to support automatic recompilation for significant optimizations (e.g., when NULL constants enable better plans)

## Implementation Details

**Key files:**
- `src/core/database.ts` - `prepare()` accepts parameter values or explicit types; `_buildPlan()` passes parameter types to planning
- `src/core/statement.ts` - Statement class manages parameter types and validation
- `src/core/param.ts` - `getParameterTypes()` infers types from parameter values
- `src/types/logical-type.ts` - `getPhysicalType()` determines physical type from JavaScript values; `physicalTypeName()` provides human-readable names
- `src/planner/scopes/param.ts` - `ParameterScope` receives parameter types directly and uses them during planning

**Design:**
- Parameter types (not dummy values) are passed directly to the planner
- The planner works with precise logical types from the start
- No intermediate conversion to/from dummy parameter values
- Clean separation between type inference (from JS values) and type usage (in planning)
- Validation checks physical type compatibility, not exact logical type matching

