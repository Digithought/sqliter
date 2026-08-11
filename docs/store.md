# Persistent Store Module Design

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

This document describes the design and architecture for the Quereus storage system:
- `@quereus/store` - Core storage module (StoreModule, StoreTable, utilities)
- `@quereus/plugin-leveldb` - LevelDB plugin for Node.js
- `@quereus/plugin-indexeddb` - IndexedDB plugin for browsers

## Storage Architecture

The store module uses a **multi-store architecture** where different types of data are stored in separate logical stores:

- **Data stores**: `{schema}.{table}` - One per table, containing row data keyed by encoded primary key
- **Index stores**: `{schema}.{table}_idx_{indexName}` - One per secondary index, containing index entries
- **Stats store**: `__stats__` - Single unified store containing row count and metadata for all tables, keyed by `{schema}.{table}`
- **Catalog store**: `__catalog__` - Single store containing DDL for all tables

## Reactive Hooks

The store module exposes reactive JavaScript hooks for schema and data changes, enabling UI updates, caching invalidation, and real-time synchronization.

### Schema Change Hooks

```typescript
interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index';
  schemaName: string;
  objectName: string;
  oldObjectName?: string;  // Pre-rename table name (ALTER TABLE ... RENAME TO only)
  ddl?: string;            // For create/alter
}

store.onSchemaChange((event: SchemaChangeEvent) => {
  console.log(`${event.type} ${event.objectType}: ${event.schemaName}.${event.objectName}`);
});
```

### Data Change Hooks

```typescript
interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  key: SqlValue[];      // Primary key projected from this event's own row image
  oldRow?: Row;         // For update/delete
  newRow?: Row;         // For insert/update
}

store.onDataChange((event: DataChangeEvent) => {
  // Invalidate cache, update UI, replicate, etc.
});
```

`key` follows the engine-wide contract in [usage § Subscribing to Data Changes](usage.md#subscribing-to-data-changes):
it is the primary key projected out of the event's own row image (`newRow` for an insert or an
update, `oldRow` for a delete), and an `update` never moves a row — a key change that relocates
the row arrives as a `delete` at the old key followed by an `insert` at the new one. The store
tests relocation by its ENCODED data key, so a case-only rewrite under a `NOCASE` key stays a
single in-place `update`.

### Use Cases

- **UI Reactivity**: Update views when underlying data changes
- **Cache Invalidation**: Clear or update cached query results
- **Replication**: Stream changes to remote systems
- **Audit Logging**: Record all mutations with full context
- **Cross-Tab Sync**: Notify other browser tabs of changes (IndexedDB)

### StoreEventEmitter API

The `StoreEventEmitter` class provides the reactive hooks infrastructure and implements the `VTableEventEmitter` interface for compatibility with the core vtab event system:

```typescript
import { StoreEventEmitter } from '@quereus/store';
import type { VTableEventEmitter } from '@quereus/quereus';

// Create emitter and pass to module constructor
const eventEmitter = new StoreEventEmitter();
const module = new StoreModule(provider, eventEmitter);

// StoreEventEmitter is compatible with VTableEventEmitter
const vtabEmitter: VTableEventEmitter = eventEmitter;

// Subscribe to schema changes
const unsubscribeSchema = eventEmitter.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
  if (event.ddl) console.log('DDL:', event.ddl);
});

// Subscribe to data changes
const unsubscribeData = eventEmitter.onDataChange((event) => {
  console.log(`${event.type} on ${event.tableName}, key:`, event.key);
});

// Unsubscribe when done
unsubscribeSchema();
unsubscribeData();
```

### Cross-Tab Notifications (IndexedDB)

In browser environments, multiple tabs may share the same IndexedDB database. The `IndexedDBModule` uses `BroadcastChannel` to propagate `DataChangeEvent` across tabs:

```typescript
// Tab A makes a change
await db.exec("INSERT INTO users VALUES (1, 'Alice')");
// Event fires in Tab A via local emitter
// Event also broadcasts to other tabs

// Tab B receives the event
eventEmitter.onDataChange((event) => {
  // Fires for both local AND remote changes
  console.log(`${event.type} in ${event.tableName}`);
});
```

Events received from other tabs have `event.remote = true` to distinguish them from local changes.

## Overview

The store module provides persistent table storage while maintaining Quereus's key-based addressing model. The architecture uses a **platform abstraction layer** that separates core virtual table logic from platform-specific storage backends.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    @quereus/store (core)                      │
├──────────────────────────────────────────────────────────────┤
│  Interfaces                                                   │
│  ┌─────────────────┐  ┌─────────────────────────────────┐    │
│  │ KVStore         │  │ KVStoreProvider                  │    │
│  │ - get/put/delete│  │ - getStore(schema, table)       │    │
│  │ - iterate/batch │  │ - getCatalogStore()             │    │
│  └─────────────────┘  │ - closeStore/closeAll           │    │
│                       └─────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────┤
│  Generic Virtual Table                                        │
│  ┌─────────────────┐  ┌─────────────────────────────────┐    │
│  │ StoreTable      │  │ StoreConnection                  │    │
│  │ - query/update  │  │ - begin/commit/rollback         │    │
│  │ - getBestPlan   │  │ - savepoints                    │    │
│  └─────────────────┘  └─────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────┤
│  Common Utilities                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ Key Encoder │  │ Row Serial. │  │ TransactionCoord.   │   │
│  │ (sort-safe) │  │ (ext. JSON) │  │ - multi-table atomic│   │
│  └─────────────┘  └─────────────┘  └─────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│ @quereus/plugin-leveldb │     │ @quereus/plugin-indexeddb   │
├─────────────────────────┤     ├─────────────────────────────┤
│ LevelDBStore            │     │ IndexedDBStore              │
│ LevelDBProvider         │     │ IndexedDBProvider           │
│ - uses classic-level    │     │ - uses native IndexedDB API │
│ - Node.js only          │     │ - CrossTabSync              │
└─────────────────────────┘     │ - Browser only              │
                                └─────────────────────────────┘
```

### Key Interfaces

**KVStore** - Abstract key-value store interface:
```typescript
interface KVStore {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  has(key: Uint8Array): Promise<boolean>;
  iterate(options?: IterateOptions): AsyncIterable<KVEntry>;
  batch(): WriteBatch;
  close(): Promise<void>;
}
```

**The batch point-read is positional and bounded by the caller.** `getMany` reads several
keys at once, and the full contract lives on the interface in `kv-store.ts`. In short:
`result[i]` is the value for `keys[i]` and the array is always exactly `keys.length` long,
so an absent key is `undefined` *at its own position* rather than something that shortens
the result or shifts the keys after it; a key repeated in the input is answered at every
position it occupies, in *independent* buffers (the same read-buffer ownership `get` has,
extended across positions); and `getMany([])` resolves to `[]` without touching backing
storage. Unlike `iterate` there is no internal paging — the implementation reads exactly
the keys it was handed, so the **caller** owns peak memory and must pass a bounded batch
(`StoreTableScan` pages at `ROW_RESOLUTION_BATCH`).

A backend with a native multi-get, or any way to issue every request on one round trip,
must override it; everything else delegates to `defaultGetMany` (one `get` per key, awaited
as a group), which is correct but no faster than the loop it replaces. Today LevelDB
delegates to `abstract-level`'s native `getMany` and IndexedDB issues every `get`
synchronously into ONE readonly transaction — the case that motivated the method, since
`get` opens its own transaction and resolving the rows behind an index scan otherwise cost
one transaction *per row*. `CachedKVStore` serves its hits from memory and batches only the
misses to the store beneath it.

Tier 8 of `runKVStoreConformance` enforces the correctness half on every backend. For the
round-trip half a backend's test adapter may supply a `pointReadMeter` — a counter over
trips to backing storage (one per `get`, one per native multi-get) — and the tier then also
asserts that K keys cost exactly ONE trip, so deleting a native override goes red instead of
silently costing a trip per key. This is deliberately a separate meter from `readMeter`,
which counts entries yielded by *iteration* and cannot see a point read at all. LevelDB
(counting calls on the level handle) and IndexedDB (counting transactions opened) supply it.

**Iteration is bounded, not snapshotted.** `iterate` is a streaming read, and the full
contract lives on the interface in `kv-store.ts`. In short: peak memory must not grow with
the size of the range (a fixed-size batch is fine — IndexedDB pages 256 entries,
`abstract-level` yields one per `next()` — reading the whole range before the first yield
is not); a consumer that stops after *k* entries must cost about *k* entries of work, not
the size of the range; draining the whole range must cost about one read per entry, so a
paged backend resumes from the last key seen instead of re-reading a growing prefix
(`limit`/`offset` paging is quadratic); abandoning an iteration (`break` or a throw) must release the
backend's cursor / transaction / statement; and because batching splits one logical read
into several physical ones, `iterate` promises no point-in-time view. A backend whose
dataset is wholly resident in memory (`InMemoryKVStore`) satisfies the memory bound
trivially — the bound is on reads from *backing storage*.

Tier 7 of the shared `runKVStoreConformance` battery enforces this. The battery only holds
a `KVStore` handle and cannot see what a backend reads underneath, so a backend's test
adapter may supply a `readMeter` — a counter over whatever the store reads from, plus that
backend's batch size. Adapters without one still run tier 7's release-on-abandon cases.
Backends that cannot stream at all (a SQL `select` returns a whole result set) should page
with `pagedIterate` from `@quereus/store` rather than re-deriving the resume edge, which is
easy to get wrong at batch boundaries. Today LevelDB and React Native LevelDB stream a
native cursor one entry per yield; IndexedDB pages 256 (its own resume loop, one
transaction per batch) and NativeScript SQLite pages `ITERATE_BATCH_SIZE` (128) rows per
`select` via `pagedIterate`.

Within an IndexedDB page the direction matters. A **forward** page is one `getAllKeys` +
`getAll` pair issued over the same range in the same transaction, then zipped
positionally — two requests per 256 entries, so an N-row scan costs about
`2 × (⌊N/256⌋ + 1)` requests. A **reverse** page still steps `openCursor` +
`cursor.continue()`, which is one request and one event-loop turn per row, because
`getAll` returns records in ascending order only and its `count` takes from the front of
the range: a reverse page needs the *last* `want` entries, which can only be expressed by
reading the whole range and reversing it in memory — exactly the unbounded read the
contract above forbids. An engine without `getAll`/`getAllKeys` falls back to the same
cursor walk.

**KVStoreProvider** - Factory for platform-specific stores:
```typescript
interface KVStoreProvider {
  // Get data store for a table
  getStore(schemaName: string, tableName: string, options?: StoreOptions): Promise<KVStore>;
  
