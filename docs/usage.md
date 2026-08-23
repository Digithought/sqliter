# Quereus Usage Guide

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Quereus provides a lightweight, TypeScript-native SQL interface with a focus on virtual tables that can be backed by any data source. This document explains how to use Quereus effectively in your applications.

## Quick Start

Quereus uses native JavaScript types for SQL values. Query results are returned as objects with column names as keys:

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Create a table and insert data
await db.exec("create table users (id integer primary key, name text, email text)");
await db.exec("insert into users values (1, 'Alice', 'alice@example.com')");

// Query returns objects: { id: 1, name: 'Alice', email: 'alice@example.com' }
const user = await db.prepare("select * from users where id = ?").get([1]);
console.log(user.name); // "Alice"

// Iterate over multiple rows
for await (const user of db.eval("select * from users")) {
  console.log(user.name); // Each row is an object
}
```

**Key Points:**
- SQL values use JavaScript types: `string`, `number`, `bigint`, `boolean`, `Uint8Array`, `null`
- Temporal types (DATE, TIME, DATETIME) store values as ISO 8601 strings
- JSON type stores validated JSON strings with deep equality comparison
- BLOBs are `Uint8Array` typed arrays
- Results stream as async iterators - use `for await` to process rows

See [Type System Documentation](types.md) for complete details on types, validation, and conversion functions.

## Basic Usage

### Creating a Database

```typescript
import { Database } from '@quereus/quereus';
// Make sure to import other necessary types if using them directly
// import { type SqlValue, QuereusError, MisuseError } from '@quereus/quereus';

// Create an in-memory database
const db = new Database();
```

### Executing Simple Statements (`db.exec`)

Use `db.exec(sql)` for executing statements without fetching results, especially for DDL (`create`, `drop`), transaction control (`begin`, `commit`), or simple `insert`/`update`/`delete` statements with or without parameters.

A row-returning statement (`select`, `values`, `explain`, or DML with `RETURNING`) still runs to completion under `exec` — its rows are pulled and discarded, so its side effects happen and its errors surface, but the caller never sees the rows. Use `db.eval`/`db.get` to consume them.

```typescript
// Execute DDL
await db.exec("create table users (id integer primary key, name text, email text)");
await db.exec("create index idx_users_email on users(email)");

// Simple INSERT
await db.exec("insert into users (name, email) values (?, ?)", ["User A", "example@sample.com"]);

// Transaction control
await db.exec("begin");
// ... operations ...
await db.exec("commit");
```

### Inserting Data (Recommended: Prepared Statements)

For inserting data, especially multiple rows or with parameters, using prepared statements is safer and often more efficient.

```typescript
// Insert multiple rows with a prepared statement
const stmt = await db.prepare("insert into users (name, email) values (?, ?)");
try {
  await stmt.run(["Alice Smith", "alice@example.com"]);
  await stmt.run(["Bob Johnson", "bob@example.com"]);
} finally {
  await stmt.finalize(); // Always finalize when done
}
```

### Querying Data

Quereus provides several ways to query data, depending on your needs.

#### Iterating Over Results (`db.eval`)

The most idiomatic way to process multiple result rows is using `db.eval`, which returns an async iterator. It automatically handles statement preparation, parameter binding, and finalization.

```typescript
try {
  // Using positional parameters
  for await (const user of db.eval("select name, email from users where status = ? order by name", ["active"])) {
    console.log(`Active user: ${user.name} (${user.email})`);
    // row is Record<string, SqlValue>
  }

  // Using named parameters
  for await (const project of db.eval("select * from projects where owner = :owner and deadline < :date", 
                                    { ":owner": "Alice Smith", ":date": Date.now() })) {
    console.log(`Project: ${project.name}`);
  }

  // No parameters
  for await (const item of db.eval("select * from inventory")) {
     // ...
  }
} catch (e) {
  console.error("Query failed:", e);
  // Handle errors (e.g., QuereusError, MisuseError)
}
```

#### Fetching a Single Row (`stmt.get`)

If you expect only one row (or just need the first one), prepare the statement and use `stmt.get()`.

```typescript
const stmt = await db.prepare("select * from users where id = ?");
try {
  const user = await stmt.get([1]); // Get first row only (or undefined if none)
  if (user) {
    console.log(user.name); // "John Doe"
  }
} finally {
  await stmt.finalize();
}

// Using named parameters
const stmt2 = await db.prepare("select * from users where email = :email");
try {
  const byEmail = await stmt2.get({ ":email": "alice@example.com" });
  // ...
} finally {
  await stmt2.finalize();
}
```

#### Streaming All Rows (`stmt.all`)

The `stmt.all()` method returns an async iterator for streaming results:

```typescript
const stmt = await db.prepare("select * from users where role = ?");
try {
  // Stream rows with for-await
  for await (const admin of stmt.all(["admin"])) {
    console.log(admin.name);
  }
} finally {
  await stmt.finalize();
}
```

To collect all rows into an array, use spread or `Array.fromAsync`:

```typescript
const stmt = await db.prepare("select * from users where role = ?");
try {
  const admins = [];
  for await (const row of stmt.all(["admin"])) {
    admins.push(row);
  }
  console.log(`Found ${admins.length} admins`);
} finally {
  await stmt.finalize();
}
```

#### Cancelling an In-Flight Query (`AbortSignal`)

Every execution entry point accepts a trailing, fully-optional options bag `{ signal }`: the database-level `db.exec`, `db.eval`, and `db.get`, plus the prepared-statement methods `stmt.run`, `stmt.get`, `stmt.iterateRows`, and `stmt.all`. Aborting the signal cancels the in-flight statement cooperatively at the next yield seam: the call rejects with an `AbortError` (`instanceof QuereusError`, `code === StatusCode.ABORT`, `name === 'AbortError'`) and any implicit transaction rolls back. An already-aborted signal rejects before any work starts. Existing call sites are unaffected — omit the bag and behavior is unchanged (the 2-argument forms are preserved).

> **Where cancellation is checked.** Cooperative checkpoints live at three seams:
> the physical table-access leaf (the seq-scan / index-scan / index-seek row loop),
> the statement's output-row boundary (where rows are streamed back to the caller),
> and the DML drain loop (each source row of an `INSERT` / `UPDATE` / `DELETE`,
> which covers a scan-less bulk mutation such as `INSERT … VALUES` or
> `INSERT … SELECT` from a table-valued function or CTE with no base-table read).
> Together these cover every long-running streaming or mutating statement.
>
> What remains uninterruptible by construction is work that happens *inside a
> single instruction* with no `await` seam — a tight CPU-bound computation, an
> in-memory sort over an already-drained array, or a single heavy DDL operation.
> The engine deliberately does **not** poll the signal between scheduler
> instructions: the synchronous fast path cannot observe an abort anyway (the
> timer/microtask that calls `controller.abort()` cannot run while synchronous
> engine code holds the thread), and a between-instruction poll cannot reach the
> intra-instruction loops above, so it would add hot-path cost for no additional
> coverage. Such a statement is checked at the pre-flight boundary and then runs
> to completion once started.

```typescript
import { isAbortError } from 'quereus';

const controller = new AbortController();
setTimeout(() => controller.abort(), 1000); // cancel if it runs too long

try {
  for await (const row of db.eval("select * from big_table", undefined, { signal: controller.signal })) {
    // …
  }
} catch (err) {
  if (isAbortError(err)) {
    console.log("query cancelled");
  }
}

