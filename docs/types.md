# Quereus Type System

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

This document is the **overview**: the logical/physical split, the built-in types, validation
and coercion, comparisons and collations, and the plugin surface. The subsystems
large enough to read on their own live in the topic documents below.

## Topic documents

<!-- NOTE: a section that moved into a satellite left a one-line stub behind under its original
     heading, so its old anchor still resolves here. When linking real content that lives in a
     satellite, link the satellite — not the stub. -->

| Document | Covers | Written for |
| --- | --- | --- |
| [Semantic Ordering and Comparison Identity](types-ordering.md) | Types whose declared order differs from their storage order: the `semanticOrdering` / `collationAware` flags, and every surface that routes through `compare` or through `groupKey` identity. | An engine developer touching comparison, key, or identity code. |
| [Function and Operator Result Types](types-inference.md) | How a result type is announced before the value exists: `inferReturnType` / `validateArgTypes`, what an omitted return type costs, and the one binary-operator classification the planner and the evaluator both read. | A function or plugin author, and anyone touching `BinaryOpNode.generateType`. |
| [Parameter Types](types-parameters.md) | Parameter typing end to end: inference from bound values, explicit type hints, and what is validated on every execution of a prepared statement. | An application developer binding parameters, and anyone touching `prepare()` or `ParameterScope`. |

## Overview

Quereus implements a **logical type system** that separates type semantics from physical storage representation. This design provides strict type safety and extensibility while maintaining runtime performance.

### Core Principles

1. **Logical vs Physical Separation**: Types define validation and comparison semantics (logical) while values are stored using a small set of physical representations
2. **Strict Typing**: All type checking is strict - no implicit coercion between incompatible types
3. **Type-Specific Collations**: Collations are associated with specific types (primarily TEXT-based types)
4. **Plugin Extensibility**: Custom types can be registered via plugins
5. **Performance First**: Type information enables optimized comparisons without runtime type detection

### Design Decisions

- **Collations**: Type-specific. TEXT types support BINARY/NOCASE/RTRIM; numeric and temporal types have natural ordering
- **Type Enforcement**: Always strict - values must match declared types or be explicitly converted via conversion functions
- **Type Conversion**: Use functions like `integer()`, `text()`, `date()` instead of CAST syntax (though CAST is supported for compatibility)
- **Date/Time**: Native DATE, TIME, DATETIME types using Temporal API internally, stored as ISO 8601 strings
- **JSON**: Native JSON type with `PhysicalType.OBJECT` — values stored as JS objects in memory, serialized to JSON strings on disk
- **Constraints**: Length, precision, and other restrictions handled via CHECK constraints, not type definitions

---

## Type System Architecture

### Physical Types

Physical types represent how values are stored in memory and on disk:

```typescript
export enum PhysicalType {
  NULL = 0,
  INTEGER = 1,    // number | bigint
  REAL = 2,       // number (floating point)
  TEXT = 3,       // string
  BLOB = 4,       // Uint8Array
  BOOLEAN = 5,    // boolean
  OBJECT = 6,     // object (for JSON, custom types)
}

export type SqlValue = string | number | bigint | boolean | Uint8Array | JsonSqlValue | null;
// JsonSqlValue = { [key: string]: JSONValue } | JSONValue[]
```

#### Physical representation

A whole number could be held by either of two JavaScript forms — the `number` `5` or the
`bigint` `5n`. The engine pins one form per value (`util/numeric-canonical.ts`):

**R1 — canonical numeric form.** Holds for every `SqlValue` anywhere in the engine,
whatever its declared type, including `ANY` columns:

> A `SqlValue` is a JS `bigint` only when its magnitude is outside the safe-integer range
> (|v| > 2^53 − 1 = 9007199254740991). Every integer value inside that range is a JS
> `number`.

R1 constrains which values may be `bigint`; it does not constrain which `number`s may be
whole. A whole-valued `number` outside the safe range (e.g. `1e20` in a REAL position) is
not a violation, and `-0` is a safe integer that stays the `number` `-0` — it is neither
normalized to `0` nor widened.

**R2 — per-declared-type value space.** Holds for a value in a position of that declared
type; `null` is always admissible and nullability is a separate contract:

| declared type | admissible JS forms |
|---|---|
| INTEGER | `number` that is a safe integer, or `bigint` (necessarily outside the safe range, by R1) |
| REAL | `number` |
| NUMERIC | `number`, or `bigint` under R1 |
| BOOLEAN | `boolean` |
| TIMESTAMP | same as INTEGER — it is an integer instant, not a string temporal |
| TEXT and the string temporals (DATE/TIME/DATETIME/TIMESPAN) | `string` |
| BLOB | `Uint8Array` |
| JSON | native JS object/array, or a JSON scalar (`string`/`number`/`boolean`) |
| ANY | any of the above, each obeying R1 |

R2 does **not** constrain a *probe* value handed to a comparator: `REAL_TYPE.compare`
tolerating a `bigint` operand (an integer literal past 2^53 compared against a `real`
column) is comparator robustness against a value that is not a REAL, and stays.

**Why the safe-integer boundary and not "exactly representable as a double".** 2^53
itself (9007199254740992) is exactly representable but is not a *safe* integer —
2^53 + 1 is not representable, so arithmetic around the boundary stops round-tripping.
Under R1, 9007199254740992 is a `bigint`.

**Where canonicalization happens.** At the points where a value is *born* — never per-row
on read paths:

- **Literals**: the lexer emits `number` below the safe boundary, `bigint` above it.
- **Conversion**: `INTEGER_TYPE.parse`, `NUMERIC_TYPE.parse` and `TIMESTAMP_TYPE.parse` —
  the three integer-domain conversions — covering `cast(…)`, the conversion builtins, DML
  coercion of a differently-typed cell, and ALTER backfill.
- **Bound parameters**: canonicalized as they are stored into the statement's bound-args
  map (per-bind, not per-row).
- **Arithmetic and aggregation results**: the bigint arms of binary/unary arithmetic and
  `sum()` narrow a result that lands back inside the safe range.

  `sum()` additionally **splits the two number domains** rather than deciding per
  addition which one the running total is in. A contribution joins the *exact* part iff
  it is a `bigint` or satisfies `Number.isSafeInteger`; every other numeric contribution
  — fractions, whole `number`s outside the safe range (`1e308`), `±Infinity`, `NaN` —
  joins a separate floating-point part. The two combine only at finalize, so a fold that
  saw any non-exact contribution finalizes to a `number` and a fold that saw none
  finalizes to the exact (R1-canonical) integer. The split is what makes the answer
  independent of the order rows were scanned in, which `merge`-associativity — and
  therefore materialized-view maintenance — depends on. The predicate is
  `Number.isSafeInteger` and not `Number.isInteger` precisely because a whole `number`
  past the safe boundary is not exact in the integer sense; treating it as exact would
  put a `bigint` in a REAL-typed result, violating R2.

  `sum()`'s `algebra.decode` is therefore observational only over the exact-integer part:
  one stored value per group cannot carry the split apart. The write side already gates on
  this — the delta-aggregate arm delta-maintains `sum` only over an INTEGER-physical
  argument column, where the floating-point part is always empty.

Rows returned from a virtual-table `query()` and values returned from user-defined
functions are held to R1 by contract rather than by per-row coercion — every consumer
already tolerates both forms, so coercing there would cost where there is nothing to win.
Built-in functions are on the same footing and must simply return the canonical form:
`random()` draws a safe integer, so it returns a `number`; `abs()` preserves magnitude, so
canonical input gives canonical output.

**Downstream operators must be exact over the whole integer domain.** Because arithmetic
narrows, an operator can now receive as a `number` a value that previously reached it as a
`bigint` — so a fixed-width implementation is a wrong answer, not merely a representation
wart. Bitwise NOT is the live example: JS `~` coerces through ToInt32, so `~x` is computed
as `-x - 1` arithmetically instead (`runtime/emit/unary.ts`).

**BOOLEAN stays a first-class runtime value.** The alternative — canonicalize booleans to
0/1 at ingress and make BOOLEAN purely logical — was considered and rejected: `boolean`
is a user-visible result value with its own `PhysicalType`, its own `compare` and its own
JSON round-trip, and the only thing the change would buy is deleting the boolean arms of
the storage-class dispatch helpers, which measurement (see the accepted-tradeoff `NOTE:`
on `compareSqlValuesFast` in `util/comparison.ts`) says are worth nothing. Those arms are
also not removable on other grounds: an `ANY` column may legitimately hold a boolean, so
a numeric comparison can meet one regardless of what R2 says about declared BOOLEAN
positions.

**These `typeof` branches are not debt.** R1/R2 are correctness rules, not a license to
delete runtime storage-class dispatch: the per-row `typeof` branches measure at 0–2 ns
against a ~143 ns/instruction dispatch floor (accepted-tradeoff `NOTE:`s on
`compareSqlValuesFast` and at the `numeric-fast`/`compare-fast` branches in
`runtime/emit/binary.ts`), and probe values, `ANY` columns, and uncanonicalized
vtab/UDF output all still reach them.