  // Get index store for a secondary index
  getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;
  
  // Get stats store for table statistics
  getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;
  
  // Get catalog store for DDL metadata
  getCatalogStore(): Promise<KVStore>;
  
  // Close specific stores
  closeStore(schemaName: string, tableName: string): Promise<void>;
  closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void>;
  closeAll(): Promise<void>;
  
  // Optional: Delete stores. `indexNames` is the table's exact secondary-index
  // names (from the schema); build index store names from it via
  // buildIndexStoreName rather than prefix-scanning `{table}_idx_`, which also
  // matches a sibling table literally named `{table}_idx_<x>`.
  deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;
  deleteTableStores?(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void>;

  // Optional: Relocate a table's data + index stores for ALTER TABLE ... RENAME TO
  // (`indexNames` carries the same authoritative, exact index list). Omit it and the
  // module copies every entry through getStore/getIndexStore instead — correct on any
  // provider, but O(table size); implement this for a native move.
  renameTableStores?(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void>;
}
```

This architecture enables:
- **Platform portability** - Same SQL tables work across Node.js, browsers, and mobile
- **Custom storage backends** - Implement `KVStore` for SQLite, LMDB, or cloud storage
- **Dependency injection** - Use `KVStoreProvider` for store management

## Storage Layout

### Store Naming Convention

The module uses separate logical stores for different data types:

| Store Name | Purpose | Examples |
|------------|---------|----------|
| `{schema}.{table}` | Table data | `main.users`, `main.orders` |
| `{schema}.{table}_idx_{name}` | Secondary indexes | `main.users_idx_email` |
| `__stats__` | All table statistics | Single unified store |
| `__catalog__` | DDL metadata | Single catalog store |

**Benefits:**
- Clean grouping by table name (all stores for a table appear together)
- Each index gets its own store (no prefix required in keys)
- Shorter keys (no redundant schema.table prefixes)
- Simpler iteration (no prefix filtering needed)
- Unified stats store eliminates late database upgrades for stats

**Physical name collisions:** store names are built by concatenation and `_idx_` is a
legal substring of any identifier, so two distinct logical objects can collapse to the
same physical name (index `archive` on table `q` and a sibling table literally named
`q_idx_archive` both map to `main.q_idx_archive`). The module rejects any DDL that would
introduce such a collision — `CREATE TABLE`, `CREATE INDEX`, and
`ALTER TABLE ... RENAME TO` (which checks the new data store name plus every relocated
index store name) — with a sited error *before* any storage side effect, so a rejected
statement is a clean no-op. Providers implementing `renameTableStores` should still check
every destination before moving anything (the bundled LevelDB and IndexedDB providers do)
as a backstop against on-disk state the catalog doesn't know about.

**Provider encoding must be injective.** The names above are *logical*; each provider maps
them into its own namespace (IndexedDB verbatim, the other three escaped — see their
READMEs). A provider must build the name with `buildDataStoreName` / `buildIndexStoreName`
rather than composing its own, and its mapping must be one-to-one: two logical names may
never produce one physical name, and a namespace that cannot represent one must reject it
rather than fold it onto another. That is what lets the string comparison above stand in for
a physical check, and nothing in the type system enforces it — so `@quereus/store/testing`
exports `runStoreNameDistinctness`, registered by every plugin's `test/conformance.spec.ts`,
which opens a corpus of adversarial names and checks each store reads back its own marker.

### Key Formats

**Data Keys** (in `{schema}.{table}` store):
- Format: Encoded primary key (no prefix)
- Example: For `users` table with PK `id=42`, key is just the encoded `42`

**Index Keys** (in `{schema}.{table}_idx_{name}` stores):
- Format: Encoded index columns + encoded PK
- Example: For email index, key is `encoded("alice@example.com") + encoded(42)`

**Catalog Keys** (in `__catalog__` store):
- Format: `{schema}.{table}` as UTF-8 string
- Value: DDL statement for table creation
- Example: Key `main.users` → `CREATE TABLE main.users (...)`

**Stats Keys** (in `__stats__` store):
- Format: `{schema}.{table}` as UTF-8 string
- Value: JSON `{rowCount: number, updatedAt: timestamp}`
- Example: Key `main.users` → `{"rowCount": 1000, "updatedAt": 1704067200000}`

### Primary Key Encoding

Composite keys are encoded to preserve lexicographic sort order:

- `0x00` - NULL
- `0x01` + 8-byte big-endian signed int (with sign flip for ordering)
- `0x02` + IEEE 754 double (with sign flip)
- `0x03` + UTF-8 bytes + `0x00` terminator (escaped internal nulls)
- `0x04` + length-prefixed bytes (BLOB)

### Row Serialization

Rows are stored as values using Quereus's extended JSON serializer, which handles:
- `bigint` via `{"$bigint": "12345..."}`
- `Uint8Array` via `{"$blob": "base64..."}`
- Standard JSON types

A JSON/object value whose own keys collide with a marker name is escaped on write
by prefixing one extra `$` (`$bigint` → `$$bigint`, `$$blob` → `$$$blob`) and
unescaped on read, at any nesting depth. Escaping rather than wrapping is required
because `JSON.parse` runs its reviver bottom-up, so an enclosing wrapper is visited
only after the value it was meant to protect has already been decoded.

## Secondary Indexes

Indexes are stored in separate stores, with keys containing the indexed values plus the primary key:

```
Data store (main.users):
  key: encoded(42)  → value: {id:42, email:"alice@example.com", name:"Alice"}

Index store (main.users_idx_email):
  key: encoded("alice@example.com") + encoded(42)  → value: (empty)
```

**Benefits of separate index stores:**
- No prefix needed in index keys (store name already identifies the index)
- Simpler iteration (no filtering required)
- Each index can be managed independently
- Clean separation for index-specific operations

Index maintenance occurs during `update()`:
- INSERT: Add index entries for new row in each index store
- DELETE: Remove index entries for old row from each index store
- UPDATE: Remove old entries, add new entries

The module's `getBestAccessPlan()` considers available indexes when evaluating filter constraints.

## Query Planning

The module implements `getBestAccessPlan()` to communicate capabilities:

| Access Pattern | Cost Model | Provides Ordering |
|----------------|------------|-------------------|
| PK equality | O(1) | Yes (single row) |
| PK range | O(k) where k = matched rows | Yes (BINARY only) |
| Secondary index eq | O(1) + PK lookup | No |
| Secondary index range | O(k) + PK lookups | No |
| Full scan | O(n) | Yes (PK order, BINARY) |

Non-BINARY collations: The module cannot provide collation-aware ordering. It reports `providesOrdering: undefined` and Quereus handles sorting above the Retrieve boundary.

## Schema Discovery

When connecting to existing storage, the module reads DDL from the catalog store and imports it into the in-memory schema manager. The recommended entry point is `rehydrateCatalog()`, which handles loading, importing, and error tolerance in a single call.

### rehydrateCatalog

```typescript
const result = await storeModule.rehydrateCatalog(db);
// result.tables:  string[]           — imported table names
// result.indexes: string[]           — imported index names
// result.errors:  RehydrationError[] — collected failures
```

Each DDL entry is imported individually. A corrupt or unparseable entry is logged and skipped so that other tables still load. Call after `db.registerModule()` (and `db.setDefaultVtabName()` if DDL may lack a USING clause).

Internally, `rehydrateCatalog()` delegates to `loadAllDDL()` (scan the catalog store) and `schemaManager.importCatalog()` (parse + connect). `loadAllDDL()` remains available as a lower-level escape hatch.

### Discovery Flow

1. Module opens storage at configured path/database
2. `rehydrateCatalog(db)` scans catalog store (keys are `{schema}.{table}`, values are DDL)
3. Each entry is imported via `schemaManager.importCatalog([ddl])`
4. Parse failures are collected in `result.errors`; remaining tables load normally
5. Tables become queryable

### Catalog persistence (bundled index DDL)

This section covers **table** entries. Views and materialized views are engine-level
objects that never reach a module hook; the store persists them under reserved-prefix
keys through a schema-change subscription — see
[view-persistence.md](view-persistence.md).

`@quereus/store` persists each table's secondary indexes **inside the same
catalog entry as the table**, keyed `{schema}.{table}` (no per-index key
namespace). The entry is a newline-joined bundle: the `CREATE TABLE` statement
first, then one `CREATE [UNIQUE] INDEX` line per persistable index, then one
`alter index … set tags (…)` line per *exposed implicit index* carrying user
tags:

```
CREATE TABLE "main"."t" (...) USING store
CREATE INDEX "ix_b" ON "main"."t" ("b")
CREATE UNIQUE INDEX "uq_email" ON "main"."t" ("email" COLLATE NOCASE) WHERE "email" IS NOT NULL
alter index main.uq_vin set tags (purpose = 'lookup')
```

`StoreModule.buildCatalogEntry` produces the bundle (table DDL + every index DDL,
both in the persistence-safe no-`db` form; the `alter index` lines via
`generateIndexTagsDDL`, a schema→AST-lift over the shared `alterIndexToString`
emitter — its lowercase keywords are cosmetic, both forms re-parse). Hidden
implicit covering indexes (the auto-built BTree backing a declared inline
`UNIQUE`) are excluded — they round-trip via the table's `UNIQUE` constraint,
not as a standalone `CREATE INDEX`. An *exposed* implicit index is likewise
never emitted as a `CREATE INDEX` (a re-import would materialize a real
`IndexSchema`, changing the store-mode shape); only its user tags
(`UniqueConstraintSchema.exposedIndexTags`) persist, as a whole-set
`alter index … set tags` statement (the canonical replace form; empty tag records
emit no line). On reopen, `rehydrateCatalog` feeds each bundle to
`importCatalog`, whose `parser.parseAll` splits it by AST (never on `\n`, so a
newline inside a `DEFAULT` / `CHECK` / partial-predicate string literal is safe)
and imports table-before-indexes; the trailing `alter index` lines re-apply
silently (no change event, no import-result entry) against the just-imported
table, whose `CREATE TABLE` earlier in the bundle carries the constraint and its
exposure flag.

**When a table's entry is written.** The authoritative write happens when the engine
REGISTERS the table — the store's schema-change listener handles `table_added` and
compare-writes the bundle. Registration is the right moment because it is the first
point at which the table definitively exists: `SchemaManager.createTable` runs
`validateForeignKeyCollations` *after* `module.create` returns and throws there without
calling `destroy`, so a write inside `create` could leave an entry for a table the user
never got, which would reopen as a phantom.

The listener self-filters on ownership (`ownsTableCatalogEntry` — memory tables and other
modules' tables are left alone, and a store table behind the isolation wrapper is still
recognized) and compare-writes rather than blind-puts, because `table_added` is also
delivered during rehydration for a store-hosted materialized-view backing whose entry is
already current.

`StoreTableBase.initializeStore` still compare-writes the entry the first time a table's
storage is opened, now purely as a **backstop**: for an already-persisted table it reads
and skips. It is retained because the `table_added` write rides the async persist queue,
which logs and swallows — so the backstop is the only site where a table whose DDL text
cannot be encoded at all (a lone surrogate in a quoted column name, a `DEFAULT` string
literal, a `CHECK` constant) raises on a statement rather than vanishing quietly. Before
this arrangement the write was *only* lazy, so a table nobody ever read or wrote was never
persisted at all and disappeared on reopen.

**Why bundle rather than a per-index key:** every existing re-persist path carries
the indexes for free —

- `CREATE INDEX` / `DROP INDEX` rewrite the bundle (`StoreModule.createIndex` /
  `dropIndex` call `saveTableDDL` after updating the connected table's schema).
- `DROP TABLE` deletes the single key, so the indexes vanish with it (no orphan
  catalog entries). The teardown drains the persist queue first, so a create-then-drop
  in one session cannot have its queued `table_added` write land *after* the delete and
  resurrect a phantom entry.
- `RENAME TABLE` regenerates the bundle under the new name (index DDL references
  the renamed table automatically).
- `ALTER INDEX … SET/ADD/DROP TAGS` fires `table_modified` on the *owning* table;
  the store's catalog listener regenerates the bundle (index tags live in
  `tableSchema.indexes`; exposed-implicit-index tags on the originating
  constraint's `exposedIndexTags`) with no index-specific plumbing.
- Structural ALTERs that reindex columns already re-persist the table, so the
  bundle's index lines track the reindexed columns.
- `RENAME TABLE` / `RENAME COLUMN` rewrite every self-naming part of the table's own
  definition — partial-index `WHERE` predicates, `CHECK` expressions, and a
  self-referencing foreign key's target — **before** it is persisted, in two places. The
  module's hook does it inline: the engine's propagation runs only after the hook returns,
  so a module that persisted first would durably write a definition naming the pre-rename
  table or column, and a crash in that window strands an un-rehydratable bundle on disk.
  `runRenameTable` repeats it inside the engine before the catalog swap and the
  `table_modified` notify, or the store's catalog listener — firing on that notify —
  re-persists a bundle whose self-FK still names the vanished table. The expression
  rewrites are idempotent and mutate the AST in place (shared by reference with the catalog
  schema and with a unique partial index's derived `UNIQUE` constraint), so the later
  propagation pass finds nothing to change and its event compare-skips; the foreign-key
  retarget is a copy, since it touches a name field rather than an AST.
- `RENAME TABLE` corrects **other** objects too — a cross-schema FK, a `CHECK` expression,
  a view or materialized-view body naming the renamed table — which live in *other*
  catalog entries the module's single-table hook cannot know about. The engine rewrites them
  in its post-hook propagation (`propagateTableRename`), which enqueues their corrective
  catalog writes. So that a crash cannot strand a dependent naming a vanished table, the
  rename is **two-phase** at the module boundary: `module.renameTable` writes the
  new entry and moves physical storage but leaves the **old** name's catalog entry in place;
  the engine then calls `module.finalizeRename` at the end of `runRenameTable`, after
  propagation, and the store drains the dependents' writes to durability **before** deleting
  the old entry. Both entries coexist on disk during the window, so every
  intermediate catalog set rehydrates into a working database. The guarantee is
  *"no durable catalog set ever names a vanished table"* — short of full cross-table atomicity
  (see best-effort residue below).

**Reattach, not rebuild.** The physical index KV store survives a logical close,
so rehydrate does **not** scan rows to rebuild it. After the import loop,
`rehydrateCatalog` refreshes each connected `StoreTable`'s cached schema from the
now-current registry (import updates the registry, not the live table instance), so
DML maintains the rehydrated index and the derived `UNIQUE` enforces. The backing
store is reattached lazily on first access via `provider.getIndexStore`. Partial
indexes are maintained on DML too: the index-update path honors the index `WHERE`
predicate, matching the build-time filtering.

**Best-effort durability.** Persistence follows the store's best-effort contract:
if the catalog write fails after a `CREATE INDEX` built the physical index store,
the in-memory schema has the index but the catalog does not, so on reopen the
index is missing and its store is orphaned — no two-phase protocol here.

The `RENAME TABLE` `finalizeRename` protocol (above) orders the *catalog* writes but
does not make the whole rename atomic. Two accepted residues remain, both safer than the
"child cannot be written to" failure they replace, neither occurring on a clean
(crash-free) rename:

- **Physical-move orphan.** `renameTableStores` *moves* (not copies) the old table's data
  store into the new name inside `renameTable`, while the old catalog entry is still present.
  A crash there, then reopen, rehydrates the old name as an **empty** table (a fresh store
  is minted on connect) — a visible, droppable orphan.
- **Copy-fallback orphan.** A provider without `renameTableStores` gets the module's
  generic copy fallback instead: every entry is read from the old-named data and index
  stores and written under the new name, then the old stores are reclaimed via
  `deleteTableStores` when the provider has it, or closed with a logged warning when it
  does not (the old-named copy then survives as a droppable duplicate). A provider whose
  `deleteTableStores` only *closes* its stores — both mobile plugins do today — leaves the
  same duplicate without the warning. A copy failure propagates before the catalog is
  rewritten, so the table stays reachable under its old name.
- **Old-entry delete failure.** The deferred old-entry delete is best-effort (logged, not
  fatal); a failure leaves both entries on disk — again a droppable orphan, not a stranded
  dependent.

Full cross-table atomicity would remove even these residues; it is unimplemented — see
`docs/todo.md`.

**Per-column PK key collation.** The store enforces PRIMARY KEY uniqueness/ordering
*physically* in the key bytes, encoding each PK column under its own declared collation
(`StoreTable.pkKeyCollations` — `BINARY` / `NOCASE` / `RTRIM`, the registered key
encoders). So **any** declared PK collation is honored natively (`x text collate binary
primary key` keys under BINARY, `collate nocase` under NOCASE), at parity with the memory
module. The table-level key collation K (`config.collation`, `BINARY` or `NOCASE`, default
`NOCASE`) is only a **default** for an undecorated PK column whose logical type is
`isTextual` (i.e. `text`). Secondary-index *column* values are likewise keyed per-column,
under the index column's own effective collation (`resolveIndexKeyCollations`: the index
column's `COLLATE`, else the table column's declared collation, else `BINARY` — **not** K;
an undecorated non-PK text column genuinely compares under BINARY, since the CREATE-time
K-reconcile below applies only to PK members), with the same hard-`BINARY` rule for
collation-blind columns (`json`, the temporal types) as the PK bullet below. So the stored
index bytes always agree with the collation the residual re-check, the planner's cover
analysis, and UNIQUE enforcement compare under. The schema entry points:

- **A collation-aware PK column** — one whose type's `compare` applies the collation it
  is handed (`LogicalType.collationAware`: `text` and `any`) — is keyed under its
  **declared collation**. `create table t (k any collate nocase primary key)` is accepted
  (`NOCASE` is a registered built-in, so it passes the registry-aware column-DDL gate on
  `ANY_TYPE`, which declares no supported-collation list; an *unregistered* name is
  rejected there) and the `nocase` is *honored*: key bytes, PK/UNIQUE enforcement, and
  every comparison agree that `'A'` and `'a'` are one key, and
  `pkOrderPreservingPrefixLength` finds key and comparison collation equal, so the range
  seek and PK-order advertisement stay open. An **undecorated** `any` PK column keys (and
  compares) BINARY — `resolveDefaultCollation` never applies a non-BINARY session default
  to ANY, and the CREATE-time K-reconcile below deliberately skips it — so only an
  explicit non-BINARY `COLLATE` moves its key bytes.

- **A PK column that can hold text but is collation-blind** — `json` and the temporal
  types `date` / `time` / `datetime` / `timespan` — is keyed under **hard-coded
  `BINARY`**, never under a declared collation and never under K. Those types' `compare`
  is not the generic storage-class + collation comparison — the temporals ignore the
  argument `createTypedComparator` hands them, and JSON ranks structurally, applying the
  collation only to a string-scalar pair — so keying such a
  column under anything but BINARY would enforce uniqueness under one collation and
  compare under another — `'A'` and `'a'` are distinct to the comparator but would
  collide at one NOCASE key, so a second `insert` would be spuriously rejected and an
  `insert or replace` would silently destroy the first row. (Their empty
  `supportedCollations` list already keeps a non-BINARY column COLLATE out at DDL time;
  the hard-coding is the backstop.)

- **What the PK-order advertisement is measured against.** A range seek and a
  `providesOrdering` advertisement claim that memcmp over the key bytes reproduces the order
  the planner's `Sort` would have produced. For a collation-aware column `Sort` orders under
  the operand's *collation*, which is exactly what the key bytes encode under, so the
  advertisement holds (subject to the collation's `orderPreserving` assertion). For a
  semantic-ordering type `Sort` ranks through `logicalType.compare`, and the member counts
  only when the explicit per-type allow-list `semanticKeyOrderIsFaithful`
  (pk-key-resolution.ts) asserts its stored key bytes memcmp in exactly that order —
  TIMESPAN through its total-seconds `groupKey` transform, JSON through the structural
  byte form; any other semantic-ordering type keeps the blanket decline. Every seek
  *probe* passes through the per-value gate `semanticProbeIsKeyFaithful` besides: a probe
  the type gives no faithful byte position (a numeric or unparseable TIMESPAN probe, a
  blob/bigint JSON probe) degrades in whichever way its arm can afford — a range bound is
  dropped (widening the window), a full-PK equality declines its whole point arm (a point
  window cannot widen, only under-fetch), and a secondary index's EQ prefix stops short at
  that column (a shorter prefix window is a superset). The type-aware residual
  (`matchesFilters`) decides rows in every case. The memory backend's declared-key BTrees
  (`createTypedComparator`) agree with `Sort` on both kinds, so the two backends advertise
  the same orders.

- **CREATE.** `module.create` applies the store default K to an *implicit*-default text PK
  column (the engine's BINARY column default becomes NOCASE under K = NOCASE), so an
  undecorated text PK keeps the store's NOCASE-keyed behavior; an *explicit*
  `COLLATE` clause — even one diverging from K — is left exactly as declared and keyed
  under it. So `create table t (x text primary key)` yields **BINARY under memory**
  (`'a'` and `'A'` distinct) and **NOCASE under the store** (they collide). This is
  intentional: memory honors the session `default_collation` (BINARY out of box, via
  `resolveDefaultCollation` in `quereus/src/schema/table.ts`) while the store preserves its
  on-disk NOCASE semantics for undecorated text PKs. An authored lens (bijection inverse)
  for a text PK is therefore read-only under the store default but writable under memory,
  because the value-discriminating check needs BINARY-level distinct `'a'`/`'A'` to prove
  injectivity. (The explicit-vs-implicit distinction rides on `ColumnSchema.collationExplicit`,
  set by `columnDefToSchema` for a `COLLATE` clause and — for a **materialized-view backing
  column** — by `deriveBackingShape` (`materialized-view-helpers.ts`) when the body output
  column's collation provenance is `explicit` or `declared`. So an MV key column publishing a deliberate
  collation — an explicit `collate …` projection or a passthrough of a declared-collation
  source column — is keyed under it across the reconcile, while a genuinely-implicit MV
  column keeps the store-default reconcile, like an undecorated base-table PK.) Non-text PK columns (e.g. `integer primary key`) keep their declared
  collation — collation governs key bytes only for text.
- **Load path (`connect` / rehydrate).** The load path does **not** reconcile — the
  persisted DDL is the source of truth. The per-column key collation round-trips through
  the column's `COLLATE` clause (`generateTableDDL` elides the default `BINARY`, emits
  any non-`BINARY` collation explicitly), and the engine import path defaults a
  no-`COLLATE` column to `BINARY`, so the reloaded collation matches what the physical
  keys were written under. (A persisted DDL whose declared collation does not match its
  key bytes loads as-declared — see `store-pk-collate-legacy-reopen-divergence`.)
- **`ALTER COLUMN … SET COLLATE` on a PK column, and `ALTER TABLE … ALTER PRIMARY KEY`,**
  are both honored by a **physical re-key**: `StoreTable.rekeyRows` re-encodes every
  data-store key under the new key definition (a new collation for SET COLLATE, a new
  column set for ALTER PRIMARY KEY) and `rebuildSecondaryIndexes` rebuilds each secondary
  index non-enforcing (its keys embed the PK suffix; uniqueness was already judged
  pre-mutation, see below). Before anything is flushed or mutated, both arms ask
  `StoreTable.validateRekeyedPrimaryKey` the memory backend's two re-key questions over two
  different row sets (see [memory-table.md](memory-table.md) §"A collation change on a
  PRIMARY KEY column obeys a stricter rule" — the store mirrors it status-for-status): a
  collision among the rows the DDL transaction can *see* (its staged rows included, via the
  isolation wrapper's effective row stream) throws `CONSTRAINT` naming the key; a collision
  confined to committed rows the transaction has *deleted* — rows a `rollback` must restore,
  which a re-keyed store cannot hold — throws `BUSY` ("commit/rollback and retry"). Either
  refusal leaves the store, the catalog, and the enclosing transaction untouched. "Deleted"
  covers a delete staged in an isolation wrapper's overlay *and* one buffered in this
  module's own coordinator, so the bare module answers `BUSY` here too rather than flushing
  the delete and re-keying — which would spend the transaction's rollback silently. For SET
  COLLATE, a target equal to the column's current collation is a schema-only no-op (no
  re-key); ALTER PRIMARY KEY always re-keys. `rekeyRows`' own duplicate-key pass stays in
  place after both probes, as a backstop rather than the gate.

  An ACCEPTED re-key is still not transactional: the new collation and the re-keyed
  stores are durable the moment the statement returns, while the issuing transaction's
  own row changes remain undoable. A `rollback` afterwards therefore restores rows the
  probes judged deleted — including, where a UNIQUE index covers the altered column, rows
  that violate it under the new collation. The data store and the index still describe the
  same rows (index entry keys carry the PK suffix, so no row is displaced); the memory
  backend leaves the same state for the same statement sequence, since its secondary
  structures are multi-maps and its DDL is equally non-transactional.

The store carries no on-disk format version stamp and no rebuild-on-open path: a store whose
non-textual PK bytes were written under any collation but BINARY must be recreated. Likewise
for secondary indexes: index-column bytes were formerly encoded under the table key collation
K, so any previously-persisted database with a secondary index over a text column whose
effective collation differs from K must be recreated or re-indexed (drop + recreate the
index); the data-store bytes and the PK suffix inside each index key are unchanged.

See [`docs/sql-alter.md` § ALTER COLUMN](sql-alter.md#27-alter-table-statement) for the
full SET COLLATE contract, including the non-PK UNIQUE re-validation. Physical key bytes
and existing-row dedup both resolve the collation's key normalizer against the connection's
registry, so a custom or overridden collation is honored; a comparator-only collation
(no `normalizer`) is rejected rather than silently keyed under someone else's bytes.

**OBJECT-class PK / index key encoding.** An object-valued key member encodes through a
**canonical JSON string** (`canonicalJsonString` from `@quereus/quereus` — recursive
object-key sort, array order preserved), not a bare `JSON.stringify`. So reorder-equal
objects encode to identical key bytes and collide as one row (matching `deepCompareJson`
and the memory module), while array order stays significant. The canonical form governs
only the *key* bytes — the stored/displayed row value keeps its insertion order (rows
round-trip through `serializeRow`/`deserializeRow`, independent of the key). **No collation
applies** — the canonical string is encoded verbatim, mirroring the engine, whose
OBJECT-class comparison (`compareSameType`) and key serializer (`util/key-serializer.ts`)
both ignore the collation for object values. So the object-valued members of an
`any collate nocase` key stay case-distinct and keep the comparator's code-point order,
while that column's *text* values still fold under NOCASE.

This canonical-text path serves members with **no declared `json` type** (an `any` column
holding an object). A member on a column DECLARED `json` takes the store-local
**structural byte form** instead (`jsonStructuralKey`, `json-key.ts` — see § Order
preservation and `docs/types.md` § Semantic ordering): same reorder-equal identity, but a
memcmp order that reproduces `JSON_TYPE.compare` rather than JSON punctuation order. Its
key bytes are likewise collation-free (a declared-`json` index column keys hard-`BINARY`).

**Where a declared-`json` index column's `COLLATE` *does* bite.** `CREATE UNIQUE INDEX …
(j COLLATE NOCASE)` over a `json` column is accepted (index DDL applies no type gate), and
although the key bytes ignore that name, both uniqueness checks honor it on the one shape
`JSON_TYPE.compare` treats as text — a **top-level string scalar**. Write-time enforcement
compares through the index's collation; build-time enforcement (`buildIndexEntries`'
in-pass `seen` check and `validateUniqueIndexOverRows`) signs each value through
`storeDedupeKeyTransform`, which leaves a top-level string scalar AS a string so
`serializeKey` runs the collation normalizer over it, and falls back to the structural
bytes for every other node. Signing a string through the structural bytes instead dropped
the collation and let `CREATE UNIQUE INDEX` admit rows a later insert then rejected
(`bug-store-index-build-dedupe-skips-collation`). A **nested** string leaf is unaffected:
`deepCompareJson` takes no collation, so `["a"]` and `["A"]` stay distinct under any index
`COLLATE`.

**Index-derived UNIQUE enforcement collation.** A `CREATE UNIQUE INDEX … (col COLLATE x)`
synthesizes a `derivedFromIndex` UNIQUE constraint whose DML enforcement resolves each
column's comparison collation from the **index's** per-column `COLLATE` clause (falling
back to the declared column collation when the index column carries none) —
`StoreTable.uniqueEnforcementCollations`, matching memory's `checkUniqueViaIndex`, the
store's own `buildIndexEntries` build-time dedup, and SQLite (a unique index enforces
under the index's collation). So a *finer* index (`COLLATE BINARY` over a `NOCASE` column)
admits case-variants the column would unify, and a *coarser* index (`COLLATE NOCASE` over a
`BINARY` column) unifies case-variants the column would keep distinct. When **two** UNIQUE
indexes cover the same column-set with differing collations, each derived constraint enforces
under **its own** index's collation regardless of creation order — both backends resolve the
enforcing index BY NAME (memory's `findIndexForConstraint` off `uc.derivedFromIndex`; the
store's by-name `uniqueEnforcementCollations`), where a by-column-set resolution would collapse
both onto the first-listed index and under-enforce the coarser one
(`memory-multi-index-unique-collation-resolution`). `ALTER COLUMN … SET
COLLATE` on a column under such an index propagates the new collation into the index
column *and* rebuilds every index covering it — the store's index *key* bytes encode each
index column under its own effective collation, so the persisted entries are stale until
re-encoded under the new one — mirroring memory's schema propagation with the physical
rebuild the store's byte encoding additionally requires.

A non-derived (table-level / column) UNIQUE always enforces under the declared column
collation, even when a *finer* same-column-set `CREATE UNIQUE INDEX` exists (either DDL
order). Memory does **not** reuse that finer index as the constraint's realizing structure:
it builds the constraint's own declared-collation covering index and resolves the non-derived
UC to it BY NAME (via `getImplicitCoveringStructure`), so the two indexes coexist and each
enforces its own equivalence — matching SQLite and the store, which never reused the user
index (`memory-nonderived-unique-reused-finer-index-under-enforcement`). When a row-time
covering materialized view is *also* linked to such a constraint, a finer/incomparable index
collation disqualifies the MV from answering it (see the [covering-MV collation eligibility
gate](mv-constraints.md#enforcement-through-a-covering-mv)), so enforcement falls back to
this per-scan / auto-index path, still under the index collation. That gate reads the same
`index.columns[i].collation` this resolver does, so the two stay consistent across an `ALTER
COLUMN … SET COLLATE`.

A **semantic-ordering** column (TIMESPAN, JSON — see [types-ordering.md § Semantic
ordering](types-ordering.md#semantic-ordering)) is the one exception: its enforcement comparison is
the declared type's `compare`, so neither the index nor the column `COLLATE` participates
and `'PT1H'`/`'PT60M'` conflict under any collation. The resolved collation is still passed
to the type's `compare` (types whose ordering is partly textual may consult it). Every
backend builds these comparators from the resolved collations through one helper,
`uniqueEnforcementComparators` (`schema/unique-enforcement.ts`).

## Transaction Support

The store module integrates with Quereus's transaction coordinator to provide multi-table atomic transactions.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Quereus Database                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          Transaction Coordinator                     │    │
│  │  - Calls begin/commit/rollback on all connections   │    │
│  │  - Runs global assertions before commit             │    │
│  └─────────────────────────────────────────────────────┘    │
│           │              │              │                    │
│           ▼              ▼              ▼                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ Connection  │ │ Connection  │ │ Connection  │            │
│  │  (users)    │ │  (orders)   │ │  (items)    │            │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘            │
└─────────┼───────────────┼───────────────┼────────────────────┘
          │               │               │
          ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│               LevelDBModule TransactionCoordinator           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Shared WriteBatch                       │    │
│  │  - Collects writes from all tables                  │    │
│  │  - Single atomic write on commit                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│                    ┌─────────────┐                          │
│                    │  LevelDB    │                          │
│                    │  (classic)  │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Connection Registration**: When a table is first accessed, a `LevelDBConnection` is created and registered with the Database
2. **Transaction Begin**: Quereus calls `begin()` on all registered connections; the coordinator starts buffering writes
3. **Mutations**: All `update()` operations queue changes to the shared `WriteBatch` instead of writing directly
4. **Transaction Commit**: Quereus calls `commit()` on connections; the coordinator writes the batch atomically
5. **Transaction Rollback**: The coordinator discards the pending batch; no changes are persisted

**Same-key ordering within a batch**: a `WriteBatch`'s queued operations apply in the order they were queued, so when two operations target the same key, the later one wins — `put(k, a); delete(k)` leaves `k` absent, `delete(k); put(k, a)` leaves `k` set to `a`. Every backend (in-memory, LevelDB, IndexedDB, React Native LevelDB, NativeScript SQLite) honors this; it's part of the `WriteBatch` contract, covered by the shared conformance suite. `AtomicBatch` (the cross-store commit path used when a provider exposes `beginAtomicBatch`) applies the same rule per `(store, key)` pair — the coordinator replays its pending ops into one atomic batch without collapsing duplicates, so a transaction that writes then deletes the same row relies on it. Both persistent backends
run the shared `runKVProviderConformance` battery (`@quereus/store/testing`) over their
`beginAtomicBatch`, so the whole provider-level contract — cross-store commit, deferred
visibility until `write()`, same-key ordering, `clear()`, the empty write, and `MISUSE` on
a handle from another provider — is asserted from one place rather than per backend. A
batch is single-use: write it once and drop it (see `AtomicBatch` in `kv-store.ts`).

### DDL that implicitly commits

Some DDL rewrites or relocates storage directly, bypassing the coordinator's buffer. Such a statement first **commits the module-wide transaction** — every buffered write, for *every* table the coordinator holds, not just the altered one — and only then touches storage. After it runs there is nothing left to roll back: a subsequent `ROLLBACK` will not restore the pre-DDL rows.

The statements with this behavior:

- `ALTER TABLE ... RENAME TO` (the physical stores move)
- `ALTER TABLE ... ADD COLUMN` / `DROP COLUMN` (every stored row is re-encoded to the new column layout; `DROP COLUMN` also re-encodes the keys of every index it *narrows* — one fewer column value ahead of the PK suffix — and deletes the index store of every index it removes outright, so nothing is left for a later same-named `CREATE INDEX` to adopt)
- `ALTER TABLE ... ALTER PRIMARY KEY` (every data key, and every secondary-index key, is re-encoded)
- `ALTER TABLE ... ALTER COLUMN <pk-member> SET COLLATE` (same re-key, driven by the column's new key collation)
- `ALTER TABLE ... ALTER COLUMN <non-pk-member> SET DATA TYPE`, for any move between two *different* logical types — the physical representation need not change (every row's value is re-parsed and re-stored in the new type's canonical form). Retyping a **primary-key member** to a different logical type is rejected with `CONSTRAINT` before anything is scanned or written: the value rewrite is payload-only and would leave the row's key bytes encoded under the old type. The engine refuses this for every backend already (see [SQL DDL § ALTER TABLE](sql-alter.md#27-alter-table-statement)); the store repeats the check for direct module calls, as the memory backend does
- `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`, when existing rows hold NULL and a literal `DEFAULT` backfills them

Validation that can reject the statement runs *before* the commit wherever possible, reading the buffered-plus-committed view so it sees this transaction's own rows: the NULL probe of `SET NOT NULL`, the convertibility probe of `SET DATA TYPE`, the `NOT NULL`-without-`DEFAULT` probe of `ADD COLUMN`, the non-PK UNIQUE re-validation — run for `SET COLLATE` and, over the *converted* values, for the two value-rewriting arms (`SET DATA TYPE`, `SET NOT NULL` backfill), whose rewrite can collapse two distinct values onto one — and both primary-key probes of *either* PK re-key, `SET COLLATE` on a PK member and `ALTER PRIMARY KEY` alike (`StoreTable.validateRekeyedPrimaryKey`: `CONSTRAINT` over the transaction's effective rows, `BUSY` over the committed rows a rollback must restore). All of these leave the transaction intact when they reject. Validation that cannot be separated from the rewrite runs after the commit, so its error arrives with the enclosing transaction already committed. Storage is still left untouched in that case; only the transaction is gone. One check remains in this category: the `NOT NULL` check on a value produced by an `ADD COLUMN` backfill expression (it runs per row, as the rows are rewritten). `rekeyRows`' own duplicate-key pass, for both re-keying statements, is now only a backstop behind the pre-commit probes above, not a rejection path a caller can reach.

Savepoints opened before such a statement go away with the transaction. A later `ROLLBACK TO` or `RELEASE` naming one of them warns and proceeds — everything committed by the DDL stays committed — rather than raising. This mirrors the memory module.

DDL that writes no rows does **not** commit: `ADD CONSTRAINT`, `RENAME COLUMN`, `SET DEFAULT`, `SET COLLATE` on a non-PK column, `SET DATA TYPE` between aliases of one logical type (`TEXT` → `VARCHAR(50)`), `DROP NOT NULL`, and `CREATE INDEX` (which builds from the buffered-plus-committed view) all stay inside the open transaction.

**Declared contract: `ddlTransactionality: 'auto-commit'`.** The store module declares this tier in `getCapabilities()` (see [module-capabilities.md § DDL transactionality tiers](module-capabilities.md#ddl-transactionality-tiers)). The flag is a single **worst-case summary**: because the committing statements above force-commit the buffered transaction (schema change *and* every pending write), the store declares `auto-commit` even though the no-row DDL in the previous paragraph is merely `non-transactional`. A caller that wants a hard guarantee against either surprise can set `ddl_transaction_policy = 'strict'`, which refuses module-dispatching DDL inside an explicit transaction on any non-`transactional` module (the store is not `transactional`). The default `'permissive'` policy leaves the behavior above unchanged.

### Multi-Table Atomicity

Since all tables in a LevelDB module share the same underlying database (tables are distinguished by key prefixes), a single `WriteBatch` can atomically commit changes across all tables:

```typescript
BEGIN TRANSACTION;
INSERT INTO users VALUES (1, 'Alice');
INSERT INTO orders VALUES (100, 1, 50.00);
INSERT INTO items VALUES (1000, 100, 'Widget');
COMMIT;  -- All three inserts succeed or fail together
```

### Savepoint Support

Savepoints create nested snapshots within a transaction:

```sql
BEGIN;
INSERT INTO users VALUES (1, 'Alice');
SAVEPOINT sp1;
INSERT INTO users VALUES (2, 'Bob');
ROLLBACK TO sp1;  -- Discards Bob, keeps Alice
COMMIT;           -- Only Alice is persisted
```

The coordinator maintains a stack of pending operations, rolling back to the appropriate snapshot on `ROLLBACK TO`.

### LevelDB Backend
- All tables share one `ClassicLevel` instance
- `WriteBatch` provides atomic multi-key writes
- Savepoints tracked via operation snapshots

### IndexedDB Backend

**Current architecture**: Each table gets its own IndexedDB **database** by default (e.g., `quereus_main_users`, `quereus_main_orders`). Each database contains a single object store for key-value storage.

- Tables can share a database via `database='shared_name'` option
- Native IDB transaction provides atomicity within a single database
- `transaction.abort()` for rollback

### IndexedDB Architecture Gap

**Current limitation**: The default separate-database-per-table architecture prevents cross-table atomicity:

| Scenario | Atomicity |
|----------|-----------|
| Multiple tables in SAME IDB database | ✅ Native IDB transaction |
| Multiple tables in DIFFERENT IDB databases | ❌ Sequential commits |
| Data tables + sync metadata (different DBs) | ❌ Sequential commits |

**Note on storage quotas**: Browser storage quotas are per-origin, not per-database. Having separate databases does **not** increase available storage—all databases under the same origin share the same quota (~60% of disk on Chrome, ~50% on Firefox, ~1GB on Safari).

**Preferred direction**: Consolidate to a **single IndexedDB database** with multiple object stores (one per table):

| Single Database | Multiple Databases (current) |
|-----------------|------------------------------|
| ✅ Native cross-table transactions | ❌ No cross-DB transactions |
| ✅ Atomicity for sync operations | ❌ Sequential commits |
| ✅ Same storage quota | ✅ Same storage quota |
| ✅ No WAL needed | ⚠️ Would need WAL for atomicity |
| ⚠️ Slightly more complex object store management | ✅ Each table is self-contained |

This matches LevelDB's architecture (single database, key prefixes for tables) and would enable native ACID semantics.

### Isolation Gap

**Additional limitation**: Even with single-database atomicity, the Store module does not provide **isolation** (preventing readers from seeing intermediate states during a transaction).

| Backend | Atomicity | Isolation |
|---------|-----------|-----------|
| LevelDB | ✅ WriteBatch | ❌ Readers see intermediate state |
| IndexedDB (single DB) | ✅ IDB transaction | ❌ Readers see intermediate state |

**What the isolation layer does and does not give you.** The `@quereus/isolation` wrapper
(`packages/quereus-isolation`) closes part of this gap, but only part of it. It provides
**read-committed** visibility plus **read-your-own-writes**: a transaction sees its own
uncommitted rows through its overlay, and otherwise sees whatever is committed *at the
moment of the read*. It is **not snapshot isolation** — two reads of the same table inside
one transaction may return different rows if another transaction commits between them. It
also performs **no write-write conflict detection**: two transactions that update the same
row concurrently both succeed, and the last connection to flush wins. Applications that
need serializability must arrange it themselves. See [Isolation Layer Design](design-isolation-layer.md#isolation-level-provided).

**Future direction**: Implement isolation using a layered architecture similar to the memory vtab module:

1. **TransactionLayer pattern**: Writers work on an isolated layer that inherits from the committed base
2. **Copy-on-write semantics**: Uncommitted changes are invisible to readers
3. **Atomic visibility**: All changes become visible at once on commit
4. **Rollback**: Discard the transaction layer without affecting readers

This would provide true ACID semantics and enable features like:
- Consistent reads during long-running transactions
- Sync operations that apply atomically across tables
- Snapshot isolation for reporting queries

### Concurrent committed reads: not supported

The engine can run an eligible read-only statement *outside* the execution mutex,
against each table's last committed state, when the caller passes
`{ readConcurrency: 'committed' }` — so the read completes even while another
statement is parked inside a slow commit. **Store-backed tables never take that
path.** `StoreModule.readCommittedSnapshot` is `false`, so a read of a
store-backed table silently falls back to the ordinary serialized path: correct
rows, but it waits for the writer like any other statement. Opting in is never an
error; it just has no effect here.

Two things would have to change first:

1. `StoreModule.connect` returns a **shared cached `StoreTable` per table key**,
   so the `_readCommitted` connect option is dropped on the floor — the
   "committed snapshot" reader is handed the same instance the writer is using.
2. `StoreTable.query` **merges the coordinator's pending-op view** over the
   committed store (read-your-own-writes, see [Isolation Gap](#isolation-gap)), so
   a read taken while a commit flushes those ops observes a partially applied
   batch.

Wrapping with `@quereus/isolation` does not rescue this. The wrapper *mirrors* its
underlying — its own committed reads open a dedicated `_readCommitted` underlying
handle and bypass the overlay, so it adds no tearing window — but mirroring `false`
is still `false`, and point 1 above is exactly why: `StoreModule.connect` re-serves
the cached `StoreTable`, so the wrapper's "dedicated" handle is the writer's
instance. See
[Committed-Snapshot Reads](module-authoring.md#4-committed-snapshot-reads-_readcommitted)
for the obligation a module takes on by declaring it, and the
`runCommittedReadConformance` harness that checks it. The work that would let the
store stack qualify is filed as `backlog/feat-store-committed-snapshot-reads`.

## Statistics

Row counts are maintained lazily for efficient query planning:

- **Storage**: All table statistics are stored in the unified `__stats__` store, keyed by `{schema}.{table}`
- **Key format**: `{schema}.{table}` as UTF-8 string (e.g., `main.users`)
- **Value format**: JSON `{rowCount: number, updatedAt: timestamp}`
- **Tracking**: Each insert increments count (+1), each delete decrements (-1)
- **Persistence**: After ~100 mutations, stats are flushed to storage in a microtask
- **Flush on close**: Stats are persisted when a table is disconnected
- **Load on open**: The persisted count is read back the first time a table's storage is opened, before any mutation can be tracked against it — otherwise the first write after a reopen would restart the count from zero
- **No database upgrades**: The `__stats__` store is created at database initialization, so stats persistence never triggers schema upgrades

```typescript
// Access statistics programmatically
const table = module.getTable('main', 'users');
const rowCount = await table.getEstimatedRowCount();
```

### How the count reaches the planner

Two routes, answering two different questions.

`StoreTable.getStatistics()` is the engine's `VirtualTable` contract: `ANALYZE` calls it, and it answers the table's **size** in O(1) from the maintained count, with no per-column statistics (the store keeps no value distribution — a distinct count or histogram would cost a full scan). `ANALYZE` treats that empty `columnStats` as "size answered, collect the rest yourself" and still scans for the per-column numbers, preferring the scan's row count because it counted every live row while the maintained one is a delta-tracked estimate that can drift. `ANALYZE` is therefore also the reconciliation for a drifted count. What it collects is cached on `TableSchema.statistics` and is what the engine's own cost model (join ordering, cache thresholds, sort costs) reads.

`StoreModule.getBestAccessPlan()` covers the between-`ANALYZE`s case, which is every store table until someone runs one. The planner's `request.estimatedRows` hint is populated only from `ANALYZE`-collected statistics, so a never-analyzed table arrives as `undefined` and every cost below would otherwise be computed against the module's fixed 1000-row placeholder. The module fills the hint in from `StoreTable.getKnownRowCount()` — the count already in memory, including the open transaction's buffered delta — whenever the planner supplied none. A planner-supplied hint always wins, so the access path is costed with the same number as the plan around it.

The substituted count is floored at 1. `rows: 0` is the access-plan protocol's *"this predicate is unsatisfiable"* — `rule-select-access-path` replaces the whole table access with a static empty relation on it — and a table that is empty when the plan is built can still be read after the same statement writes into it. The rule now also requires the plan to have claimed at least one filter before folding, so the floor is belt-and-braces for the no-filter case and the real guard for a filtered one. Consequence: a genuinely empty store table is still costed as though it held one row, not zero.

## Configuration

```sql
-- LevelDB (Node.js)
CREATE TABLE t (...) USING leveldb(path = './data/mydb');

-- IndexedDB (Browser)  
CREATE TABLE t (...) USING indexeddb(database = 'myapp');
```

In practice, applications set the default module:
```typescript
db.setDefaultModule('leveldb', { path: './data' });
// Then users simply: CREATE TABLE t (...)
```

Module options (all optional, passed in the `USING` clause and persisted in the
table's DDL, so they survive close → reopen):

- `collation` — table key collation `K` for text keys (`BINARY` | `NOCASE`, default `NOCASE`).
- `max_batch_bytes` — serialized-key byte budget for a single **index-build** write
  batch. `CREATE INDEX` (and the `ALTER`-driven index rebuild) flushes and starts a
  fresh batch once accumulated key bytes cross this, so building an index on a table
  larger than memory never buffers the whole index at once. Default 8 MiB; a missing
  or non-positive value clamps to the default (a zero budget must never *disable*
  flushing). Bounds the write batch only — the UNIQUE-build dedup set is not bounded
  by it.

## Schema Migration

Uses lazy migration: rows missing new columns return NULL or the declared default on read. No eager rewriting of existing data.

## Collation Support

The store module uses collation-aware binary encoding to preserve sort order in the underlying key-value store.

### Key Normalizers

A text value's key bytes are produced by running it through the collation's **key
normalizer** — the `(s: string) => string` whose output equality partitions strings
exactly as the collation's comparator does. Normalizers are resolved against the owning
connection's collation registry (`db.getKeyNormalizerResolver()`), which `StoreTable`
binds once into `EncodeOptions.normalizers`. Key bytes and value comparisons therefore
always agree on which strings are the same value, including under a collation registered
or overridden with `db.registerCollation`.

A collation registered with a comparator but **no** normalizer cannot key a persisted
structure, and neither can an unregistered name. Both are rejected at `CREATE TABLE`
(and at `CREATE INDEX` / `ALTER`), over exactly the collations the table's key encoding
uses: each text-capable primary-key column's key collation (which for an undecorated
`isTextual` member is `K`), plus each text-capable index column's key collation for every
index — hidden `_uc_*` included. A table whose `K` cannot key but whose encoding never
reaches `K` (integer PK, index columns keyed `BINARY`) stays openable.

### Built-in Collations

| Collation | Key normalizer | Ordering Support |
|-----------|----------------|------------------|
| **NOCASE** | `s => s.toLowerCase()` | Full (default) |
| **BINARY** | identity | Full |
| **RTRIM** | strips trailing ASCII space (`0x20`) only | Full |
| **Custom** | whatever `registerCollation` supplied | Point/equality always; range and PK order only with `{ orderPreserving: true }` |

"Ordering Support" is about the **range window and the PK-order advertisement**, which need
the normalizer to preserve order. Point/equality seeks never do — see § *Order preservation*
below for what each index arm actually asks.

The default collation is **NOCASE**, matching Quereus's case-insensitive comparison semantics.

`RTRIM` strips only ASCII `0x20`, matching `RTRIM_COLLATION`. (The retired store-local
encoder stripped every Unicode whitespace character, so `'a\t'` and `'a'` shared one key
despite comparing distinct — a distinct row could be clobbered by its neighbour.)

### Order preservation

Rows are physically ordered by memcmp of their normalized key bytes, but the engine
orders and filters them with the collation's comparator. Three store decisions equate the
two: the primary-key range window, the secondary-index range window, and the PK-order
advertisement (`providesOrdering` / `monotonicOn`, which lets the optimizer drop a Sort).

`registerCollation` promises only that a normalizer partitions strings the way the
comparator calls them **equal** — never that it preserves **order**. A collation asserts
the stronger property with `{ orderPreserving: true }`: for all strings `x`, `y`,
`sign(comparator(x, y))` equals `sign(memcmp(utf8(normalizer(x)), utf8(normalizer(y))))`.
The three built-ins carry the assertion; a custom collation (or an override of `NOCASE` /
`RTRIM` — only `BINARY` is protected) must opt in.

Without the assertion the store **declines the optimization, not the query**: the range
window degrades to a full scan and the Sort is retained, with the collation-aware
post-fetch filter still deciding every row. Point/equality seeks never need the assertion
— they rely only on the equality guarantee — and are unaffected.

The table key collation `K` is **not** part of a secondary-index seek decision. Index
bytes are encoded under the index column's own key collation, and the post-fetch filter
re-compares under the index column's `COLLATE` (else the table column's declared
collation). Both index arms ask only whether those two agree:

- **Equality** — agreement makes the byte window exactly the qualifying set. A `text` or
  `any` column always agrees (both types' `compare` honors the collation it is handed —
  `LogicalType.collationAware` — so key bytes and filter resolve the same name), so an
  index on a plain (BINARY) text column of a default-`K` (NOCASE) table seeks, and so do
  an index on a `collate nocase` column of a `collation = binary` table and an index over
  an `any collate nocase` column.
- **Range** — the same agreement *plus* the collation's `orderPreserving` assertion,
  since a byte window also equates memcmp of the key bytes with the comparator's order.

The one shape where the two do **not** agree is a collation-blind column (`json`, the
temporal types — whose `compare` is not the generic collation comparison) under an index column
carrying an explicit non-`BINARY` `COLLATE` (index DDL does not type-gate the way column
DDL does). Those key hard-`BINARY` while the filter still compares under the declared
name, so both arms decline and the query full-scans. Declining costs the seek, never a
row.

The built-ins hold their assertion for every **well-formed** string, including text outside
the basic multilingual plane. They compare by Unicode code point (`compareCodePoints` in
`util/comparison.ts`), not with JavaScript `<` / `>` — which orders by UTF-16 code unit and
would sort a surrogate pair below `U+E000`–`U+FFFF` even though its UTF-8 encoding sorts
above. A custom collation that compares with `<` / `>` must therefore **not** claim
`orderPreserving`. The one case no comparator can satisfy is an **unpaired surrogate**,
which has no UTF-8 encoding at all (`TextEncoder` folds each to `U+FFFD`, so all 2048 of
them would share one key). The store closes that gap from the other side: `encodeText`
**refuses** a text value carrying an unpaired surrogate rather than encoding it, naming the
offending code unit and offset. This is the one deliberate divergence between a memory table
(accepts the value — the comparators stay total) and a store-backed table (raises at encode
time), and it is what makes the built-ins' `orderPreserving` stamp true over every value a
store-backed table can hold. A key member on an **`any`** column holding an object needs no
such guard: its bytes come from `JSON.stringify`, which escapes a lone surrogate to ASCII.
A member on a column DECLARED `json` does: it keys through the structural byte form
(`jsonStructuralKey`, `json-key.ts`), which encodes real UTF-8, so a lone surrogate in a
string leaf or an object key raises exactly as `encodeText` raises for a text column.

Identifiers are guarded the same way. `buildCatalogKey`, `buildViewCatalogKey`,
`buildMaterializedViewCatalogKey`, and `buildStatsKey` (`key-builder.ts`) all raise before
encoding a schema/table/view name carrying an unpaired surrogate, and the full persisted DDL
text (`saveTableDDL` and the other catalog-write sites in `store-module-catalog.ts`) is guarded too —
a lone surrogate in a quoted column name or a `default`/`check` string literal is caught even
when the table's own name is clean.

For a **view, materialized view, or plain table** that guard alone is not enough, because the
catalog write is fire-and-forget (see [view-persistence.md](view-persistence.md)): the
throw lands inside the persist queue, where it can only be logged, so the definition would
create "successfully" and be gone after reopen — and for a table nobody ever reads or writes
again, nothing would ever surface the loss at all. `StoreModule.assertCatalogObjectPersistable`
closes that on the CREATE TABLE / CREATE VIEW / CREATE MATERIALIZED VIEW / `ALTER … SET TAGS`
paths — it runs the same key + DDL derivation the write path runs, synchronously, before the
object is registered, so a refusal is a clean no-op. `CREATE TABLE` calls it with the
pre-`module.create` schema (`SchemaManager.createTable`, before the module is asked to
instantiate the table) — the only thing a later reconcile can still change is a PK's collation,
which can only substitute another engine-known collation name, never introduce an unencodable
character, so the pre-create object is text-equivalent to the one that would actually persist.

An ALTER that rewrites a view/MV **indirectly** rides the same hook, through the engine-side
pre-flight dependent scan `assertRenameDependentsPersistable`: before
`alter table … rename to` / `rename column` takes its first side effect, every dependent view
and materialized-view body in that schema is rewritten on a clone and the prospective object
is offered here — and a renamed materialized view's own new catalog key and DDL text are
vetted too. Dependent **tables** ride the same scan under the `'table'` kind: a rename is also
propagated into other tables' FK targets, referenced-column lists, CHECK expressions,
partial-index predicates and column `DEFAULT` / generated expressions, and those re-persists
are fire-and-forget too, so every table whose
record the rewrite would change is offered here as well. Because that scan reaches tables this
module may not own, the hook self-filters on ownership (`ownsTableCatalogEntry`, mirroring
`StoreModule.resolveOwnedTable`) instead of the write path's catalog-entry-absent test, which
would need IO the hook is not allowed to do. One visible consequence: for a **store-backed**
table that has a dependent view or a dependent store table, the pre-flight now fires ahead of
the physical store-name guard, so the error changes from `cannot store the identifier …` to
`cannot store persisted schema text …`. Both name the unpaired surrogate; both leave the
catalog and all physical storage untouched.

Still uncovered: a module that has never been handed a `Database` persists nothing and
therefore vetoes nothing (`bug-store-untouched-table-and-early-view-never-persisted`). That
same gap is the one place the table veto is STRICTER than the write path — a store-owned table
whose catalog entry has not been written yet is refused here, where the write path would have
skipped it; refusing is the safe side, since that table's own later `saveTableDDL` would throw
on the diverged text with nothing left to tell the user.

`@quereus/sync`'s metadata key builders
(`buildColumnVersionKey`, `buildTombstoneKey`, etc. in `metadata/keys.ts`) apply the same
guard to their schema/table/column identifier arguments, importing it from `@quereus/store`.

The **physical store-name** builders `buildDataStoreName` and `buildIndexStoreName` carry the
same guard, and it matters for two reasons beyond keying. First, a provider may encode the
store name to bytes — `LevelDBProvider.encodeSublevelName` percent-escapes the name's UTF-8
bytes — so without the guard two tables whose names differ only in a lone surrogate would
resolve to the *same* sublevel (`main.%EF%BF%BD`). Second, it is what lets
`StoreModule.assertStoreNameFree` stand in for a *physical* store collision check: that check
compares names as JS strings, before any provider encoding, so distinct logical names imply
distinct physical stores only where the provider's encoding is injective. With unpaired
surrogates refused, every shipped provider's encoding is (see
[Store Naming Convention](#store-naming-convention)).
Because every call site builds the physical name before its first side
effect, the throw always lands on a clean no-op — notably `renameTable`, which relocates
storage *before* rewriting the catalog and does not undo the relocation, so a guard that only
fired at the catalog write left the table's rows stranded under an orphan store name and the
table reading as empty. The user-visible consequence is a timing difference: a table or index
whose own **name** carries a lone surrogate is refused at `CREATE`/`ALTER … RENAME`, while a
lone surrogate that only appears in the persisted DDL **text** (a column name, a `default`
literal) still surfaces lazily on first data access, since the table's own name is clean.

Note also that a collation-blind primary-key column (`json`, a date/time type) is keyed
under `BINARY`, not under the table key collation `K` — matching the `BINARY` the engine
compares it under, so its range seeks and PK-order advertisement stand and its uniqueness
is enforced bytewise. An `any` PK member keys under its declared collation (BINARY unless
an explicit non-BINARY `COLLATE` is declared — the K-reconcile skips non-text columns).
See "Per-column PK key collation" in [schema.md](schema.md).
(A declared-`json` member takes no collation at all: its transform hands `encodeValue` a
`Uint8Array`, which the BLOB path encodes verbatim — no normalizer runs.)

## Package Structure

The store system is split across three packages to enable platform-specific packaging:

```
packages/quereus-store/                # Core (platform-agnostic)
  src/
    common/
      encoding.ts       # Key encoding utilities (type-prefixed sort-safe encoding)
      json-key.ts       # Structural key bytes for declared-json key members
      key-builder.ts    # Store naming and key construction utilities
      serialization.ts  # Extended JSON row serialization
      kv-store.ts       # KVStore and KVStoreProvider interfaces
      events.ts         # Schema and data change event emitter
      ddl-generator.ts  # Generate CREATE TABLE/INDEX DDL from schemas
      pk-key-resolution.ts       # Per-column KEY collation / transform / order-safety for PK + index columns
      implicit-unique-index.ts   # Hidden `_uc_*` index materialized per plain UNIQUE constraint
      store-table-base.ts        # StoreTableBase: state, store handles, stats, transaction lifecycle
      store-table-scan.ts        # StoreTableScan: the read path (predicate -> byte window -> rows)
      store-table-constraints.ts # StoreTableConstraints: secondary-index maintenance + UNIQUE enforcement
      store-table.ts    # Generic StoreTable (uses KVStore abstraction) — the write path
      store-connection.ts  # Generic transaction connection
      store-module-base.ts         # StoreModuleBase: module state, store handles, coordinator, name-collision guard
      store-module-catalog.ts      # StoreModuleCatalog: the catalog store (DDL entries, shutdown marker, stale-MV set)
      store-module-schema-sync.ts  # StoreModuleSchemaSync: rehydration + engine schema-change subscription
      store-module-index.ts        # StoreModuleIndex: CREATE/DROP INDEX and the `_uc_*` store reconcile
      store-module-index-build.ts  # Index population + UNIQUE validation helpers (free functions)
      store-module-alter-column.ts # StoreModuleAlterColumn: ALTER COLUMN + its pure per-attribute sub-branches
      store-module-alter.ts        # StoreModuleAlter: ALTER TABLE dispatch and every other arm
      store-module-rename.ts       # StoreModuleRename: two-phase RENAME TABLE
      store-module-access-plan.ts  # Access planning (free functions) — mirror of store-table-scan.ts
      store-module-schema-rewrite.ts # Pure schema rewrites: PK collation reconcile, self-FK retarget
      store-module.ts   # Generic StoreModule — lifecycle, capabilities, backing host
      transaction.ts    # Transaction coordinator
      index.ts          # Common module exports

packages/quereus-plugin-leveldb/       # Node.js LevelDB plugin
  src/
    store.ts            # LevelDBStore (classic-level wrapper)
    provider.ts         # LevelDBProvider (KVStoreProvider implementation)
    plugin.ts           # Plugin entry point for registerPlugin()
    index.ts            # Package exports

packages/quereus-plugin-indexeddb/     # Browser IndexedDB plugin
  src/
    store.ts            # IndexedDBStore (native IndexedDB wrapper)
    manager.ts          # IndexedDBManager (unified database management)
    provider.ts         # IndexedDBProvider (KVStoreProvider implementation)
    broadcast.ts        # CrossTabSync for BroadcastChannel notifications
    plugin.ts           # Plugin entry point for registerPlugin()
    index.ts            # Package exports
```

`StoreTable` is one class split across four files, each layer adding one job to the one
below it — so a change to (say) the read path touches one file rather than a 3,400-line
one:

```
StoreTableBase        store-table-base.ts        state, store handles, stats, txn lifecycle,
                                                 effective-row reads (committed + pending)
  └ StoreTableScan    store-table-scan.ts        query: predicate -> byte window -> rows
    └ StoreTableConstraints
                      store-table-constraints.ts secondary-index maintenance, UNIQUE enforcement
      └ StoreTable    store-table.ts             update(), bulk row rewrites for ALTER
```

Only `StoreTable` is exported; the intermediate layers are `abstract` and exist purely to
divide the file. A layer may call downward (a scan may read the base's effective-row
iterator) but never upward. Nothing enforces that rule explicitly — it holds because a
base class cannot name a subclass member, so an upward call fails to compile.

`StoreModule` is layered the same way, over more files because it does more jobs:

```
StoreModuleBase          store-module-base.ts        provider/store handles, the module's
                                                     StoreTable map, the shared coordinator,
                                                     the catalog-write queue, name collisions
  └ StoreModuleCatalog   store-module-catalog.ts     catalog entries for tables/views/MVs,
                                                     clean-shutdown marker, stale-MV set
    └ StoreModuleSchemaSync
                         store-module-schema-sync.ts rehydrate at open, lazy table reconnect,
                                                     engine schema-change subscription
      └ StoreModuleIndex store-module-index.ts       create/drop index, `_uc_*` reconcile
        └ StoreModuleAlterColumn
                         store-module-alter-column.ts alter column (value rewrites, re-keys)
          └ StoreModuleAlter
                         store-module-alter.ts       alter table: every other arm
            └ StoreModuleRename
                         store-module-rename.ts      two-phase rename table
              └ StoreModule
                         store-module.ts             create/connect/destroy, capabilities,
                                                     backing host, closeAll
```

Three groups came out as free functions instead of layers, because they read no module
state: `store-module-access-plan.ts` (which access path to advertise),
`store-module-index-build.ts` (populating an index store, validating uniqueness over a row
stream) and `store-module-schema-rewrite.ts` (schema-to-schema rewrites). Prefer that shape
where it works — a free function is testable without constructing a module.

`store-module-access-plan.ts` is the deliberate mirror of `store-table-scan.ts`: the
planner decides which access path to advertise, the scan layer executes it, and several
soundness predicates (the collation-cover guards, the partial-index and semantic-ordering
declines) are duplicated across the two on purpose. A plan that claims a filter the scan
cannot honor drops the residual `Filter` and returns wrong rows, so the two must be changed
together.

- NOTE: the two largest `StoreTable` layers have both passed the ~1,000-line seam
  (`store-table-scan.ts` 1,113, `store-table-base.ts` 1,033 — `wc -l`, 2026-08). Splitting
  them is backlog `debt-split-store-table-scan-and-base`: the scan layer's natural seam is
  the multi-seek group (`decodeMultiSeekTuples` / `orderTupleValues` / `scanMultiSeek` /
  `scanMultiSeekPrimary`), the base's is the statistics block. Until it lands, prefer
  putting new scan-side logic in a collaborator (`pk-key-resolution.ts`, `key-builder.ts`,
  `json-key.ts`) over growing these two further.
- NOTE: no `StoreModule` layer is above ~620 lines today. `store-module-alter.ts` is the
  one most likely to grow, since every new ALTER arm lands there; if it passes ~900, the
  natural next seam is the three constraint arms (`alterAddConstraint` /
  `alterDropConstraint` / `alterRenameConstraint`), which touch no row data.

## Implementation Status

### Phase 1: Core Infrastructure ✓
- [x] Define `KVStore` interface with get/put/delete/iterate/batch/approximateCount
- [x] Implement key encoding with sort-order preservation (type-prefixed)
- [x] Implement row serialization using extended JSON
- [x] Implement key builder for data rows and secondary indexes
- [x] Implement schema/data change event emitter

### Phase 2: LevelDB Backend ✓
- [x] Implement `LevelDBStore` using `classic-level`
- [x] Implement `LevelDBModule` with create/connect/destroy
- [x] Implement `LevelDBTable` (query with PK point/range/scan, update with insert/update/delete)
- [x] Implement `getBestAccessPlan()` with cost estimation
- [x] Add single-table batch transactions via `WriteBatch`

### Phase 3: Secondary Indexes ✓
- [x] Index storage layout (i:schema.table.index:cols:pk)
- [x] Index maintenance during insert/update/delete
- [x] Index-aware `getBestAccessPlan()` cost estimation
- [x] CREATE INDEX DDL integration (createIndex on modules)

### Phase 4: IndexedDB Backend ✓
- [x] Implement `IndexedDBStore` with full KVStore interface
- [x] Implement `IndexedDBModule` and `IndexedDBTable`
- [x] Cross-tab change notifications via BroadcastChannel

### Phase 5: Schema Persistence ✓
- [x] Metadata storage (DDL strings in m:ddl:* keys)
- [x] Schema discovery via `rehydrateCatalog()` (wraps `loadAllDDL()` + `importCatalog()` with error tolerance)
- [x] DDL generation from TableSchema/IndexSchema
- [x] Reactive hooks for schema changes (StoreEventEmitter)
- [x] Lazy statistics refresh and persistence (~100 mutation batching)
- [x] Comprehensive test suite

### Phase 6: Additional Features ✓
- [x] Multi-table transactions via TransactionCoordinator
- [x] Collation-aware binary encoding infrastructure
- [ ] Per-column collation specification for keys/indexes (TODO)

### Phase 7: IndexedDB Single-Database Architecture ✓
- [x] Migrate from separate IDB databases to single database with multiple object stores
- [x] One object store per table (named by schema.table)
- [x] Sync metadata object store in same database (`__catalog__`)
- [x] Native cross-table IDB transactions for atomicity (`MultiStoreWriteBatch`)
- [x] No WAL needed for crash recovery

**Implementation**: `UnifiedIndexedDBModule` and `UnifiedIndexedDBStore` provide the new architecture.
Use `UnifiedIndexedDBModule` instead of `IndexedDBModule` to opt-in to the unified database.

### Phase 8: Platform Abstraction Layer ✓
- [x] Define `KVStoreProvider` interface for dependency injection
- [x] Create generic `StoreTable` that works with any `KVStore`
- [x] Create generic `StoreConnection` for transaction management
- [x] Core module in `@quereus/store` package
- [x] LevelDB plugin in `@quereus/plugin-leveldb` package
- [x] IndexedDB plugin in `@quereus/plugin-indexeddb` package
- [x] Create `LevelDBProvider` and `IndexedDBProvider` implementations
- [x] Factory functions: `createLevelDBProvider()` and `createIndexedDBProvider()`

This enables custom storage backends by implementing `KVStore` and `KVStoreProvider`.

### Phase 9: Transaction Isolation (Longer-term)
- [ ] Implement TransactionLayer pattern (similar to memory vtab) for read isolation
- [ ] Copy-on-write layer that inherits from committed base
- [ ] Readers see committed snapshot; writers work on isolated layer
- [ ] Atomic visibility on commit
- [ ] Enable sync plugin to leverage Store isolation for ACID sync operations
