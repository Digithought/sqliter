# SQL Transactions & PRAGMA

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Part of the [Quereus SQL Reference](sql.md) — see [Topic documents](sql.md#topic-documents) for the full map.

## 8. Transactions and Savepoints

Transactions group multiple operations into a single unit that either succeeds completely or fails completely.

### 8.1 BEGIN Transaction

Starts a new transaction.

**Syntax:**
```sql
begin [transaction]
```

**Examples:**
```sql
-- Start a transaction
begin;

-- Start a transaction with explicit keyword
begin transaction;
```

### 8.2 COMMIT Transaction

Saves all changes made during the current transaction.

**Syntax:**
```sql
commit [transaction]
```

**Example:**
```sql
-- Commit the current transaction
commit;
```

### 8.3 ROLLBACK Transaction

Discards all changes made during the current transaction.

**Syntax:**
```sql
rollback [transaction]
```

**Example:**
```sql
-- Discard all changes in the current transaction
rollback;
```

### 8.4 Savepoints

Savepoints allow partial transaction rollbacks.

**Create a savepoint:**
```sql
savepoint savepoint_name
```

**Rollback to a savepoint:**
```sql
rollback [transaction] to [savepoint] savepoint_name
```

**Release a savepoint:**
```sql
release [savepoint] savepoint_name
```

**Example:**
```sql
-- Transaction with savepoints
begin;

insert into users (name, email) values ('Alice', 'alice@example.com');

savepoint after_alice;

insert into users (name, email) values ('Bob', 'bob@example.com');

-- Oops, we made a mistake with Bob
rollback to savepoint after_alice;

-- Only Alice is inserted, Bob's insert was rolled back
insert into users (name, email) values ('Charlie', 'charlie@example.com');

-- Release a savepoint (optional, mostly for cleanup)
release savepoint after_alice;

commit;
```

### 8.5 Transaction Best Practices

1. **Explicit Transactions**: Always use explicit transactions for multi-statement operations.
2. **Error Handling**: Combine transactions with proper error handling to ensure rollback on failure.
3. **Transaction Size**: Keep transactions as short as possible to reduce lock contention.
4. **Savepoints**: Use savepoints for partial rollback instead of entire transaction rollback.

**JavaScript Example with Quereus:**
```javascript
// Using explicit transactions in JavaScript
try {
  await db.exec("begin");
  
  const orderId = await db.get("insert into orders (customer_id, total) values (?, ?) returning (id)", [42, 129.99]);
  
  await db.exec("insert into order_items (order_id, product_id, quantity) values (?, ?, ?)",
    [orderId, 101, 2]);
  await db.exec("insert into order_items (order_id, product_id, quantity) values (?, ?, ?)",
    [orderId, 205, 1]);
  
  await db.exec("commit");
  console.log("Transaction committed successfully");
} catch (error) {
  await db.exec("rollback");
  console.error("Transaction failed:", error);
}
```

## 9. PRAGMA Statements

PRAGMA statements are special commands that control the behavior of the Quereus database engine.

### 9.1 Basic Syntax

```sql
pragma name = value;
pragma name;  -- query the current value
```

### 9.2 Supported PRAGMA Statements

#### 9.2.1 default_vtab_module

Sets or queries the default virtual table module used when `create table` is called without a specific `using` clause.

```sql
-- Set default module to "memory"
pragma default_vtab_module = 'memory';

-- Query current default module
pragma default_vtab_module;
```

#### 9.2.2 default_vtab_args

Sets or queries the default arguments passed to the default virtual table module. The value should be a JSON array of strings.

```sql
-- Set default args for the default module
pragma default_vtab_args = '["create table x(id integer primary key, data text)"]';

-- Query current default args
pragma default_vtab_args;
```

#### 9.2.3 default_column_nullability

**🚨 IMPORTANT: Departure from SQL Standard**

Sets or queries the default nullability behavior for columns. This is a significant departure from the SQL standard, aligning with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf) principles which advocate against NULL by default.

**Values:**
- `'not_null'` (default): Columns are NOT NULL by default unless explicitly declared otherwise
- `'nullable'`: Standard SQL behavior - columns are nullable by default unless explicitly declared NOT NULL

```sql
-- Set to Third Manifesto behavior (default in Quereus)
pragma default_column_nullability = 'not_null';

-- Set to SQL standard behavior  
pragma default_column_nullability = 'nullable';

-- Query current setting
pragma default_column_nullability;
```

