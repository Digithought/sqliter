# Built-in Functions Reference

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

This document lists the built-in SQL functions available in Quereus. For the underlying type system, validation rules, and custom type registration, see the [Type System Documentation](types.md).

---

## Type Conversion Functions

Quereus uses conversion functions instead of the SQL `CAST` operator for explicit type conversions. Each validates and converts to the target type, returning `NULL` on `NULL` input or throwing on invalid conversion.

| Function | Returns | Description |
|---|---|---|
| `integer(X)` | INTEGER | Truncates reals, parses strings, booleans to 0/1 |
| `real(X)` | REAL | Parses strings, integers to float, booleans to 0.0/1.0 |
| `text(X)` | TEXT | The one value-to-text conversion (see [types.md § Value to text](types.md#value-to-text)): numbers stringified, booleans to `'true'`/`'false'`, blobs UTF-8-decoded, JSON documents to their own text. Never throws |
| `blob(X)` | BLOB | A string becomes its literal UTF-8 bytes — no hex sniffing. Use `unhex(X)` for a hex string. Throws on a JSON document; `cast(X as blob)` stays lenient there and yields the document's own text as bytes |
| `boolean(X)` | BOOLEAN | 0/`'false'` is false; non-zero/`'true'` is true |
| `date(X)` | TEXT | `YYYY-MM-DD` format. Accepts `'now'` for current UTC date |
| `time(X)` | TEXT | `HH:MM:SS` format. Accepts `'now'` for current UTC time |
| `datetime(X)` | TEXT | ISO 8601 datetime. Accepts `'now'` for current UTC timestamp |
| `timespan(X)` | TEXT | ISO 8601 duration. Accepts ISO (`'PT1H30M'`) or human-readable (`'1 hour 30 minutes'`) |
| `json(X)` | JSON | Parses JSON string into native object. Passes through native objects unchanged |

```sql
select integer('42');        -- 42
select real(42);             -- 42.0
select text(true);           -- 'true'
select blob('ab');           -- x'6162' (literal UTF-8 bytes, not hex-decoded)
select boolean(0);           -- false
select date('now');           -- '2024-01-15'
select timespan('2 hours');  -- 'PT2H'
select json('{"x":1}');      -- {"x":1}  (native object)
```

---

## Scalar Functions

### Math Functions

| Function | Args | Returns | Description |
|---|---|---|---|
| `abs(X)` | 1 | numeric | Absolute value. Preserves input type (INTEGER/REAL/BIGINT) |
| `round(X)` | 1 | numeric | Round to nearest integer |
| `round(X, Y)` | 2 | numeric | Round X to Y decimal places |
| `sqrt(X)` | 1 | REAL | Square root. `NULL` if negative |
| `pow(X, Y)` | 2 | REAL | X raised to power Y |
| `power(X, Y)` | 2 | REAL | Alias for `pow` |
| `floor(X)` | 1 | numeric | Largest integer not greater than X |
| `ceil(X)` | 1 | numeric | Smallest integer not less than X |
| `ceiling(X)` | 1 | numeric | Alias for `ceil` |
| `clamp(X, min, max)` | 3 | numeric | Constrain X to range [min, max] |
| `random()` | 0 | BIGINT | Pseudo-random integer in safe JS integer range. Non-deterministic |
| `randomblob(N)` | 1 | BLOB | N pseudo-random bytes (capped at 1 MB). Non-deterministic |

```sql
select abs(-5);           -- 5
select round(123.456, 2); -- 123.46
select sqrt(16);          -- 4.0
select pow(2, 3);         -- 8.0
select floor(4.8);        -- 4
select ceil(-4.8);        -- -4
select clamp(15, 0, 10);  -- 10
```

### Conditional and Type Functions

| Function | Args | Returns | Description |
|---|---|---|---|
| `coalesce(X, Y, ...)` | variadic | any | First non-NULL argument |
| `nullif(X, Y)` | 2 | any | `NULL` if X = Y, else X |
| `iif(X, Y, Z)` | 3 | any | If X is truthy then Y, else Z |
| `typeof(X)` | 1 | TEXT | Type name: `'null'`, `'integer'`, `'real'`, `'text'`, `'blob'`, `'json'` |
| `greatest(X, Y, ...)` | variadic | any | Largest value using SQL comparison; NULLs are skipped |
| `least(X, Y, ...)` | variadic | any | Smallest value using SQL comparison; NULLs are skipped |
| `choose(N, V1, V2, ...)` | variadic | any | Returns the N-th value (1-based index). `NULL` if out of range |

```sql
select coalesce(null, 5, 'hello'); -- 5
select nullif(10, 10);             -- NULL
select iif(1 > 0, 'yes', 'no');   -- 'yes'
select typeof(10.5);               -- 'real'
select greatest(3, 1, 2);          -- 3
select least(3, 1, 2);             -- 1
select choose(2, 'a', 'b', 'c');   -- 'b'
```

`nullif`, `greatest` and `least` compare exactly as the `=` operator and `order by`
do — honoring a column's declared collation, semantic-ordering types like TIMESPAN,
JSON documents, and the numeric reading of a numeric-looking string (`nullif(int_col,
'1')` matches, as `int_col = '1'` does) — rather than raw bytes. See
[types.md](types.md#comparison-collation-resolution).

The reconciliation applies to the *comparison* only. All three return one of their
arguments verbatim, so a converted copy is what gets compared and the original
argument is what comes back — `nullif('3', 1)` returns the text `'3'`,
`greatest(int_col, '2')` returns the text `'2'` when the literal wins, and
`least('abc', 1)` returns `'abc'` (the comparison reads `'abc'` as `0`, which loses
to `1`, but `0` is never a result). Storage class survives too:
`typeof(nullif('3', 1))` is `text`.

---

## String Functions

| Function | Args | Returns | Description |
|---|---|---|---|
| `lower(X)` | 1 | TEXT | Lowercase. `NULL` if not a string |
| `upper(X)` | 1 | TEXT | Uppercase. `NULL` if not a string |
| `length(X)` | 1 | INTEGER | Character count (TEXT) or byte count (BLOB) |
| `substr(X, Y, Z?)` | 2-3 | TEXT | Substring starting at position Y (1-based), Z chars long |
| `substring(X, Y, Z?)` | 2-3 | TEXT | Alias for `substr` |
| `trim(X, Y?)` | 1-2 | TEXT | Remove leading+trailing chars (default: whitespace) |
| `ltrim(X, Y?)` | 1-2 | TEXT | Remove leading chars |
| `rtrim(X, Y?)` | 1-2 | TEXT | Remove trailing chars |
| `replace(X, Y, Z)` | 3 | TEXT | Replace all occurrences of Y in X with Z. Case-sensitive |
| `instr(X, Y)` | 2 | INTEGER | 1-based position of first occurrence of Y in X. 0 if not found. `NULL` if either input is `NULL` |
| `reverse(X)` | 1 | TEXT | Reverse the string. Unicode-aware |
| `lpad(X, N, P)` | 3 | TEXT | Left-pad X to length N using pad string P |
| `rpad(X, N, P)` | 3 | TEXT | Right-pad X to length N using pad string P |
| `like(pattern, string)` | 2 | BOOLEAN | LIKE match: `%` = any chars, `_` = one char. Case-sensitive. `NULL` if either argument is `NULL`. A non-text operand is rendered through the one value-to-text conversion first (see [types.md § Value to text](types.md#value-to-text)) |
| `glob(pattern, string)` | 2 | BOOLEAN | GLOB match: `*` = any chars, `?` = one char. Case-sensitive. `NULL` if either argument is `NULL`. Operands render the same way `like` renders them |
| `hex(X)` | 1 | TEXT | Uppercase hex spelling of X's bytes, no separator. A non-blob argument converts to bytes first, the same path `cast(X as blob)` takes |
| `unhex(X)` | 1 | BLOB | Parses a hex string into bytes. `NULL` (not an error) if X is not a whole number of hex digit pairs |

`hex`/`unhex` are on the one *blob* conversion (`hex` converts a non-blob argument through
the same path `cast(X as blob)` takes; see [types.md § Binary types](types.md#binary-types)), so they are
not part of the divergence below.

The rest of the table above is **not** yet on the one value-to-text conversion. Given a
non-text argument, `substr`/`substring`, `trim`/`ltrim`/`rtrim`, `replace` and `instr`
still use JavaScript's own stringification (a BLOB becomes its comma-joined byte numbers,
`97,98`), while `lower`, `upper`, `reverse`, `lpad` and `rpad` return `NULL` instead. Pass
`text(X)` explicitly if the argument may not be text. Tracked as
`debt-string-builtins-coerce-three-different-ways`.

```sql
select lower('Quereus');             -- 'quereus'
select substr('Quereus', 4, 2);     -- 're'
select substr('Quereus', -4);       -- 'reus'
select trim('  abc  ');             -- 'abc'
select ltrim('123abc123', '0123456789'); -- 'abc123'
select replace('abc abc', 'b', 'X'); -- 'aXc aXc'
select instr('banana', 'a');         -- 2
select reverse('hello');             -- 'olleh'
select lpad('42', 5, '0');          -- '00042'
select hex(x'cafe');                -- 'CAFE'
select unhex('cafe');               -- x'cafe'
```

### String Table-Valued Function

**`split_string(str, delimiter)`** -- Splits a string into rows.

| Column | Type | Description |
|---|---|---|
| `value` | TEXT | The split segment |
| `ordinal` | INTEGER | 0-based index |

```sql
select value from split_string('a,b,c', ',');
-- 'a', 'b', 'c'
```

### String Aggregate

**`string_concat(X)`** -- Concatenates all non-NULL string values with commas.

```sql
select string_concat(name) from users;
-- 'Alice,Bob,Charlie'
```

---

## Aggregate Functions

Aggregate functions compute a single result from multiple rows within a `GROUP BY` group (or the entire result set).

| Function | Args | Returns | Description |
|---|---|---|---|
| `count(*)` | 0 | INTEGER | Total row count (including NULLs) |
| `count(X)` | 1 | INTEGER | Count of non-NULL values |
| `sum(X)` | 1 | INTEGER/BIGINT/REAL | Sum. `NULL` for empty set |
| `total(X)` | 1 | REAL | Sum, always REAL. `0.0` for empty set |
| `avg(X)` | 1 | REAL | Average. `NULL` for empty set |
| `min(X)` | 1 | any | Minimum non-NULL value |
| `max(X)` | 1 | any | Maximum non-NULL value |
| `group_concat(X, Y?)` | 1-2 | TEXT | Concatenate values, separated by Y (default `','`). Skips NULLs. Non-text values render through the one value-to-text conversion (see [types.md § Value to text](types.md#value-to-text)) — a BLOB is UTF-8-decoded, a JSON document keeps its own text |
| `var_pop(X)` | 1 | REAL | Population variance. `NULL` if fewer than 1 value |
| `var_pop(X)` | 1 | REAL | Population variance. `NULL` for empty set |
| `var_samp(X)` | 1 | REAL | Sample variance. `NULL` if fewer than 2 values |
| `stddev_samp(X)` | 1 | REAL | Sample standard deviation |
| `json_group_array(X)` | 1 | JSON | Native JSON array of all values (including NULLs as JSON `null`) |
| `json_group_object(N, V)` | 2 | JSON | Native JSON object from key/value pairs. Skips NULL keys |

```sql
select count(*), sum(salary), avg(salary) from employees;
select group_concat(name, '; ') from users;
select json_group_array(score) from results;
-- [95,80,null,95]  (native array)
select json_group_object(key, value) from config;
-- {"theme":"dark","fontSize":12}  (native object)
```

**Difference from SQLite:** `sum()` promotes to BIGINT to avoid overflow. It accumulates exact integers and floating-point values in *separate* running totals and combines them only at the end, so the answer does not depend on the order rows were scanned. A fold that saw only `bigint`s and safe integers returns an exact integer; a fold that saw anything else — a fraction, a whole `number` past 9,007,199,254,740,991, or a non-finite — returns REAL. A REAL total that overflows returns `Infinity` (agreeing with `total()` and `avg()`), unlike binary `+`, which returns `NULL` on a non-finite result.

---

## Window Functions

All aggregate functions above can be used as window functions with an `OVER` clause. Quereus also provides dedicated ranking functions.

**Syntax:**
```sql
function([args]) over (
  [partition by expr [, ...]]
  [order by expr [asc | desc] [, ...]]
)
```

### Ranking Functions

| Function | Returns | Description |
|---|---|---|
| `row_number()` | INTEGER | Sequential number within partition |
| `rank()` | INTEGER | Rank with gaps on ties (1, 1, 3, 4) |
| `dense_rank()` | INTEGER | Rank without gaps (1, 1, 2, 3) |
| `ntile(N)` | INTEGER | Distribute rows into N buckets |

```sql
select
  name,
  department,
  salary,
  row_number() over (partition by department order by salary desc) as dept_rank,
  rank() over (order by salary desc) as overall_rank
from employees;
```

### Aggregate Window Examples

```sql
select
  name,
  salary,
  sum(salary) over (partition by department order by hire_date) as running_total,
  avg(salary) over (partition by department) as dept_avg,
  count(*) over (partition by department) as dept_size
from employees;
```

---

## Date/Time Functions

These functions manipulate date and time values using the `Temporal` polyfill. The single-argument forms documented in [Type Conversion Functions](#type-conversion-functions) handle simple conversions; the multi-argument forms below apply date arithmetic via modifiers.

See [datetime.md](datetime.md) for supported timestring formats and modifier syntax.

### Core Functions

| Function | Returns | Description |
|---|---|---|
| `date(timestring, modifier, ...)` | TEXT | Date as `YYYY-MM-DD` after applying modifiers |
| `time(timestring, modifier, ...)` | TEXT | Time as `HH:MM:SS` after applying modifiers |
| `datetime(timestring, modifier, ...)` | TEXT | Datetime as `YYYY-MM-DD HH:MM:SS` after applying modifiers |
| `julianday(timestring, modifier, ...)` | REAL | Julian day number |
| `strftime(format, timestring, modifier, ...)` | TEXT | Formatted datetime (supports `%E` epoch_s, `%Q` epoch_ms) |

```sql
select date('2024-01-15', '+7 days');     -- '2024-01-22'
select time('14:30:15', '+15 minutes');    -- '14:45:15'
select datetime('now', '-1 hour');         -- current time minus 1 hour
select strftime('%Y-%m-%d %H:%M', 'now');
```

**Modifiers:** `'+N days'`, `'-N hours'`, `'start of month'`, `'start of year'`, `'start of day'`, `'weekday N'`, `'unixepoch'`, `'localtime'`, `'utc'`, `'subsec'`.

The **`subsec`** modifier includes milliseconds in `datetime()` and `time()` output:

```sql
select datetime('2024-07-26 12:30:45.123', 'subsec');
-- '2024-07-26 12:30:45.123'
```

### Epoch Functions

Strict parsing -- only ISO 8601 strings and `'now'` accepted; bare numbers rejected. Output is always UTC-relative.

| Function | Returns | Description |
|---|---|---|
| `epoch_s(timestring, modifier, ...)` | INTEGER | Unix epoch seconds |
| `epoch_ms(timestring, modifier, ...)` | INTEGER | Unix epoch milliseconds |
| `epoch_s_frac(timestring, modifier, ...)` | REAL | Unix epoch seconds with fractional precision |

```sql
select epoch_s('2024-01-01 00:00:00');       -- 1704067200
select epoch_ms('2024-07-26 12:30:45.123');  -- 1721997045123
select epoch_s_frac('2024-07-26 12:30:45.5');-- 1721997045.5
```

### Validation Functions

| Function | Returns | Description |
|---|---|---|
| `IsISODate(text)` | BOOLEAN | `true` if valid `YYYY-MM-DD` (leap-year aware), `false` otherwise. Never `NULL` |
| `IsISODateTime(text)` | BOOLEAN | `true` if valid ISO 8601 datetime with `T` separator, `false` otherwise. Never `NULL` |

```sql
select IsISODate('2024-02-29');         -- true (leap year)
select IsISODate('2023-02-29');         -- false
select IsISODateTime('2024-01-01T00:00:00Z'); -- true
select IsISODateTime('2024-01-01 00:00:00');  -- false (space not allowed)
```

---

## Timespan Functions

Extract components or convert TIMESPAN values to different units. All accept an ISO 8601 duration string.

### Component Extraction

| Function | Returns | Description |
|---|---|---|
| `timespan_years(ts)` | INTEGER | Years component |
| `timespan_months(ts)` | INTEGER | Months component |
| `timespan_weeks(ts)` | INTEGER | Weeks component |
| `timespan_days(ts)` | INTEGER | Days component |
| `timespan_hours(ts)` | INTEGER | Hours component |
| `timespan_minutes(ts)` | INTEGER | Minutes component |
| `timespan_seconds(ts)` | REAL | Seconds component (includes fractional) |

```sql
select timespan_years(timespan('1 year 2 months'));   -- 1
select timespan_months(timespan('1 year 2 months'));  -- 2
select timespan_seconds(timespan('1 minute 30.5 seconds')); -- 30.5
```

### Total Conversion

Convert entire timespan to a single unit (uses a reference date for calendar units).

| Function | Returns | Description |
|---|---|---|
| `timespan_total_seconds(ts)` | REAL | Total duration in seconds |
| `timespan_total_minutes(ts)` | REAL | Total duration in minutes |
| `timespan_total_hours(ts)` | REAL | Total duration in hours |
| `timespan_total_days(ts)` | REAL | Total duration in days |

```sql
select timespan_total_seconds(timespan('1 hour'));       -- 3600
select timespan_total_minutes(timespan('1 hour 30 minutes')); -- 90
select timespan_total_days(timespan('1 week'));           -- 7
```

---

## JSON Functions

JSON values are stored natively as JS objects/arrays in memory (`PhysicalType.OBJECT`). All `json_*` functions accept both native JSON objects and JSON strings as input. Functions that produce JSON results return native objects (not JSON strings).

JSON paths use `$` as root, `.key` for object members, and `[N]` for array indices (e.g., `$.phones[0].type`). Invalid JSON input typically returns `NULL`.

### Inspection

| Function | Args | Returns | Description |
|---|---|---|---|
| `json_valid(json)` | 1 | BOOLEAN | `true` if well-formed JSON, `false` otherwise. Never `NULL` |
| `json_type(json, path?)` | 1-2 | TEXT | JSON type: `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'`, `'object'` |
| `json_extract(json, path, ...)` | variadic | any | Extract value at first matching path. Nested arrays/objects returned as native JSON |
| `json_array_length(json, path?)` | 1-2 | INTEGER | Length of JSON array (0 if not an array) |

The `->` and `->>` operators are syntactic sugar for `json_extract()`:
- `expr -> path` desugars to `json_extract(expr, path)` (returns JSON)
- `expr ->> path` desugars to `cast(json_extract(expr, path) as text)` (returns TEXT)

Path shorthand: `'name'` becomes `'$.name'`, `0` becomes `'$[0]'`.

```sql
select json_valid('{"a":1}');           -- true
select json_type('{"a":1}', '$.a');     -- 'integer'
select json_extract('{"a":[1,2]}', '$.a[1]'); -- 2
select json_array_length('[1,2,3]');    -- 3
select '{"a":1}' -> 'a';               -- 1 (same as json_extract(..., '$.a'))
select '{"a":"hello"}' ->> 'a';        -- 'hello' (as TEXT)
```

### Construction

| Function | Args | Returns | Description |
|---|---|---|---|
| `json_quote(value)` | 1 | TEXT | SQL value as JSON literal (`NULL` becomes `'null'`, TEXT becomes quoted string) |
| `json_array(V1, V2, ...)` | variadic | JSON | Build a JSON array from SQL values (returns native array) |
| `json_object(N1, V1, ...)` | variadic | JSON | Build a JSON object from key/value pairs (returns native object) |

```sql
select json_quote('hello');              -- '"hello"'
select json_array(1, 'two', null);       -- '[1,"two",null]'
select json_object('name', 'Alice', 'age', 30); -- '{"name":"Alice","age":30}'
```

### Mutation

All mutation functions operate on a copy and return the modified native JSON object.

| Function | Behavior |
|---|---|
| `json_insert(json, path, value, ...)` | Insert only where path **does not exist** |
| `json_replace(json, path, value, ...)` | Replace only where path **already exists** |
| `json_set(json, path, value, ...)` | Insert or replace (creates intermediate nodes, pads arrays with `null`) |
| `json_remove(json, path, ...)` | Remove elements at paths. Non-existent paths ignored |

```sql
select json_insert('{"a":1}', '$.b', 2);        -- '{"a":1,"b":2}'
select json_insert('{"a":1}', '$.a', 99);        -- '{"a":1}' (no overwrite)
select json_replace('{"a":1,"b":2}', '$.a', 10); -- '{"a":10,"b":2}'
select json_set('{"a":1}', '$.a', 10, '$.b', 20);-- '{"a":10,"b":20}'
select json_set('[1]', '$[2]', 3);                -- '[1,null,3]'
select json_remove('{"a":1,"b":2}', '$.b');       -- '{"a":1}'
```

### JSON Patch (RFC 6902)

**`json_patch(json, patch)`** -- Applies a JSON Patch operation array to the document.

```sql
select json_patch('{"a":1}', '[{"op":"add","path":"/b","value":2}]');
-- '{"a":1,"b":2}'
```

### Schema Validation

**`json_schema(json, schema_definition)`** -- Validates JSON against a TypeScript-like structural schema (powered by [moat-maker](https://github.com/theScottyJam/moat-maker)). Returns BOOLEAN: `true` if valid, `false` otherwise (never `NULL`).

**Schema syntax:**
- Base types: `number`, `string`, `boolean`, `null`, `any`
- Arrays: `type[]` e.g. `number[]`
- Objects: `{ prop: type }` e.g. `{ x: number, y?: string }`
- Unions: `type1 | type2`
- Tuples: `[type1, type2]`
- Nested: `{ x: number }[]`

When the schema argument is a constant (e.g., in CHECK constraints), the validator is compiled once and cached with the query plan.

```sql
select json_schema('[1, 2, 3]', 'number[]');  -- true
select json_schema('{"x":42}', '{ x: number }'); -- true
select json_schema('[1,"mixed"]', 'number[]');    -- false

create table events (
  id integer primary key,
  data json check (json_schema(data, '{ x: number, y: number }[]'))
);
```

### JSON Table-Valued Functions

**`json_each(json, path?)`** -- Returns one row per element of the JSON array/object at the given path (or root).

**`json_tree(json, path?)`** -- Like `json_each`, but recursively walks the tree (parent before children).

Both return the same columns:

| Column | Type | Description |
|---|---|---|
| `key` | TEXT? | Array index or property name |
| `value` | TEXT? | JSON value as text |
| `type` | TEXT | `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'`, `'object'` |
| `atom` | TEXT? | Scalar value; `NULL` for arrays/objects |
| `id` | INTEGER | Unique element ID |
| `parent` | INTEGER? | Parent element ID |
| `fullkey` | TEXT | Full JSON path to this element |
| `path` | TEXT | JSON path to parent |

```sql
select key, value from json_each('[10, 20, 30]');
select fullkey, type from json_tree('{"a": [1, 2]}');
```

---

## Schema Introspection (TVFs)

| Function | Args | Description |
|---|---|---|
| `schema()` | 0 | All schema objects (tables, views, indexes, functions) |
| `table_info(table_name)` | 1 | Column details for a specific table |
| `function_info(name?)` | 0-1 | All registered functions, or only those matching `name` (case-insensitive) |
| `foreign_key_info(table_name)` | 1 | Foreign key constraints for a specific table |
| `index_info(table_name)` | 1 | One row per (index, indexed-column) on a table |
| `check_constraint_info(table_name)` | 1 | CHECK constraints on a table |
| `unique_constraint_info(table_name)` | 1 | UNIQUE constraints on a table (excludes the primary key) |
| `assertion_info()` | 0 | All `CREATE ASSERTION` objects |

### Tags column

Schema objects can carry arbitrary `WITH TAGS (key = value, ...)` metadata. Introspection TVFs expose this as a `tags` column containing a JSON object (TEXT), or `NULL` when the object has no tags. Query individual keys with `json_extract`:

```sql
select name, json_extract(tags, '$.audit') as audit
  from schema() where type = 'table';
select name, json_extract(tags, '$.error_message') as msg
  from check_constraint_info('orders') where name is not null;
```

### `schema()` columns

| Column | Type | Description |
|---|---|---|
| `schema` | TEXT | Schema name (`'main'`, `'temp'`, attached) |
| `type` | TEXT | `'table'`, `'view'`, `'index'`, `'function'` |
| `name` | TEXT | Object name |
| `tbl_name` | TEXT | Associated table name |
| `sql` | TEXT? | SQL definition |
| `tags` | TEXT? | Tag bag as JSON object (`NULL` if no tags; always `NULL` for functions) |

### `table_info(table_name)` columns

| Column | Type | Description |
|---|---|---|
| `cid` | INTEGER | Column index (0-based) |
| `name` | TEXT | Column name |
| `type` | TEXT | Column type |
| `notnull` | INTEGER | 1 if NOT NULL |
| `dflt_value` | TEXT? | Default value |
| `pk` | INTEGER | 1 if primary key |
| `tags` | TEXT? | Column tags as JSON object (`NULL` if no tags) |
| `collation` | TEXT | Declared collation (defaults to `'BINARY'`) |
| `generated` | INTEGER | 0 = not generated, 1 = virtual generated, 2 = stored generated |

### `function_info()` columns

| Column | Type | Description |
|---|---|---|
| `name` | TEXT | Function name |
| `num_args` | INTEGER | Argument count (-1 = variadic) |
| `type` | TEXT | `'scalar'`, `'aggregate'`, `'table'`, `'window'` |
| `deterministic` | INTEGER | 1 if deterministic |
| `flags` | INTEGER | Internal flags |
| `signature` | TEXT | Display signature |

### `foreign_key_info(table_name)` columns

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | FK index (0-based), shared by multi-column FK columns |
| `name` | TEXT? | Constraint name (if named) |
| `table` | TEXT | Child table name |
| `from` | TEXT | Child column name |
| `referenced_table` | TEXT | Parent table name |
| `referenced_schema` | TEXT? | Parent schema; resolved at CREATE TABLE time, so a same-schema FK reports that schema rather than null |
| `to` | TEXT? | Parent column name — the parent's primary-key column when the declaration named no parent columns, `NULL` when the parent table can't be resolved or the parent key is narrower than the child column list |
| `on_update` | TEXT | Update action (`cascade`, `restrict`, `setNull`, `setDefault`) |
| `on_delete` | TEXT | Delete action (`cascade`, `restrict`, `setNull`, `setDefault`) |
| `deferred` | INTEGER | 1 if enforcement is deferred to COMMIT |
| `seq` | INTEGER | Column sequence within FK (0-based) |
| `tags` | TEXT? | FK tags as JSON object (repeated across `seq` rows) |

### `index_info(table_name)` columns

One row per (index, indexed-column) pair, ordered by column position within the index.

| Column | Type | Description |
|---|---|---|
| `index_name` | TEXT | Index name |
| `seq` | INTEGER | 0-based position within the index |
| `column_name` | TEXT | Column name |
| `desc` | INTEGER | 1 if column is sorted descending |
| `collation` | TEXT? | Collation for the column in this index (NULL if not specified) |
| `unique` | INTEGER | 1 if the index enforces uniqueness (repeated per row) |
| `partial` | INTEGER | 1 if the index has a `WHERE` predicate |
| `tags` | TEXT? | Index tags as JSON object (repeated per row) |

The implicit covering structure backing a plain `UNIQUE` constraint is not a user-addressable index, so neither `index_info()` nor `schema()` lists it — on any backend — unless the constraint opts in via `quereus.expose_implicit_index`. See [sql-vtab.md §6.3](sql-vtab.md#63-indexes-on-virtual-tables).

### `check_constraint_info(table_name)` columns

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Constraint index (0-based) |
| `name` | TEXT? | Constraint name (NULL for unnamed) |
| `expr` | TEXT | CHECK expression as SQL text |
| `operations` | TEXT | Comma-joined subset of `insert,update,delete` |
| `deferrable` | INTEGER | 0/1 |
| `initially_deferred` | INTEGER | 0/1 |
| `tags` | TEXT? | Constraint tags as JSON object |

### `unique_constraint_info(table_name)` columns

One row per (UNIQUE constraint, column) pair. The primary key is excluded — query `table_info().pk` for that. UNIQUE constraints synthesized from `CREATE UNIQUE INDEX` appear here too.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Constraint index (0-based) |
| `name` | TEXT? | Constraint name (NULL for unnamed) |
| `seq` | INTEGER | 0-based column position within the constraint |
| `column_name` | TEXT | Column name |
| `partial` | INTEGER | 1 if the backing index has a `WHERE` predicate |
| `tags` | TEXT? | Constraint tags as JSON object (repeated per row) |

### `assertion_info()` columns

| Column | Type | Description |
|---|---|---|
| `schema_name` | TEXT | Schema the assertion lives in |
| `name` | TEXT | Assertion name (unique per schema) |
| `violation_sql` | TEXT | The query that should return zero rows when the assertion holds |
| `deferrable` | INTEGER | 0/1 |
| `initially_deferred` | INTEGER | 0/1 |
| `dependent_tables` | TEXT | JSON array of `{relationKey, base}` — one entry per base-table *reference* in the body (a self-join yields two), `base` lowercased `schema.table` |

```sql
select type, name from schema() where type = 'table';
select name, type, notnull, collation, generated from table_info('users');
select name, type from function_info() where type = 'scalar';
select * from function_info('abs');
select "from", "to", on_delete from foreign_key_info('orders');
select index_name, column_name, "desc" from index_info('orders') order by index_name, seq;
select name, expr from check_constraint_info('orders');
select name, column_name from unique_constraint_info('orders') order by id, seq;
select name from assertion_info();
select name, json_extract(tags, '$.audit') as audit
  from schema() where type = 'table';
```

---

## Debug/Explain Functions (TVFs)

These table-valued functions provide query introspection and execution tracing. Primarily for development and debugging.

| Function | Args | Description |
|---|---|---|
| `query_plan(sql)` | 1 | Query execution plan tree |
| `scheduler_program(sql)` | 1 | Compiled instruction sequence |
| `stack_trace(sql)` | 1 | Execution stack trace |
| `execution_trace(sql)` | 1 | Instruction-level trace with timing. Non-deterministic |
| `row_trace(sql)` | 1 | Row-level data flow trace. Non-deterministic |
| `explain_assertion(name)` | 1 | Assertion analysis: classification, prepared PK params, violation SQL. `name` may be `'schema.name'` or bare (first match across schemas) |

```sql
select id, op, detail from query_plan('select * from users where age > 25');
select addr, description from scheduler_program('select 1 + 1');
```

### `explain_assertion(name)` columns

| Column | Type | Description |
|---|---|---|
| `assertion` | TEXT | Assertion name |
| `relation_key` | TEXT | Instance-unique table reference (e.g., `main.users#17`) |
| `base` | TEXT | Base table name (e.g., `main.users`) |
| `classification` | TEXT | `'row'` if row-specific (PK fully covered), else `'global'` |
| `prepared_pk_params` | TEXT? | JSON array of parameter names when row-specific |
| `violation_sql` | TEXT | Stored violation query |

---

## Registration and Plugin-Based Functions

Custom functions (scalar, aggregate, table-valued) can be registered via the [Plugin System](plugins.md#function-plugins). See also [Usage Guide](usage.md#user-defined-functions) for inline function registration.

---

## Generation Functions (TVFs)

**`generate_series(start, stop)`** -- Generates integers from `start` to `stop` (inclusive), step 1.

Returns a single column `value` (INTEGER).

```sql
select * from generate_series(1, 5);
-- 1, 2, 3, 4, 5
```