// The same options bag works on a prepared statement:
const stmt = db.prepare("select * from big_table");
try {
  for await (const row of stmt.all([], { signal: controller.signal })) {
    // …
  }
} finally {
  await stmt.finalize();
}
```

Cancellation interrupts *execution* (the row-by-row drain), not an already-started commit: an abort that races a commit is a no-op, so a cancelled write can never leave a partially-committed state. A fully-synchronous, await-free in-memory operator (e.g. an in-memory sort over an already-drained array) is uninterruptible by construction — the drain that *fills* it is interruptible, but the CPU-bound pass itself runs to completion. See [errors.md](./errors.md) for `AbortError` / `isAbortError` / `throwIfAborted`.

#### Concurrent Committed Reads (`readConcurrency`)

By default, every statement — reads included — queues behind the database's execution mutex. That means a read issued while another statement is stuck in a slow virtual-table commit (e.g. a network-backed store) waits for that commit to finish. The same options bag accepts an opt-out for reads that can tolerate slightly stale data:

```typescript
// Runs immediately against the last COMMITTED state, even while a write is
// mid-commit — instead of waiting its turn behind the mutex.
const row = await db.get("select count(*) as n from t", undefined, { readConcurrency: 'committed' });
```

- `'serialized'` (default) — queue behind the mutex, exactly as today.
- `'committed'` — when the statement is *eligible*, run WITHOUT the mutex against each table's last committed state. An ineligible statement silently falls back to `'serialized'` — opting in is never an error.

Eligibility (all must hold): the query is read-only; no explicit `BEGIN` is open (a read inside your own transaction must see the transaction's writes, so it always serializes); for `db.eval`, the SQL is a single statement (a `select; insert; select` batch falls back wholesale); every table read resolves to a module that declares `readCommittedSnapshot` (the in-memory module qualifies, as does the `@quereus/isolation` wrapper *over* a qualifying module, since it mirrors what it wraps; store-backed modules currently do not — reads on them just keep serializing); and the query calls no table-valued function, because a table-valued function reaches its data outside the module check above and some of them (the tracing ones) run arbitrary SQL of their own.

**The tradeoff — read this before opting in.** `'committed'` deliberately gives up an ordering guarantee you may be relying on without realizing it: after `void db.exec(insert)` (unawaited), an opted-in `await db.get(select)` may answer from the *pre-insert* state, because the read no longer waits for the write to land. If you need read-your-writes ordering, either `await` the write first or use the default. That footgun is exactly why the opt-in is per call and there is no database-wide switch.

**One prepared statement, one execution at a time.** A `Statement` holds per-execution state (its bound arguments, its busy flag), so overlapping executions of the *same* prepared statement throw `Statement busy` — the execution mutex used to make that impossible to hit, and mutex-free reads expose it. Give each concurrent caller its own statement; `db.get` and `db.eval` prepare per call and are unaffected.

Honored by the row-returning entry points: `db.get`, `db.eval`, and the prepared-statement `stmt.get`, `stmt.all`, `stmt.iterateRows`, `stmt.run`. `db.exec` ignores the option (it returns no rows, and its per-statement transaction loop is exactly what the mutex-free path must not touch). A caller `signal` combines with the option normally, and `db.close()` aborts any in-flight concurrent read at its next row boundary. See [SQL Transactions § Concurrent committed reads](sql-txn.md#86-concurrent-committed-reads) for the transaction-interaction details and [Committed-Snapshot Reads](module-committed-reads.md) for the module contract.

### Transactions

Quereus supports explicit transaction control using `BEGIN`, `COMMIT`, and `ROLLBACK`. Additionally, both `db.exec()` and `statement.run()` automatically wrap their execution in implicit transactions when in autocommit mode.

#### Implicit Transactions

When not in an explicit transaction (autocommit mode), both `db.exec()` and `statement.run()` automatically wrap their execution in an implicit transaction:

```typescript
// db.exec() - each statement is its own implicit transaction
await db.exec("insert into users (name) values ('User 1')");
// Automatically committed after successful execution

// statement.run() - wraps execution in transaction
const stmt = db.prepare("insert into users (name) values (?)");
await stmt.run(["User 2"]);
await stmt.finalize();
// Automatically committed after successful execution

// Multiple statements in one db.exec() are NOT atomic as a batch: matching
// SQLite autocommit, each statement commits or rolls back on its own.
await db.exec(`
  insert into users (name) values ('User 3');
  insert into users (name) values ('User 4');
`);
// If the second statement fails, the first stays committed.
// Wrap the batch in begin/commit for all-or-nothing.

// On error, implicit transactions automatically rollback
try {
  await db.exec("insert into users (id, name) values (1, 'User 5')");
  await db.exec("insert into users (id, name) values (1, 'Duplicate')"); // Error!
} catch (e) {
  // Second exec() was automatically rolled back
}
```

#### Explicit Transactions

For fine-grained control, use explicit transaction commands:

```typescript
// Simple transaction
await db.exec("begin transaction");
try {
  await db.exec("insert into users (name) values (?)", ["User 1"]);
  await db.exec("insert into users (name) values (?)", ["User 2"]);
  await db.exec("commit");
} catch (e) {
  await db.exec("rollback");
  throw e;
}

// Transaction with savepoints
await db.exec("begin transaction");
try {
  await db.exec("insert into users (name) values (?)", ["User 3"]);
  
  await db.exec("savepoint save1");
  try {
    await db.exec("insert into users (name) values (?)", ["User 4"]);
    // Some condition to decide whether to keep these changes
    if (shouldRollback) {
      await db.exec("rollback to save1");
    } else {
      await db.exec("release save1");
    }
  } catch (e) {
    await db.exec("rollback to save1");
    // Continue with the outer transaction
  }
  
  await db.exec("commit");
} catch (e) {
  await db.exec("rollback");
  throw e;
}

// Within explicit transactions, no nested implicit transactions occur
await db.exec("begin");
const stmt = db.prepare("insert into users (name) values (?)");
await stmt.run(["User 5"]); // No implicit transaction - part of explicit one
await stmt.run(["User 6"]); // Same transaction
await stmt.finalize();
await db.exec("commit"); // Commits both inserts
```

## Event System

Quereus provides a database-level event system for reactive applications. Events are emitted for data changes (inserts, updates, deletes) and schema changes (table/index/column creation, alteration, dropping) across all virtual table modules.

### Subscribing to Data Changes

```typescript
const unsubscribe = db.onDataChange((event) => {
  console.log(`${event.type} on ${event.schemaName}.${event.tableName}`);
  console.log(`Module: ${event.moduleName}, Remote: ${event.remote}`);

  if (event.type === 'update') {
    console.log('Changed columns:', event.changedColumns);
    console.log('Old row:', event.oldRow);
    console.log('New row:', event.newRow);
  }
});

// Perform some operations
await db.exec("insert into users (id, name) values (1, 'Alice')");
// Event fires: { type: 'insert', tableName: 'users', ... }

// Unsubscribe when done
unsubscribe();
```

The `DatabaseDataChangeEvent` interface:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'insert' \| 'update' \| 'delete'` | The mutation operation |
| `moduleName` | `string` | The virtual table module that raised the event |
| `schemaName` | `string` | Schema containing the table |
| `tableName` | `string` | Table name |
| `key` | `SqlValue[]` | Primary key values projected out of the event's **own** row image (`newRow` for insert/update, `oldRow` for delete), under the primary key the table has at delivery |
| `oldRow` | `Row` | Previous row data (for update/delete) |
| `newRow` | `Row` | New row data (for insert/update) |
| `changedColumns` | `string[]` | Column names that changed (for updates) |
| `remote` | `boolean` | `true` if the change originated from a sync/remote source |

`oldRow` / `newRow` are **positional**: pair value *i* with column *i* of the table's schema.
The engine guarantees that pairing is safe **at delivery time**: every event a commit delivers
describes its rows in the schema current at delivery — even when the transaction changed the
table's columns (`ALTER TABLE ADD/DROP/RENAME COLUMN`, `ALTER COLUMN … SET DATA TYPE` /
`SET NOT NULL`) *after* recording the write. Events recorded before such an ALTER are rewritten
to the post-ALTER shape before the commit delivers them, and `changedColumns` only ever names
columns that exist in that schema (a `RENAME COLUMN` moves no value, so only the name changes).

`tableName` is as-of-delivery in the same way: a mid-transaction `ALTER TABLE … RENAME TO`
relabels the events the transaction already recorded, so every event a commit delivers names
the table as it exists at that moment — never a name the rename has already retired. Renames
compose within a transaction (`t` → `t2` → `t3` delivers `t3`), and a rename that happens
*between* transactions changes nothing about events already delivered, which correctly carry
the name the table had when they were delivered. `key` and `oldRow`/`newRow` are untouched by
a rename, which moves no value.

`key` addresses exactly one row, and an `update` never moves it. Every producer follows the
same two clauses, so a listener can treat `key` as the row's identity without knowing anything
about the table's schema:

1. **`key` is the primary key projected out of the event's own row image** — out of `newRow`
   for an `insert` and an `update`, out of `oldRow` for a `delete`. An update therefore keys by
   the row's *post*-image, which is the row the table now holds.
2. **An `update` never moves a row.** When a statement changes a primary key such that the row
   *relocates* — its key values differ under the primary key's own comparator, which is
   per-column collation- and type-aware, not byte identity — the producer delivers a `delete`
   at the old key followed by an `insert` at the new key, **in that order**, instead of one
   `update`. A rewrite that leaves the row where it was stays a single `update`: under a
   `NOCASE` primary key, `update t set k = 'APPLE' where k = 'apple'` moves nothing, so it is
   one `update` whose `key` is the post-image `['APPLE']` the table now stores.

The split is what lets a plain listener retire the old identity. `update t set a = 2 where a =
1` on a table keyed by `a` delivers `delete key: [1]` then `insert key: [2]`, so a cache or a
change log keyed by `key` drops row `1` and adds row `2` without having to know which columns
form the key — which the event does not carry. The cost is deliberate: a relocating update
carries no `changedColumns` and no "these two events are the same row" link. **Ordering is
guaranteed; adjacency is not** — other events may be delivered between the `delete` and the
`insert`, so do not pair them positionally.

`key` is as-of-delivery too: it holds the values of the primary key the table has **at
delivery**, so a consumer that addresses rows by `key` (an incremental cache, a sync change
log) can always pair the event with a row the table now contains. A mid-transaction `ALTER
TABLE … ALTER PRIMARY KEY` re-derives the `key` of every event the transaction already
recorded, projecting it out of that event's own row image — widening `(a)` to `(a, b)` turns
a recorded `[1]` into `[1, 9]`, and narrowing turns `[1, 9]` back into `[1]`. Without that,
the delivered key would carry the retired key's arity and match no row at all. As with the
other two families, an ALTER PRIMARY KEY *between* transactions leaves already-delivered
events alone: they correctly carry the key the table had at the time. A `RENAME TO` still
leaves `key` untouched (it moves no value); only an ALTER PRIMARY KEY rewrites it.

