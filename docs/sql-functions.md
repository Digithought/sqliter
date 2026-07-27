# SQL Functions

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 5. Functions

Quereus provides a rich set of built-in functions for data manipulation, calculation, and transformation. These functions follow SQL standards with some Quereus-specific extensions.

### 5.1 Scalar Functions

Scalar functions operate on single values and return a single value per row.

#### String Functions
- `lower(X)`: Returns the lowercase version of string X
- `upper(X)`: Returns the uppercase version of string X
- `length(X)`: Returns the length of string X in characters
- `substr(X, Y[, Z])`: Returns a substring of X starting at position Y (1-based) and Z characters long
- `substring(X, Y[, Z])`: Alias for `substr()`
- `trim(X[, Y])`: Removes leading and trailing characters Y from X
- `ltrim(X[, Y])`: Removes leading characters Y from X
- `rtrim(X[, Y])`: Removes trailing characters Y from X
- `replace(X, Y, Z)`: Replaces all occurrences of Y in X with Z
- `instr(X, Y)`: Returns the 1-based position of the first occurrence of Y in X
- `lpad(X, Y[, Z])`: Left-pads string X to length Y with string Z (default space)
- `rpad(X, Y[, Z])`: Right-pads string X to length Y with string Z (default space)
- `reverse(X)`: Returns string X with characters in reverse order
- `like(X, Y)`: Returns 1 if X matches pattern Y, 0 otherwise
- `glob(X, Y)`: Returns 1 if X matches glob pattern Y, 0 otherwise

**Examples:**
```sql
-- String manipulation
select 
  lower('HELLO') as lowercase,
  upper('world') as uppercase,
  length('Quereus') as str_length,
  substr('abcdef', 2, 3) as substring,
  trim('  test  ') as trimmed,
  replace('hello world', 'world', 'Quereus') as replaced;

-- Result:
-- lowercase | uppercase | str_length | substring | trimmed | replaced
-- 'hello'   | 'WORLD'   | 7          | 'bcd'     | 'test'  | 'hello Quereus'
```

#### Numeric Functions
- `abs(X)`: Returns the absolute value of X
- `round(X[, Y])`: Rounds X to Y decimal places
- `ceil(X)`, `ceiling(X)`: Returns the smallest integer not less than X
- `floor(X)`: Returns the largest integer not greater than X
- `pow(X, Y)`, `power(X, Y)`: Returns X raised to the power of Y
- `sqrt(X)`: Returns the square root of X
- `clamp(X, min, max)`: Constrains X to be between min and max
- `greatest(X, Y, ...)`: Returns the largest value from the arguments
- `least(X, Y, ...)`: Returns the smallest value from the arguments
- `random()`: Returns a random integer
- `randomblob(N)`: Returns a blob containing N bytes of pseudo-random data

**Examples:**
```sql
-- Numeric calculations
select 
  abs(-42) as absolute,
  round(3.14159, 2) as rounded,
  ceil(9.1) as ceiling,
  floor(9.9) as floor_val,
  pow(2, 8) as power_val,
  sqrt(144) as square_root,
  random() % 100 as random_num;

-- Result example:
-- absolute | rounded | ceiling | floor_val | power_val | square_root | random_num
-- 42       | 3.14    | 10      | 9         | 256       | 12          | 73
```

#### Conditional Functions
- `coalesce(X, Y, ...)`: Returns the first non-NULL value
- `nullif(X, Y)`: Returns NULL if X equals Y, otherwise returns X
- `iif(X, Y, Z)`: If X is true, returns Y, otherwise returns Z
- `choose(index, val0, val1, ...)`: Returns the value at the given index (0-based)

**Examples:**
```sql
-- Conditional logic
select 
  coalesce(null, null, 'third', 'fourth') as first_non_null,
  nullif(5, 5) as same_values,
  nullif(10, 20) as different_values,
  iif(age >= 18, 'adult', 'minor') as age_category
from users;

-- Result example:
-- first_non_null | same_values | different_values | age_category
-- 'third'        | null        | 10               | 'adult'
```

#### Type Functions
- `typeof(X)`: Returns the datatype of X as a string ('null', 'integer', 'real', 'text', or 'blob')

### 5.2 Aggregate Functions

Aggregate functions perform a calculation on a set of values and return a single value.