**API surface.** Canonicalization is visible to embedders through `eval` /
`iterateRows` / UDF arguments / vtab `update()` inputs as a `typeof` change, never a
value change: a parameter bound as a small `bigint` (`stmt.bind(1, 5n)`) is used, stored
and returned as the `number` `5`, and a bigint arithmetic or `sum()` result landing back
inside the safe range is a `number`. An embedder relying on a `bigint` round-trip for
safe-range values must re-widen on its own side. Both changes move toward the form the
same value would have had if written as a literal.

#### Enforcement: `QUEREUS_REPR_STRICT`

R1 and R2 are enforced by coercion only where the engine MINTS values. At the two ingress
boundaries it deliberately does not coerce — rows out of a virtual-table module's
`query()`, and values out of a user-defined function — the rules are a **contract**, and an
opt-in strict mode verifies it. Set the environment variable `QUEREUS_REPR_STRICT=1` (or
run `yarn test:repr-strict`, which is `node test-runner.mjs --repr-strict`). This is the
same shape as the two existing runtime harnesses, `QUEREUS_FORK_STRICT` and
`QUEREUS_CONTEXT_STRICT` (see `runtime/strict-flags.ts` and `docs/runtime.md`).

The flag is read once at module load. With it off, every check is a single already-false
branch and nothing is built at emit time on the checker's behalf; the checker itself lives
in `runtime/strict-representation.ts` and throws `QuereusError(INTERNAL)` naming the seam,
the column or argument, the declared type, the value's JavaScript form and a truncated
rendering of the value. R2's predicate itself lives one layer down, in
`types/representation.ts` (`conformsToType` / `buildConformanceCheck`), because the DML
write path guards its conversion skip with the same question — see § Where coercion
happens. One definition, so the checker and the write path cannot drift apart on what
"conforms" means.

Four seams, each chosen so a violation is reported at the layer that CAUSED it:

| seam | what is checked | against |
|---|---|---|
| virtual-table scan output (`runtime/emit/scan.ts`) | each row a module's `query()` yields | the table's declared column types — R1 + R2 |
| DML write (`runtime/emit/dml-executor.ts`) | the row about to reach `vtab.update`, after the pipeline's coercion pass | the declared column types — R1 + R2 |
| UDF return (`runtime/emit/scalar-function.ts`) | a scalar function's returned value | its schema's declared return type — R1 + R2 |
| statement row egress (`core/statement.ts`) | each row yielded to the caller | **R1 only** |

The egress seam is the backstop for an *expression* producing a non-canonical value (an
arithmetic path that forgot to narrow), which none of the other three sees. A result
column's ANNOUNCED type — the planner's `ScalarType` inference, reachable through
`Statement.getColumnDefs()` / `getColumnType()` — is now held to R2 as a matter of
correctness: every computed-column inference (literals, arithmetic promotion, CASE and
VALUES branch merges, `sum()`'s NUMERIC, LAG/LEAD defaults, polymorphic builtins,
untyped parameters) names a type whose value space the column's values inhabit, and
`test/announced-result-types.spec.ts` pins each shape. A column with no principled
concrete type announces **ANY**, which is an honest "no representation constraint —
convert before trusting", never a guess.

The seam still *asserts* R1 only. Two known wrong-VALUE defects block the upgrade to
full R2 — both runtime bugs, not inference imprecision. `coerceAggregateValue` converts
numeric-looking text before `min`/`max`, so `min(text_col)` announces TEXT (correctly)
and can yield a number (wrongly) — tracked as
`backlog/bug-text-coercion-in-arithmetic-and-aggregates`; this is the one the suite
trips. And binary arithmetic over two safe-integer operands returns the raw double when
the exact answer escapes the safe range (`9007199254740991 * 3`), which the announced
INTEGER does not admit — tracked as
`backlog/bug-integer-arithmetic-silently-leaves-the-exact-integer-range`; no suite site
trips it today, so it does not block the widening, but a boundary case added later
would. Once those land, the seam
widens by passing the plan's output logical types instead of the empty declared-type
array (see the comment in `Statement._iterateWithSignal`); the rest of the suite
already passes under that widening. The announced `nullable` flag is a further axis R2
does not cover (null is admissible in every position) — its violations are tracked as
`backlog/debt-announced-nullability-disagrees-with-produced-nulls`.

**No capability flag, and why.** A `representationFidelity` declaration on
`VirtualTableModule` (alongside `scanSnapshotIsolation`) was considered and rejected:
nothing would *behave* differently based on it. The engine tolerates both numeric forms
everywhere today and will continue to, so a module declaring "I am faithful" and a module
declaring nothing take the identical code path — a configuration knob with no consumer,
which rots. The obligation lives in the module contract prose (`vtab/module.ts`, and
`docs/plugins.md` § Declaring return types for functions) and the strict checker enforces
it in tests.

**Known gaps in coverage** (the checker is a net, not a proof):

- A scalar function with a `customEmitter` bypasses the UDF seam — its emitter builds its
  own `run`. Several builtins are in this category.
- Aggregate and window function results are not checked at their own seam; they reach the
  egress seam, where only R1 applies.
- Values inside a JSON document are not walked; only the top-level `SqlValue` is checked.
- `@quereus/store`'s exported `decodeValue` / `decodeCompositeKey` return `BigInt(...)` for
  every integer-valued key, which violates R1 for small integers. They are key decoders and
  are not used to reconstruct rows, so no seam sees them — tracked as
  `backlog/debt-store-key-decode-returns-noncanonical-integers`.

### Logical Types

Logical types define the semantics and behavior of values:

```typescript
export interface LogicalType {
  // Identity
  name: string;                              // e.g., "DATE", "INTEGER", "TEXT"
  physicalType: PhysicalType;                // Physical storage representation

  // Validation
  validate?(value: SqlValue): boolean;       // Check if value is valid for this type
  parse?(value: SqlValue): SqlValue;         // Convert/normalize value to canonical form

  // Comparison
  compare?(a: SqlValue, b: SqlValue, collation?: CollationFunction): number;
  supportedCollations?: readonly string[];   // Which collations apply to this type

  // Serialization
  serialize?(value: SqlValue): SqlValue;     // Convert for storage/export
  deserialize?(value: SqlValue): SqlValue;   // Convert from storage

  // Metadata
  isNumeric?: boolean;
  isTextual?: boolean;
  isTemporal?: boolean;

  // Sargable-range support (optional)
  // For monotone-but-lossy transforms (e.g. `date(ts) = D`), compute the
  // half-open range `[lowerInclusive, upperExclusive)` on the input value.
  // `kind` is named by the function schema's `rangeRewriteOnArg` trait;
  // see docs/optimizer-rule-families.md § "Sargable range rewrites".
  bucketBounds?(
    kind: string,
    value: SqlValue,
  ): { lowerInclusive: SqlValue; upperExclusive: SqlValue } | undefined;
}
```

### Column Schema

Columns reference logical types:

```typescript
export interface ColumnSchema {
  name: string;
  logicalType: LogicalType;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: Expression | null;
  collation?: string;  // Must be in logicalType.supportedCollations
  // ... other fields
}
```

### Scalar Type

Plan nodes use ScalarType which includes the logical type:

```typescript
export interface ScalarType {
  typeClass: 'scalar';
  logicalType: LogicalType;
  nullable: boolean;
  collationName?: string;
  /** Provenance of collationName: 'explicit' | 'declared' | 'default' (absent = 'default'). */
  collationSource?: CollationSource;
  isReadOnly?: boolean;
}
```

This ensures type information flows through the entire planning and execution pipeline.

---

## Built-in Types

### Numeric Types