**Rationale:**
The Third Manifesto argues that NULL is fundamentally problematic in relational theory and that non-nullable types should be the default. Quereus follows this principle to avoid the "billion-dollar mistake" of NULL by default, while still allowing NULLs when explicitly needed.

**Examples:**

```sql
-- With default_column_nullability = 'not_null' (Quereus default)
create table users (
  id integer primary key, -- Implicitly NOT NULL
  name text,           -- Implicitly NOT NULL
  email text,          -- Implicitly NOT NULL  
  bio text null        -- Explicitly allows NULL
);

-- With default_column_nullability = 'nullable' (SQL standard)
create table users (
  id integer primary key, -- Implicitly NOT NULL
  name text,           -- Allows NULL
  email text not null, -- Explicitly NOT NULL
  bio text             -- Allows NULL
);
```

**Note:** Primary key columns are always NOT NULL regardless of this setting.

#### 9.2.4 default_collation

Sets or queries the default **declared collation** for columns that carry no explicit
`COLLATE` clause. Defaults to `'BINARY'`, so out of the box there is no behavior change —
opt into `'NOCASE'` / `'RTRIM'` / any registered collation per database.

**Values:**
- `'BINARY'` (default): omitted-`COLLATE` columns are byte-compared (case-sensitive).
- `'NOCASE'` / `'RTRIM'` / any registered collation name: omitted-`COLLATE` columns resolve
  to that collation, **but only for types that support it** (text). Non-text columns
  (`INTEGER`/`REAL`/`BLOB`) and empty-collation types (`JSON`, temporal) fall back to
  `BINARY`. An invalid collation name is rejected at set time (the pragma value rolls back).

```sql
-- Make omitted-COLLATE text columns case-insensitive for this database
pragma default_collation = 'nocase';

create table users (
  id integer primary key,     -- INTEGER → BINARY (NOCASE unsupported)
  name text,                  -- TEXT, no COLLATE → resolves to NOCASE
  code text collate binary    -- explicit COLLATE always wins → BINARY
);

-- Query current setting
pragma default_collation;

-- Restore byte-comparison default
pragma default_collation = 'binary';
```

**Semantics (important):** `default_collation` is a **schema-authoring convenience
only**. The catalog always stores the concrete, resolved collation, and persisted DDL always
emits an explicit `COLLATE` for any non-`BINARY` collation. So a table created under
`default_collation = 'nocase'` round-trips its `NOCASE` columns unambiguously even when the
database is later reopened (or its DDL re-executed) under a different — or the default —
`default_collation`. An explicit `COLLATE` clause always overrides the session default.

`ALTER TABLE ... ADD COLUMN` honors the default the same way `CREATE TABLE` does: an added
text column with no explicit `COLLATE` resolves to the session default (non-text falls back to
`BINARY`), so an added column gets the same collation a `CREATE`-d one would. `RENAME COLUMN`
deliberately does **not** consult the default — it preserves the renamed column's existing
collation rather than re-resolving it to the current session setting.

Because "the catalog always stores the concrete, resolved collation" is enforced by emitting an
explicit `COLLATE` for every non-`BINARY` collation, a column whose collation came from the
session default is *defaulted* in-session (rank 1, `default`) but reloads as *declared* (rank 2)
after a reopen or DDL re-execution — the re-parsed `COLLATE` clause is indistinguishable from a
hand-written one. This is intended: the comparison-collation rank may rise from rank 1 to rank 2
across the persistence boundary, and the only observable effect is *stricter* (fail-louder)
conflict detection — a comparison that previously resolved silently can become a prepare-time
ambiguous-collation error, never silently different results (see docs/types.md § Comparison
collation resolution). `ALTER COLUMN ... SET COLLATE` likewise marks the collation explicit
(rank 2) in-session, with the same standing as a CREATE-time `COLLATE`.

#### 9.2.5 nondeterministic_schema

Allows non-deterministic expressions (`random()`, `datetime('now')`, user-defined functions
marked non-deterministic, etc.) inside DEFAULT, CHECK, and `GENERATED ALWAYS AS` clauses.
Defaults to `false` (strict rejection) for backward compatibility.

**Aliases:** `allow_nondeterministic_schema_expressions`