One statement raises **no** data events even though it moves every row: `ALTER TABLE … ALTER
PRIMARY KEY` on a backend that cannot re-key in place falls back to an engine-internal rebuild
(copy every row into a shadow table with the new key, then swap it in), and that rebuild is
deliberately silent on all three channels. A re-key changes no row, so announcing the copy as a
row-per-`insert` would be wrong. See [`sql-alter.md`](sql-alter.md) § ALTER PRIMARY KEY. Both
built-in modules re-key in place and never take that path.

`changedColumns` is present on an update event only if the owning module supplies it — the
memory module and the engine's auto-event path do; the store module deliberately omits it and
leaves the per-column diff to the consumer. That per-module choice is stable: a mid-transaction
ALTER re-derives an existing `changedColumns`, but never synthesizes one that was absent.

### Subscribing to Schema Changes

```typescript
const unsubscribe = db.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
  if (event.ddl) {
    console.log('DDL:', event.ddl);
  }
});

await db.exec("create table orders (id integer primary key, total real)");
// Event fires: { type: 'create', objectType: 'table', objectName: 'orders', ... }

unsubscribe();
```

The `DatabaseSchemaChangeEvent` interface:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'create' \| 'alter' \| 'drop'` | The schema operation |
| `objectType` | `'table' \| 'index' \| 'column'` | Type of object modified |
| `moduleName` | `string` | The module that raised the event |
| `schemaName` | `string` | Schema name |
| `objectName` | `string` | Object name (table or index name) |
| `oldObjectName` | `string` | Previous table name (`alter table … rename to` only) |
| `columnName` | `string` | Column name (for column operations) |
| `oldColumnName` | `string` | Previous column name (for renames) |
| `ddl` | `string` | DDL statement if available |
| `remote` | `boolean` | `true` if the change originated from a remote source |

#### Every DDL statement announces on its success path only

A schema-change event is raised **only** for a statement that succeeded. A DDL statement that
throws announces nothing at all, on every backend — no matter how far it got before failing.

This is not free, and it is worth knowing why the engine has to work for it. Some statements
do their announcing part-way through, so a later failure has to take the announcement back:

- `create table … maintained as <body>` (and `create materialized view`) creates the backing
  table first and fills it afterwards. If the body's rows violate a `CHECK` the declaration
  itself asked for, or produce duplicate keys, the statement fails and the engine drops the
  backing table again. Without retraction you would be told a table was created and then
  dropped — and a peer device replicating those events would build and destroy a real table
  for a statement that did nothing.
- `alter table … add column <inline constraint>` on a backend that emits for itself announces
  from inside its own storage call, before the engine installs the inline constraint. A
  constraint that the backfilled rows violate unwinds the whole column.

The engine scopes each DDL statement's schema events and retracts them as the error
propagates, so both cases announce nothing. Like every other event, delivery of a successful
statement's event is batched to commit and dropped on rollback.

One deliberate exception: a declarative `apply schema` runs its generated migration DDL as
ordinary statements, and a migration that fails part-way leaves the statements before the
failure **applied**. Those really happened, so they stay announced; only the statement that
failed retracts its own. See § [Declarative Schema Workflow](#declarative-schema-workflow).

#### What each `ALTER TABLE` arm reports

Every structural `ALTER TABLE` arm raises exactly **one** event, whether or not the storage
backend ships an emitter of its own — a backend without one is covered by the engine's own
fallback, so a subscriber sees the same facts either way:

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename to` | `alter` | `table` | **new** table name (`oldObjectName` = old) | — | — |
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` (all four attribute forms) | `alter` | `column` | table | altered column | — |
| `alter primary key` | `alter` | `table` | table | — | — |
| `add constraint` | `alter` | `table` | table | — | — |
| `drop constraint` | `alter` | `table` | table | — | — |
| `rename constraint` | `alter` | `table` | table | — | — |

Note `drop column` reports `type: 'drop'`, not `'alter'` — the arm removes an object.

Every arm above also sets `ddl` to the statement's **canonical, schema-qualified SQL** — the
text a replicating peer re-executes to reproduce the alteration. The engine renders it once at
plan-build time from the *resolved* table, so `alter table orders …` on a table in schema `sales`
announces `alter table sales.orders …` regardless of how you spelled it; statement keywords are
lowercased, while identifier and data-type casing is preserved as written.

`add column` with inline constraints (`add column w text null unique`) reports **one** event on
either path, carrying the whole statement's text. A backend that emits for itself makes an extra
internal `addConstraint` round-trip per inline constraint, but those calls are marked
engine-internal and announce nothing.

The event is raised on the statement's **success** path only — an ALTER that throws announces
nothing at all, on every backend, including when the failure lands *after* a self-emitting
backend has already announced the change. That is the general DDL rule above (§ [Every DDL
statement announces on its success
path only](#every-ddl-statement-announces-on-its-success-path-only)), not an ALTER-specific one.

Two arm families report nothing on either path: the metadata-tag arms (`set tags`, `add tags`,
`drop tags`) and the materialized-view lifecycle arms (`set maintained`, `drop maintained`).
Both are catalog-only and no backend announces them.

A declarative `apply schema` runs its generated migration DDL through the ordinary statement
path, so each `alter table` the differ generates reports exactly as if you had typed it —
alongside the `create` / `drop` events the same apply already raised.

`ALTER TABLE … ALTER PRIMARY KEY` on a backend that cannot re-key in place reports its one
`alter`/`table` event like any other backend, but stays silent about the engine-internal rebuild
that carries it out (see above, and [`sql-alter.md`](sql-alter.md) § ALTER PRIMARY KEY): that rebuild
runs with this channel suppressed, so a subscriber that mirrors the catalog is never told that a
machine-named `<table>__rekey_<ms>` shadow table was created and the real one dropped — neither
of which is a change the application made.

### Per-Table Subscription via `db.getTable(...)`

`Database.getTable(schemaName, tableName)` returns a public `Table` handle (or `undefined` if the table does not exist). The handle exposes the underlying module's event emitter:

```typescript
const table = db.getTable('main', 'users');
const tableEmitter = table?.getEventEmitter();

const off = tableEmitter?.onDataChange?.((event) => {
  // event.tableName is the source table — filter when you only care about one
  if (event.tableName === 'users') {
    console.log('users changed:', event);
  }
});

// Later
off?.();
```

Notes:

- The emitter is **module-scoped**: it is the same instance shared by every table that lives under the same virtual table module. Callbacks fire for changes to any table in that module, so consumers must filter by `schemaName`/`tableName` if they only care about a single table.
- When the module does not provide an event emitter, `getEventEmitter()` returns `undefined`. Fall back to the database-level `db.onDataChange()` / `db.onSchemaChange()` listeners — the engine populates those automatically for modules without native event support.
- The handle is a snapshot taken at `db.getTable()` time. If the table is dropped or replaced, the emitter reference remains valid (the module outlives individual tables) but no further events for that specific table will be produced. Re-acquire the handle after schema changes if you need a fresh view.

### Transaction Batching

Events are batched within transactions and delivered only after a successful commit. On rollback, batched events are discarded. This ensures listeners see a consistent view of committed data.

```typescript
db.onDataChange((event) => {
  console.log('Change committed:', event.type, event.tableName);
});

await db.exec("begin");
await db.exec("insert into users (id, name) values (1, 'Alice')");
await db.exec("insert into users (id, name) values (2, 'Bob')");
// No events emitted yet — still in transaction
await db.exec("commit");
// Both insert events delivered now, after commit

await db.exec("begin");
await db.exec("insert into users (id, name) values (3, 'Charlie')");
await db.exec("rollback");
// No events — transaction was rolled back
```

Savepoint semantics are also supported: events within a savepoint are tracked separately and discarded on `ROLLBACK TO SAVEPOINT` or merged on `RELEASE`.

For module-level event integration (implementing events in custom virtual table modules), see [Database-Level Event System](./module-events.md).

## Database Options

Quereus has a centralized options system accessible both programmatically and via SQL `pragma` statements.

### Programmatic Access

```typescript
// Set an option
db.setOption('default_column_nullability', 'nullable');

// Get an option
const nullability = db.getOption('default_column_nullability');
console.log(nullability); // 'nullable'
```

### SQL Pragma Equivalence

```sql
-- Set via pragma
pragma default_column_nullability = 'nullable';

-- Read via pragma
pragma default_column_nullability;
```

### Available Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema_path` | string | `'main'` | Comma-separated schema search path for unqualified relation (table / view) names. Alias: `search_path` |
| `default_column_nullability` | string | `'not_null'` | Default nullability for columns: `'not_null'` (Third Manifesto) or `'nullable'` (SQL standard). Aliases: `column_nullability_default`, `nullable_default` |
| `default_vtab_module` | string | `'memory'` | Default virtual table module used for `create table` without `using` clause |
| `default_vtab_args` | object | `{}` | Default arguments passed to the default virtual table module |
| `foreign_keys` | boolean | `true` | Enable foreign key constraint enforcement. When omitted, ON DELETE / ON UPDATE default to RESTRICT. Alias: `fk_enforcement` |
| `runtime_stats` | boolean | `false` | Enable runtime execution statistics collection. Alias: `runtime_metrics` |
| `validate_plan` | boolean | `false` | Enable plan validation before execution. Alias: `plan_validation` |
| `trace_plan_stack` | boolean | `false` | Enable plan stack tracing for debugging (also disables scalar fusion) |
| `runtime_fuse_scalars` | boolean | `true` | Compile pure synchronous scalar expression subtrees into single fused closures instead of per-row sub-programs (see `docs/runtime.md` § Scalar fusion). Kill switch for bisecting a suspected fusion bug; baked into a prepared statement at emit time, so recompile to pick up a change |
| `auto_analyze` | boolean | `true` | Track how many distinct rows each table has had changed by committed transactions since its statistics were last collected, and refresh those statistics in the background once the drift crosses the threshold below. When off, no counting and no refreshing happens at all; turning it back on mid-session resumes from whatever each table's count already was, without reconstructing the mutations missed while it was off. See `docs/sql-txn.md` §9.5 |
| `auto_analyze_min_mutations` | number | `500` | Absolute floor for the staleness threshold, in distinct changed rows. Positive integer. Governs on its own for a never-analyzed table, whose known row count is 0 |
| `auto_analyze_ratio` | number | `0.2` | Fraction of the known row count that must change before statistics are stale. Finite and greater than 0. Combined with the floor as `max(min_mutations, ratio × knownRowCount)` |
| `auto_analyze_row_limit` | number | `100000` | Largest table (in known rows) an automatic statistics refresh will scan; a larger table is left to an explicit `ANALYZE`, and the skip is logged once. Set to 0 to disable the cap. A table nobody has analyzed yet reports 0 known rows, so its first automatic refresh is not size-gated |