**INTEGER**
- Physical: `PhysicalType.INTEGER`
- Values: `number` (safe integers) or `bigint` (only outside the safe range — see
  [Physical representation](#physical-representation))
- Comparison: Numeric ordering
- Collations: None
- Text conversion (`cast('…' as integer)`, `integer('…')`, and the plan-time cast the
  planner inserts for a numeric-vs-text comparison) reads the leading integer run and
  returns a `number` while it stays a safe integer, an exact `bigint` beyond that —
  the same boundary the lexer applies to INTEGER literals. There is **no 64-bit clamp**:
  `cast('99999999999999999999999999' as integer)` is exact rather than SQLite's
  `INT64_MAX`, matching Quereus' arbitrary-precision integer literals.
- Number conversion follows the same rule: a finite whole `number` past the safe boundary
  widens to an exact `bigint`, so `cast(1e20 as integer)` — and `insert into t(int_col)
  values (1e20)` — stores exactly `100000000000000000000`, matching the digit and text
  spellings of the same value. Fractional values truncate as before; `NaN`/`±Infinity`
  are still rejected by `validate` at a write.

**REAL**
- Physical: `PhysicalType.REAL`
- Values: `number` (floating point)
- Comparison: Numeric ordering with NaN handling (NaN sorts smallest, NaN = NaN). A
  `bigint` operand is tolerated even though it is outside REAL's value space — the
  shared index/PK comparators hand through raw storage-class values, so a `real` column
  compared against an integer literal past 2^53 arrives as one — and is ordered by exact
  mathematical value, not rounded through `Number()`
- Collations: None

**NUMERIC** (SQLite's NUMERIC affinity — integer if it fits, else real)
- Physical: `PhysicalType.REAL`
- Values: `number` or `bigint` under R1 (see
  [Physical representation](#physical-representation)) — both halves are accepted by
  `validate`/`parse`, so a NUMERIC column can hold a whole number past 2^53 in exact
  `bigint` form, including one written as text
  (`insert into t(numeric_col) values ('9007199254740993')`), while `parse` narrows a
  safe-range `bigint` to `number`. Only an all-digit string takes the integer arm; a
  fractional spelling (`'9007199254740993.0'`) falls through to REAL and rounds, as in
  SQLite
- Comparison: numeric ordering with REAL's NaN handling (NaN sorts smallest, NaN = NaN).
  Mixed `number`/`bigint` pairs are ordered by exact mathematical value — REAL and NUMERIC
  share one comparator (`compareNumericWithNaN`, `types/builtin-types.ts`)
- Collations: None

**BOOLEAN**
- Physical: `PhysicalType.BOOLEAN`
- Values: `boolean` (true/false)
- Comparison: false < true
- Collations: None

#### The numeric seek key space

A numeric index key's identity is its **value**, not the JavaScript representation
(`number` vs `bigint`) that happens to hold it. Three independent layers implement that
identity and must never disagree:

- **the hash/set membership key** — `canonicalNumeric` in `src/util/key-serializer.ts`
  puts `number`, `bigint` and `boolean` under one `n:` tag and routes integer-valued
  numbers through `BigInt(n)`, so `5`, `5.0` and `5n` all serialize to `n:5`;
- **the in-memory index and primary-key BTrees** — ordered by the column's declared
  logical type `compare`; `INTEGER`, `REAL` and `NUMERIC` all rank a mixed
  `number`/`bigint` pair by exact magnitude (`compareNumericValues`);
- **the persistent store's key bytes** — `encodeNumeric` in
  `@quereus/store`'s `common/encoding.ts` uses a single numeric tag with an exact
  residual tie-break, so integers and reals interleave by magnitude: `5n` and `5.0`
  encode identically, `9007199254740993n` and `9007199254740992` do not.

Because all three agree, `INTEGER`, `REAL` and `NUMERIC` are one **seek key space**: an
index seek keyed by a value of one may be issued against a column declared another
without missing a row. `sharesSeekKeySpace` (`src/types/builtin-types.ts`) is the
plan-time predicate; `rule-key-set-seek` and the index-nested-loop candidate builder both
gate on it. Two consequences worth stating explicitly:

- **The key value is never coerced.** Converting it into the target column's type would
  truncate (`INTEGER_TYPE.parse(1.5)` → `1`) and mint a key for a value `=` calls
  unequal — a wrong answer wherever no residual re-check survives above the seek.
- **`BOOLEAN` is not in the space**, even though the key serializer and the store's byte
  encoding both fold booleans into it. `BOOLEAN_TYPE.compare` ranks by `a === b`, so a
  memory BTree over a boolean column is ordered by a comparator the probe side does not
  share. Plugin-registered numeric types are excluded for the same reason: they supply
  their own `compare`.

### Text Types

**TEXT**
- Physical: `PhysicalType.TEXT`
- Values: `string`
- Comparison: Collation-based
- Collations: BINARY (default), NOCASE, RTRIM, custom

### Binary Types

**BLOB**
- Physical: `PhysicalType.BLOB`
- Values: `Uint8Array`
- Comparison: Byte-by-byte
- Collations: None
- Conversion: `blob(value)` / `cast(value as blob)` on a string is **literal UTF-8** —
  the string's bytes, with no hex sniffing. `cast('6162' as blob)` is the four
  bytes of `'6162'`, not the two bytes `x'6162'`. Use `unhex(x)` to parse a hex
  string into bytes, and `hex(x)` for the reverse (uppercase, no separator).
  `hex` runs a non-blob argument through that same blob conversion first, so
  `hex('ab')` is `'6162'`; `unhex` takes text only and answers `NULL` for
  anything else, including a blob.

### Temporal Types

**DATE**
- Physical: `PhysicalType.TEXT` (ISO 8601 string: "YYYY-MM-DD")
- Values: ISO date strings
- Validation: Must parse as a valid bare PlainDate, or as a datetime string (bare, offset, `Z`, or `[zone]`) from which a date can be extracted
- Comparison: Lexicographic (ISO strings sort correctly)
- Collations: None
- Canonicalization: A datetime-shaped input is first converted to UTC (offset / `Z` / `[zone]` annotations honored), then the UTC date is stored. Numeric inputs (Unix milliseconds) are likewise canonicalized through UTC.

**TIME**
- Physical: `PhysicalType.TEXT` (ISO 8601 string: "HH:MM:SS.sss")
- Values: ISO time strings
- Validation: Must parse as a valid bare PlainTime, or as a datetime string (bare, offset, `Z`, or `[zone]`) from which a time can be extracted
- Comparison: Lexicographic
- Collations: None
- Canonicalization: A datetime-shaped input is first converted to UTC, then the UTC wall-clock time is stored — `'2024-01-15T10:30:00+02:00'` stores as `'08:30:00'`, not `'10:30:00'`.

**DATETIME**
- Physical: `PhysicalType.TEXT` (ISO 8601 string: "YYYY-MM-DDTHH:MM:SS.sss")
- Values: ISO datetime strings
- Validation: Must parse as valid Temporal.PlainDateTime, Temporal.ZonedDateTime, or Temporal.Instant
- Comparison: Lexicographic (by UTC wall-clock — see canonicalization below)
- Collations: None
- Canonicalization: Inputs with an offset (`+HH:MM` / `Z`) or `[zone]` annotation are converted to UTC, and numeric inputs (Unix milliseconds) are canonicalized through UTC, before being stored as the bare PlainDateTime form. Equal instants compare equal regardless of input shape.

**TIMESPAN**
- Physical: `PhysicalType.TEXT` (ISO 8601 duration string: "PT1H30M", "P1DT2H")
- Values: ISO 8601 duration strings
- Validation: Must parse as valid Temporal.Duration
- Comparison: Total duration comparison (normalized to seconds; calendar units — years/months/weeks — resolve against a fixed reference date, 2024-01-01)
- Ordering: **Semantic** (`semanticOrdering: true`) — ordered by elapsed time, not by duration text: `'PT90M'` sorts before `'PT2H'` although the text sorts the other way. See [Semantic ordering](types-ordering.md#semantic-ordering).
- Identity: `'PT1H'` and `'PT60M'` are the *same* elapsed time — `=` treats them equal, and DISTINCT / GROUP BY / set operations / hash-join keys collapse them (via the type's `groupKey` hook, which maps compare-equal values to one hash representative). Which textual representative survives is unspecified.
- Collations: None
- Arithmetic: Supports addition/subtraction with DATE, TIME, DATETIME types
- Human-readable parsing: `timespan('1 hour 30 minutes')` → `"PT1H30M"`

**Temporal arithmetic: one table, read by both the planner and the evaluator.**
Which `(operator, left operand, right operand)` combinations exist, what each produces,
and what result type each announces all live in a single table,
`src/types/temporal-ops.ts`. Because every side reads one description, the type an
expression *announces* predicts the value it *produces*; before the table existed the
planner announced the left operand's type for every temporal pair, so `date - date`
claimed DATE while yielding a duration string, and downstream consumers of the declared
type (the numeric fast path, `create table … as select`, view column types,
`Statement.getColumnType()`) were reading a type that did not hold.

There are two routes into the table, and which one an expression takes is decided once,
at plan/emit time, from the operands' **declared** types:

- **From declared types** — `temporalOpCaseForTypes` classifies each operand by identity
  against the registered singletons. `BinaryOpNode.generateType` announces the case's
  `resultType`, and the emitter (`buildNumericOpSpec`, `runtime/emit/binary.ts`) bakes the
  same case into the per-row body so no classification happens while rows flow. Both call
  the one function, so the announced type and the executed case cannot disagree. When both
  kinds are known and the table has *no* case, the emitted body is a NULL check plus a
  constant throw — still raised per row, so a guarded or filtered-out occurrence keeps
  succeeding.
- **From runtime values** — when a declared type settles nothing (TEXT, ANY, NULL,
  TIMESTAMP, a plugin-registered type), `tryTemporalArithmetic`
  (`runtime/emit/temporal-arithmetic.ts`) classifies each operand by the shape of the
  value instead, per row. That *is* the defined semantics there: a TEXT column holding a
  duration string is a supported shape.

The declared-type route trusts the declaration: an operand typed DATE that somehow held a
non-parseable string would yield NULL where value classification raised `Unsupported
temporal operation`. Write-side coercion enforces declared types on every path SQL can
reach (a bad INSERT is rejected, a failed CAST is NULL), so only a misbehaving virtual
table can produce such a value.

The operand kinds are `date`, `time`, `datetime`, `timespan`, and `number`. Supported
combinations:

| Operator | Left | Right | Result |
|---|---|---|---|
| `-` | DATE / DATETIME | DATE / DATETIME | TIMESPAN |
| `-` | TIME | TIME | TIMESPAN |
| `+` / `-` | DATE | TIMESPAN | DATE |
| `+` / `-` | DATETIME | TIMESPAN | DATETIME |
| `+` / `-` | TIME | TIMESPAN | TIME |
| `+` | TIMESPAN | DATE / DATETIME / TIME | DATE / DATETIME / TIME |
| `+` / `-` | TIMESPAN | TIMESPAN | TIMESPAN |
| `*` | TIMESPAN | number | TIMESPAN |
| `*` | number | TIMESPAN | TIMESPAN |
| `/` | TIMESPAN | number | TIMESPAN |
| `/` | TIMESPAN | TIMESPAN | REAL (ratio of elapsed seconds) |

Anything absent — `%` on any pair, `DATE + DATE`, `DATE * number`, `TIME - DATE`,
`DATE - number` — raises `Unsupported temporal operation` when a row is evaluated.
Notes on the edges:

- A `DATE`/`DATETIME` difference collapses both sides to a calendar date first, so
  `datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')` is `P5D`, not
  `P5DT2H`. Tracked as `bug-datetime-difference-drops-time-of-day`.
- `TIMESPAN / 0` and a ratio involving calendar units (years/months/weeks, which have no
  fixed length without a reference date) both return NULL rather than raising.
- The `number` side must be a JS `number`; a value past 2^53 arrives as a `bigint` and is
  rejected as unsupported.
- **TIMESTAMP is deliberately not in the table.** It is an integer instant rather than a
  string temporal, so `ts_col + 1` is ordinary integer arithmetic and keeps the runtime
  path it always had.
- An operand whose declared type settles nothing — TEXT, ANY, a plugin-registered type,
  or a plugin type that shadows a built-in temporal name (a different object, so identity
  fails) — selects no case at plan time. The runtime still classifies that operand by
  value, so `timespan('PT1H') + 'PT1H'` is still `'PT2H'`.
- Announcing TIMESPAN also hands a difference expression the semantic ordering below, so
  `order by (a - b)`, `min`/`max`, `distinct` and materialized views over it now rank by
  elapsed time; they ranked the duration strings as text while the announcement was DATE.

**Two families of date/time functions, typed differently.** The single-argument
conversion functions `date(x)`, `time(x)`, `datetime(x)` (`func/builtins/conversion.ts`)
return DATE / TIME / DATETIME and produce each type's canonical spelling. The
modifier-accepting variadic forms `date(x, …)`, `time(x, …)`, `datetime(x, …)`
(`func/builtins/datetime.ts`) return **TEXT**: they emit SQLite's *display* spelling,
which is not canonical — `datetime()` separates date and time with a space rather than
`T`, and `time(…, 'subsec')` always emits three fractional digits where TIME trims them.
Declaring the temporal type on those would make the write path treat the value as already
in declared form (see "Where coercion happens (and why exactly once)") and store the
display spelling into a temporal column, where comparison is binary text — so the row
would stop matching canonically-written values. The split is therefore deliberate:
reconciling the two families (canonicalize the display output, or teach the write path to
canonicalize a temporal spelling) was raised as its own ticket and closed unworked in a
backlog triage pass, so this paragraph — not a queued ticket — is the record. Revisit if a
caller is found relying on `datetime(x, …)` being storable into a DATETIME column without
an explicit conversion.

### Special Types

**NULL**
- Physical: `PhysicalType.NULL`
- Values: `null` only
- Used for expressions that always return NULL

**JSON**
- Physical: `PhysicalType.OBJECT`
- Values: Native JS objects, arrays, and JSON-compatible primitives (stored in memory as-is)
- Validation: Must be valid JSON; accepts objects, arrays, numbers, booleans, strings (parsed as JSON), and null
- Comparison: Deep structural comparison (`deepCompareJson`). **Object key order is not significant** — `{a:1,b:2}` equals `{b:2,a:1}` — but **array element order is** (positional). Numeric storage class holds, so a JSON *number* scalar `5` equals `5.0`. A JSON **string** scalar always compares as text — under the supplied collation, or BINARY (code-point order) when none is given — so the strings `"9"` and `"9.0"` are distinct values and never collapse onto one row.
- Comparison against SQL text: JSON's values are native JS objects, a storage class that never compares equal to a string, so a text operand is converted **at plan time** — `insertCrossTypeCoercion` (`planner/building/coercion.ts`) wraps the non-object side of a comparison / BETWEEN bound / IN-list value / simple-`case` WHEN in `cast(… as json)`. `json_col = '{ "a" : 1 }'` therefore matches a row stored as `{"a":1}`, and an unhinted bound parameter (plan-time type TEXT) comes along for free. An IN whose right-hand side is a **subquery** has no fixed operand list to wrap, so it converts **per row inside membership evaluation** instead (`inMembershipKeys` in `runtime/emit/subquery.ts`, using the same lenient-cast semantics via `types/cast-semantics.ts`): `json_col in (select text_col from …)` and `text_col in (select json_col from …)` both match structurally. That conversion is **asymmetric** — only the non-JSON side converts, never the JSON side, so a JSON *string scalar* (physically a plain string, e.g. the document `"[1,2]"` stored as the string `[1,2]`) is not re-parsed into a different document. A `col in (subquery)` that decorrelates into a semi / existence-flag join has the `=` that rewrite synthesizes reconciled the same way (both arms call `coerceComparisonSet`). The gate is `physicalType === OBJECT`, not `semanticOrdering` — the temporal types are physically text and keep their existing runtime path. The cast is lenient: text that is not valid JSON source still compares unequal rather than erroring, so `json_col = 'not json'` is false. It gets there two ways — a bare string is itself a valid JSON *string scalar*, so the JSON type accepts it, the operand survives the cast, and the comparison is unequal; anything the JSON type does not accept at all (a blob, say) casts to NULL instead, which makes the comparison UNKNOWN, so `=` **and** `<>` both match no rows. One consequence for JSON *string scalars*, which are physically plain strings: a column holding `"hello"` matches both `'"hello"'` and the bare `'hello'`.
- Ordering: **Semantic** (`semanticOrdering: true`) — ORDER BY and `<`/`>` on a declared JSON column rank by the structural deep-compare (JSON type rank: null < boolean < number < string < array < object, then element/key-wise recursion — so `{"a":2}` sorts before `{"a":10}`), not by canonical JSON text. Equality is identical under both forms, so identity paths (DISTINCT, GROUP BY, hash keys) need no change. See [Semantic ordering](types-ordering.md#semantic-ordering).
- Keys: hash keys (GROUP BY / DISTINCT / join partitioning) derive from a **canonical text form** (`canonicalJsonString` — recursive object-key sort, arrays positional) so a value's key always agrees with the comparator: reorder-equal objects group/de-dup/conflict as one, distinct objects never over-merge. Persisted byte keys (a JSON PK / index member in `quereus-store`) instead encode a **structural byte form** (`jsonStructuralKey`, `quereus-store`'s json-key.ts) — same identity, and its memcmp order also reproduces the structural compare, so the store scans JSON keys in `compare` order. Both forms are used **only to derive keys** — never for storage or display. The canonical text form also fingerprints object-valued literals for scalar CSE (`planner/analysis/expression-fingerprint.ts`), so two distinct documents are never folded into one shared computation. The memory module keeps documents as native values and orders its BTree with the same `JSON_TYPE` comparator `<`/`>`/ORDER BY use, so an indexed range seek walks exactly the window the operators evaluate. (The canonical-text form's own order sorts by JSON punctuation and does *not* reproduce the structural compare — it is never used to order a JSON index; identity is all it provides.)
- Collations: None
- Serialization: `serialize()` converts to JSON string for storage; `deserialize()` parses back to native object. Storage and display preserve **insertion order** (only key derivation canonicalizes)
- Conversion: `json(value)` parses a JSON string into a native object; inserting a JSON string into a JSON column auto-parses it
- Functions: All `json_*` functions accept both native objects and JSON strings as input

---

## Semantic ordering

Moved to [Semantic ordering](types-ordering.md#semantic-ordering).

---

## Type Validation

Values are validated at INSERT/UPDATE boundaries:

```typescript
export function validateValue(value: SqlValue, type: LogicalType): SqlValue {
  if (value === null) return null;

  // Type-specific validation
  if (type.validate && !type.validate(value)) {
    throw new QuereusError(
      `Type mismatch: expected ${type.name}, got ${typeof value}`,
      StatusCode.MISMATCH
    );
  }

  // Type-specific parsing/normalization
  if (type.parse) {
    return type.parse(value);
  }

  return value;
}
```

### Where coercion happens (and why exactly once)

A write's values are converted to the declared column logical types **once, at
the top of the DML pipeline** — in the DML emitters — and everything downstream
(constraint checking, the isolation overlay, the storage layer) sees the
declared form.

**Stated positively: every expression evaluated against a row being written sees
that row in its columns' declared form** — CHECK (immediate and deferred alike),
a column `DEFAULT` including one reading a sibling through `new.<column>`, and a
`GENERATED ALWAYS AS` body — at every write site: INSERT, UPDATE,
`ON CONFLICT … DO UPDATE`, and the `ALTER TABLE … ADD COLUMN` backfill. No
write-path expression sees the form the statement spelled. The enumeration under
*Concretely* below says **where** each site converts; this contract is the
property that enumeration has to add up to, and the two drift apart easily: the
enumeration used to omit where DEFAULT and generated evaluation sat in the order,
and INSERT evaluated both against the *unconverted* row while UPDATE evaluated
them against the converted one — so one value produced two different computed
results depending on which statement wrote it. Guarded end-to-end by
`test/logic/15.1.3-declared-form-write-contract.sqllogic` (DATETIME, where the
two forms differ by a `Z` suffix the conversion canonicalizes away) and
`test/logic/15.1.1-json-check-coercion.sqllogic` (JSON, raw text vs. parsed
document). Recorded as
[RT-001](invariants.md#rt-001--every-write-path-expression-sees-the-declared-form).

Conversion cannot simply be re-run at each layer, because it is not repeatable
for every type:

> **`JSON_TYPE.parse` is not idempotent for a string scalar.** `parse('"Bob"')`
> returns the bare string `Bob`, and `parse('Bob')` then throws
> `Cannot convert 'Bob' to JSON: invalid JSON syntax` — while re-parsing the
> stored text `9` silently *changes* it into the number 9. A converted value is
> indistinguishable at runtime from unparsed JSON source, so "convert again just
> in case" is not safe.

What primarily decides whether a cell converts is therefore the **static type of
the expression that produced it**, which the planner already knows. The rule
(`buildCellCoercion` / `buildRowCoercion` in `types/validation.ts`): convert
cell *i* **unless** the producing expression's `LogicalType` is — by object
identity — the target column's type **and** the value in hand already inhabits
that type. A SQL literal `'"abc"'` is TEXT → into a JSON column, convert; a
reference to a JSON column is JSON → already declared form, leave alone.

The second half is a guard, not a second opinion. An announced type is an
*inference* the engine does not otherwise enforce, and the skip trusted it
alone. Two historical examples, both since corrected at the source: `sum()`
announced REAL but returned a `bigint` past 2^53 (it announces `NUMERIC` now),
and an untyped positional `?` announced TEXT but could be bound to a number, a
blob, a boolean or a `bigint` (it announces `ANY` now). Both landed a value
outside the column's declared value space in storage (rule R2 of § Physical
representation — the rule the write path exists to uphold). Fixing the inferences
does not retire the guard: an inference is still not an enforcement, and a
misbehaving virtual table or UDF can produce a non-conforming value under any
announcement. The guard asks the value itself, via `conformsToType`
(`types/representation.ts`) — the same predicate the `QUEREUS_REPR_STRICT`
checker enforces, so the two can never disagree about what conforms.

It is a **conjunction** with the identity test, deliberately: a TEXT-announced
expression feeding a DATE column produces a string, which conforms to DATE's
TEXT physical type, yet still needs converting so the spelling is canonicalized.
And the JSON case above stays safe, because a value read out of a JSON column —
a native object/array, or a JSON scalar such as the string `abc` or the string
`9` — *conforms* to JSON's OBJECT physical type, so `parse` is never re-applied.
A column whose physical type constrains nothing (`ANY`) needs no guard at all, so
its cell is skipped outright; and a row whose guarded cells all conform is
returned as-is rather than copied, so a bulk copy between same-typed tables still
allocates nothing per row.

The guard converts where the skip used to store, so an announcement the value
contradicts can now surface as a `Type conversion failed for column '…'` error
instead of silently landing a non-conforming value — e.g. a NaN reaching an
INTEGER column from an INTEGER-announced expression. That is the intent: an
inaccurate announcement is a planner bug, and failing the write names it rather
than burying it in storage.

Concretely:

- INSERT's row-expansion projection (`building/insert.ts`) is a **chain of
  stages**, and conversion is interleaved *into* that chain rather than run after
  it: each stage wraps the cell it produces in a planner-inserted `WriteCoercion`
  node (`coerceToDeclared`, same `buildCellCoercion` semantics) **in place**,
  before any later stage can read it. The order is supplied and literal-DEFAULT
  cells, then expression DEFAULTs, then the generated columns in topological
  order. So a DEFAULT reading a supplied sibling via `new.<col>`, a generated
  expression reading a supplied column, and a generated expression reading an
  earlier generated column all see the value that will be stored, matching what
  UPDATE and the `DO UPDATE` recompute hand the same expressions.
- `emitInsert` masks each cell by the source relation's attribute type at that
  position (the source is projected into full table-column order, so the two
  align); with the expansion projection announcing declared types, its pass
  degrades to conformance guards there. `insert into b select j from a`
  copies JSON values untouched; a VALUES literal converts in the projection.
- `emitUpdate` masks an assigned column by its assignment expression's type and
  an unassigned column by the source attribute's type — for the ordinary
  target-table scan that is the declared type itself, so the carried-over
  stored values are never re-converted. `update t set v = 'X'` leaves a JSON
  key column byte-identical.
- Two paths inject a value *after* that pass and convert their one cell by the
  same rule, calling the same `buildCellCoercion` helper: the `OR REPLACE` NOT
  NULL DEFAULT substitution (`runtime/row-constraints.ts`, reached both from the
  `ConstraintCheckNode` emitter and from the `ON CONFLICT … DO UPDATE` arm's own
  validation) and `ON CONFLICT … DO UPDATE` assignments (the DML executor).
  Injecting late does not make either an exception to the contract: the row they
  **read** — `new.<col>` in a substituted DEFAULT, `excluded.<col>` in a DO UPDATE
  assignment — is the already-converted one; only the cell they **write** still
  needs converting.
- `ALTER TABLE … ADD COLUMN`'s per-row backfill (a non-foldable DEFAULT or a
  GENERATED ALWAYS AS expression) converts its one cell through the same helper
  too, so a backfilled cell is what an INSERT under the same DEFAULT would store.

The DML executor then passes `preCoerced: true` on its `vtab.update` calls, and
every conversion-performing layer below honors it: the memory module
(`MemoryTableManager.performInsert`/`performUpdate`), `quereus-store`'s
`StoreTable`, and `quereus-isolation`'s `IsolatedTable` (which also forwards the
flag to its overlay writes). The isolation layer's flush and tombstone writes
set the flag themselves — those cells were read back out of storage.

The storage layer's own conversion is **not** gone: a write that does not come
through the DML executor — external-change apply, materialized-view maintenance
writes, direct `vtab.update` API use — leaves `preCoerced` unset and the
storage layer converts as before. The public vtab contract is unchanged.

Because the row reaching `ConstraintCheckNode` is already in declared form,
CHECK and FK expressions — immediate and deferred alike — read it directly: a
CHECK compares the same values the read path would (`check (a < b)` over two
JSON columns compares structurally, not as raw text), and an UPDATE that never
mentions a JSON column shows the CHECK the *stored* value rather than a
re-converted (possibly damaged) one. Under `OR REPLACE`, the NOT NULL pass may
substitute a column's DEFAULT first; CHECK/FK then read the row *as finally
substituted*, which is also what flows downstream.

Conversion errors surface from the emitter (for INSERT, before the row reaches
constraint checking), but the message text is unchanged — the same
`validateAndParse` produces it.

**ALTER backfills follow the same rule.** `alter table … add column … default <x>`,
`alter table … add column … generated always as (<x>)` and `alter column … set not
null` write existing rows outside the DML pipeline, so they convert explicitly:

- A DEFAULT that folds to a literal goes through `foldDefaultToType`
  (`types/validation.ts`), which folds *and* converts to the new column's declared
  type. Every site shares it — the memory module, `quereus-store`, the isolation
  overlay's staged rows (which write `preCoerced: true` and so cannot pick the
  conversion up implicitly), and the batched data-change-event remaps — so a
  backfilled cell is indistinguishable from one a fresh INSERT under the same
  DEFAULT would produce. No identity guard is needed here: an AST literal is always
  raw source form. A literal that cannot convert (`add column n integer default
  'abc'`) raises the same `MISMATCH` the equivalent INSERT raises, and does so
  whether or not the table holds any rows, so DDL acceptance does not depend on the
  data. Note the deliberate asymmetry with `CREATE TABLE`, which still accepts an
  unconvertible literal DEFAULT and only fails at the first INSERT.
- A non-foldable DEFAULT (`default (new.<col>)`) is evaluated per existing row, and
  its result takes the write path's own per-cell decision, built by the same
  `buildCellCoercion` helper: it converts unless the default expression's static
  type already IS the new column's type *and* the value in hand inhabits it
  (`add column k json default (new.j)` over an existing JSON column must copy, not
  re-parse — and a value read out of a JSON column conforms, so it does). The
  conversion runs before the per-row CHECK predicates, matching `emitInsert`.
- A `generated always as (<x>)` expression takes that same guarded
  `AddColumnBackfill.coerce` path — one `AddColumnBackfill` serves both kinds — so a backfilled
  generated cell holds what an INSERT computing the same expression would store
  (`add column g integer generated always as (v || '0')` over a text `v` stores the
  integer). It differs from the DEFAULT arm in one respect: it is *never* folded to a
  bulk-written literal, because a generated column has no `defaultValue` a module
  could write, so even `generated always as (2)` is evaluated per row.

Because every `JSON_TYPE.compare` caller is guaranteed to hold parsed values, a
JS string reaching `compare` is unambiguously a JSON **string scalar** and is
never re-parsed: `compare('9', 9)` ranks the number first (number < string)
instead of calling them equal.

The rule is only as sound as the static types it reads, so an expression node
that advertises a logical type it does not actually produce is still a write-path
defect — narrowed, but not closed, by the conformance guard above. The guard sees
only which JS storage class a value is, so it catches an announcement contradicted
by the *representation* (a number announced as TEXT) and misses one contradicted
only by the *content*: serialized JSON text and a date spelled the wrong way both
inhabit their declared type's physical form. Known cases:

- A scalar function whose schema *declares* a JSON return type must return
  native (parsed) JSON values, never serialized text — the skip rule takes the
  declaration at its word. The builtins that declare JSON (`json()`,
  `json_group_array`, `json_group_object`) all return native values;
  `json_extract` and friends declare no return type and are unaffected.

A **set operation is a conversion site** under this contract. Its output column
carries rows from both operands, so `SetOperationNode` advertises the
*symmetric* per-column merge of the two operand types (`mergeSetOpColumnType` in
`planner/analysis/set-op-type-merge.ts` — order-independent, so swapping the
arms cannot change the result), OR-merging nullability alongside:

1. **Identical logical types** → that type (the overwhelmingly common case).
2. **Either side NULL** → the other side's type — a `select null` branch is a
   valid member of every type and must not poison a well-typed union.
3. **Both builtin numeric** (and differing — rule 1 already took the identical
   pairs) → `NUMERIC`, whatever the pair: `1 union all 2.5` stays numeric.
   Deliberately *not* the `REAL + REAL → REAL` promotion arithmetic
   (`BinaryOpNode.generateType`) uses — because unlike rule 4, rule 3
   converts **neither branch**. Arithmetic yields one value in one form, which
   `REAL` describes exactly; a set operation yields a *stream mixing both* forms
   (`number` from the REAL arm, `bigint` from the INTEGER arm), and only
   `NUMERIC` — whose value space is `number | bigint` — describes that. Claiming
   `REAL` was a lie the DML skip rule believed: a bigint rode it unconverted into
   a `real`-declared column, and a `real`-declared key then threw out of
   `REAL_TYPE.compare` (that comparator now tolerates a bigint operand, but the
   type claim was still wrong). Because no branch is converted, the read side is
   untouched: `select <big int> union all select 2.5` still returns each row in
   its own storage class, matching SQLite.
4. **Exactly one side object-physical** (JSON today) → the object side's type,
   and the construction factory (`SetOperationNode.create`) wraps the other
   branch in a *lenient* CAST so it actually produces that type — the same rule
   and direction predicate coercion applies to `json_col = 'text'`. The
   conversion happens in the branch, so at a DML the advertised type matches the
   declared column and the skip rule correctly leaves both branches' cells
   alone; on the read side, UNION dedup and predicates compare both branches
   under JSON's structural rules.
5. **Otherwise** → `ANY`. `ANY` on a set-op output column means "no principled
   common type — nothing is claimed, every consumer converts": its `parse` is
   pass-through, its `compare` is storage-class + BINARY ordering, and at a DML
   it is never identical to a declared column type, so every cell converts.
   That is correct precisely because rule 5 only fires when no branch is
   guaranteed to already be in target form (`date_col union all '2024-01-02…'`:
   the raw literal normalizes, the stored value survives idempotent
   re-conversion).

A branch that surfaces set-op membership flags cannot be CAST-wrapped (the
projection would flatten its flag columns into the data arity), so a rule-4
pair over such a branch stays unconverted and honestly advertises `ANY`
instead. `AsyncGatherNode`'s `unionAll` combinator folds the same merge across
its children, so the physical rewrite of a union-all chain advertises the same
types the logical node did.

Rules 1–5 are not set-op-specific — they are the answer for **any** result
position that carries values from several branches with no branch converted, so
every such site folds through the same `mergeSetOpAdvertisedType` rather than
inventing its own: `CASE` arms plus its `ELSE`, a `VALUES` column across *all* its
rows (not just the first), the value-returning polymorphic builtins
(`coalesce`/`iif`/`choose`/`greatest`/`least`), and `LAG`/`LEAD` folded with their
optional default argument. Arithmetic is deliberately excluded — it produces one
converted value, so it promotes by its own table
([Binary operator result types](types-inference.md#binary-operator-result-types)).

`CAST` is the settled case, and states the rule the others must meet: it stays
lenient — it never throws — but it never produces a value outside the type it
advertises either. When the target type's `parse` throws, `castFallback`
(`types/cast-semantics.ts`) applies SQLite's numeric/text/blob fallbacks (`0`,
`0.0`, [`valueToText`](#value-to-text) and its UTF-8 bytes — each a valid member
of its own type); for every other target it keeps the operand only when the
target type's own `validate` accepts it, and yields NULL otherwise. `parse` reads
its input as source *text*, so `validate` is the right question to ask: a bare
string is a legitimate JSON string scalar that `JSON_TYPE.parse` nonetheless
rejects.

Because a converting cast can produce NULL from a non-null operand,
`CastNode.getType()` reports `nullable` for a cast that changes the logical type
— except to TEXT or BLOB, which convert *every* non-null operand and so cannot
introduce a NULL (`castCanYieldNull`, same module, is the one place that table
lives). The exception matters at the write end: a `not null` lens column over
`cast(x as text)` is sound and must still deploy, while the same shape over a
temporal or JSON target is not and is correctly blocked. The emitter reads the
resolved target type back off `CastNode.getType()` rather than re-resolving the
name, so the plan and the runtime cannot disagree — they previously did for a
name that misses the registry but matches an affinity rule (`nvarchar` → TEXT),
which made a value-preserving cast read as converting and block an index seek.

Standing regression coverage for "convert exactly once" (several JSON text
scalars, across ordinary writes and the row-rewriting paths — `ALTER TABLE`
(add/drop/rename column, retype, add constraint, `SET NOT NULL` backfill),
transactions, savepoints, rollback, `INSERT OR REPLACE`, primary-key
relocation, index DDL) lives in `test/logic/06.9.1-json-coerce-once.sqllogic` and its
capability-gated sibling `test/logic/06.9.1.1-json-coerce-once-index.sqllogic`.

### Value to text

There is exactly ONE conversion from a value to text — `valueToText`
(`util/value-text.ts`). Every construct that has to render a value as text calls
it and nothing else: `TEXT_TYPE.parse` (and so `cast(x as text)`, `text(x)`, and
any write into a TEXT column), `castFallback`'s TEXT and BLOB arms, `||`, LIKE's
operand coercion (both the `LIKE` operator and the `like`/`glob` functions),
`group_concat`, and TEXT affinity. A value therefore has one text spelling no
matter which construct produced it.

The one exception is the rest of the string builtin family — `substr`, `trim`,
`replace`, `instr`, `lower`, `upper`, `reverse`, `lpad`, `rpad` — which still coerce
a non-text argument their own way (some with JavaScript stringification, some by
returning NULL). See [functions.md § String functions](functions.md#string-functions);
tracked as `debt-string-builtins-coerce-three-different-ways`.

| source | text | notes |
|---|---|---|
| `NULL` | `NULL` | SQL NULL propagates |
| TEXT | itself | including every temporal value — DATE/TIME/DATETIME/TIMESPAN are physically text |
| INTEGER / REAL / NUMERIC (`number`) | `String(v)` | JavaScript's shortest round-trip spelling |
| INTEGER / NUMERIC (`bigint`) | exact decimal digits | no `Number()` round-trip, so no rounding past 2^53 |
| BOOLEAN | `true` / `false` | |
| BLOB | UTF-8 decode | the bytes reinterpreted as text, matching SQLite |
| JSON object / array | `JSON.stringify` | the document's own key order |

Three properties are load-bearing and should not be "fixed" without reading why:

- **The binary decode is lossy.** Decoding is non-fatal, so bytes that are not
  valid UTF-8 become U+FFFD — `x'ff'` and `x'fe'` render as the same text. Text
  derived from a blob is not a key for that blob. The decoder is constructed with
  `ignoreBOM: true`, so a leading `EF BB BF` stays one U+FEFF character instead of
  being silently stripped (`length(cast(x'efbbbf' as text))` is 1, not 0).
- **JSON keeps the document's own key order**, deliberately not the canonical
  (sorted) form `canonicalJsonString` produces. Canonical form exists for grouping
  keys and expression fingerprints, which must agree with `JSON_TYPE.compare`; a
  user-visible conversion should show the document as it is. The consequence is
  real: that comparator is a structural deep-compare, so two documents differing
  only in key order are *equal* yet render *different* text.
- **The conversion is total** — it never throws for a value inhabiting `SqlValue`.
  `castCanYieldNull` declares TEXT and BLOB total over non-null operands on the
  strength of that, and a `not null` lens column over `cast(x as text)` deploys on
  the strength of `castCanYieldNull`.

Two consequences worth stating outright. A JSON column holding a *string* scalar is
physically a JS string, so it renders bare (`hello`, not `"hello"`) — the conversion
dispatches on the runtime value and cannot see the declared type. And because
`TEXT_TYPE.parse` is this conversion, inserting a BLOB into a TEXT column **stores**
the UTF-8 decode; that is a stored value, not just a display, and it is lossy for
non-UTF-8 bytes.

Number spelling stays JavaScript's: `cast(1.0 as text)` is `1` where SQLite gives
`1.0`, and non-finite values give `Infinity`/`NaN` where SQLite gives `Inf`. That is
a separate divergence, tracked on its own.

Behaviour is pinned in `test/logic/03.6.2-value-to-text.sqllogic` (SQL-visible) and
`test/util/value-text.spec.ts` (per-type table).

### Explicit Conversion

Use type conversion functions for explicit conversion:

```sql
-- Convert string to integer
select integer('123');

-- Convert timestamp to date
select date(1234567890);

-- Convert string to real
select real('3.14');

-- Invalid conversion throws error
select integer('abc');  -- Error: Type mismatch

-- Conversion functions are just regular scalar functions
select text(42);           -- '42'
select boolean(1);         -- true
select datetime('2024-01-15T10:30:00');
```

**Built-in Conversion Functions**:
- `integer(value)` - Convert to INTEGER
- `real(value)` - Convert to REAL
- `text(value)` - Convert to TEXT
- `boolean(value)` - Convert to BOOLEAN
- `blob(value)` - Convert to BLOB
- `date(value)` - Convert to DATE
- `time(value)` - Convert to TIME
- `datetime(value)` - Convert to DATETIME
- `timespan(value)` - Convert to TIMESPAN (supports ISO 8601 durations and human-readable strings)
- `json(value)` - Convert to JSON (parses JSON strings into native objects)

Note: CAST syntax is also supported for SQL compatibility, but conversion functions are preferred.

See [Built-in Functions Reference](functions.md#type-conversion-functions) for the full list of conversion functions, including `json()`, date/time arithmetic with modifiers, and validation functions.

---

## Type-Aware Comparisons

### Comparison Rules

1. **NULL Handling**: NULL compares less than any non-NULL value
2. **Type Matching**: Both values must have the same logical type
3. **Type-Specific Logic**: Each type defines its own comparison semantics
4. **Collation Support**: TEXT types use collation functions

```typescript
export function compareTypedValues(
  a: SqlValue,
  b: SqlValue,
  typeA: LogicalType,
  typeB: LogicalType,
  collation?: CollationFunction
): number {
  // NULL handling
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;

  // Type mismatch error
  if (typeA !== typeB) {
    throw new QuereusError(
      `Type mismatch in comparison: ${typeA.name} vs ${typeB.name}`,
      StatusCode.MISMATCH
    );
  }

  // Use type-specific comparison
  if (typeA.compare) {
    return typeA.compare(a, b, collation);
  }

  // Fallback to default comparison
  return defaultCompare(a, b, typeA.physicalType);
}
```

### Type Coercion in Comparisons

All expressions in Quereus have known types at plan time — including parameters, which must be typed at prepare time (either inferred from values or explicitly declared). There is no concept of an "untyped" expression.

When the planner encounters a comparison between operands of different type categories (e.g., numeric vs textual), it inserts an **explicit conversion** on the appropriate operand, matching the target type. For example, `integer_column = '25'` becomes equivalent to `integer_column = integer('25')` at plan time. This keeps the runtime free of implicit coercion — both sides of every comparison have matching type categories, enabling fast-path execution.

**Same-category comparisons** (both numeric, both textual, etc.) require no conversion and use a direct comparison path at runtime.

**One probe against many values.** `IN` value lists, simple `CASE` and the scalar builtins that declare a comparison group (`nullif`, `greatest`, `least`) compare ONE probe expression against N value expressions. They share the `=` rule through `comparisonGroupCoercions` (`types/comparison-coercion.ts`) — which `coerceComparisonSet` (`planner/building/coercion.ts`) turns into plan-time casts and `makeComparisonGroup` (`runtime/emit/operand-comparator.ts`) turns into emit-time comparison keys for the value-returning builtins — so `i in ('1')` and `case i when '1'` answer exactly as `i = '1'` does. The probe is a single operand, so it can only be converted ONCE, which is the one place these sites differ from a plain pairwise comparison:

- A **value-side** cast is decided per value and never conflicts, so a mixed list (`case i when 'abc' when '1'` over an integer `i`) gets a per-clause decision.
- A **probe-side** cast is hoisted, so it is applied only when unambiguous. For the JSON pairing it always is (the cast is lenient, so a non-JSON textual value survives as itself). For the numeric pairing it is not — `cast('abc' as real)` is `0` — so the probe casts only when every non-NULL value is numeric. A textual probe against a list mixing numeric and textual values (`text_col in (1, 'abc')`) is therefore left uncoerced and still differs from the `=` disjunction on the numeric member; closing that needs a per-value probe, which `IN` cannot express because its members share one key space.

An `IN` whose right-hand side is a **subquery** has no operand list to wrap, so the same reconciliation happens per row inside membership evaluation (`inMembershipKeys` in `runtime/emit/subquery.ts`), gated on a uniform right-hand side so it cannot pick up the mixed-list shape the plan-time helper declines.

**Cross-category comparisons** are resolved at plan time by wrapping the mismatched operand in a conversion function node. The conversion targets the other operand's type category (e.g., textual → numeric via `integer()` or `real()`). Users can also write explicit conversions directly:

```sql
-- Explicit conversion (always preferred)
select * from users where age = integer('25');

-- Planner inserts equivalent conversion when types are mixed
select * from users where age = '25';
```

The planner also handles BETWEEN expressions the same way: `value BETWEEN '10' AND '100'` with a numeric `value` will have both bounds cast to the appropriate numeric type at plan time.

### Performance Characteristics

Type-aware comparisons enable optimized execution:

- **No runtime type detection**: Type is known at index/sort creation time
- **Direct comparator calls**: Comparator functions are resolved once and reused
- **Type-specific optimizations**: Each type can implement optimal comparison logic

---

## Collations and Types

### Type-Specific Collations

Collations are associated with specific types:

```typescript
const TEXT_TYPE: LogicalType = {
  name: 'TEXT',
  supportedCollations: ['BINARY', 'NOCASE', 'RTRIM'],
  compare: (a, b, collation) => collation(a as string, b as string),
};

const INTEGER_TYPE: LogicalType = {
  name: 'INTEGER',
  supportedCollations: undefined,  // No collations for numeric types
  compare: (a, b) => compareNumbers(a, b),
};
```

### Collation Validation

Schema creation validates collation compatibility:

```typescript
if (column.collation && column.logicalType.supportedCollations) {
  if (!column.logicalType.supportedCollations.includes(column.collation)) {
    throw new QuereusError(
      `Collation ${column.collation} not supported for type ${column.logicalType.name}`,
      StatusCode.ERROR
    );
  }
}
```

### Comparison collation resolution

A comparison (`=`, `!=`, `<`, `<=`, `>`, `>=`, plus IN, each BETWEEN bound,
each simple-`CASE` WHEN clause, and the declared argument group of a comparison
builtin — `nullif` pairwise, `greatest`/`least` as one N-ary merge)
resolves ONE effective collation from its operands' types via a
**provenance-ranked lattice** (implemented once in
`planner/analysis/comparison-collation.ts`, shared by every plan-time
analysis and runtime emitter so the two cannot drift):

| rank | source (`ScalarType.collationSource`)                  | does BINARY contribute? |
|------|--------------------------------------------------------|-------------------------|
| 3    | `explicit` — a `COLLATE` expression                    | yes (`collate binary` is a real demand) |
| 2    | `declared` — column declared with an explicit `COLLATE`| yes (`c text collate binary` is a real preference) |
| 1    | `default` — defaulted column collation (session `default_collation`, store-module reconcile, engine BINARY default) | **no** — a defaulted BINARY contributes nothing |
| —    | no `collationName` (literals, most expressions)        | n/a |

Resolution of `left <op> right`:

1. The highest rank present among the two contributions wins.
2. If both operands contribute at that rank with **different** names:
   - rank 3 → plan-time error: `conflicting COLLATE clauses in comparison: X vs Y`
   - rank 2 → plan-time error: `ambiguous collation for comparison: column collations X vs Y differ; apply an explicit COLLATE`
   - rank 1 → **BINARY**, silently (defaults are preferences, not declarations)
3. Otherwise the winning contribution's name; no contributions at all → BINARY.

Resolution is **symmetric**: `a = b` and `b = a` always resolve identically
(and error identically). This deliberately diverges from SQLite's
left-operand precedence, in keeping with the engine's explicit-over-implicit
philosophy: a declared `NOCASE` column compared against a plain column is
NOCASE from either side, and genuinely ambiguous declared/explicit pairs are
errors rather than coin flips. Conflicts error even when the operands are
statically non-textual (consistent strictness; only `COLLATE`-wrapped
expressions can reach this case, since non-text columns reject collation
declarations).

Errors surface at the point the comparison compiles: statement prepare for
queries, DML prepare for write-path scopes (CHECK enforcement, FK
parent-existence checks, upsert SET, RETURNING).

**FOREIGN KEY collations are validated at declaration time.** A FK's enforced
comparison is `parent.k = child.fk`; the same lattice that resolves it at DML
prepare also runs at **declaration time** (CREATE TABLE / ALTER … ADD CONSTRAINT
/ ALTER … ADD COLUMN / declarative apply) over the two columns' `ScalarType`s, so
a same-rank conflicting pair is rejected the moment the `REFERENCES` clause is
declared rather than at the first write against the child
(`schema/constraint-builder.ts` `validateForeignKeyCollations`, mirroring the
FK-builder's comparison exactly — never a re-derived name- or textuality-based
rule). It is **unconditional** (not gated on `pragma foreign_keys`): a
contradictory declaration is malformed regardless of whether enforcement is
enabled. The one residual is a **forward-declared parent** (the parent table
does not exist yet when the child is declared): the parent column types are not
yet knowable, so the conflict stays caught at first DML — unchanged. Reload /
`importTable` deliberately does **not** re-validate, so a legacy persisted
conflicting FK reloads without error and still surfaces at DML.

**Provenance is a function of the current catalog column, not its history.**
A column reaches rank 2 (`declared`) two ways, with identical standing: a
CREATE-time explicit `COLLATE` clause, OR `ALTER COLUMN ... SET COLLATE`
(including `SET COLLATE binary` — a real BINARY demand, not the absence of
one). So the same `SET COLLATE NOCASE` resolves identically whether the column
was originally created with or without a `COLLATE` clause; the rank follows the
live column schema (`ColumnSchema.collationExplicit`), never how the column was
first declared.

**Rank-1 `default` provenance is session-transient.** It is not persisted as a
distinct bit: the catalog and persisted DDL are fully explicit (an explicit
`COLLATE` for every non-`BINARY` collation, `BINARY` elided — see docs/sql.md
§ 9.2.4). So a column that got `NOCASE` from session `default_collation`, or a
store-module reconcile default, carries rank 1 in-session but reloads through
the CREATE path as rank 2 (`declared`), because the re-parsed `COLLATE NOCASE`
sets `collationExplicit`. This reload upgrade is **fail-louder only**: a
comparison that previously resolved silently (to BINARY, or to the declared
side) can only become a prepare-time ambiguous-collation error — never silently
different results — so the upgrade needs no catalog/DDL representation change.
A defaulted *BINARY* (and an explicit `SET COLLATE binary`) reloads as rank 1
because `BINARY` is elided from DDL — consistent with a CREATE-time
`c text collate binary` column, which already round-trips to rank 1. This is the
one direction where reopen relaxes rather than tightens: an in-session rank-2
`collate binary` operand can make a comparison an ambiguous-collation error that,
after reopen, resolves silently (the elided BINARY contributes nothing at rank
1). The "fail-louder only" guarantee above covers the rank-1→rank-2 *upgrade* of
a non-BINARY default; the BINARY-elision *downgrade* of an explicit/declared
BINARY is the documented exception, and matches CREATE-time `collate binary`
either way.

Related forms:

- **IN** — `cond IN (e1, …, en)` / `cond IN (subquery)` merges the RHS
  contributions first (a rank-3/2 name conflict among elements is the same
  plan-time error; rank-1 conflicts merge to no contribution; a subquery
  contributes its output column's contribution), then resolves
  condition-vs-RHS through the lattice. The whole membership test runs under
  that ONE collation. Literal-only lists contribute nothing, so the dominant
  case stays condition-driven.
- **BETWEEN** — desugars to two independent comparisons (`expr >= lo`,
  `expr <= hi`); each bound resolves against the tested expression
  separately. Two differently-collated bounds are NOT a conflict with each
  other.
- **Simple `CASE`** — `case x when v1 … when vn` decides each match exactly as
  `x = v1` … `x = vn` would, resolved **per clause** (like BETWEEN's two
  bounds, not like IN's single merged collation). Two differently-collated WHEN
  operands are therefore not a conflict with each other; an explicit `COLLATE`
  on the base *and* a different explicit `COLLATE` on one WHEN operand is the
  same conflict error `=` raises for that pair. The routing between the declared
  type's own `compare`, storage-class comparison and the runtime duration check
  is shared with BETWEEN and `=` (`runtime/emit/operand-comparator.ts`), so a
  `timespan` column matches `case d when 'PT120M'` on elapsed time and a plain
  `text` column holding duration-shaped text stays text-compared. A *searched*
  `CASE` (`case when <predicate>`) does no comparison of its own — its WHEN is an
  ordinary boolean expression that already resolved through the lattice.
- **USING joins** — `using (k)` desugars to the `l.k = r.k` comparison node, so
  it resolves through the lattice by construction, identically to the spelled-out
  form. The pairwise join-key surfaces (merge / bloom / asof) all resolve their
  key collation through the same lattice — the sibling of set operations below.
- **Set operations** (`UNION` / `INTERSECT` / `EXCEPT` / `DIFF`, and `UNION
  ALL`) — each OUTPUT column resolves its dedup/compare collation **symmetrically
  across BOTH inputs'** corresponding column types through the same lattice
  (`resolveSetOpColumnCollation`), rather than inheriting the left input's
  collation alone. The resolved collation is written into the
  `SetOperationNode`'s output column/attribute types, so it governs the dedup /
  membership comparator **and** the output column's `collationName` — i.e. what an
  enclosing `ORDER BY` over the set operation sorts under — in lockstep (one
  resolution site, both readers). The winning *rank* propagates as
  `collationSource`, so a nested set operation re-resolves against the inner
  node's output column **at the correct rank**, and divergence surfaces at every
  level. Conflict handling splits on whether the operator dedups:
    - **DISTINCT operators** (`UNION` / `INTERSECT` / `EXCEPT`; `DIFF` desugars to
      nested `EXCEPT`/`UNION`) DO compare, so a same-rank explicit/declared name
      conflict in any output column is the same prepare-time error a spelled-out
      comparison throws (surfaced when the compound's output scope is built).
    - **`UNION ALL`** does NO dedup, so a conflict is **not** an error — it
      propagates no collation forward (BINARY-equivalent), exactly as `||` / CASE
      swallow conflicts. Rows pass through unchanged.
  Non-textual columns carry no collation, so resolution is a harmless no-op.
  (No sort-merge set-op strategy exists today; if one is ever added it MUST
  derive its key collation from this same resolved output-column collation.)
- **Propagation through non-comparison combiners** (`||` concat, CASE branch
  merge) — the highest-ranked contribution wins and keeps its provenance;
  equal-rank contributions with different names propagate **no** collation
  (the conflict is not an error there — those nodes don't compare — but it
  must not silently coin-flip; a later comparison over the result falls back
  to BINARY).

### Custom Collations for Custom Types

Plugins can define type-specific collations:

```typescript
const PHONENUMBER_TYPE: LogicalType = {
  name: 'PHONENUMBER',
  physicalType: PhysicalType.TEXT,
  supportedCollations: ['AREA_CODE', 'COUNTRY_CODE'],
  compare: (a, b, collation) => {
    // Custom comparison logic based on collation
  },
};
```

---

## Plugin System

### Registering Custom Types

Plugins can register custom logical types. For the full plugin packaging and loading workflow, see the [Plugin System](plugins.md). The examples below show the type registration portion:

```typescript
// Example: UUID type plugin
export default function register(db: Database) {
  return {
    types: [
      {
        type: 'type',
        definition: {
          name: 'UUID',
          physicalType: PhysicalType.TEXT,

          validate: (v) =>
            typeof v === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),

          parse: (v) => {
            if (typeof v === 'string') return v.toLowerCase();
            throw new TypeError('Invalid UUID');
          },

          compare: (a, b) => (a as string).localeCompare(b as string),
        }
      }
    ]
  };
}
```

### Using Custom Types

```sql
-- After loading UUID plugin
create table users (
  id uuid primary key,
  name text not null
);

insert into users values ('550e8400-e29b-41d4-a716-446655440000', 'Alice');
```

---

## Polymorphic Function Type Inference

Moved to [Polymorphic Function Type Inference](types-inference.md#polymorphic-function-type-inference).

---

## Binary operator result types

Moved to [Binary operator result types](types-inference.md#binary-operator-result-types).

---

## Parameter Types

Moved to [Parameter Types](types-parameters.md#parameter-types).

---

## Implementation Files

**Core Type System**:
- `src/types/logical-type.ts` - Core type definitions and interfaces
- `src/types/registry.ts` - Type registry and lookup
- `src/types/builtin-types.ts` - Built-in type definitions (INTEGER, REAL, TEXT, BLOB, BOOLEAN, DATE, TIME, DATETIME, TIMESPAN)
- `src/types/temporal-types.ts` - Temporal type implementations
- `src/types/temporal-ops.ts` - The temporal arithmetic operation table (result type + evaluation for each `(operator, kind, kind)`), read from declared types by `temporalOpCaseForTypes` (`BinaryOpNode.generateType` and `buildNumericOpSpec`) and from runtime values by `tryTemporalArithmetic`
- `src/func/builtins/conversion.ts` - Type conversion functions

**Type Inference**:
- `src/planner/analysis/binary-operator-class.ts` - The binary-operator classification (`classifyBinaryOperator`), read by `BinaryOpNode.generateType`, `buildBinaryOpSpec`, `isComparisonOperator`, `building/expression.ts` and `analysis/scalar-param-usage.ts`
- `src/common/type-inference.ts` - Type inference utilities (`findCommonType`, `promoteNumericTypes`)
- `src/planner/build-function-call.ts` - Planning-time type inference for function calls

---

## Future Enhancements

### Comparison System Optimization

**Goal**: Pre-resolve comparators at index/sort creation time to eliminate runtime type detection.

**Current**: Comparisons use `compareSqlValues()` which performs runtime type detection on every call.

**Proposed**: Pre-create type-specific comparators at index creation time and store them in index metadata.

**Performance Target**: 2-3x speedup for index operations, joins, and sorts.

### JSON Enhancements

**Potential future work**:
- Indexing JSON properties (functional indexes on `json_extract`)
- JSON-specific index types for nested queries