**Values:**
- `false` (default) — strict rejection: a CREATE TABLE / INSERT / UPDATE that compiles a
  non-deterministic expression in a DEFAULT, CHECK, or generated-column clause raises
  `Non-deterministic expression not allowed in …`.
- `true` — permit non-deterministic expressions. Per-row evaluation still produces a
  concrete literal at the `vtab.update()` frontier (captured in `args.values` and in the
  literal SQL produced by `buildInsertStatement` / `buildUpdateStatement` /
  `buildDeleteStatement`), so the replay contract — "apply primitives at the module-layer
  boundary" — is preserved.

```sql
-- Default: strict rejection
create table t (id integer primary key, ts text default datetime('now'));
-- error: Non-deterministic expression not allowed in DEFAULT

-- Relax the gate
pragma nondeterministic_schema = true;

create table audit (
  id integer primary key,
  ts text default datetime('now'),         -- now permitted
  tag integer generated always as (random()) stored
);

insert into audit (id) values (1);
-- The row stored carries a concrete ts string and concrete tag integer.
```

**Scope:** The option is read at validation time. Toggling it affects validation of
*subsequent* DDL / DML only; tables already created retain whatever expressions they
were created with. The option is not baked into any persisted schema.

**See also:** [Determinism Validation](determinism.md) for the full
replay-contract discussion, and [Mutation Statements](module-authoring.md#mutation-statements)
for how the captured artifact is structured.

#### 9.2.6 schema_path

Sets or queries the default schema search path used when resolving unqualified table names. The value is a comma-separated list of schema names.

**Values:**
- Comma-separated list of schema names (e.g., `'main,extensions,plugins'`)
- Empty string or `'main'` to use only the default schema

```sql
-- Set search path for the connection
pragma schema_path = 'main,extensions,plugins';

-- Query current search path
pragma schema_path;
-- Returns: "main,extensions,plugins"

-- Reset to default
pragma schema_path = 'main';
```

**Resolution Order:**

When resolving unqualified table names:
1. Qualified names (`schema.table`) are used exactly as specified
2. `WITH SCHEMA` clause on the statement (highest priority)
3. `PRAGMA schema_path` setting (session default)
4. Default schema (`main`)

A **stored body** (a view or materialized-view definition) is the exception: it resolves its unqualified names against the owning object's own schema first, then the session default path — never the reading statement's `WITH SCHEMA` path. See [SQL Reference § Schema Search Path](sql-select.md#211-schema-search-path-with-schema).

**Examples:**

```sql
-- Set search path for the session
pragma schema_path = 'workspace,main';

-- All subsequent queries use this path
select * from users;  -- Searches workspace.users, then main.users

-- Override per-query with WITH SCHEMA
select * from users with schema main;  -- Only searches main.users
```

### 9.3 Examples

```sql
-- Configure default VTab settings
pragma default_vtab_module = 'memory';
pragma default_vtab_args = '[]';

-- Set Third Manifesto-aligned nullability (default)
pragma default_column_nullability = 'not_null';

-- Set schema search path
pragma schema_path = 'main,extensions';

-- Create a table using the default module and nullability
create table simple_cache (
  key text primary key,
  value text              -- NOT NULL by default with 'not_null' setting
);
-- Equivalent to: create table simple_cache (...) using memory;

-- Tables will be resolved from main first, then extensions
select * from users;  -- Searches main.users, then extensions.users
```

### 9.4 Transactions Control PRAGMAs

These PRAGMAs are parsed but may not affect behavior in the same way as SQLite due to Quereus's virtual table-centric architecture.

```sql
pragma journal_mode = 'memory';
pragma synchronous = 'off';
```

### 9.5 ANALYZE

The `ANALYZE` command collects table statistics for cost-based query optimization. Statistics include row counts, per-column distinct value counts, null counts, min/max values, and equi-height histograms for selectivity estimation.

```sql
-- Analyze all tables in the default schema
analyze;

-- Analyze a specific table
analyze products;

-- Analyze a table in a specific schema
analyze main.products;

-- Analyze every table in a specific schema
analyze main.*;
```

`ANALYZE` returns one row per table with columns `table` (text) and `rows` (integer).

If a virtual table module implements `getStatistics()`, those statistics are used directly. Otherwise, a full table scan collects per-column statistics with reservoir-sampled histograms. Collected statistics are cached on the table schema and used by the optimizer's `CatalogStatsProvider` for improved cost estimates.