### Type-Safe Getters

The options manager provides type-safe accessors for common option types:

```typescript
// These are available on the internal options manager
// and throw if the option has an unexpected type
db.getOption('foreign_keys');                    // returns OptionValue
// For type-safe access within modules/extensions:
// options.getBooleanOption('foreign_keys')       → boolean
// options.getStringOption('schema_path')         → string
// options.getObjectOption('default_vtab_args')   → Record<string, SqlValue>
```

## Database API Reference

### `db.exec(sql: string, params?: SqlParameters, options?: StatementOptions): Promise<void>`
Executes one or more SQL statements separated by semicolons. Primarily intended for DDL, transaction control, or DML without results. Supports optional parameters and an optional `{ signal }` for cooperative cancellation (see [Cancelling an In-Flight Query](#cancelling-an-in-flight-query-abortsignal)).

**Implicit Transaction Behavior:** When in autocommit mode (not within an explicit `BEGIN...COMMIT`), `exec()` automatically wraps the entire batch of statements in an implicit transaction. All statements commit together on success, or all rollback on error. This provides batch-level atomicity.

### `db.prepare(sql: string): Statement`
Prepares an SQL statement for execution, returning a `Statement` object. This is the entry point for using the `Statement` API (`run`, `get`, `all`, `bind`, etc.).

### `db.get(sql: string, params?: SqlParameters, options?: StatementOptions): Promise<Record<string, SqlValue> | undefined>`
Convenience method to execute a query and return the first result row, or undefined if no rows. Equivalent to `db.prepare(sql).get(params, options)`. Accepts an optional `{ signal }` for cooperative cancellation (see [Cancelling an In-Flight Query](#cancelling-an-in-flight-query-abortsignal)).

```typescript
const user = await db.get("select * from users where id = ?", [1]);
```

### `db.eval(sql: string, params?: SqlParameters, options?: StatementOptions): AsyncIterable<Record<string, SqlValue>>`
A high-level async generator for executing a query and iterating over its results. Handles statement preparation, parameter binding, and automatic finalization. Accepts an optional `{ signal }` for cooperative cancellation (see [Cancelling an In-Flight Query](#cancelling-an-in-flight-query-abortsignal)).

### `db.beginTransaction()`, `db.commit()`, `db.rollback()`
Standard transaction control methods.

### `db.getTable(schemaName: string | undefined, tableName: string): Table | undefined`
Returns a public handle to a table for inspection and per-table event subscription, or `undefined` if the table does not exist or its owning module is not registered. The handle exposes `schemaName`, `tableName`, `schema`, `moduleName`, and `getEventEmitter()`. See the [Event System / Per-Table Subscription](#per-table-subscription-via-dbgettable) section for details and lifecycle caveats.

### `db.registerModule(...)`, `db.createScalarFunction(...)`, `db.createAggregateFunction(...)`, `db.registerCollation(...)`
Methods for extending database functionality.

#### Shadowing a built-in function

Function registration overwrites by `name`/argument-count, so `db.createScalarFunction('upper', …)` or `db.createAggregateFunction('min', …)` **replaces** the built-in of that name for every query on the connection. Optimizer rewrites whose soundness depends on a built-in's own semantics detect the shadow by schema identity — not by name — and decline, so those queries stay correct and merely lose the speedup (`ruleMinMaxIndexBoundary` and `ruleGroupByFdSimplification`; see [Optimizer Rules](optimizer-rules.md)).

The same identity check covers the **materialized-view query rewrite**. A grouped MV's backing rows were produced by whichever functions were registered when the view's maintenance plan was built; the rewrite records those registrations and compares them against the live ones, so taking over the name of an aggregate a view stores (e.g. registering your own `sum` when an MV holds `sum(x)`) makes covered queries decline the rewrite and compute from the base tables — the same answer your function gives everywhere else, just without the speedup (see [Materialized Views § Aggregate rollup](materialized-views.md#aggregate-rollup-indexed-view-matching)).

Two limits worth knowing. The check is by object identity, which cannot survive a process boundary: on a fresh connection over persisted state the recorded registrations are whatever is registered at that point, so re-registering a *user* function under the same name on a later run is indistinguishable from registering the same function again — the engine cannot tell you whether the code behind the name changed. And the view's **maintenance** side still runs the plan compiled at registration, so rows written after you take over a name are maintained with the previous function's semantics until the view is refreshed or re-registered.

#### `db.registerCollation(name, comparator, optionsOrNormalizer?)`

Registers a comparison rule for text. `NOCASE` and `RTRIM` may be overridden; `BINARY` may not. The third argument is either a bare key normalizer (legacy positional form) or an options object:

```typescript
db.registerCollation('NOCASE', comparator, {
  normalizer,             // (s: string) => string
  replicable: true,       // bit-identical across peers/platforms/app-versions
  orderPreserving: true,  // normalizer preserves ORDER, not just equality
});
```

- **`normalizer`** — rewrites a string into a canonical form, so two strings the comparator calls equal always rewrite to the same form. Required for the collation to key a compound index or a persisted structure; `order by` and standalone comparisons work without it.
- **`replicable`** — asserts the collation is bit-identical across peers, platforms, and app versions (not merely deterministic). Consulted by the materialized-view gate when a backing host declares `requiresReplicableDerivations`.
- **`orderPreserving`** — asserts the normalizer preserves order: for all strings `x`, `y`, `sign(comparator(x, y))` equals `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`. This is strictly stronger than the equality promise `normalizer` alone makes; a normalizer can agree with its comparator on equality and still disagree on order.

Both assertions default to `false` for a custom collation and are stamped `true` on the three built-ins. `orderPreserving` matters for persistent storage: a store physically orders rows by normalized key bytes, so it may only seek a byte range — or advertise byte order as collation order — for a collation carrying the assertion. Without it, queries stay **correct** and simply run a full scan with a comparator-accurate filter instead of a seek. See [store.md § Order preservation](./store.md#order-preservation).

### `db.setInstructionTracer(tracer: InstructionTracer | undefined)`
Sets an instruction tracer for debugging and performance analysis. The tracer receives callbacks for every instruction executed, enabling detailed visibility into query execution.

```typescript
import { CollectingInstructionTracer } from '@quereus/quereus';

// Enable tracing with the built-in collecting tracer
const tracer = new CollectingInstructionTracer();
db.setInstructionTracer(tracer);

// Execute queries — trace events are collected
await db.exec("select * from users where id = 1");

// Inspect collected events
const events = tracer.getTraceEvents();
for (const event of events) {
  console.log(`[${event.type}] instruction ${event.instructionIndex}: ${event.note}`);
}

// Disable tracing
db.setInstructionTracer(undefined);
```

#### Debug Table-Valued Functions

Quereus provides built-in debug TVFs for query analysis. Each takes a SQL string and returns a table of diagnostic information:

| Function | Description |
|----------|-------------|
| `query_plan(sql)` | Shows the logical/physical plan tree with estimated costs and row counts |
| `scheduler_program(sql)` | Shows the compiled instruction sequence with dependencies |
| `execution_trace(sql)` | Executes the query and returns per-instruction timing, inputs, and outputs |
| `row_trace(sql)` | Executes the query and returns row-level data flow through each instruction |
| `stack_trace(sql)` | Shows the planning call stack for the query |

```typescript
// Inspect the query plan
for await (const node of db.eval("select * from query_plan('select * from users where id = 1')")) {
  console.log(`${' '.repeat(node.subquery_level * 2)}${node.op}: ${node.detail}`);
  console.log(`  Cost: ${node.est_cost}, Rows: ${node.est_rows}`);
}

// Analyze execution performance
for await (const step of db.eval("select * from execution_trace('select * from users where id > 5')")) {
  console.log(`Instruction ${step.instruction_index}: ${step.operation}`);
  if (step.duration_ms !== null) {
    console.log(`  Duration: ${step.duration_ms}ms`);
  }
}

// Trace row-level data flow
for await (const row of db.eval("select * from row_trace('select name from users order by name')")) {
  console.log(`Instruction ${row.instruction_index} row ${row.row_index}: ${row.row_data}`);
}
```

See [Functions Reference](./functions.md) for complete debug function column schemas.

### `db.setSchemaPath(paths: string[])`
Sets the default schema search path for resolving unqualified table names. This is a convenience method equivalent to `PRAGMA schema_path`.

```typescript
// Set search path programmatically
db.setSchemaPath(['main', 'extensions', 'plugins']);

// Now unqualified tables search in order: main → extensions → plugins
for await (const user of db.eval('select * from users')) {
  console.log(user);
}
```

### `db.getSchemaPath(): string[]`
Returns the current schema search path.

```typescript
const path = db.getSchemaPath();
console.log(path); // ['main', 'extensions', 'plugins']
```

### `db.close()`
Closes the database connection and finalizes all open statements.

## Statement API Reference

Prepared statements provide methods for executing parameterized SQL.

#### `stmt.run(params?: SqlValue[] | Record<string, SqlValue>, options?: StatementOptions): Promise<void>`

Executes the statement until completion, ignoring any result rows. Ideal for INSERT, UPDATE, or DELETE operations. Accepts an optional `{ signal }` for cooperative cancellation (see [Cancelling an In-Flight Query](#cancelling-an-in-flight-query-abortsignal)).

**Implicit Transaction Behavior:** When in autocommit mode (not within an explicit `BEGIN...COMMIT`), `run()` automatically wraps its execution in an implicit transaction. The statement commits on success, or rolls back on error.

```typescript
await stmt.run(["param1", 42]); // Positional parameters
await stmt.run({ ":name": "Alice", ":age": 30 }); // Named parameters
```

#### `stmt.get(params?: SqlValue[] | Record<string, SqlValue>, options?: StatementOptions): Promise<Record<string, SqlValue> | undefined>`

Executes the statement and returns the first result row as an object, or undefined if no rows are returned. Accepts an optional `{ signal }` for cooperative cancellation (see [Cancelling an In-Flight Query](#cancelling-an-in-flight-query-abortsignal)).

```typescript
const user = await stmt.get([1]); // e.g., "select * from users where id = ?"
if (user) {
  console.log(user.name, user.email);
}
```

#### `stmt.all(params?: SqlValue[] | Record<string, SqlValue>, options?: StatementOptions): AsyncIterable<Record<string, SqlValue>>`

Returns an async iterator over all result rows. Use `for await` to stream results. Accepts an optional `{ signal }` for cooperative cancellation (see [Cancelling an In-Flight Query](#cancelling-an-in-flight-query-abortsignal)). (`stmt.iterateRows` accepts the same options bag and returns raw `Row` arrays instead of objects.)

```typescript
for await (const user of stmt.all([30])) {
  console.log(user.name);
}
```

#### `stmt.bind(key: number | string, value: SqlValue): stmt`

Binds a single parameter by position (1-based) or name. Returns the statement for chaining.

```typescript
stmt.bind(1, "value"); // Bind first parameter
stmt.bind(":name", "John"); // Bind named parameter
```

#### `stmt.bindAll(params: SqlValue[] | Record<string, SqlValue>): stmt`

Binds multiple parameters at once. Returns the statement for chaining.

```typescript
stmt.bindAll([1, "text", null]); // Positional
stmt.bindAll({ ":id": 1, ":name": "John" }); // Named
```

Parameter types are inferred from the values bound (or supplied to `db.prepare(sql, params)`)
and are frozen at the statement's first compilation — later binds must stay type-compatible
or they are rejected. Inspecting a freshly prepared statement before binding anything (e.g.
`stmt.getColumnDefs()`) compiles it with no values to infer from, leaving its parameters at
the default `TEXT` type; bind first if you need the announced types to reflect the values.

#### `stmt.reset(): Promise<void>`

Resets the statement to its initial state, ready to be re-executed with new parameters.

#### `stmt.finalize(): Promise<void>`

Releases all resources associated with the statement. The statement cannot be used after finalizing.

#### `stmt.getWorkCounters(): WorkCounterSnapshot | undefined`

How much work the most recent execution did — per-instruction execution, input and
output counts, per-table access counts, plus totals — as counts only, so the same
statement over the same data reports identically on every machine. Requires the
`runtime_stats` option (alias `runtime_metrics`); returns `undefined` when it is off.
Counts are complete only once the row iterable has been fully drained: breaking out
early leaves a partial snapshot.
See [Runtime Work Counters](runtime-work-counters.md).

`snapshot.tables` is keyed by lowercased `<schema>.<table>`, each entry carrying
`queryCalls`, `rowsScanned` and `updateCalls`. These measure the calls the *engine*
made into a virtual-table module, so they work for every module without any
per-module cooperation — but they do not see what a module does internally, so a
module that batches its own storage reads moves none of them.

```typescript
db.setOption('runtime_metrics', true);
const stmt = db.prepare('select a from t');
for await (const _row of stmt.all()) { /* drain */ }
console.log(stmt.getWorkCounters()?.totals);
```

#### `stmt.getPlanShape(): PlanShape`

Node count and per-node-type tallies for the statement's plan. Available straight
after preparing — no execution and no metrics option needed.

## Change-scope introspection

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

`Statement.getChangeScope(params?)` returns a JSON-serializable `ChangeScope`
describing what base-table state and external inputs the statement reads
from. The result is a static analysis — sound but conservative — and is
the public projection of the binding analysis used by assertions and
reactive watches. See [Change-scope Documentation](change-scope.md)
for the full data contract.

### Analyzer-only

```typescript
import {
    analyzeChangeScope,
    serializeChangeScope,
    unionScopes,
    bindParameters,
} from '@quereus/quereus';

// Per-prepared-statement.
await db.exec('create table orders (id integer primary key, total integer)');
const stmt = db.prepare('select total from orders where id = ?');
const scope = stmt.getChangeScope();
// scope.watches[0] === { table: { schema: 'main', table: 'orders' },
//                        columns: Set{'total'},
//                        scope: { kind: 'rows', key: ['id'],
//                                 values: [[{ kind: 'param', index: 1, type: {...} }]] } }
// scope.unboundParameters === [1]

// Substitute the parameter and clear the placeholder.
const bound = stmt.getChangeScope([42]);
// bound.watches[0].scope.values === [[42]]
// bound.unboundParameters === []
```

### Composition

```typescript
const sA = db.prepare('select * from t where id = 1').getChangeScope();
const sB = db.prepare('select * from t where id = 2').getChangeScope();
const merged = unionScopes(sA, sB);
// merged.watches[0].scope.values === [[1], [2]]

const wire = JSON.stringify(serializeChangeScope(merged));
// ...ship `wire` somewhere...
```

### Reactive subscriptions (`Database.watch`)

`Database.watch(scope, handler)` registers a post-commit callback
driven by any `ChangeScope` value — analyzed, deserialized, or
hand-built. The watcher is plan-independent: nothing in its design
ties to a particular `Statement`.

```typescript
import { Database, type ChangeScope, type WatchEvent } from '@quereus/quereus';

const db = new Database();
await db.exec('create table t (id integer primary key, v text)');

// Hand-built scope: "watch row id=7 on table t." No Statement needed.
const scope: ChangeScope = {
    watches: [{
        table: { schema: 'main', table: 't' },
        columns: new Set(['id', 'v']),
        scope: { kind: 'rows', key: ['id'], values: [[7]] },
    }],
    nonDeterministicSources: [],
    unboundParameters: [],
};

const sub = db.watch(scope, (event: WatchEvent) => {
    console.log(`watch ${sub.id} fired in ${event.txnId}`);
    for (const m of event.matched) {
        console.log(`  ${m.watch.table.schema}.${m.watch.table.table} hits=${JSON.stringify(m.hits)}`);
    }
});

await db.exec("insert into t values (7, 'seven')");
// → watch fired with hits=[[7]]

sub.unsubscribe();
```

End-to-end with the analyzer:

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();
await db.exec('create table orders (id integer primary key, total integer)');
const stmt = db.prepare('select total from orders where id = ?');

// Statement.getChangeScope() returns a parameter-aware ChangeScope; passing
// values resolves placeholders so `db.watch` accepts it without further
// `bindParameters` calls.
const scope = stmt.getChangeScope([42]);
const sub = db.watch(scope, (event) => {
    console.log(`order #42 changed in ${event.txnId}`);
});
await stmt.finalize();
// later... await db.exec('update orders set total = 100 where id = 42'); // fires
```

The handler fires once per successful commit and receives every
`MatchedWatch` for that transaction in a single event. Handler
errors are logged but do not roll the commit back (assertions enforce;
watchers observe). See [change-scope.md](change-scope.md) for the
full firing semantics, schema-change invalidation policy, and the
list of v1 limitations.

For tables backed by a replicated/external store (e.g. an optimystic
vtab) that learns of remote writes out-of-band — changes that never
touch this `Database`'s commit change-log — call
`db.notifyExternalChange(tableName, schemaName?)` to fire every watcher
on that table as if the whole table changed. It is coarse by design
(table-granular, no key narrowing); see the *External / out-of-band
changes* section of [change-scope.md](change-scope.md).

## Virtual Tables

One of Quereus's key features is its support for virtual tables, which allow you to expose any data source as a SQL table.

### Creating virtual tables

The explicit way to create a virtual table is using the `create table ... using module_name(...)` syntax. The arguments passed to the module name are specific to that module.

```typescript
// Register a virtual table module (e.g., a module for reading JSON)
db.registerModule('json_data', new JsonTableModule());

// Create a virtual table using the module with specific arguments
await db.exec(\`
  create table products using json_data(
    '{"data": [{"id": 1, "name": "Product A"}, {"id": 2, "name": "Product B"}]}'
  )
\`);

// Query it like a regular table
const products = await db.prepare("select * from products where id > ?").all([1]);
```

### Using `create table` with a Default Module

Alternatively, you can define a *default* virtual table module for the database connection using `pragma`. Any `create table` statement without the `using` clause will implicitly use this default module. This can be useful if you primarily interact with one type of virtual table or want a specific behavior for standard table creation.

```typescript
// Example: Setting the built-in 'memory' module as the default
// The 'memory' module creates an in-memory table based on the schema
// (Requires the MemoryTableModule to be registered)
await db.exec("pragma default_vtab_module = 'memory'");

// Optional: Set default arguments for the module (if it accepts/requires them)
// The format is typically a JSON array string.
// For the 'memory' module, it currently doesn't use constructor args in this way,
// but other modules might. E.g., pragma default_vtab_args = '["arg1", {"key": "value"}]';
await db.exec("pragma default_vtab_args = '[]'"); // Set empty args for 'memory'

// Now, a standard CREATE TABLE implicitly uses the 'memory' module
await db.exec("create table my_memory_table (col_a integer, col_b text)");

// Query the implicitly created virtual table
const results = await db.prepare("select * from my_memory_table").all();

// To clear the default module:
// await db.exec("pragma default_vtab_module = null");
// await db.exec("pragma default_vtab_args = null");
```

**Note:** When using a default module with `create table`, the module's `create` function receives the table definition (columns, constraints) parsed from the `create table` statement itself, rather than relying solely on arguments passed via `using (...)` or `pragma default_vtab_args`. The `memory` module is designed to work this way.

See the [Memory Table documentation](./memory-table.md) for more details on the built-in memory table implementation.

### Working with Multiple Schemas

Quereus supports organizing tables into multiple named schemas for better modularity. Unqualified relation names — tables, views and materialized views alike — are resolved using a flexible search path system.

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Create tables in different schemas
await db.exec("create table main.users (id integer primary key, name text)");
await db.exec("create table extensions.plugins (id integer primary key, config json)");

// Option 1: Use qualified names
const user = await db.get("select * from main.users where id = ?", [1]);
const plugin = await db.get("select * from extensions.plugins where id = ?", [1]);

// Option 2: Set a session-wide search path
db.setSchemaPath(['main', 'extensions']);
// or via SQL:
await db.exec("pragma schema_path = 'main,extensions'");

// Now unqualified names search in order
const users = await db.get("select * from users where id = ?", [1]); // Searches main.users first

// Option 3: Use per-query search path with WITH SCHEMA
for await (const row of db.eval(`
  select * from users, plugins
  with schema extensions, main
`)) {
  console.log(row);
}
```

**Use Cases for Multiple Schemas:**

- **Plugin Systems**: Core tables in `main`, plugin tables in separate schemas
- **Multi-Tenancy**: Separate schemas per tenant for isolation
- **Modularity**: Logical grouping of related tables
- **Testing**: Test tables in `temp` schema, production in `main`

**Resolution Order:**

1. Qualified names (`schema.table`) - Always resolved exactly
2. `WITH SCHEMA` clause - Per-query explicit search path
3. `PRAGMA schema_path` / `db.setSchemaPath()` - Session default
4. Default schema (`main`) - Final fallback

The path is walked one schema at a time, and each entry's tables **and** views are checked together, so the first schema holding an object of that name wins regardless of kind — a table named `x` in an earlier entry beats a view named `x` in a later one. (Within one schema a table and a view cannot share a name; `create table` and `create view` each reject a name the other already holds.)

A **stored body** (a view or materialized-view definition) is the exception: it resolves its unqualified names against the owning object's own schema first, then the session default path — never the reading statement's `WITH SCHEMA` path. So a view declared next to its tables in a non-`main` schema reads correctly under any session path.

## Views, Updatable Views, and Materialized Views

For the SQL syntax and semantics see the [SQL Reference §2.8–2.11](sql-views.md#28-create-view-statement). This section covers the operational/API-level behavior.

**Plain views** re-evaluate their body on every reference. **Updatable views** let you `insert` / `update` / `delete` through a view (or a non-recursive CTE, or a subquery in `from`) — the engine rewrites the DML to the underlying base table(s):

```typescript
await db.exec(`create view GreenMen as select id, name, color from Men where color = 'green'`);
await db.exec(`insert into GreenMen (id, name) values (7, 'Bob')`);   // color defaults to 'green'
await db.exec(`update GreenMen set name = 'Bobby' where id = 7`);     // routes to Men
```

Because the write reaches the base table, **change-scope and reactive watches report the base table, not the view** — a `Database.watch` registered against `Men` fires when you write through `GreenMen`. A non-writable column (a computed/aggregate output) is read-only and raises a `no-inverse` diagnostic on write rather than silently dropping the value.

**Materialized views** store the body and keep it consistent with its sources **synchronously, inside the writing transaction**:

```typescript
await db.exec(`create materialized view mv as select id, x from t order by x`);
await db.exec(`insert into t values (1, 10)`);
// reads-own-writes: mv already reflects the insert within the same transaction
const rows = await db.prepare(`select * from mv`).all();
```

Operational consequences:

- A materialized view is **transactional** — a maintenance failure or a `rollback` reverts source and backing together; there is no asynchronous drift and `refresh materialized view` is not required for currency.
- `Database.watch` on a materialized view projects to its **source** tables (the backing table is maintained off the change log, so watching it directly would never fire).
- Only [narrow body shapes](sql-views.md#210-create-materialized-view-statement) are eligible; an ineligible body is rejected at `create`.
- A covering materialized view (projecting a UNIQUE constraint's columns, ordered by them) makes that constraint's enforcement O(log n) and conflict-resolution-capable.

These features run against persistent storage backends too — the `.sqllogic` suites for views, materialized views, and lens write-through are exercised under both the in-memory and LevelDB store backends (`yarn test:store`).

## Declarative Schema Workflow

Quereus supports an order‑independent declarative schema with a separate apply step. DDL remains primary; declarative is an optional layer that produces canonical DDL. Modules continue to use the DDL interface. For the `DeclaredSchemaManager` API and schema change events, see [Schema Management](schema.md).

### Quick Start

```typescript
import { Database } from '@quereus/quereus';

const db = new Database();

// Optional: set default module (so `using ...` can be omitted)
await db.exec("pragma default_vtab_module = 'memory'");

// 1) Declare target schema
await db.exec(`
  declare schema main version '1.0.0' {
    table users {
      id integer primary key,
      email text not null unique,
      name text not null
    }

    table roles {
      id integer primary key,
      name text not null unique
    }

    table user_roles (
      user_id integer not null,
      role_id integer not null,
      constraint pk_user_roles primary key (user_id, role_id),
      constraint fk_user foreign key (user_id) references users(id),
      constraint fk_role foreign key (role_id) references roles(id)
    );

    index users_email on users(email);

    seed roles (
      (1, 'admin'),
      (2, 'viewer')
    )
  }
`);

// 2) Get migration DDL statements
const ddlStatements = [];
for await (const row of db.eval('diff schema main')) {
  ddlStatements.push(row.ddl);
}
console.log('Migration DDL:', ddlStatements);

// 3) Option A: Execute DDL manually with custom logic
for (const ddl of ddlStatements) {
  console.log('Executing:', ddl);
  await db.exec(ddl);
  // Insert custom migration logic here (backfills, data transforms, etc.)
}

// 3) Option B: Auto-apply (convenience)
await db.exec('apply schema main');

// 4) Apply with seed data (clears and repopulates)
await db.exec('apply schema main with seed');

// 5) Verify schema hash
const hashResult = await db.prepare('explain schema main').get();
console.log(hashResult.info); // e.g., "hash:a1b2c3d4e5f6"

// 6) Use the schema
await db.exec("insert into users (id, email, name) values (1, 'alice@example.com', 'Alice')");
const users = await db.prepare('select * from users').all();
console.log(users);
```

### Working with Declarative Schemas

**Declaring Schemas:**
- Use `{...}` braces or `(...)` parentheses for table column definitions.
- All declarations are stored but have no side effects until `apply`.
- Tables, indexes, and views can be declared in any order.

**Viewing Changes:**
- `diff schema` returns a JSON object showing all required changes.
- Review the diff before applying to understand impact.

**Applying Migrations:**
- `apply schema main` executes the migration DDL automatically.
- `apply schema main with seed` also clears tables and inserts seed data.
- Migrations execute in safe order: drops, creates, then alters.

**Seed Data:**
- Seed blocks define initial data for tables.
- Application clears existing data before inserting seeds.
- Use for test fixtures, reference data, or initial configurations.

### Logical Schemas and Lenses

A **logical schema** describes a design free of any storage commitment; a **lens** maps each logical table onto a module-backed **basis** schema. At `apply` the lens compiles to an inline view, so the rest of the engine sees an ordinary (updatable) view over basis.

```typescript
// 1) The basis: module-backed storage
await db.exec(`declare schema basis {
  table men { id integer primary key, name text not null, color text not null }
}`);
await db.exec('apply schema basis');

// 2) The logical design — no module, no indexes
await db.exec(`declare logical schema app {
  table Person { id integer primary key, fullName text not null, color text not null }
}`);

// 3) The lens: sparse overrides over basis (only the deviations)
await db.exec(`declare lens for app over basis {
  view Person as select id, name as fullName, color from men;
}`);

// 4) Deploy — compiles the lens-backed views
await db.exec('apply schema app');

// 5) Use the logical table like any view; writes propagate to basis
await db.exec(`insert into app.Person (id, fullName, color) values (1, 'Bob', 'green')`);
```

- Columns a lens override does not cover are gap-filled by the default name-based mapper; every logical column must end up mapped to basis (an uncovered column the basis cannot back is a compile error).
- The logical schema's constraints are enforced at the lens boundary (row-local checks, foreign keys, and uniqueness — see [Lenses](lens.md)).
- Inspect the composed mapping with `select * from quereus_effective_lens('app', 'Person')`.

The lens layer is the most recently landed feature set and is still evolving; see [Lenses and Layered Schemas](lens.md) for the current boundaries.


## User-Defined Functions

Quereus allows you to define custom SQL functions:

```typescript
// Register a scalar function
db.createScalarFunction("reverse", { numArgs: 1, deterministic: true }, 
  (text) => {
    if (typeof text !== 'string') return text;
    return text.split('').reverse().join('');
  }
);

// Use it in SQL
const result = await db.prepare("select reverse(name) from users").all();
```

`db.createScalarFunction` takes a **synchronous** implementation. An asynchronous one —
or any implementation that returns a Promise — is registered by building the schema with
`createScalarFunction` from `@quereus/quereus` and passing it to `db.registerFunction`;
see [Plugins § Asynchronous scalar functions](plugins.md#asynchronous-scalar-functions)
for why a promise-returning function that is not declared `async` must set `isAsync: true`.

## Error Handling

Quereus throws specific error types that you can catch and handle. For the complete error class hierarchy, status codes, error chain utilities, and common error patterns, see [Error Handling](errors.md).

```typescript
try {
  await db.exec("insert into nonexistent_table values (1)");
} catch (err) {
  if (err instanceof QuereusError) {
    console.error(`Quereus error (code ${err.code}): ${err.message}`);
  } else if (err instanceof MisuseError) {
    console.error(`API misuse: ${err.message}`);
  } else {
    console.error(`Unknown error: ${err}`);
  }
}
```

## Direct Parser and Emitter Access

For advanced use cases like building SQL tools, IDE integrations, query analysis, or programmatic SQL manipulation, Quereus exposes its SQL parser and emitter as separate subpath exports.

### Parser (`@quereus/quereus/parser`)

Parse SQL statements into Abstract Syntax Tree (AST) nodes:

```typescript
import { parse, parseAll, parseSelect, Parser } from '@quereus/quereus/parser';
import type { Statement, SelectStmt, Expression, CreateTableStmt } from '@quereus/quereus/parser';

// Parse a single statement
const stmt = parse('select * from users where id = ?');
console.log(stmt.type); // 'select'

// Parse multiple statements separated by semicolons
const stmts = parseAll('select 1; select 2;');
console.log(stmts.length); // 2

// Parse specifically as SELECT (throws if not a SELECT)
const selectAst = parseSelect('select name, email from users');

// Access the Parser class directly for more control
const parser = new Parser();
const ast = parser.parse('insert into users (name) values (?)');
```

**Available Exports:**
- `parse(sql)` - Parse a single SQL statement, returns `Statement`
- `parseAll(sql)` - Parse multiple semicolon-separated statements, returns `Statement[]`
- `parseSelect(sql)` - Parse as SELECT statement, throws if not SELECT
- `parseInsert(sql)` - Parse as INSERT statement, throws if not INSERT
- `Parser` - The parser class for direct access
- `Lexer`, `TokenType`, `KEYWORDS` - Lexer internals for tokenization
- All AST type definitions (`Statement`, `SelectStmt`, `Expression`, etc.)

### Emitter (`@quereus/quereus/emit`)

Convert AST nodes back into SQL strings:

```typescript
import {
  astToString,
  quoteIdentifier,
  selectToString,
  insertToString,
  createTableToString
} from '@quereus/quereus/emit';
import { parse } from '@quereus/quereus/parser';

// Convert any statement AST to SQL
const ast = parse('select * from users');
const sql = astToString(ast);
console.log(sql); // 'select * from "users"'

// Quote identifiers safely (adds quotes when needed)
const safeName = quoteIdentifier('my-table');  // '"my-table"'
const simpleName = quoteIdentifier('users');   // 'users' (no quotes needed)

// Statement-specific emitters
const selectSql = selectToString(selectAst);
const insertSql = insertToString(insertAst);
const createSql = createTableToString(createTableAst);
```

**Available Exports:**
- `astToString(ast)` - Convert any statement AST to SQL string
- `quoteIdentifier(name)` - Safely quote an identifier if needed
- `expressionToString(expr)` - Convert an expression AST to SQL
- `selectToString`, `insertToString`, `updateToString`, `deleteToString`, `valuesToString` - DML emitters
- `createTableToString`, `createIndexToString`, `createViewToString` - DDL emitters

### Use Cases

**Query Analysis:**
```typescript
import { parse } from '@quereus/quereus/parser';

const ast = parse('select name from users where active = true');
// Inspect tables referenced
console.log(ast.from[0].name); // 'users'
// Inspect columns selected
console.log(ast.columns[0].expr.name); // 'name'
```

**Query Rewriting:**
```typescript
import { parse } from '@quereus/quereus/parser';
import { astToString } from '@quereus/quereus/emit';

const ast = parse('select * from users');
// Add a WHERE clause programmatically
ast.where = { type: 'binary', operator: '=', left: {...}, right: {...} };
const modifiedSql = astToString(ast);
```

**SQL Formatting/Normalization:**
```typescript
import { parse } from '@quereus/quereus/parser';
import { astToString } from '@quereus/quereus/emit';

// Parse and re-emit to normalize formatting
const normalized = astToString(parse('SELECT   *   FROM   users'));
console.log(normalized); // 'select * from "users"'
```

## Type System Reference

This section provides comprehensive details on how Quereus represents SQL values in JavaScript/TypeScript.

### Core Type Definitions

```typescript
// All SQL values are represented by this union type
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

// Rows are arrays of values
type Row = SqlValue[];

// Parameters can be positional (array) or named (object)
type SqlParameters = Record<string, SqlValue> | SqlValue[];
```

### SQL to JavaScript Type Mapping

| SQL Type | JavaScript Type | Notes |
|----------|----------------|-------|
| `NULL` | `null` | SQL NULL is JavaScript null |
| `INTEGER` | `number` or `bigint` | Small integers use `number`, large integers use `bigint` |
| `REAL` / `FLOAT` | `number` | Floating-point numbers |
| `TEXT` | `string` | Text strings |
| `BLOB` | `Uint8Array` | Binary data as typed array |
| `BOOLEAN` | `boolean` | True/false values |
| `DATE` | `string` | ISO 8601 date: `"2024-01-15"` |
| `TIME` | `string` | ISO 8601 time: `"14:30:00"` |
| `DATETIME` | `string` | ISO 8601 datetime: `"2024-01-15T14:30:00"` |
| `TIMESPAN` | `string` | ISO 8601 duration: `"PT1H30M"` (1 hour 30 minutes) |
| `JSON` | `string` | Validated JSON string |

### Temporal Types (DATE, TIME, DATETIME)

Quereus has native temporal types that store values as ISO 8601 strings and provide validation and comparison:

```typescript
// Create table with temporal columns
await db.exec(`
  create table events (
    id integer primary key,
    event_date date,
    event_time time,
    created_at datetime
  )
`);

// Insert temporal values - strings are validated and normalized
await db.exec(`
  insert into events values (
    1,
    '2024-01-15',           -- DATE
    '14:30:00',             -- TIME
    '2024-01-15T14:30:00'   -- DATETIME
  )
`);

// Use conversion functions to ensure proper type
await db.exec(`
  insert into events values (
    2,
    date('2024-03-20'),
    time('09:00:00'),
    datetime('now')
  )
`);

// Query temporal values - returned as ISO 8601 strings
for await (const event of db.eval("select * from events")) {
  console.log(event.event_date);   // "2024-01-15"
  console.log(event.event_time);   // "14:30:00"
  console.log(event.created_at);   // "2024-01-15T14:30:00"
}

// Temporal types support proper comparison and ordering
for await (const event of db.eval(`
  select * from events
  where event_date >= date('2024-01-01')
  order by created_at desc
`)) {
  console.log(event);
}
```

**Conversion Functions:**
- `date(value)` - Convert to DATE type
- `time(value)` - Convert to TIME type
- `datetime(value)` - Convert to DATETIME type
- `timespan(value)` - Convert to TIMESPAN type
- Special value: `datetime('now')` returns current timestamp

### TIMESPAN Type

Quereus has a native TIMESPAN type for representing durations and intervals:

```typescript
// Create table with timespan column
await db.exec(`
  create table events (
    id integer primary key,
    name text,
    duration timespan
  )
`);

// Insert timespan values - ISO 8601 duration strings
await db.exec(`
  insert into events values
    (1, 'Meeting', 'PT1H30M'),        -- 1 hour 30 minutes
    (2, 'Workshop', 'PT3H'),          -- 3 hours
    (3, 'Sprint', 'P14D')             -- 14 days
`);

// Use timespan() function with human-readable strings
await db.exec(`
  insert into events values
    (4, 'Break', timespan('15 minutes')),
    (5, 'Project', timespan('2 weeks 3 days'))
`);

// Temporal arithmetic: add timespan to datetime
for await (const event of db.eval(`
  select
    name,
    duration,
    datetime('2024-01-15T09:00:00') + duration as end_time
  from events
`)) {
  console.log(event);
}

// Subtract timespans
const diff = await db.prepare(`
  select timespan('2 hours') - timespan('30 minutes') as remaining
`).get();
console.log(diff.remaining); // "PT1H30M"

// Compare timespans
for await (const event of db.eval(`
  select * from events
  where duration > timespan('1 hour')
  order by duration
`)) {
  console.log(event);
}
```

**TIMESPAN Features:**
- ISO 8601 duration string format (`"PT1H30M"`, `"P1DT2H"`)
- Human-readable parsing via `timespan()` function
- Arithmetic operations with DATE, TIME, DATETIME types
- Addition and subtraction of timespans
- Proper comparison and ordering
- Stored as TEXT with validation

### JSON Type

Quereus has a native JSON type that validates JSON syntax and provides deep equality comparison:

```typescript
// Create table with JSON column
await db.exec(`
  create table users (
    id integer primary key,
    profile json
  )
`);

// Insert JSON data - validated and normalized
await db.exec(`
  insert into users values
    (1, '{"name":"Alice","age":30}'),
    (2, json('{"name":"Bob","age":25}'))
`);

// Enforce JSON structure with CHECK constraints
await db.exec(`
  create table events (
    id integer primary key,
    data json check (json_schema(data, '[{x:integer,y:number}]'))
  )
`);

// Valid insert - matches schema
await db.exec(`
  insert into events values (1, '[{"x": 1, "y": 2.5}, {"x": 2, "y": 3.14}]')
`);

// Invalid insert - fails CHECK constraint
try {
  await db.exec(`
    insert into events values (2, '[{"x": "wrong", "y": 2.5}]')
  `);
} catch (err) {
  console.log('CHECK constraint failed'); // x must be integer
}

// JSON values are compared by content, not string representation
// These two are considered equal despite different key order:
await db.exec(`insert into users values (3, '{"x":1,"y":2}')`);
await db.exec(`insert into users values (4, '{"y":2,"x":1}')`);

// Query JSON data
for await (const user of db.eval("select * from users")) {
  console.log(user.profile); // Normalized JSON string
}

// Use JSON functions to extract values
for await (const row of db.eval(`
  select
    id,
    json_extract(profile, '$.name') as name,
    json_extract(profile, '$.age') as age
  from users
`)) {
  console.log(`${row.name} is ${row.age} years old`);
}

// json() conversion function validates and normalizes
const normalized = await db.prepare("select json(?) as data").get(['{"x":1}']);
console.log(normalized.data); // '{"x":1}' (normalized)
```

**JSON Features:**
- Validates JSON syntax on insert/update
- Normalizes JSON (consistent formatting)
- Deep equality comparison (content-based, not string-based)
- Works with all existing JSON functions (json_extract, json_valid, etc.)

### Working with BLOBs

Binary data is represented as `Uint8Array`:

```typescript
// Insert binary data
const imageData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
await db.exec("insert into files (name, data) values (?, ?)",
  ["image.jpg", imageData]);

// Retrieve binary data
const file = await db.prepare("select data from files where name = ?").get(["image.jpg"]);
console.log(file.data instanceof Uint8Array); // true
console.log(file.data); // Uint8Array(4) [255, 216, 255, 224]

// Generate random binary data
const random = await db.prepare("select randomblob(16) as random_bytes").get();
console.log(random.random_bytes instanceof Uint8Array); // true
```

### Working with Large Integers

JavaScript `number` type is limited to safe integers (±2^53 - 1). For larger integers, Quereus uses `bigint`:

```typescript
// Small integers use number
const small = await db.prepare("select 42 as value").get();
console.log(typeof small.value); // "number"

// Large integers use bigint
const large = await db.prepare("select 9007199254740992 as value").get();
console.log(typeof large.value); // "bigint"

// You can pass bigint as parameters
await db.exec("insert into counters (id, count) values (?, ?)",
  [1, 9007199254740992n]);
```

### NULL Handling

SQL `NULL` is represented as JavaScript `null`:

```typescript
// NULL values in results
const user = await db.prepare("select name, email from users where id = ?").get([1]);
console.log(user.email === null); // true if email is NULL

// NULL in parameters
await db.exec("insert into users (name, email) values (?, ?)",
  ["John", null]); // email will be NULL

// NULL checks in SQL
const hasEmail = await db.prepare(
  "select count(*) as count from users where email is not null"
).get();
```

### Type Coercion

Quereus follows SQL type coercion rules:

```typescript
// Numeric strings are coerced in comparisons
const result = await db.prepare("select 42 = '42' as equal").get();
console.log(result.equal); // true (boolean)

// String concatenation with ||
const concat = await db.prepare("select 'Value: ' || 42 as text").get();
console.log(concat.text); // "Value: 42" (string)

// Arithmetic operations coerce to numbers
const math = await db.prepare("select '10' + '20' as sum").get();
console.log(math.sum); // 30 (number)
```

### Row Representation: Arrays vs Objects

Internally, Quereus represents rows as **arrays of values** (`Row = SqlValue[]`), but the high-level API converts them to **objects** for convenience:

```typescript
// stmt.get() returns a single object (Record<string, SqlValue>)
const user = await db.prepare("select id, name, email from users where id = ?").get([1]);
// user is: { id: 1, name: "Alice", email: "alice@example.com" }
console.log(user.name); // "Alice"

// stmt.all() returns an async iterator of objects
const stmt = await db.prepare("select id, name from users");
for await (const user of stmt.all()) {
  console.log(user.name); // Each row is an object
}
await stmt.finalize();

// db.eval() also returns an async iterator of objects
for await (const user of db.eval("select * from users")) {
  console.log(user.name); // Each user is an object
}
```

**Key Points:**
- All query methods return rows as objects with column names as keys
- Two result columns sharing a name (`select l.a, r.a from l join r …`, with or without `group by`) are numbered — the first keeps the name, later ones get a `:<n>` suffix: `a`, `a:1`. Without this the object form would drop a column; use an explicit alias when you want a stable name
- `get()` returns a single object (or undefined)
- `all()` and `eval()` return async iterators for streaming

### Async Iteration and Streaming

Quereus uses **async iterators** for streaming query results, allowing you to process large result sets without loading everything into memory:

```typescript
// db.eval returns AsyncIterableIterator<Record<string, SqlValue>>
const iterator = db.eval("select * from large_table");

// Use for-await-of to stream rows
for await (const row of iterator) {
  console.log(row); // Each row is an object
  // Rows are streamed - not all loaded into memory at once
}

// Or manually control iteration
const iter = db.eval("select * from users");
const first = await iter.next(); // { value: { id: 1, name: "Alice" }, done: false }
const second = await iter.next(); // { value: { id: 2, name: "Bob" }, done: false }
```

**Runtime Value Types:**

At the runtime level, Quereus works with these value types:

```typescript
// SqlValue: primitive values
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

// Row: array of values
type Row = SqlValue[];

// RuntimeValue: what instructions can work with
type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | ((ctx: RuntimeContext) => OutputValue);

// SqlParameters: how you pass parameters
type SqlParameters = Record<string, SqlValue> | SqlValue[];
```

This means:
- **Scalar queries** return a single `SqlValue`
- **Table queries** return `AsyncIterable<Row>` (streamed rows)
- **Parameters** can be positional arrays or named objects

### Multi-Statement Execution

When executing multiple statements with `db.eval`, **only the last statement's results are returned**:

```typescript
// Only the SELECT results are returned
for await (const row of db.eval(`
  create table temp_data (id integer, value text);
  insert into temp_data values (1, 'a'), (2, 'b');
  select * from temp_data;
`)) {
  console.log(row); // { id: 1, value: 'a' }, then { id: 2, value: 'b' }
}

// The CREATE and INSERT are executed, but their results are discarded
// Only the final SELECT produces rows to iterate

// If the last statement doesn't return rows, the iterator is empty
for await (const row of db.eval(`
  create table users (id integer, name text);
  insert into users values (1, 'Alice');
`)) {
  // This loop never executes - INSERT doesn't return rows
}

// Use db.exec for multi-statement DDL/DML without results
await db.exec(`
  create table users (id integer, name text);
  insert into users values (1, 'Alice');
`);
```

**Best Practices:**
- Use `db.eval()` when you need results from the last statement
- Use `db.exec()` for DDL/DML statements that don't return results
- For multiple statements with results, execute them separately

### TypeScript Type Safety

For better type safety, you can define interfaces for your result types:

```typescript
interface User {
  id: number;
  name: string;
  email: string | null;
  created_at: string; // Date/time as string
}

const user = await db.prepare("select * from users where id = ?").get([1]) as User;
console.log(user.name.toUpperCase()); // TypeScript knows name is a string

// For async iteration
for await (const user of db.eval("select * from users") as AsyncIterableIterator<User>) {
  console.log(user.email?.toLowerCase()); // TypeScript knows the shape
}
```