- `count(X)`: Returns the number of non-NULL values of X
- `count(*)`: Returns the number of rows
- `sum(X)`: Returns the sum of all non-NULL values of X
- `avg(X)`: Returns the average of all non-NULL values of X
- `min(X)`: Returns the minimum value of all non-NULL values of X
- `max(X)`: Returns the maximum value of all non-NULL values of X — `min`/`max`
  rank X the same way `order by X` does, so a `timespan` column compares by
  elapsed time, a `json` column by structure, and a collated text column under
  its declared collation (see [Type System § Semantic ordering](types.md#semantic-ordering))
- `group_concat(X[, Y])`: Returns a string concatenating non-NULL values of X, separated by Y (default ',')
- `total(X)`: Returns the sum as a floating-point value (returns 0.0 for empty set)
- `var_pop(X)`: Returns the population variance
- `var_samp(X)`: Returns the sample variance
- `stddev_pop(X)`: Returns the population standard deviation
- `stddev_samp(X)`: Returns the sample standard deviation
- `string_concat(X)`: Concatenates string values with comma separator

**Examples:**
```sql
-- Basic aggregates
select 
  count(*) as total_rows,
  count(email) as users_with_email,
  sum(cost) as total_cost,
  avg(age) as average_age,
  min(created_at) as earliest_record,
  max(score) as highest_score
from users;

-- Grouping with aggregates
select 
  department,
  count(*) as employee_count,
  avg(salary) as avg_salary,
  min(hire_date) as earliest_hire,
  group_concat(name, ', ') as employee_names
from employees
group by department;
```

### 5.3 JSON Functions

Quereus provides comprehensive functions for working with JSON data.

**JSON Query Functions:**
- `json_extract(json, path, ...)`: Extracts values from JSON using JSONPath
- `json_type(json[, path])`: Returns the type of JSON value ('object', 'array', 'string', 'number', 'boolean', 'null')
- `json_valid(json)`: Checks if a string is valid JSON (returns 1 or 0)
- `json_schema(json, schema_def)`: Validates JSON against a structural schema (returns 1 or 0)
- `json_array_length(json[, path])`: Returns the length of a JSON array

**JSON Construction Functions:**
- `json_object(key, value, ...)`: Creates a JSON object from key-value pairs
- `json_array(value, ...)`: Creates a JSON array from values
- `json_quote(value)`: Converts a SQL value to a JSON-quoted string

**JSON Modification Functions:**
- `json_insert(json, path, value, ...)`: Inserts values into JSON (does not overwrite existing)
- `json_replace(json, path, value, ...)`: Replaces existing values in JSON
- `json_set(json, path, value, ...)`: Sets values in JSON (inserts or replaces)
- `json_remove(json, path, ...)`: Removes values from JSON
- `json_patch(json, patch)`: Applies a JSON Patch (RFC 6902) to a JSON document

**JSON Aggregate Functions:**
- `json_group_array(X)`: Aggregate function that creates a JSON array from values
- `json_group_object(key, value)`: Aggregate function that creates a JSON object from key-value pairs

**JSON Table-Valued Functions:**
- `json_each(json[, path])`: Returns one row per element in a JSON array or object
- `json_tree(json[, path])`: Returns one row per node in the JSON tree structure

**Examples:**
```sql
-- JSON extraction
select
  json_extract('{"name":"John","age":30}', '$.name') as name,
  json_extract('{"name":"John","age":30}', '$.age') as age;

-- JSON creation
select
  json_object('name', 'Alice', 'age', 25) as person,
  json_array(1, 2, 3, 4, 5) as numbers;

-- JSON schema validation (using TypeScript-like syntax)
select json_schema('[1, 2, 3]', 'number[]');  -- Returns 1 (valid)
select json_schema('{"x": 42}', '{ x: number }');  -- Returns 1 (valid)
select json_schema('[{"x": 1}, {"x": 2}]', '{ x: number }[]');  -- Returns 1 (valid)

-- Enforcing JSON structure with CHECK constraints
create table api_events (
  id integer primary key,
  event_type text not null,
  payload json check (json_schema(payload, '{ timestamp: string, data: any }'))
);

-- Aggregating to JSON
select
  department,
  json_group_array(name) as employees,
  json_group_object(id, salary) as salary_map
from employees
group by department;
```

### 5.4 Date and Time Functions

Quereus includes functions for manipulating dates and times.

**Temporal Type Functions:**
- `date(timestring[, modifier...])`: Returns the date as 'YYYY-MM-DD'
- `time(timestring[, modifier...])`: Returns the time as 'HH:MM:SS'
- `datetime(timestring[, modifier...])`: Returns the date and time as 'YYYY-MM-DD HH:MM:SS'
- `timespan(duration_string)`: Returns a TIMESPAN from ISO 8601 duration or human-readable string
- `julianday(timestring[, modifier...])`: Returns the Julian day number
- `strftime(format, timestring[, modifier...])`: Returns a formatted date string
- `is_iso_date(X)`: Returns 1 if X is a valid ISO 8601 date, 0 otherwise
- `is_iso_datetime(X)`: Returns 1 if X is a valid ISO 8601 datetime, 0 otherwise

**Common modifiers:**
- `+N days`, `+N hours`, `+N minutes`, `+N seconds`, `+N months`, `+N years`
- `start of month`, `start of year`, `start of day`
- `weekday N` (0=Sunday, 1=Monday, etc.)
- `localtime`, `utc`

**Examples:**
```sql
-- Date functions
select
  date('now') as today,
  time('now', 'localtime') as current_time,
  datetime('now', '+1 day') as tomorrow,
  julianday('2023-01-01') - julianday('2022-01-01') as days_difference,
  strftime('%Y-%m-%d %H:%M', 'now') as formatted_now,
  strftime('%W', 'now') as week_of_year;

-- Date calculations
select
  date('now', '+7 days') as one_week_later,
  date('now', 'start of month', '+1 month', '-1 day') as last_day_of_month,
  datetime('now', 'weekday 1') as next_or_current_monday;

-- Timespan creation and arithmetic
select
  timespan('1 hour 30 minutes') as duration1,
  timespan('PT2H30M') as duration2,
  datetime('2024-01-15T09:00:00') + timespan('2 hours') as meeting_end,
  date('2024-01-15') + timespan('7 days') as next_week,
  timespan('3 hours') - timespan('45 minutes') as remaining;

-- Timespan comparisons
select * from events
where duration > timespan('1 hour')
order by duration desc;
```

### 5.5 Window Functions

Window functions perform calculations across a set of table rows related to the current row. Quereus provides comprehensive window function support with an extensible architecture.

**Window Function Syntax:**
```sql
window_function([arguments]) over (
  [partition by partition_expression [, ...]]
  [order by sort_expression [asc | desc] [, ...]]
  [window_frame_clause]
)
```

**Available Window Functions:**

**Ranking Functions:**
- `row_number()`: Returns a sequential row number within the partition
- `rank()`: Returns the rank with gaps (e.g., 1, 1, 3, 4)
- `dense_rank()`: Returns the rank without gaps (e.g., 1, 1, 2, 3)
- `ntile(n)`: Distributes rows into n buckets

**Aggregate Window Functions:**
- `count(*)`, `count(expr)`: Count of rows or non-NULL values
- `sum(expr)`: Sum of values in the window frame
- `avg(expr)`: Average of values in the window frame
- `min(expr)`, `max(expr)`: Minimum/maximum values in the window frame. These rank
  by the same comparison as their plain-aggregate forms and as `order by` — the
  argument's logical type semantics for `timespan` / `json`, the argument's
  collation for text (see `docs/types.md`, "Semantic ordering")

**Navigation Functions (Planned):**
- `lead(expr[, offset[, default]])`: Accesses data from subsequent rows
- `lag(expr[, offset[, default]])`: Accesses data from previous rows
- `first_value(expr)`: Returns the first value in the window frame
- `last_value(expr)`: Returns the last value in the window frame

**Architecture Features:**
- **Extensible Registration**: Window functions are registered like scalar/aggregate functions
- **Performance Optimized**: Groups functions by window specifications for efficiency
- **Streaming Execution**: Non-partitioned functions use constant memory
- **Partitioned Execution**: PARTITION BY properly collects and processes partitions

**Examples:**
```sql
-- Ranking employees by salary within departments
select 
  name,
  department,
  salary,
  row_number() over (partition by department order by salary desc) as dept_rank,
  rank() over (order by salary desc) as overall_rank,
  dense_rank() over (partition by department order by salary desc) as dense_dept_rank
from employees;

-- Running totals and departmental statistics
select
  name,
  department,
  salary,
  sum(salary) over (partition by department order by hire_date) as running_dept_total,
  avg(salary) over (partition by department) as dept_average,
  count(*) over (partition by department) as dept_size
from employees;

-- Quartile analysis
select
  name,
  salary,
  ntile(4) over (order by salary) as salary_quartile
from employees;

-- Multiple window functions with same specification (optimized)
select
  product_id,
  sales_date,
  amount,
  sum(amount) over w as running_total,
  avg(amount) over w as running_average,
  count(*) over w as running_count
from sales
window w as (partition by product_id order by sales_date);
```

### 5.6 Table-Valued Functions

Table-valued functions return a result set that can be queried like a table.

**Generation Functions:**
- `generate_series(start, stop[, step])`: Generates a series of integer values from start to stop
- `split_string(str, delimiter)`: Splits a string into rows based on a delimiter

**Schema Introspection Functions:**
- `schema()`: Returns information about all tables, views, and functions across all schemas (columns: `schema`, `type`, `name`, `tbl_name`, `sql`)
- `table_info(table_name)`: Returns column information for a specific table
- `function_info([function_name])`: Returns information about all registered functions, or a given registered function

**Debugging and Analysis Functions:**
- `query_plan(sql)`: Returns the query execution plan for a SQL statement
- `scheduler_program(sql)`: Returns the scheduler program for a SQL statement
- `stack_trace(sql)`: Returns the execution stack trace
- `execution_trace(sql)`: Returns detailed execution trace information
- `row_trace(sql)`: Returns row-level trace information
- `explain_assertion(assertion_name)`: Returns information about a specific assertion

**Examples:**
```sql
-- Generate a series of numbers
select value from generate_series(1, 10);

-- Get schema information
select schema, type, name, sql from schema() where type = 'table';

-- Get column information for a table
select cid, name, type, notnull, pk from table_info('users');

-- Get function information
select name, num_args, type, deterministic from function_info();

-- Analyze query plan
select * from query_plan('select * from users where id = 1');
```
