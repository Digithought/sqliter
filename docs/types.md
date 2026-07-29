# Quereus Type System

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

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
- Values: `number` (safe integers) or `bigint`
- Comparison: Numeric ordering
- Collations: None

**REAL**
- Physical: `PhysicalType.REAL`
- Values: `number` (floating point)
- Comparison: Numeric ordering with NaN handling
- Collations: None

**NUMERIC** (SQLite's NUMERIC affinity — integer if it fits, else real)
- Physical: `PhysicalType.REAL`
- Values: `number` or `bigint` — both halves are accepted by `validate`/`parse`, so a
  NUMERIC column can hold a whole number past 2^53 in exact `bigint` form
- Comparison: numeric ordering with REAL's NaN handling (NaN sorts smallest, NaN = NaN).
  Mixed `number`/`bigint` pairs are ordered by exact mathematical value — NUMERIC has its
  own comparator rather than delegating to REAL's, whose `isNaN` throws on a bigint
- Collations: None

**BOOLEAN**
- Physical: `PhysicalType.BOOLEAN`
- Values: `boolean` (true/false)
- Comparison: false < true
- Collations: None

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
- Ordering: **Semantic** (`semanticOrdering: true`) — ordered by elapsed time, not by duration text: `'PT90M'` sorts before `'PT2H'` although the text sorts the other way. See "Semantic ordering" below.
- Identity: `'PT1H'` and `'PT60M'` are the *same* elapsed time — `=` treats them equal, and DISTINCT / GROUP BY / set operations / hash-join keys collapse them (via the type's `groupKey` hook, which maps compare-equal values to one hash representative). Which textual representative survives is unspecified.
- Collations: None
- Arithmetic: Supports addition/subtraction with DATE, TIME, DATETIME types
- Human-readable parsing: `timespan('1 hour 30 minutes')` → `"PT1H30M"`

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
- Comparison against SQL text: JSON's values are native JS objects, a storage class that never compares equal to a string, so a text operand is converted **at plan time** — `insertCrossTypeCoercion` (`planner/building/expression.ts`) wraps the non-object side of a comparison / BETWEEN bound / IN-list value / simple-`case` WHEN in `cast(… as json)`. `json_col = '{ "a" : 1 }'` therefore matches a row stored as `{"a":1}`, and an unhinted bound parameter (plan-time type TEXT) comes along for free. One surface is **not** covered: `json_col in (select text_col from …)` compares per subquery row rather than against a fixed operand list, so it is still unconditionally false — see `tickets/backlog/bug-json-in-subquery-not-structural`. The gate is `physicalType === OBJECT`, not `semanticOrdering` — the temporal types are physically text and keep their existing runtime path. The cast is lenient: text that is not valid JSON source still compares unequal rather than erroring, so `json_col = 'not json'` is false. It gets there two ways — a bare string is itself a valid JSON *string scalar*, so the JSON type accepts it, the operand survives the cast, and the comparison is unequal; anything the JSON type does not accept at all (a blob, say) casts to NULL instead, which makes the comparison UNKNOWN, so `=` **and** `<>` both match no rows. One consequence for JSON *string scalars*, which are physically plain strings: a column holding `"hello"` matches both `'"hello"'` and the bare `'hello'`.
- Ordering: **Semantic** (`semanticOrdering: true`) — ORDER BY and `<`/`>` on a declared JSON column rank by the structural deep-compare (JSON type rank: null < boolean < number < string < array < object, then element/key-wise recursion — so `{"a":2}` sorts before `{"a":10}`), not by canonical JSON text. Equality is identical under both forms, so identity paths (DISTINCT, GROUP BY, hash keys) need no change. See "Semantic ordering" below.
- Keys: hash keys (GROUP BY / DISTINCT / join partitioning) derive from a **canonical text form** (`canonicalJsonString` — recursive object-key sort, arrays positional) so a value's key always agrees with the comparator: reorder-equal objects group/de-dup/conflict as one, distinct objects never over-merge. Persisted byte keys (a JSON PK / index member in `quereus-store`) instead encode a **structural byte form** (`jsonStructuralKey`, `quereus-store`'s json-key.ts) — same identity, and its memcmp order also reproduces the structural compare, so the store scans JSON keys in `compare` order. Both forms are used **only to derive keys** — never for storage or display. The canonical text form also fingerprints object-valued literals for scalar CSE (`planner/analysis/expression-fingerprint.ts`), so two distinct documents are never folded into one shared computation. The memory module keeps documents as native values and orders its BTree with the same `JSON_TYPE` comparator `<`/`>`/ORDER BY use, so an indexed range seek walks exactly the window the operators evaluate. (The canonical-text form's own order sorts by JSON punctuation and does *not* reproduce the structural compare — it is never used to order a JSON index; identity is all it provides.)
- Collations: None
- Serialization: `serialize()` converts to JSON string for storage; `deserialize()` parses back to native object. Storage and display preserve **insertion order** (only key derivation canonicalizes)
- Conversion: `json(value)` parses a JSON string into a native object; inserting a JSON string into a JSON column auto-parses it
- Functions: All `json_*` functions accept both native objects and JSON strings as input

---

## Semantic ordering

Some logical types define an order that observably differs from the storage-class +
collation order of their stored representation. These declare
`semanticOrdering: true` on the `LogicalType`, and the rule is:

> Wherever a value of a declared logical type is ordered or compared — ORDER BY,
> `<`/`>`/`=` operators, BETWEEN, IN membership, primary-key/index order and range
> scans, DISTINCT / GROUP BY / set-operation identity, window ORDER BY/PARTITION BY,
> merge/hash join keys, UNIQUE constraint enforcement — the type's `compare` function
> is the order. Text/byte order is a storage encoding detail, never a user-visible
> semantic.

Today the flag is set on **TIMESPAN** (elapsed-time order) and **JSON** (structural
order). DATE/TIME/DATETIME need no flag: their canonical ISO text order *is* their
semantic order, so the cheaper storage-class compare is already correct. ANY and
untyped expressions have no semantic-ordering type and keep storage-class +
collation ordering (their declared `compare` is a BINARY fallback that ignores
collation, which is why the flag — not mere presence of `compare` — gates routing).

The flag keys on the **declared** logical type of the column/expression, not the
runtime value: an ANY column holding a duration-shaped string still orders as text.
When only one side of a comparison is declared (e.g. `timespan_col > 'PT90M'` with a
plain text literal), the runtime temporal check in the generic comparison path still
compares durations semantically; the typed fast path engages when *both* sides share
the semantic-ordering type. JSON reaches that shared-type shape a different way — it
has no runtime escape hatch (its values are objects, not text), so the *undeclared*
side is cast to JSON at plan time instead, and the typed path then engages normally.
See the JSON entry above. Probes of a different storage class (an integer literal
against a TIMESPAN column) order by storage class and never falsely compare equal
(`createTypedComparator`'s mismatch fallback).

The comparison builtins follow the rule through a schema declaration: `nullif`,
`greatest` and `least` mark the argument positions they compare as one group
(`BaseFunctionSchema.comparesArgs`), which drives the same plan-time
object-physical coercion `=`/IN/simple CASE apply and an emit-time comparator
bound through the shared collation lattice — so `nullif(d, 'PT120M')` matches
exactly when `d = 'PT120M'` does, and `greatest`/`least` rank a TIMESPAN or
collated-TEXT group the way ORDER BY would. A `greatest`/`least` group whose
operands do not all declare one type (a TIMESPAN column against a bare text
literal) routes through the same generic path a mixed `>` does, so the runtime
duration check still applies. Which raw value `greatest`/`least` return for
values a non-BINARY comparator ties ('PT1H' vs 'PT60M') is unspecified, the same
latitude the min/max aggregate and DISTINCT take.

`greatest`/`least` NULL handling is a separate, pre-existing wrinkle the
comparison work deliberately left alone: `greatest` skips NULLs, but `least` is
order-dependent — a NULL wipes the running minimum, so `least(1, null, 3)` is 3.
Pinned by `test/logic/24-builtin-branches.sqllogic` and tracked as
`tickets/backlog/bug-least-null-handling-order-dependent`.

**Join keys: the mixed-pair rule.** A physical equi-join key (hash / bloom / merge)
compares with no type context, so it can only carry a pair whose two sides agree on
semantic ordering — either neither declares a semantic-ordering type, or both declare
the SAME one. A **mixed** pair, `timespan_col = text_col`, is inadmissible: `=` runs
its generic path's runtime duration check and matches 'PT1H' against 'PT60M', which a
raw-text hash key or merge co-walk does not. The equi-pair extractor
(`planner/rules/join/equi-pair-extractor.ts`) declines such a pair, demoting it to the
join's residual predicate — or, for `using (…)`, sinking the whole extraction to the
generic nested-loop join — so the `=` operator's own semantics decide the match. The
cost is that a rare shape drops to nested-loop; losing rows is worse.

Declining rather than canonicalizing the key is deliberate. Merge join needs both
inputs physically sorted in its comparator's order, and a `timespan` side is sorted by
elapsed time while a `text` side is sorted by text — no single comparator merges those
two orders, so canonicalizing would fix hash join and leave merge join unsound.
Canonicalizing also introduces a false-positive hazard: TIMESPAN's `groupKey` returns a
*number*, so a `timespan` ↔ `integer` pair would hash-match values `=` reports unequal.

`using (k)` is the same equality, so the generic join's USING comparison routes through
`makeOperandComparator` — the one copy of the comparison routing rule `=` uses — and a
mixed USING pair matches exactly what `=` matches. One gap remains: USING skips the
plan-time cross-type coercion `=` gets, so a JSON column joined `using` a TEXT column
still compares OBJECT against TEXT and never matches. Tracked as
`tickets/backlog/bug-using-join-skips-cross-type-coercion`.

`using (k)` also fails a NULL key on either side, matching `=` (`null = null` is
UNKNOWN) and the hash path (which never inserts NULL keys). The nested-loop emitter
needs its own guard for that: the comparators it routes through are *ordering*
functions, and ordering ranks NULL/NULL as equal.

Two surfaces still do **not** follow the rule — one observable, one latent.

**AS OF** match/partition columns compare by storage class + collation. Correct for the canonical AS OF column
types (DATE/DATETIME, whose ISO text order is their semantic order), wrong for a TIMESPAN
or JSON match column. AS OF has no residual to demote into, so the join gate does not
apply. Tracked as `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering`.

**Filter-level equality facts.** `extractEqualityFds`
(`planner/util/fd-utils.ts`) mints the same value-level claims from `where`
equalities — mirror FDs and an EC pair from `col1 = col2`, an `∅ → col` FD plus a
constant binding from `col = literal` — and gates on collation only. Both claims are
false for a semantic-ordering operand: `where d = 'PT60M'` also matches rows storing
`'PT1H'`, so `d` is not pinned to one value. No consumer turns those facts into a
wrong answer today (probed across constant substitution, `distinct`, `group by`,
`order by` transfer, IN/EXISTS and transitive two-conjunct pins), which is why the
gate has not been added: declining every pin on a TIMESPAN/JSON column would cost
real optimizations for no present correctness gain. Tracked as
`tickets/backlog/debt-filter-equality-facts-ignore-semantic-ordering`.

Hash-keyed identity (GROUP BY, window PARTITION BY, hash-join build/probe) cannot
call `compare` pairwise, so a semantic-ordering type whose stored form is not
canonical for equality also supplies `groupKey` — a canonical representative such
that compare-equal values serialize to the same hash key (TIMESPAN maps to total
seconds against the same fixed reference date `compare` uses). JSON needs no
`groupKey`: canonical-text equality and structural equality coincide.

`IN` is an identity test, so it routes through `groupKey` rather than `compare`: when
either side declares a semantic-ordering type, `emitIn` normalizes the probe and every
RHS value before comparing, so `d IN ('PT120M')` matches a `'PT2H'` row exactly as
`d = 'PT120M'` does. Normalizing (instead of dropping `compare` into the membership
BTree's comparator) is what keeps the set structures sound — the normalized keys rank
by plain storage-class order, which stays total even when a list literal is not a valid
value of the type, whereas `TIMESPAN.compare` mixes elapsed-time and text ordering
there and is not.

UNIQUE enforcement collapses the same identity on **every** backend. A constrained
column whose declared type carries semantic ordering is compared through that type's
`compare`; every other column keeps the storage-class + collation comparison (a
TEXT/ANY column's declared `compare` is not collation-aware, so consulting it would
break NOCASE/RTRIM enforcement — the `hasSemanticOrdering` flag is the gate). The
per-column comparators are built once per constraint check by the shared
`uniqueEnforcementComparators` (`schema/unique-enforcement.ts`), which the memory
backend's three re-validators, the persistent store's finders, the isolation
overlay's merged-view search, and the covering materialized view's shared candidate
generator (`lookupCoveringConflicts` — see [mv-constraints.md](mv-constraints.md))
all call, so the backends cannot drift. Concretely, in a
`d timespan unique` column an insert of `'PT60M'` after `'PT1H'` raises a UNIQUE
violation, `insert or ignore` drops it, and `insert or replace` evicts the existing
row — the same on memory and store.

`insert … on conflict (<cols>) do update / do nothing` routes on that same identity.
The virtual table reports the conflicting row but not which constraint fired, so the
DML executor decides which `on conflict` clause a violation belongs to by comparing
the proposed and existing rows at the clause's target columns — through comparators
built by the same `uniqueEnforcementComparators` (per-column enforcement collations
resolved at plan time by `resolveConflictTargetEnforcement` in
`planner/building/insert.ts`, comparators built once at emit in
`runtime/emit/dml-executor.ts`). So `on conflict (d) do update` fires for a re-spelled
TIMESPAN duration rather than aborting with a UNIQUE error, while a NOCASE/RTRIM
column keeps routing by its collation. One residual corner is unfixable by value
comparison and stays out of scope: an insert violating the targeted constraint *and*
another one at once is suppressed by the matching clause, because the vtab
short-circuits on the first violation and never reports the second.

The persistent store follows the same rule for both identity and order (resolved by
`quereus-store`'s `storeSemanticKeyTransform`): a TIMESPAN key member is encoded
through `groupKey`, so `'PT1H'` and `'PT60M'` collide on one physical key — duplicate
spellings raise the ordinary PK/UNIQUE violation, `on conflict` actions fire, and the
isolation overlay shadows across spellings; a JSON key member is encoded in a
store-local **structural byte form** (`jsonStructuralKey`, `quereus-store`'s
json-key.ts) whose memcmp order reproduces the structural compare — so a store scan
emits JSON keys in `compare` order, agreeing with the memory backend, and the
isolation overlay aligns its merge streams (an in-transaction update or delete of a
JSON-keyed row shadows correctly). Store *ordering* advertisements and byte-window
seeks over semantic-ordering members remain declined (a real Sort runs and
point/range predicates re-check through the type-aware residual); with both types'
key bytes now order-faithful the declines are merely conservative — re-opening them
is tracked in backlog `feat-reopen-timespan-store-seeks`.

The `min`/`max` **aggregates** follow the same rule: at emit (and materialized-view
plan-build) time the call site binds the aggregate to its argument's declared type
and resolved collation (`AggregateFunctionSchema.bindArgs`, applied via
`bindAggregateSchema`), replacing step/merge/decode/finalize with closures over the
argument's semantic comparator. So `min(timespan_col)` returns the shortest
duration, `min(json_col)` the structurally-least document, and `min` over a
`collate nocase` column the NOCASE-least value — each agreeing with
`order by … limit 1` — and store-maintained materialized-view min/max columns
(delta merge and read-side rollup both execute the bound algebra) agree with
direct evaluation. Untyped/ANY arguments with no declared collation keep the
storage-class + BINARY behavior. Under a semantic tie with byte-different
spellings (`'PT1H'` vs `'PT60M'`), which raw value survives is unspecified — the
same latitude DISTINCT and GROUP BY take for a group representative.

An aggregate's *result* type carries its argument's logical type but **not** the
argument's collation, so a materialized view over `min(nocase_col)` has a
BINARY-declared backing column. Anything that re-ranks stored partials must
therefore take the collation from the argument, not from the backing column — the
read-side rollup does so via the collation the rewrite matcher records alongside
each stored partial (`MergeReagg.argCollation`).

**Window** `min(x) over (…)` / `max(x) over (…)` follow the same rule through the
same seam. Window functions live in their own registry
(`schema/window-function.ts`), so it carries its own `bindArgs` hook — taking the
same `AggregateArgBinding` and routing through the same
`createSemanticValueComparator` — applied by `bindWindowSchema` where
`runtime/emit/window.ts` resolves each call site's schema. The window emitter has
three execution shapes (the buffered frame walk, the streaming running
accumulator, and the streaming sliding-frame scan) and all three fold through
that one bound schema, so they cannot rank differently for the same query.

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

Conversion cannot simply be re-run at each layer, because it is not repeatable
for every type:

> **`JSON_TYPE.parse` is not idempotent for a string scalar.** `parse('"Bob"')`
> returns the bare string `Bob`, and `parse('Bob')` then throws
> `Cannot convert 'Bob' to JSON: invalid JSON syntax` — while re-parsing the
> stored text `9` silently *changes* it into the number 9. A converted value is
> indistinguishable at runtime from unparsed JSON source, so "convert again just
> in case" is not safe.

What decides whether a cell converts is therefore the **static type of the
expression that produced it**, which the planner already knows. The rule
(`buildRowCoercion` in `types/validation.ts`): convert cell *i* iff the
producing expression's `LogicalType` is not — by object identity — the target
column's type. A SQL literal `'"abc"'` is TEXT → into a JSON column, convert; a
reference to a JSON column is JSON → already declared form, leave alone.
Concretely:

- `emitInsert` masks each cell by the source relation's attribute type at that
  position (the source is projected into full table-column order, so the two
  align). `insert into b select j from a` copies JSON values untouched; a
  VALUES literal still converts.
- `emitUpdate` masks an assigned column by its assignment expression's type and
  an unassigned column by the source attribute's type — for the ordinary
  target-table scan that is the declared type itself, so the carried-over
  stored values are never re-converted. `update t set v = 'X'` leaves a JSON
  key column byte-identical.
- Two paths inject a value *after* that pass and convert their one cell by the
  same rule: the `OR REPLACE` NOT NULL DEFAULT substitution
  (`constraint-check.ts`) and `ON CONFLICT … DO UPDATE` assignments (the DML
  executor).

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

**ALTER backfills follow the same rule.** `alter table … add column … default <x>`
and `alter column … set not null` write existing rows outside the DML pipeline, so
they convert explicitly:

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
  its result converts only when the default expression's static type is not already
  the new column's type — the same object-identity check `buildRowCoercion` makes,
  for the same reason (`add column k json default (new.j)` over an existing JSON
  column must copy, not re-parse). The conversion runs before the per-row CHECK
  predicates, matching `emitInsert`.

Because every `JSON_TYPE.compare` caller is guaranteed to hold parsed values, a
JS string reaching `compare` is unambiguously a JSON **string scalar** and is
never re-parsed: `compare('9', 9)` ranks the number first (number < string)
instead of calling them equal.

The rule is only as sound as the static types it reads, so an expression node
that advertises a logical type it does not actually produce becomes a write-path
defect. Known cases:

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
   pairs) → `NUMERIC`, whatever the pair. Deliberately *not* CASE's "arms differ
   ⇒ TEXT": `1 union all 2.5` stays numeric. Also deliberately *not* the
   `INTEGER + REAL → REAL` promotion arithmetic (`BinaryOpNode.generateType`) and
   polymorphic builtins (`findCommonType`) use — because unlike rule 4, rule 3
   converts **neither branch**. Arithmetic yields one value in one form, which
   `REAL` describes exactly; a set operation yields a *stream mixing both* forms
   (`number` from the REAL arm, `bigint` from the INTEGER arm), and only
   `NUMERIC` — whose value space is `number | bigint` — describes that. Claiming
   `REAL` was a lie the DML skip rule believed: a bigint rode it unconverted into
   a `real`-declared column, and a `real`-declared key then threw out of
   `REAL_TYPE.compare`. Because no branch is converted, the read side is
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

`CAST` is the settled case, and states the rule the others must meet: it stays
lenient — it never throws — but it never produces a value outside the type it
advertises either. When the target type's `parse` throws, `castFallback`
(`types/cast-semantics.ts`) applies SQLite's numeric/text/blob fallbacks (`0`,
`0.0`, `String(v)`, UTF-8 bytes — each a valid member of its own type); for
every other target it keeps the operand only when the target type's own
`validate` accepts it, and yields NULL otherwise. `parse` reads its input as
source *text*, so `validate` is the right question to ask: a bare string is a
legitimate JSON string scalar that `JSON_TYPE.parse` nonetheless rejects.

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
- **USING joins** — each same-named column pair resolves through the lattice,
  so `using (k)` agrees with the spelled-out `l.k = r.k`. The four pairwise
  join-key surfaces (USING comparator, merge / bloom / asof) all resolve their
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
  validateArgTypes: (argTypes) => argTypes[0].isNumeric
}, absImpl);
```

### Built-in Polymorphic Functions

The following built-in functions use type inference:

- **Numeric functions**: `abs()`, `round()`, `nullif()`, `sqrt()`, `floor()`, `ceil()`, `ceiling()`, `clamp()`
- **Common type resolution**: `coalesce()`, `iif()`, `greatest()`, `least()`, `choose()`
- **String functions**: `length()`, `upper()`, `lower()`, `trim()`, `ltrim()`, `rtrim()`, `substr()`, `substring()`, `replace()`, `reverse()`, `lpad()`, `rpad()`, `instr()`
- **Aggregate functions**: `MIN()`, `MAX()`
- **Arithmetic operators**: `+`, `-`, `*`, `/`, `%` with numeric type promotion (INTEGER + INTEGER → INTEGER, INTEGER + REAL → REAL, etc.)

### Type Promotion Rules

Arithmetic operators follow these type promotion rules:

- `INTEGER op INTEGER` → `INTEGER`
- `INTEGER op REAL` → `REAL`
- `REAL op INTEGER` → `REAL`
- `REAL op REAL` → `REAL`

---

## Parameter Types

### Overview

Parameters in Quereus have strong types that are established at prepare time and validated on each execution. This provides type safety while maintaining a user-friendly API for JavaScript developers.

### Two Ways to Specify Parameter Types

Quereus offers two approaches for specifying parameter types:

1. **Type Inference from Values** - Pass initial parameter values to `prepare()` and types are inferred
2. **Explicit Type Hints** - Pass a Map of explicit type hints to `prepare()`

### Type Inference Rules

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

### Type Resolution and Validation

Parameter types are established during the **planning phase** and validated on each execution:

1. **At prepare time**: Types are inferred from initial values or set via explicit parameter types
2. **At execution time**: Parameter values are validated against the established types
3. **No recompilation**: Prepared statements are NOT recompiled when parameter values change (only when types would change)
4. **Type safety**: Attempting to execute with incompatible types throws an error

### Examples

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

### Type Checking and Validation

Parameter type validation ensures type safety across executions:

- **Physical type validation**: Validates that JavaScript values are compatible with the **physical type** of the declared logical type
- **Type preservation**: Once established, parameter types are preserved across all executions of a prepared statement
- **Validation on execution**: Each execution validates that parameter values match the established physical types
- **NULL compatibility**: NULL values are compatible with any nullable parameter type
- **Flexible logical types**: Different logical types with the same physical type are compatible (e.g., `number` and `bigint` both work for INTEGER physical type)
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

### Performance Benefits

The parameter type system provides significant performance benefits:

1. **No recompilation**: Prepared statements are compiled once and reused, avoiding expensive recompilation
2. **Early validation**: Type errors are caught before execution begins
3. **Optimized plans**: The query planner can optimize based on known parameter types
4. **Future optimizations**: The system is designed to support automatic recompilation for significant optimizations (e.g., when NULL constants enable better plans)

### Implementation Details

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

---

## Implementation Files

**Core Type System**:
- `src/types/logical-type.ts` - Core type definitions and interfaces
- `src/types/registry.ts` - Type registry and lookup
- `src/types/builtin-types.ts` - Built-in type definitions (INTEGER, REAL, TEXT, BLOB, BOOLEAN, DATE, TIME, DATETIME, TIMESPAN)
- `src/types/temporal-types.ts` - Temporal type implementations
- `src/func/builtins/conversion.ts` - Type conversion functions

**Type Inference**:
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
