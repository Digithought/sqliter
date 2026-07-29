# Quereus - A TypeScript SQL Query Processor

<img src="../../docs/images/Quereus_colored_wide.svg" alt="Quereus Logo" height="150">

> **Stability** — this package spans tiers: the core SQL engine, type system, and
> virtual-table framework are **Stable**, while other feature areas are Beta or
> Experimental. See [Stability](#stability) below and
> [Stability Tiers](../../docs/stability.md#tiers) for the per-area assignment.

Quereus is a feature-complete SQL query processor specifically designed for efficient in-memory data processing with a strong emphasis on the **virtual table** interface. It provides rich SQL query and constraint capabilities (joins, aggregates, subqueries, CTEs, window functions, constraints) over data sources exposed via the virtual table mechanism. Quereus features a modern type system with temporal types, JSON support, and plugin-extensible custom types. It has no persistent file storage, though one could be built as a virtual table module.

## Project Goals

*   **Virtual Table Centric** — provide a robust and flexible virtual table API as the primary means of interacting with data sources. All tables are virtual tables.
*   **In-Memory Default** — includes a comprehensive in-memory virtual table implementation (`MemoryTable`) with support for transactions and savepoints.
*   **Modern Type System** — extensible logical/physical type separation with built-in temporal types (DATE, TIME, DATETIME), native JSON type with deep equality comparison, and plugin support for custom types. See [Type System Documentation](../../docs/types.md).
*   **TypeScript & Modern JS** — leverage TypeScript's type system and modern JavaScript features and idioms.
*   **Async VTab Operations** — virtual table data operations (reads/writes) are asynchronous. Cursors are implemented as async iterables.
*   **Cross-Platform** — target diverse Javascript runtime environments, including Node.js, browser, and React Native. Plugin loading (via `@quereus/plugin-loader`) uses dynamic `import()` and is not compatible with React Native; use static imports for RN.
*   **Minimal Dependencies** — avoid heavy external dependencies where possible.
*   **SQL Compatibility** — comprehensive support for modern SQL features including joins, window functions, subqueries, CTEs, constraints, views, and advanced DML/DDL operations.
*   **Key-Based Addressing** — all tables are addressed by their defined Primary Key. The concept of a separate, implicit `rowid` for addressing rows is not used.
*   **Third Manifesto Friendly** — embraces some of the principles of the [Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf), such as allowing for empty keys. Utilizes algebraic planning.

## Quick Start

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Create a table and insert data
await db.exec("create table users (id integer primary key, name text, email text)");
await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");

// Query returns objects: { id: 1, name: 'Alice', email: 'alice@example.com' }
const user = await db.get("select * from users where id = ?", [1]);
console.log(user.name); // "Alice"

// Iterate over multiple rows
for await (const row of db.eval("select * from users")) {
  console.log(row.name);
}
```

### Reactive Patterns with Event Hooks

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Subscribe to data changes at the database level
db.onDataChange((event) => {
  console.log(`${event.type} on ${event.tableName} (module: ${event.moduleName})`);
  if (event.remote) {
    console.log('Change came from remote sync');
  }
  if (event.type === 'update') {
    console.log('Changed columns:', event.changedColumns);
  }
});

// Subscribe to schema changes
db.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
});

// Events fire after commit
await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
// Output: create table: users

await db.exec("INSERT INTO users VALUES (1, 'Alice')");
// Output: insert on users (module: memory)
```

The database-level event system aggregates events from all modules automatically. Events are batched within transactions and delivered only after successful commit.

SQL values use native JavaScript types (`string`, `number`, `bigint`, `Uint8Array`, `null`). Temporal types are ISO 8601 strings. Results stream as async iterators.

See the [Usage Guide](../../docs/usage.md) for complete API reference and [Database-Level Event System](../../docs/module-events.md) for event system details.

## Platform Support & Storage

Quereus runs on any JavaScript runtime. For persistent storage, platform-specific plugins provide the `store` virtual table module:

### Node.js

Use [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) for LevelDB-based persistent storage with full transaction isolation. Each table becomes a subdirectory under `basePath`:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, { basePath: './data' }); // ./data/users/, ./data/orders/, etc.

await db.exec(`create table users (id integer primary key, name text) using store`);

// Full transaction isolation enabled by default
await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
const user = await db.get('SELECT * FROM users WHERE id = 1'); // Sees uncommitted insert
await db.exec('COMMIT');
```

### Browser

Use [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) for IndexedDB-based persistent storage with cross-tab sync and full transaction isolation. All tables share one IndexedDB database:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';

const db = new Database();
await registerPlugin(db, indexeddbPlugin, { databaseName: 'myapp' }); // IndexedDB database name

await db.exec(`create table users (id integer primary key, name text) using store`);
```

### React Native

Use [`@quereus/plugin-react-native-leveldb`](../quereus-plugin-react-native-leveldb/) for fast LevelDB storage with full transaction isolation. Each table becomes a separate LevelDB database with a name prefix:

```typescript
import { LevelDB, LevelDBWriteBatch } from 'react-native-leveldb';
import { Database, registerPlugin } from '@quereus/quereus';
import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';

const db = new Database();
await registerPlugin(db, leveldbPlugin, {
  openFn: LevelDB.open,
  WriteBatch: LevelDBWriteBatch,
  databaseName: 'myapp'  // creates myapp_users, myapp_orders, etc.
});

await db.exec(`create table users (id integer primary key, name text) using store`);
```

**Note:** React Native requires runtime polyfills and static plugin loading. See the [plugin README](../quereus-plugin-react-native-leveldb/) for setup details.

**Required polyfills:**
- `structuredClone` (Quereus uses it internally)
- `TextEncoder` / `TextDecoder` (used by store plugins)
- `Symbol.asyncIterator` (required for async-iterable support; Quereus has a Hermes workaround for AsyncGenerator iterables, but the symbol must exist)

### NativeScript

Use [`@quereus/plugin-nativescript-sqlite`](../quereus-plugin-nativescript-sqlite/) for SQLite-based storage with full transaction isolation. All tables share one SQLite database file:

```typescript
import { openOrCreate } from '@nativescript-community/sqlite';
import { Database, registerPlugin } from '@quereus/quereus';
import sqlitePlugin from '@quereus/plugin-nativescript-sqlite/plugin';

const sqliteDb = openOrCreate('myapp.db');  // SQLite database file
const db = new Database();
await registerPlugin(db, sqlitePlugin, { db: sqliteDb });

await db.exec(`create table users (id integer primary key, name text) using store`);
```

See [Store Documentation](../../docs/store.md) for the storage architecture and custom backend implementation.

## Documentation

**Architecture deep dive:** [Architecture](../../docs/architecture.md) — the pipeline (parser → planner → runtime), source layout, extension patterns, design decisions, constraints model, and testing strategy. Start here if you're working on the engine itself.

**User & operator docs:**
* [Stability Tiers](../../docs/stability.md) — what each tier promises, and which feature areas are Stable, Beta, Experimental, or Internal
* [Usage Guide](../../docs/usage.md) — complete API reference (type mappings, parameter binding, logging, tracing, transactions)
* [SQL Reference Guide](../../docs/sql.md) — SQL syntax (includes Declarative Schema)
* [Schema Management](../../docs/schema.md) — SchemaManager API, change events, key types, DDL generation
* [View Updateability](../../docs/view-updateability.md) — write-through for views, CTEs, and subqueries-in-FROM; per-operator semantics and override tags
* [Materialized Views](../../docs/materialized-views.md) — keyed derived relations, DDL, query resolution, write-through, declarative-schema round-trip. Deep dives: [maintenance](../../docs/mv-maintenance.md), [derived-row constraints and covering structures](../../docs/mv-constraints.md), [external row-change ingestion](../../docs/mv-ingestion.md), [schema-change staleness](../../docs/mv-schema-change.md), [the backing-host capability](../../docs/mv-backing-host.md)
* [Lenses and Layered Schemas](../../docs/lens.md) — logical/basis separation and bidirectional per-table lenses
* [Schema Migration in a Synced Database](../../docs/migration.md) — evolving schemas across replicated peers with lenses and maintained basis tables
* [Type System](../../docs/types.md) — logical/physical types, temporal types, JSON, custom types
* [Functions](../../docs/functions.md) — built-in scalar, aggregate, window, and JSON functions
* [Memory Tables](../../docs/memory-table.md) — built-in MemoryTable module
* [Module Authoring](../../docs/module-authoring.md) — virtual table module development
* [Database-Level Event System](../../docs/module-events.md) — data and schema change events
* [Date/Time Handling](../../docs/datetime.md) — temporal parsing, functions, and ISO 8601 formats
* [Runtime](../../docs/runtime.md) — instruction-based execution and opcodes
* [Error Handling](../../docs/errors.md) — error types and status codes
* [Plugin System](../../docs/plugins.md) — virtual tables, functions, and collations
* [Optimizer](../../docs/optimizer.md) — hub; topic docs for [Rules](../../docs/optimizer-rules.md), [Rule Families](../../docs/optimizer-rule-families.md), [Joins](../../docs/optimizer-joins.md), [Retrieve Push-down](../../docs/optimizer-retrieve.md), [Streaming](../../docs/optimizer-streaming.md), [Parallel](../../docs/optimizer-parallel.md), [Assertions](../../docs/optimizer-assertions.md), [Functional Dependencies](../../docs/optimizer-fd.md), [Conventions](../../docs/optimizer-conventions.md)
* [Change-scope Introspection](../../docs/change-scope.md) — what a prepared statement reads from
* [TODO List](../../docs/todo.md) — planned features

### Plugin Development

Quereus exports all critical utilities needed for plugin and module development:

* **Comparison Functions** — `compareSqlValues`, `compareRows`, `compareTypedValues`, `createTypedComparator` — match Quereus SQL semantics in custom implementations
* **Coercion Utilities** — `tryCoerceToNumber`, `coerceForAggregate` — handle type coercion for aggregates and arithmetic
* **Collation Support** — collations are registered per database with `db.registerCollation(name, func, options?)` and resolved through `db.getCollationResolver()`; the built-ins `BINARY`, `NOCASE`, and `RTRIM` are always present. Naming an unregistered collation raises `no such collation sequence`
* **Type System** — full access to logical types, validation, and parsing utilities
* **Event Hooks** — `VTableEventEmitter` interface for mutation and schema change events; enable reactive patterns, caching, and replication
* **DDL Generation** — `generateTableDDL(tableSchema, db?)`, `generateIndexDDL(indexSchema, tableSchema, db?)` — canonical `CREATE TABLE` / `CREATE INDEX` output from runtime schema objects. With a `Database`, matches session defaults (schema qualification, `default_column_nullability`, `default_vtab_module`/`default_vtab_args`) for readable output; without one, emits fully-qualified, explicitly-annotated DDL safe for cross-session persistence. See [Schema Management — DDL Generation](../../docs/schema.md#ddl-generation).

See the [Plugin System documentation](../../docs/plugins.md#comparison-and-coercion-utilities) for complete API reference and examples.

## Current Status

Quereus is a feature-complete SQL query processor with a modern planner and instruction-based runtime architecture. The engine successfully handles complex SQL workloads including joins, window functions, subqueries, CTEs, constraints, and comprehensive DML/DDL operations.

### Stability

Quereus spans a battle-tested SQL core and several research tracks. Every feature area
carries one of four tiers, which say how much a future release may break you:

| Tier | A breaking change may land in | In short |
| --- | --- | --- |
| **Stable** | a major release only | Build on it. |
| **Beta** | a minor release | Complete and tested; the surface is still being shaped. |
| **Experimental** | **any** release, including a patch | A research track. Prototype on it; expect churn. |
| **Internal** | any release | Engine internals — no user-facing contract. |

A tier is about compatibility, not correctness: a wrong answer is a bug at every tier,
including Experimental. See [Stability Tiers](../../docs/stability.md) for the definitions
and the per-area assignment.

### Capabilities

*   **Modern Type System** — temporal types (DATE, TIME, DATETIME), JSON with deep equality, plugin-extensible custom types
*   **Complete JOIN support** — INNER, LEFT, RIGHT, CROSS, SEMI, and ANTI joins with proper NULL padding
*   **Advanced window functions** — ranking, aggregates, and frame specifications
*   **Full constraint system** — NOT NULL, CHECK, FOREIGN KEY, and CREATE ASSERTION. Row-level constraints that reference other tables are automatically deferred to COMMIT. The `committed.tablename` pseudo-schema provides read-only access to pre-transaction state for transition constraints (e.g., "balance may not decrease"). See [Architecture — Constraints](../../docs/architecture.md#constraints).
*   **Comprehensive subqueries** — scalar, correlated, EXISTS, and IN subqueries
*   **Relational orthogonality** — INSERT/UPDATE/DELETE with RETURNING can be used as table sources
*   **Complete set operations** — UNION, INTERSECT, EXCEPT with proper deduplication
*   **DIFF (symmetric difference)** — `A diff B` equals `(A except B) union (B except A)`, handy for table equality checks via `not exists(A diff B)`
*   **Robust transaction support** — multi-level savepoints and rollback. See [Usage Guide](../../docs/usage.md#transactions) for details
*   **Rich built-in function library** — scalar, aggregate, window, JSON, and date/time functions
*   **Rule-based optimizer** — constant folding, caching, streaming aggregation, bloom-join selection, and correlated subquery decorrelation. See [Architecture — Optimizer](../../docs/architecture.md#optimizer).
*   **Change-scope introspection and reactive subscriptions** — `Statement.getChangeScope()` returns a JSON-serializable description of what base-table state and external inputs a prepared statement reads from. The companion `Database.watch(scope, handler)` consumes any `ChangeScope` value (analyzed, deserialized, or hand-built) and fires a post-commit callback whenever matching rows, groups, or tables change. See [Change-scope Documentation](../../docs/change-scope.md).
*   **Updatable views** *(Beta)* — `insert` / `update` / `delete` propagate through views, non-recursive CTEs, and subqueries in `from` to the underlying base tables (no `instead of` triggers; predicate-driven). Single-source projection-and-filter and multi-source key-preserving inner-join bodies are supported, with `returning`, the core-`select` `with defaults (col = expr, …)` and `with inverse (col = expr, …)` clauses (omitted-insert defaults and authored write-back expressions, both riding the body select), and per-row writable presence/membership columns for write routing. See [View Updateability](../../docs/view-updateability.md).
*   **Materialized views** *(Beta)* — `create materialized view` stores a query body as a keyed backing relation kept consistent with its sources **synchronously, inside the writing transaction** (row-time maintenance — no refresh-policy knob, reads-own-writes), with write-through DML and covering-structure constraint enforcement. See [Materialized Views](../../docs/materialized-views.md).
*   **Logical schemas and lenses** *(Experimental)* — separate an embodiment-free logical design from a module-backed basis, mapped by per-table bidirectional **lenses** built on view updateability. See [Lenses and Layered Schemas](../../docs/lens.md).

[TODO List](../../docs/todo.md) has remaining priorities.

## Supported Built-in Functions

*   **Scalar** — `lower`, `upper`, `length`, `substr`/`substring`, `abs`, `round`, `coalesce`, `nullif`, `like`, `glob`, `typeof`
*   **Aggregate** — `count`, `sum`, `avg`, `min`, `max`, `group_concat`, `json_group_array`, `json_group_object`
*   **Window Functions** — complete implementation with `row_number`, `rank`, `dense_rank`, `ntile` (ranking); `count`, `sum`, `avg`, `min`, `max` with OVER clause (aggregates); full frame specification support (`ROWS BETWEEN`, `UNBOUNDED PRECEDING/FOLLOWING`); `NULLS FIRST/LAST` ordering
*   **Date/Time** — `date`, `time`, `datetime`, `julianday`, `strftime` (supports common formats and modifiers), `epoch_s`, `epoch_ms`, `epoch_s_frac` (Unix epoch conversions with strict parsing)
*   **JSON** — `json_valid`, `json_schema`, `json_type`, `json_extract`, `json_quote`, `json_array`, `json_object`, `json_insert`, `json_replace`, `json_set`, `json_remove`, `json_array_length`, `json_patch`
*   **Query Analysis** — `query_plan`, `scheduler_program`, `execution_trace` (debugging and performance analysis)

## Testing

Tests live in `test/*.spec.ts`, driven by Mocha with ts-node/esm. Run with `yarn test`. Quereus uses SQL logic tests (primary), property-based tests, performance sentinels, unit tests, and a benchmark suite — see [Architecture — Testing Strategy](../../docs/architecture.md#testing-strategy) for details.
