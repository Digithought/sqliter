# Memory Table Module Documentation

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

The Memory Table Module provides virtual tables backed by memory for the Quereus engine. These tables support standard SQL operations with full ACID transaction support and can be used for high-performance in-memory data storage that requires SQL query capabilities.

## Architecture Overview

The `MemoryTable` implementation (`src/vtab/memory/`) provides a sophisticated, layer-based MVCC (Multi-Version Concurrency Control) system using inherited BTrees with copy-on-write semantics.

### **Core Components:**

*   **`MemoryTableModule`** (`src/vtab/memory/module.ts`): Factory for creating and managing memory table instances
*   **`MemoryTable`** (`src/vtab/memory/table.ts`): Connection-specific table interface that delegates to the manager
*   **`MemoryTableManager`** (`src/vtab/memory/layer/manager.ts`): Shared state manager handling schema, connections, and layer lifecycle
*   **`alter column` planning** (`src/vtab/memory/layer/alter-column.ts`): The decide-and-validate half of `MemoryTableManager.alterColumn` — one pre-validating handler per attribute, mutating nothing (see [DDL and transactions](#ddl-and-transactions))
*   **Layer System**: MVCC implementation with inherited BTrees
    *   **`BaseLayer`** (`src/vtab/memory/layer/base.ts`): Root layer containing the canonical table data
    *   **`TransactionLayer`** (`src/vtab/memory/layer/transaction.ts`): Transaction-specific modifications using inherited BTrees
    *   **`MemoryTableConnection`** (`src/vtab/memory/layer/connection.ts`): Per-connection state with transaction and savepoint support

### **Inherited BTree Backend:**

*   **Backend Library:** Uses the `inheritree` library (fork of `digitree`) for efficient, sorted storage with copy-on-write inheritance
*   **Inheritance Model:** Each `TransactionLayer` creates BTrees that inherit from their parent layer's BTrees, providing automatic data propagation without complex change tracking
*   **Copy-on-Write:** Modifications in child layers only copy pages when necessary, sharing immutable pages with parent layers
*   **Layer Promotion:** The `clearBase()` method allows transaction layers to become independent, supporting efficient layer collapse

## **Key Features:**

### **MVCC Transaction Support:**
*   **Isolation:** Each connection sees a consistent snapshot of data throughout its transaction
*   **Concurrency:** Multiple connections can read/write simultaneously with proper isolation
*   **Savepoints:** Full support for nested savepoints within transactions (`SAVEPOINT`, `ROLLBACK TO`, `RELEASE`)
*   **Layer Collapse:** Automatic promotion and cleanup of committed layers when safe

#### Commit and sibling-layer rebase

`commitTransaction` publishes a connection's pending `TransactionLayer` into the
committed chain. Which of three relationships holds between the pending layer and
the current committed head decides how:

*   **Head is an ancestor of pending** — the normal case: the pending layer forked
    off (a descendant of) the current head, so its chain already contains
    everything committed so far. It is published *wholesale* as the new head.
*   **Head advanced past pending's fork point** — a *sibling* commit. Two
    connections forked pending layers off the same base `B`; the first committed
    and moved the head to `P1`, so the second's pending `P2` is now a sibling of
    `P1` rather than a descendant. Publishing `P2` wholesale would splice `P1` (and
    its rows) out of the chain — a silent last-writer-wins data loss. Instead the
    second commit **rebases**: it builds a fresh `TransactionLayer` parented on the
    advanced head and *replays `P2`'s own writes on top*, so `P1`'s rows survive.
    Rebasing chains — `B ← P1 ← rebased-P2`, then a third sibling rebased onto
    that — so any number of sibling commits to one table all land.
*   **No common ancestor** — a genuinely stale commit (e.g. the base was
    consolidated away by an `ALTER TABLE`). Outside a coordinated commit this rolls
    back with `BUSY` so the caller can retry; a schema drift between pending and the
    advanced head also aborts with `BUSY` rather than replay stale-schema rows.

The replay source is an **always-on per-layer write log** (`TransactionLayer.getOwnWrites()`),
maintained independently of the event-tracking `pendingChanges` so it is a reliable
record of the layer's own structural mutations.

**Isolation-model boundary.** Rebase is the right resolution *because* every sibling
connection in a coordinated commit belongs to the same `Database`'s single atomic
transaction — a `BUSY` there would abort the whole `COMMIT` and, since the siblings
arise deterministically from the same statements, a retry re-hits the identical path
(permanent failure, not eventual success). The memory manager offers
**read-your-own-writes**, *not* snapshot isolation: a primary key or secondary-`UNIQUE`
value written by *both* siblings resolves last-writer-wins to the rebasing writer, and
cross-sibling write-write / `UNIQUE` conflicts are **not** detected here. Full conflict
detection lives in `quereus-isolation`.

### **Reactive Event Hooks:**
*   **Data Change Events:** Subscribe to INSERT, UPDATE, DELETE events (fired on commit)
*   **Schema Change Events:** Subscribe to CREATE/ALTER/DROP operations for tables, columns, and indexes
*   **Fine-Grained Tracking:** UPDATE events include `changedColumns` for intelligent cache invalidation
*   **Zero Overhead:** Event tracking only enabled when listeners are registered
*   See [Module Authoring Guide](module-authoring.md#database-level-event-system) for complete documentation

### **Indexing and Query Planning:**
*   **Unified Index Treatment:** Primary and secondary indexes are treated uniformly using inherited BTrees
*   **Flexible Primary Indexing:** Data is organized by user-defined single-column or composite `PRIMARY KEY`
*   **Secondary Index Support:** `CREATE INDEX` and `DROP INDEX` on single or multiple columns, all backed by inherited BTrees
*   **Query Planning:** Implements `xBestIndex` for optimal query execution:
    *   Index selection for equality and range queries
    *   Full table scans (ascending/descending based on primary key)
    *   Fast equality lookups (`WHERE indexed_col = ?`) on single or composite keys
    *   Range scans (`WHERE indexed_col > ?`, etc.) on the first column of chosen index
    *   Prefix-equality + trailing-range scans on composite indexes (`WHERE a = ? AND b > ?` on `idx(a, b)`)
    *   `ORDER BY` satisfaction using index ordering

### **Schema Evolution:**
*   **Dynamic Schema Changes:** `ALTER TABLE` support for adding, dropping, and renaming columns
*   **Primary Key Alteration:** `ALTER TABLE ... ALTER PRIMARY KEY` is supported via an automatic table rebuild. The rebuild creates a new table with the new PK definition, copies all rows, and swaps it in place. If duplicate-key violations occur during the rebuild, the operation fails cleanly without data loss (the original table is unchanged).
*   **Index Management:** Runtime creation and deletion of secondary indexes
*   **Schema Safety:** Operations ensure consistency across all active transactions

### **Performance Optimizations:**
*   **Inherited Data Access:** Automatic traversal through layer inheritance without manual merging
*   **Efficient Scanning:** Direct iteration over inherited BTrees eliminates complex merge logic
*   **Memory Efficiency:** Copy-on-write semantics minimize memory usage for read-heavy workloads

## **Usage Examples:**

### **Basic Table Operations:**

```typescript
import { Database, MemoryTableModule } from 'quereus';

const db = new Database();
// Register the module (typically done once)
db.registerModule('memory', new MemoryTableModule());

// Create a table with single-column primary key
await db.exec(`
    create table main.users(
        id integer primary key,
        name text,
        email text,
        created_at text
    );
`);

// Create a table with composite primary key
await db.exec(`
    create table main.user_sessions(
        user_id integer,
        session_id text,
        created_at text,
        expires_at text,
        primary key (user_id, session_id)
    );
`);
```

### **Secondary Indexes:**

```typescript
// Create secondary indexes for efficient querying
await db.exec("create index users_email_idx on users (email)");
await db.exec("create index users_created_idx on users (created_at desc)");

// Queries automatically use appropriate indexes
const userByEmail = await db.prepare("select * from users where email = ?").get("john@example.com");
const recentUsers = await db.prepare("select * from users order by created_at desc limit 10").all();
```

### **Transaction and Savepoint Support:**

```typescript
// Explicit transaction with savepoints
await db.exec("begin");
try {
    await db.exec("insert into users (id, name, email) values (1, 'John', 'john@example.com')");

    await db.exec("savepoint sp1");
    await db.exec("insert into users (id, name, email) values (2, 'Jane', 'jane@example.com')");

    // Rollback to savepoint, keeping John but removing Jane
    await db.exec("rollback to sp1");

    await db.exec("insert into users (id, name, email) values (3, 'Bob', 'bob@example.com')");
    await db.exec("commit"); // Commits John and Bob
} catch (error) {
    await db.exec("rollback");
}
```

### **Schema Evolution:**

```typescript
// Add new column with default value
await db.exec("alter table users add column age integer default 0");

// Create index on new column
await db.exec("create index users_age_idx on users (age)");

// Rename column (if supported by parser)
await db.exec("alter table users rename column created_at to registration_date");
```

## **Implementation Details:**

### **Layer Management:**
*   **Connection Isolation:** Each connection maintains its own read layer and optional pending transaction layer
*   **Automatic Promotion:** Committed transaction layers are automatically promoted when no longer referenced
*   **Lock-Free Reads:** Read operations don't require locks, using the connection's current layer view
*   **Efficient Writes:** Write operations use inherited BTrees to minimize data copying

### **Index Consistency:**
*   **Unified Updates:** Primary and secondary index updates are handled uniformly during mutations
*   **Inheritance Propagation:** Index changes automatically propagate through layer inheritance
*   **Schema Consistency:** Index definitions are maintained consistently across layer transitions

### **Memory Management:**
*   **Copy-on-Write Pages:** Only modified pages are copied, sharing immutable pages across layers
*   **Automatic Cleanup:** Unused layers are automatically garbage collected when no longer referenced
*   **Base Clearing:** The `clearBase()` operation makes layers independent, reducing memory overhead

## DDL and transactions

`CREATE INDEX` / `CREATE UNIQUE INDEX` / `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE` /
`ALTER TABLE ... ALTER COLUMN ... SET COLLATE` / `ALTER TABLE ... ALTER COLUMN ... SET DATA TYPE` /
`ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` / `ALTER TABLE ... ADD COLUMN` /
`ALTER TABLE ... DROP COLUMN` may run inside an open transaction. Three rules
define what that means.

**1. Row-validating DDL sees exactly what a `SELECT` in the same transaction sees.**
`MemoryTableManager` validates against the DDL connection's *effective* rows — the committed
base overlaid with that connection's uncommitted writes, i.e. the layer
`pendingTransactionLayer ?? readLayer`. A duplicate the transaction inserted but has not
committed raises `UNIQUE constraint failed`; a duplicate it has *deleted* does not block the
change. Validation runs before anything is mutated, so a rejection leaves the schema, the base
layer and the index map untouched, and the transaction stays usable.

Every `ALTER COLUMN` that can make two previously-distinct rows collide is validated the same
way, once per uniqueness-enforcing index covering the altered column (`indexEnforcesUnique` —
the index's own `unique` flag, or its role as the auto-built covering structure for a declared
UNIQUE constraint). The probe index is built from the *new* `TableSchema`, so it compares
exactly as the rebuilt structure will. Two families qualify:

*   **`SET COLLATE`** re-keys the structures under a new comparator; the stored values are
    unchanged, so the probe reads the effective rows as they are. This is the only family that
    moves the comparator without rewriting values.
*   **A value rewrite** — `SET DATA TYPE` between any two *different* logical types (whether or
    not the physical storage class changes), or a `SET NOT NULL` NULL → DEFAULT backfill — so the
    probe reads the effective rows with the altered column **converted**, under the column's new
    logical type. That is what catches `'1'`/`'01'` collapsing onto the integer `1`,
    `'1.0'`/`'1.00'` onto the real `1.0`, `'2024-06-05'`/`'2024-06-05T00:00:00Z'` onto one
    canonical `DATE`, and two NULLs (mutually distinct under SQL UNIQUE) collapsing onto one
    DEFAULT literal. When the retype ALSO moves the comparison — `TEXT` ↔ `TIMESPAN` (`'PT1H'`,
    `'PT60M'` and `'PT3600S'` are one duration), `TEXT` ↔ `JSON` (`'{"a":1}'` and `'{ "a" : 1 }'`
    are one document), `TEXT` ↔ `DATE`/`TIME`/`DATETIME` (whose comparison is hard-wired to
    `BINARY`, ignoring the column's collation) — the same probe covers both effects at once,
    because it judges the converted rows under the new schema's comparators. The comparator
    trigger is `comparisonSemanticsDiffer` (`util/comparison.ts`): the two types' `compare`
    functions are not the same function; a `MemoryIndex` builds its comparator from the column's
    **logical type**, so every structure over the column is re-keyed as well as rebuilt. The base
    rewrite that follows is deliberately non-enforcing — the base's rows are not a subset of the
    effective rows — so this pre-pass is the only guard. The per-row conversion is shared with
    the base rewrite and the open layers' rewrite (`convertRowAtIndex`) so the three cannot
    disagree about what the converted row is.

Only a retype between **aliases of one logical type** (`TEXT` → `VARCHAR(50)`, `INTEGER` →
`BIGINT` — `inferType` returns the same shared type object) is a metadata-only no-op that skips
all of this.

For `ALTER COLUMN`, "validate before anything is mutated" is structural rather than a matter of
comment discipline. The decide half lives in `layer/alter-column.ts` — one handler per attribute
(`SET COLLATE`, `SET`/`DROP NOT NULL`, `SET DATA TYPE`, `SET`/`DROP DEFAULT`), each running its own
pre-validation over the effective rows and returning the post-change `ColumnSchema` plus whether the
structures re-key and whether the stored values must be rewritten. That file is a pure function of
the pre-change schema and those rows: it throws to reject, and has no access to the manager, the
base layer or any open layer. The apply half — base rebuild, open-layer propagation, rollback —
stays on `MemoryTableManager`, which owns that state, behind the single named first-write step
`applyAlterColumnToBase`. One consequence worth preserving: the manager's own effective-row view is
a **synchronous** iterable, and the scan helper keeps it that way (branching on the source's flavour
instead of routing everything through `for await`) so no microtask gap opens mid-scan for another
connection's autocommit write to land in — the schema-change latch serializes DDL, not DML. A
wrapper-supplied `EffectiveRowSource` is genuinely async and has no such atomicity to lose.

When the table is wrapped by a module that stages the transaction's writes *outside* this
manager — the isolation layer, whose per-connection overlay this manager cannot see — those
writes never reach `pendingTransactionLayer`, so the manager's own effective rows degenerate to
the committed base. The wrapper therefore supplies the rows to judge through the optional
`EffectiveRowSource` parameter on `createIndex` / `alterTable`, and every validation site above
prefers it over `effectiveDdlRows()`. See [module-authoring.md](module-authoring.md) § "When the
pending rows live outside your module". `validateRekeyedPrimaryKey` consumes it too, but as only
*half* of what it judges — see rule 3 below: legality is decided over the supplied rows, physical
representability over this manager's own layers.

**2. The rule is enforced for the remainder of that transaction, and after it commits.** A
`TransactionLayer` freezes its schema at construction, so a layer created before the DDL would
otherwise carry neither the new `IndexSchema` (an index scan raises "Secondary index not found")
nor the derived `uniqueConstraints` entry (a colliding insert is silently accepted) — and after a
re-keying change (a collation change, or a same-storage-class semantic retype) it would go on
comparing the old way, then *become* the committed head at commit and shadow the base's rebuilt
structures entirely.

`TransactionLayer.adoptSchema` hands the new schema to the pending layer and to every savepoint
snapshot beneath it, oldest-first. It **adds** an index the layer does not hold, and **replaces**
one whose `IndexSchema` object the new schema rebuilt (which is exactly what re-keying DDL does,
and what additive DDL never does — a semantic retype has no index-column field to change, so
`alterColumn` rebuilds those objects purely to raise this signal). Either way the layer's `MemoryIndex` is built over its parent's
tree and then brought up to date with only that layer's own writes. Rebasing would achieve the
same, but it would invalidate the savepoint snapshots a `ROLLBACK TO SAVEPOINT` must restore.

**Only the DDL-issuing connection may hold uncommitted writes.** A sibling connection's
pending rows are invisible to the DDL's transaction, so a new constraint cannot be validated
against them, and its layers cannot be re-pointed at the new schema. `ensureSchemaChangeSafety`
raises `BUSY` in that case, the same posture as the pre-existing "older transaction versions
are in use" branch.

`adoptSchema` also **removes** a structure a `DROP INDEX` / `DROP CONSTRAINT` deleted — dropping
the layer's now-orphaned `MemoryIndex` and, with it, the derived `uniqueConstraints` entry the
frozen schema was still enforcing — alongside its add/replace behavior. Like the additive side,
that removal is not undone by `ROLLBACK` / `ROLLBACK TO SAVEPOINT` — after `rollback to savepoint`,
the dropped index stays dropped.

**Declared contract: `ddlTransactionality: 'non-transactional'`.** The memory module declares this
tier in `getCapabilities()` (see [module-authoring.md § DDL transactionality tiers](module-authoring.md#ddl-transactionality-tiers)):
a schema change escapes the enclosing transaction (it survives `rollback`), but buffered DML still
rolls back normally. Callers that want a hard guarantee against this can set the
`ddl_transaction_policy = 'strict'` pragma, which refuses module-dispatching DDL inside an explicit
transaction on any module that is not `transactional` (memory is not). The default `'permissive'`
policy leaves the behavior above unchanged.

**`SET DATA TYPE` validates and rewrites values, not just structures.** The gate is logical-type
**identity**, not the physical storage class: a retype between aliases of one type (`TEXT` →
`VARCHAR(50)`, `INTEGER` → `BIGINT`, where `inferType` returns the same shared object) is
metadata-only; *every* other retype validates and rewrites. `MemoryTableManager.alterColumn` first
runs a throw-only conversion pass over the effective rows (rule 1): a value the transaction can see
that will not convert rejects the `ALTER` with `MISMATCH`, and one only in a row it has deleted does
not block it. Accepted values are rewritten to the new type's **canonical form** — the value an
`INSERT` would have stored (`'2024-06-05T00:00:00Z'` → `'2024-06-05'`, `'1 hour'` → `'PT1H'`) —
even when the storage class is unchanged, so the column never holds a spelling no write path could
have produced. The rewrite REPLACES the base primary tree with a fresh one built from the converted
rows (`rebuildPrimaryTreeFromRows`, which rebuilds every secondary index too) — never an in-place
mutation, which inheritree forbids while open layers derive from that tree — and, for the open
transaction, hands each layer to `TransactionLayer.convertColumn` oldest-first (paralleling
`adoptSchema`, but rewriting the stored value at the column index rather than only re-pointing an
index; it re-installs the schema and rebuilds the layer's indexes, so it subsumes `adoptSchema`
when the retype also moved the comparators). Like `rekeyPrimaryKey`, `convertColumn` collapses the
layer's own-write log to its net effect per key, carrying the *converted* value, so the commit-time
rebase replays converted rows. A base or own-write value that fails to convert here is left
untouched: the effective-view pass already accepted every value the transaction can read, so an
unconvertible one is necessarily shadowed by a delete or a later write and is never read back. The
result matches the store backend, whose `alterColumnSetDataType` flushes buffered writes before the
physical rewrite. Retyping a **primary-key** column is rejected outright (`CONSTRAINT`) — defense in
depth, since the engine already refuses `SET DATA TYPE` on any PK column: the key bytes, the tree's
ordering, or at minimum the key values' canonical spelling would move, and neither the base rewrite
nor the layer conversion re-keys the primary tree. It is the type-change analogue of the SET COLLATE
primary-key carve-out.

**`SET NOT NULL` validates over the effective view and backfills through the same machinery.**
Tightening a column to `NOT NULL` scans the effective rows (rule 1) for a NULL the transaction can
see: a committed-or-pending NULL rejects the `ALTER` with `CONSTRAINT`, and one only in a row the
transaction has deleted does not block it. When the column has a usable literal `DEFAULT`, those
NULLs are *backfilled* instead of rejected — and this runs through the identical seam `SET DATA TYPE`
uses (`convertBaseRows` replaces the base primary tree, `convertColumn` rewrites each open layer's
own-writes oldest-first), with the value map `null → DEFAULT` and the `convertNulls` flag set so NULLs
flow through the converter instead of passing untouched. Routing backfill through the base-replacement
path (rather than an in-place `upsert`) is what lets it fill the transaction's own pending NULL rows —
which live in the pending layer, not the base — and avoids mutating a base the open layers derive from
(`MutatedBaseError`). The key bytes never change, so no primary-key re-key is involved. This matches
the store backend, whose `alterColumnSetNotNull` flushes buffered writes before its `mapRowsAtIndex`
backfill.

**`ADD COLUMN` / `DROP COLUMN` reshape the open transaction's own pending rows too.** The base
rewrite (`addColumnToBase` / `dropColumnFromBase`) reaches only committed rows; the DDL
connection's uncommitted rows live in its open transaction layers, which would otherwise keep the
pre-ALTER arity under their frozen schema. Left alone, that mismatch is not merely a stale read:
mid-transaction `SELECT`s project *every* row — committed ones included — through the stale column
list, a `DROP` of a column preceding others commits rows whose values sit one slot off their
column names, and after a `ROLLBACK TO SAVEPOINT` the commit-time snapshot wrap (which requires
the read layer's schema to be the *current* one) is skipped and the snapshot's rows are dropped at
commit. `TransactionLayer.prepareReshapedColumns` / `installReshapedColumns` close this the same
way `convertColumn` does for value rewrites, applied oldest-first: each layer's own-write log is
collapsed to its net per-key effect, each surviving row is rewritten to the new column set (ADD
splices in the backfilled value — including a per-row `default (new.<col>)` evaluated against the
pending row itself — DROP filters out the dropped slot), the layer's primary tree is rebuilt over
its parent's already-reshaped one, and every secondary index is rebuilt. Unlike `convertColumn`,
the primary-key *functions* are rebuilt — a column-set change can shift the PK's column indices
(`DROP COLUMN` past the removed slot, a positioned `ADD COLUMN` past the inserted one) — but the
key *values* are invariant (the added column is part of no key wherever it lands; dropping a PK
column is rejected), so tree ordering and the recorded own-write keys survive unchanged. The rewrite is split into a fallible
compute phase and an infallible install phase because the ADD backfill can throw on a pending row
even when every committed row converts cleanly: all computation runs *before* the first mutation
anywhere, so a failure — a throwing evaluator, or a per-row DEFAULT that yields NULL for a
`NOT NULL` column on a pending row — rejects the ALTER with the schema, the base, and every layer
untouched. (An `ADD COLUMN` whose column is NOT NULL — explicitly, or by the session
`default_column_nullability` — with no usable DEFAULT is rejected earlier still, by the emitter's
`validateNotNullBackfill`, which queries the DDL connection's *effective* rows and so already
counts pending ones. A DEFAULT that folds to NULL counts as "no DEFAULT" there.) As with every schema
change here, the ALTER itself is **not** undone by `ROLLBACK` / `ROLLBACK TO SAVEPOINT` (DDL is
non-transactional — see the declared-contract paragraph above); what the reshape guarantees is
that the transaction's DML — including rows inserted before a savepoint — survives at the new
arity.

**The pending-change *event log* is rewritten alongside the rows.** When change tracking is on
(the module was given an emitter and a listener exists), each open layer also holds the
`PendingChange` log its commit will emit; a mid-transaction column-set or value change must
rewrite those recorded `oldRow`/`newRow` images too, or the events delivered at commit describe
rows in the pre-ALTER shape (value *i* filed under the wrong column *i*). The delivered contract
is: *every event's row images match the schema current at delivery.* So
`prepareReshapedColumns` reshapes the log alongside the net own-writes (installed by
`installReshapedColumns`), and `convertColumn` converts the value at the altered column in every
image. Two deliberate asymmetries with the row rewrite beside it:

*   **The log is never deduplicated.** The row rewrite collapses own-writes to one entry per
    key; the event log keeps every recorded write as a separate event, because that is what the
    listener is owed.
*   **The log rewrite is best-effort; the row rewrite is not.** The log holds *historical*
    images — including superseded intermediate ones the net-effect row rewrite never touches —
    and an ADD COLUMN backfill evaluator or a retype conversion can legitimately fail on such an
    image while succeeding on every live row. A row-rewrite failure must reject the ALTER; an
    event-image failure must not. ADD COLUMN falls back to `NULL` in the new slot; a retype
    keeps the raw value.

For ADD COLUMN, the pre-image (`oldRow`) gets the **same** map as the post-image: the literal
default, or the backfill evaluator applied to the pre-image itself (the evaluator is a function
of a row, and the pre-image is a row), falling back to `NULL`. Reusing the post-image's result
for the pre-image was rejected — it makes `oldRow[new] === newRow[new]` always, so a diffing
consumer (e.g. the sync engine's per-column versioning) would never record the added column —
as was suppressing the pre-image, which silently turns updates into upserts.
`rekeyPrimaryKey` (`SET COLLATE` on a PK column) deliberately leaves the log alone: a collation
change moves only the comparator, never a stored value or key value, so the recorded images are
still accurate. `RENAME COLUMN` needs nothing either — the log stores no column names, and
`changedColumns` is derived from the images against `this.tableSchema` at *emit* time, so it
already reads the post-rename name. Consolidation (`consolidateToBaseLayer`) clears the drained committed layers'
logs — their events were delivered when those layers committed, and leaving them in place would
re-deliver them at the transaction's commit once the base becomes the collection boundary.

`ALTER TABLE ... RENAME TO` needs nothing from the log either, for the same reason: the log's
`PendingChange` records carry no table name, and `commitTransaction` stamps
`event.tableName` from `this._tableName` as it drains them — which `renameTable` has already
moved. The delivered event therefore names the table as it exists at commit, with no relabel
pass. (The staged *rows* do need work from `renameTable` — see the adopt/re-key section below.)

(The same delivered contract is enforced for the module's *other* two event producers — the
engine's auto-events and the store module's coordinator queue — by
`DatabaseEventEmitter.remapBatchedDataEvents` for row shape and
`DatabaseEventEmitter.renameBatchedEvents` for the table name, which the engine's ALTER arms
call; see `docs/module-authoring.md`.)

**`RENAME COLUMN` adopts the renamed schema on the open layers.** A rename changes neither the
column set nor the key bytes, so it needs `adoptSchema` rather than the reshape pair — but it needs
it just as much. `renameColumn` rebuilds every `IndexSchema` object (each carries the column's
name), which is exactly the identity signal `adoptSchema` rebuilds a layer's `MemoryIndex` on,
mirroring the base-side `handleColumnRename` rebuild. Skipping the adopt leaves an eager savepoint
snapshot on its frozen pre-rename schema, which fails the commit-time snapshot wrap's
`readLayer.getSchema() === tableSchema` check — and the transaction's staged rows are dropped at
`COMMIT` even without any rollback.

**`RENAME TO` adopts too — after re-keying the connection registry.** The whole-table rename mints
a fresh frozen `TableSchema` (only `name` differs) and so hits exactly the same snapshot-wrap
identity check: without `adoptSchemaOnOpenLayers` a transaction that renames a table *and* holds a
savepoint loses every row it staged, with `COMMIT` still reporting success. It rebuilds no
`IndexSchema` — a table name is not part of an index key — so `adoptSchema` is the right level, not
the reshape pair.

The adopt only works if the connection registry moves first. `MemoryVirtualTableConnection`
registers under the qualified `<schema>.<table>` name and `Database.getConnectionsForTable` matches
on exactly that string, so a rename that leaves the field alone makes the transaction's own
connection unfindable by every by-name lookup the manager makes: `registeredConnections`, and
through it `ddlConnection`, `knownConnections`, `repointRegisteredConnections`, and
`openTransactionLayersOldestFirst` — which is the chain `adoptSchemaOnOpenLayers` itself walks, so
adopting after the name moves is a silent no-op. `renameTable` therefore calls
`rekeyRegisteredConnections` (`MemoryVirtualTableConnection.rename`, the one legal mutation site for
`tableName`) *before* moving `_tableName`. `connectionId` embeds the creation-time name and is left
alone — it is the opaque key of `Database.activeConnections`, and changing it would orphan the
entry.

The stale registry has a second, louder symptom: a *further* ALTER in the same transaction is
refused with `Cannot perform schema change on table … while another connection has uncommitted
changes`. `ensureSchemaChangeSafety` exempts `ddlConnection()` from its "nobody else may hold open
work" sweep; with the registry stale that is `undefined`, and the transaction's own connection is
judged a stranger. `MemoryTable.ensureConnection` would likewise stop reusing it and register a
second connection for the same table.

The snapshot-wrap refusal is also now logged at warning level (`commitTransaction`), naming the
schema, table and connection, so a future arm that forgets to adopt shows up in a log rather than
as silently vanished rows.

**A savepoint's *restore view* is re-pointed at the base too.** A `SAVEPOINT` taken while the
connection holds no pending layer stores a lazy marker naming the layer it was *reading* —
typically the committed head — as the view to reinstate. `ensureSchemaChangeSafety` drains that
head into the base and the ALTER then reshapes the base's rows, so the stored reference becomes a
pre-change snapshot of the committed rows: a later `ROLLBACK TO SAVEPOINT` would reinstate it and
commit rows in the old column shape under the new schema. So the sweep that re-points `readLayer`
also re-points every lazy marker
(`MemoryTableConnection.repointLazySavepointsToCommittedHead`), on *every* connection — the DDL
issuer is exempt from the `readLayer` sweep (its read view holds its own uncommitted rows) but its
markers are just as stale. Markers whose captured view is the connection's own eager snapshot are
left alone: those rows are not in the base, and the adopt/reshape passes above carry them across.
The isolation wrapper is the sharpest case — it forwards `begin`/`savepoint` to the underlying
table while the staged rows sit in its overlay, so the underlying connection's markers are always
lazy.

**`ADD COLUMN` can place the column somewhere other than the end.** `SchemaChangeInfo.addColumn`
carries an optional `insertAtIndex`; the memory module honors it, splicing the new value into
that slot in every committed and pending row and renumbering the schema's index-bearing fields
(PK definition, secondary index and UNIQUE column lists, FK child columns, generated-column
bookkeeping) to match. Omitting it appends, which is what `alter table … add column` always asks
for — there is no SQL syntax for a position, so it reaches the module only from an in-process
wrapper (see `docs/module-authoring.md` § Per-arm mandate). One engine-side path still assumes an
append: a column-level `CHECK` on the new column is evaluated by `buildAddColumnChecks` against
`[...existingRow, value]`, so a wrapper that redirects an *engine-driven* `ADD COLUMN` to a
position must not rely on one.

**3. A collation change on a PRIMARY KEY column obeys a stricter rule, because the primary tree
is a map.** A secondary index is a multi-map and tolerates two primary keys under one index key,
so re-keying it can never lose a row. The primary tree cannot: two rows whose keys collapse under
the new comparator have nowhere to go. And every layer of the chain — the committed base, each
savepoint snapshot, each statement-boundary layer — physically holds rows that a `ROLLBACK` or
`ROLLBACK TO SAVEPOINT` must be able to restore, so *none* of them may hold such a pair, not just
the transaction's effective view. `validateRekeyedPrimaryKey` asks two questions before anything
is mutated, over two **different** row sets:

*   **Is the change legal?** — over the rows the transaction can SEE: the wrapper-supplied
    `EffectiveRowSource` when there is one, else `effectiveDdlRows()`. A duplicate here is one a
    `SELECT` in this transaction returns, so the change is simply illegal → `CONSTRAINT`, naming
    the colliding key.
*   **Can the structures carry it?** — over every layer of this manager's own chain. A duplicate
    here is invisible right now (this transaction deleted it, or a later statement did) but is
    still resident and still restorable → `BUSY`, with the "commit/rollback and retry" message.

The sets diverge only under a wrapper, and in both directions: rows the transaction staged exist
only in the wrapper's stream, rows it deleted only in these layers. So when `EffectiveRowSource`
is supplied the second walk starts **at** the view layer (its committed rows are not a subset of
what the first pass judged); when it is absent the first pass judged exactly the view, and the
walk starts at the view's parent.

A collision confined to committed rows the transaction has DELETED is therefore refused, on both
legs, by physical necessity rather than because the data is invalid — the base must keep both
rows for a rollback and a re-keyed base cannot represent the pair. The persistent store backend
refuses the same shape for the same reason
(`tickets/backlog/bug-store-pk-collate-rejects-deleted-row-collision.md`); accepting it needs
transaction-scoped DDL (`tickets/backlog/feat-transactional-ddl-native-backends.md`).

The `BUSY` arm is deliberately conservative: a transaction that has held a colliding pair at
*any* statement boundary is refused, even when its final view is clean and no savepoint can reach
the offending layer. Narrowing that would mean re-parenting the view's tree past the unreachable
layers — the rebase that savepoint snapshots exist to avoid.

When the check passes, `BaseLayer.rebuildPrimaryTreeStrict` re-keys the base and
`TransactionLayer.rekeyPrimaryKey` (not `adoptSchema`) re-keys each open layer oldest-first:
`pkFunctions`, the primary tree, and *every* secondary index, since each derives its
`primaryKeyComparator` / `encode` from the primary key definition. A layer's own-write log cannot
be replayed verbatim onto the re-keyed parent, because two keys that were distinct in it may now
collapse into one; `rekeyPrimaryKey` therefore **rewrites the log to its net effect per key** —
one entry per key, deletions first, and a deletion whose key an upsert now occupies dropped. Every
later reader of that log replays the rewritten form: the index rebuild, a `CREATE INDEX` later in
the same transaction, and the commit-time rebase.

**Rule 1 assumes the transaction commits.** DDL is not undone by `ROLLBACK` or `ROLLBACK TO
SAVEPOINT` (see `tickets/backlog/feat-ddl-transaction-capability.md`), but the rows it validated
against *are*. Rolling back therefore restores rows the surviving index or collation forbids —
a duplicate the transaction had deleted comes back under a unique index built while it was
absent. Tracked in `tickets/backlog/bug-rolled-back-rows-violate-surviving-ddl.md`.

### Where the boundary sits

The base layer's structures are populated from the base primary tree only, never from pending
rows, so one connection's uncommitted rows never surface in another's index scans. The base's
rows are therefore **not a subset** of the DDL transaction's effective rows — a duplicate that
transaction deleted still sits physically in the base tree — which is why every base build and
rebuild (`addIndexToBase`, `rebuildAllSecondaryIndexes`) is *non-enforcing*: uniqueness is owned
by the effective-rows pre-pass above, and checking again over base rows would reject a legal
change. Two consequences follow.

*   The base index can transiently hold an entry for a row the DDL transaction has deleted
    (case 1 above). That is harmless: a secondary index here is a *lookup* structure, not an
    enforcement one — `checkUniqueViaIndex` re-validates every candidate entry against the
    live effective row and drops it when the row is gone or no longer carries the colliding
    values, so a stale entry can never manufacture a conflict or a result.
*   **DDL does not roll back.** The catalog entry (`SchemaManager`) and the base index BTree
    are written immediately, outside the transaction coordinator, so a `ROLLBACK` after a
    successful `CREATE INDEX` discards the rows but leaves the index and its derived UNIQUE
    constraint in place. This is safe for the same reason: every reader re-validates an index
    entry against the live row. It is nonetheless a real departure from SQL semantics.

A module that fully cooperated with the transaction coordinator would instead stage the
catalog entry and the new structure alongside the transaction's row writes and publish or
discard both atomically at commit/rollback. Quereus does not yet expose a capability flag
distinguishing the two, so callers cannot currently ask a module whether its DDL is
transactional; see `tickets/backlog/feat-ddl-transaction-capability.md`. Modules that degrade
here should document it, as this section does.

The store module (`packages/quereus-store`) reaches the same two rules by a different route
(it validates over `StoreTable.iterateEffectiveEntries` and its index store is likewise
written outside the coordinator). See `docs/module-authoring.md` § Transaction Support.

## **Current Limitations:**

*   **Constraint Enforcement:** `UNIQUE` (both primary key and secondary), `NOT NULL`, `CHECK`, and `FOREIGN KEY` constraints are enforced at the engine level. Secondary `UNIQUE` constraints auto-create backing indexes for O(log n) enforcement; NULL values in UNIQUE columns are allowed per SQL standard. `DEFAULT` values are applied during DML operations. FK enforcement is on by default (`pragma foreign_keys = on`); FKs require explicit action clauses (e.g. `ON DELETE CASCADE`) to be enforced — the default action is `IGNORE`.
*   **Advanced Query Planning:** Composite index `IN` multi-seek is supported (cross-product of `IN` lists across index columns). Prefix-equality + trailing-range scans are supported on composite indexes (e.g., `WHERE a = 1 AND b > 5` on `idx(a, b)`). OR disjunctions with range predicates on the same indexed column use multi-range index seek (e.g., `WHERE price > 1000 OR price < 10`).
*   **IS NULL Optimization:** `IS NULL` on NOT NULL columns produces an `EmptyResult` plan (zero-cost short-circuit); `IS NOT NULL` on NOT NULL columns is eliminated as a tautology. For nullable columns, `IS NULL` / `IS NOT NULL` are still handled as residual filters.
*   **NULL-equality short-circuit:** A *literal* NULL equality on a seek column — `col = NULL`, single-value `col IN (NULL)`, or a NULL component of a composite/prefix seek key — is UNKNOWN under SQL three-valued logic and matches no row, so the access-path rule emits an `EmptyResult` instead of a point-seek (keeping `EXPLAIN` honest). A NULL supplied dynamically (`col = ?` bound to NULL) is unknown at plan time, so the seek is preserved and the scan-layer skips the NULL-bearing key at runtime. (Contrast `col IS NULL`, which legitimately returns the NULL rows.)
*   **NULL range bounds:** A NULL range bound is likewise never satisfiable, but the index key ordering ranks NULL *below* everything — an unguarded `col > NULL` seek would match every row. A *literal* NULL in a range or `BETWEEN` conjunct is declined at constraint extraction (the conjunct stays a residual filter, which evaluates it correctly); a dynamic bound (`col > ?` bound to NULL) is rejected at runtime by `planAppliesToKey`, which admits no key when any bound value or equality-prefix component is NULL.
*   **Scan-path key shape comes from arity:** A one-column primary key or index stores its BTree key as a bare `SqlValue`; every other arity — including the zero-column singleton PK, whose extractor returns `[]` — stores a `SqlValue[]` tuple. Nothing on the value tags which it is, so the scan path threads the arity down (`ResolvedScanComparators.keyIsTuple`, plus `keyParts` / `leadingKeyPart` in `vtab/memory/types.ts`) rather than testing `Array.isArray`. That test is wrong for a JSON column, whose value can itself be a JS array: a stored document `[1]` would be read as the one-element tuple `(1)` and every bound, prefix and NULL check would compare against `1` instead.
*   **Expression Indexes:** Expression-based indexes are not implemented — see `tasks/plan/2-expression-indexes.md`

## **Performance Characteristics:**

*   **Read Performance:** O(log n) for indexed lookups, O(n) for full scans
*   **Write Performance:** O(log n) for inserts/updates with copy-on-write overhead only for modified pages
*   **Memory Usage:** Efficient sharing of immutable pages across transaction layers
*   **Concurrency:** High read concurrency with minimal locking; writes are serialized per connection
*   **Transaction Overhead:** Minimal overhead for read-only transactions; moderate overhead for write transactions due to layer management

The inherited BTree architecture provides a robust foundation for high-performance in-memory SQL operations while maintaining full ACID compliance within the memory table module's scope.
