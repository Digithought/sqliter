# Memory Table Module Documentation

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

The Memory Table Module provides virtual tables backed by memory for the Quereus engine. These tables support standard SQL operations with full ACID transaction support and can be used for high-performance in-memory data storage that requires SQL query capabilities.

## Architecture Overview

The `MemoryTable` implementation (`src/vtab/memory/`) provides a sophisticated, layer-based MVCC (Multi-Version Concurrency Control) system using inherited BTrees with copy-on-write semantics.

### **Core Components:**

*   **`MemoryTableModule`** (`src/vtab/memory/module.ts`): Factory for creating and managing memory table instances
*   **`MemoryTable`** (`src/vtab/memory/table.ts`): Connection-specific table interface that delegates to the manager
*   **`MemoryTableManager`** (`src/vtab/memory/layer/manager.ts`): Shared state manager handling schema, connections, and layer lifecycle
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
`ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` may run inside an open transaction. Three rules
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
    unchanged, so the probe reads the effective rows as they are.
*   **A `SET DATA TYPE` that keeps the physical storage class but moves the comparison** —
    `TEXT` ↔ `TIMESPAN` (`'PT1H'`, `'PT60M'` and `'PT3600S'` are one duration), `TEXT` ↔ `JSON`
    (`'{"a":1}'` and `'{ "a" : 1 }'` are one document), or `TEXT` ↔
    `DATE`/`TIME`/`DATETIME` (whose comparison is hard-wired to `BINARY`, ignoring the column's
    collation). No value is rewritten, so like `SET COLLATE` the probe reads the effective rows
    as they are — but a `MemoryIndex` builds its comparator from the column's **logical type**,
    so every structure over the column has to be re-keyed just the same. The trigger is
    `comparisonSemanticsDiffer` (`util/comparison.ts`): the two types' `compare` functions are
    not the same function. A retype whose types compare identically (`TEXT` → `VARCHAR(50)`,
    `INTEGER` → `BIGINT`) is a metadata-only no-op and skips all of this.
*   **A value rewrite** — `SET DATA TYPE` across physical storage classes, or a `SET NOT NULL`
    NULL → DEFAULT backfill — leaves
    the comparators alone but changes the values, so the probe reads the effective rows with the
    altered column **converted**, under the column's new logical type. That is what catches
    `'1'`/`'01'` collapsing onto the integer `1`, `'1.0'`/`'1.00'` onto the real `1.0`, and two
    NULLs (mutually distinct under SQL UNIQUE) collapsing onto one DEFAULT literal. The base
    rewrite that follows is deliberately non-enforcing — the base's rows are not a subset of the
    effective rows — so this pre-pass is the only guard. The per-row conversion is shared with
    the base rewrite and the open layers' rewrite (`convertRowAtIndex`) so the three cannot
    disagree about what the converted row is.

When the table is wrapped by a module that stages the transaction's writes *outside* this
manager — the isolation layer, whose per-connection overlay this manager cannot see — those
writes never reach `pendingTransactionLayer`, so the manager's own effective rows degenerate to
the committed base. The wrapper therefore supplies the rows to judge through the optional
`EffectiveRowSource` parameter on `createIndex` / `alterTable`, and every validation site above
prefers it over `effectiveDdlRows()`. See [module-authoring.md](module-authoring.md) § "When the
pending rows live outside your module". One check deliberately ignores it:
`validateRekeyedPrimaryKey` asserts that no *layer of this manager's own chain* holds a PK
collision under the new comparator, which is a property of the structures it is about to re-key,
not of the wrapper's merged rows.

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

**`SET DATA TYPE` validates and rewrites values, not just structures.** When the new type shares
the physical type, no value is touched and the statement is metadata-only *unless* the two types
compare differently (`comparisonSemanticsDiffer` — `TEXT` ↔ `TIMESPAN`, `TEXT` ↔ `JSON`, `TEXT` ↔
`DATE`/`TIME`/`DATETIME`), in which case it takes the `SET COLLATE` path in full: UNIQUE
re-validation over the effective rows under the new comparator, `rebuildAllSecondaryIndexes` on
the base, and `adoptSchema` on every open transaction layer. A direct module call that aims such a
retype at a PRIMARY KEY column is rejected with `CONSTRAINT` (defense in depth — the engine
already refuses `SET DATA TYPE` on any PK column), since nothing on this path re-keys the primary
tree. When the new type has a
different physical type, `MemoryTableManager.alterColumn` first runs a throw-only conversion pass
over the effective rows (rule 1): a value the transaction can see that will not convert rejects the
`ALTER` with `MISMATCH`, and one only in a row it has deleted does not block it. It then converts
the committed base rows in place and, for the open transaction, hands each layer to
`TransactionLayer.convertColumn` oldest-first (paralleling `adoptSchema`, but rewriting the stored
value at the column index rather than re-pointing an index). Like `rekeyPrimaryKey`, `convertColumn`
collapses the layer's own-write log to its net effect per key, carrying the *converted* value, so the
commit-time rebase replays converted rows. A base or own-write value that fails to convert here is
left untouched: the effective-view pass already accepted every value the transaction can read, so an
unconvertible one is necessarily shadowed by a delete or a later write and is never read back. The
result matches the store backend, whose `alterColumnSetDataType` flushes buffered writes before the
physical rewrite. Retyping a **primary-key** column is rejected outright (`CONSTRAINT`): the physical
key bytes would change, which the in-place base rewrite cannot re-key — the type-change analogue of
the SET COLLATE primary-key carve-out.

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

**3. A collation change on a PRIMARY KEY column obeys a stricter rule, because the primary tree
is a map.** A secondary index is a multi-map and tolerates two primary keys under one index key,
so re-keying it can never lose a row. The primary tree cannot: two rows whose keys collapse under
the new comparator have nowhere to go. And every layer of the chain — the committed base, each
savepoint snapshot, each statement-boundary layer — physically holds rows that a `ROLLBACK` or
`ROLLBACK TO SAVEPOINT` must be able to restore, so *none* of them may hold such a pair, not just
the transaction's effective view. `validateRekeyedPrimaryKey` checks all of them before anything
is mutated:

*   the **effective view** collides → `CONSTRAINT`; the duplicate is one a `SELECT` in this
    transaction can see, so the change is simply illegal.
*   a **layer beneath it** collides → `BUSY`, with the "commit/rollback and retry" message. The
    duplicate is invisible right now (this transaction deleted it, or a later statement did) but
    it is still resident and still restorable.

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
*   **Expression Indexes:** Expression-based indexes are not implemented — see `tasks/plan/2-expression-indexes.md`

## **Performance Characteristics:**

*   **Read Performance:** O(log n) for indexed lookups, O(n) for full scans
*   **Write Performance:** O(log n) for inserts/updates with copy-on-write overhead only for modified pages
*   **Memory Usage:** Efficient sharing of immutable pages across transaction layers
*   **Concurrency:** High read concurrency with minimal locking; writes are serialized per connection
*   **Transaction Overhead:** Minimal overhead for read-only transactions; moderate overhead for write transactions due to layer management

The inherited BTree architecture provides a robust foundation for high-performance in-memory SQL operations while maintaining full ACID compliance within the memory table module's scope.
