# @quereus/store

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. Its on-disk key encoding is not frozen, so
> a format change can make an existing database unreadable without a migration step. See
> [Stability Tiers](../../docs/stability.md#tiers).

Abstract key-value storage module for [Quereus](https://github.com/gotchoices/quereus). Provides platform-agnostic interfaces and a generic `StoreModule` virtual table implementation.

## Architecture

This package provides the **abstract layer** that separates virtual table logic from platform-specific storage:

```
@quereus/store (this package)
├── KVStore interface           - Abstract key-value store
├── KVStoreProvider interface   - Store factory/management
├── StoreModule                 - Generic VirtualTableModule
├── StoreTable                  - Generic virtual table implementation
├── StoreConnection             - Generic transaction support
└── Common utilities            - Encoding, serialization, events

@quereus/plugin-leveldb (Node.js)     @quereus/plugin-indexeddb (Browser)
├── LevelDBStore                      ├── IndexedDBStore
├── LevelDBProvider                   ├── IndexedDBProvider
└── Plugin registration               ├── IndexedDBManager
                                      └── CrossTabSync
```

This architecture enables:
- **Platform portability** - Same SQL tables work across Node.js, browsers, and mobile
- **Custom storage backends** - Implement `KVStore` for IndexedDB, LevelDB, LMDB, or other "NoSQL" stores
- **Dependency injection** - Use `KVStoreProvider` for store management

## Storage Architecture

The store module uses separate logical stores for different data types:

**Store Naming Convention:**
- `{schema}.{table}` - Data store (row data)
- `{schema}.{table}_idx_{indexName}` - Index stores (one per secondary index)
- `{prefix}.__stats__` - Unified stats store (row counts for all tables)
- `__catalog__` - Catalog store (DDL metadata)

**Key Formats:**
- **Data keys**: Encoded primary key (no prefix)
- **Index keys**: Encoded index columns + encoded PK
- **Index values**: The row's encoded **data key**. A secondary-index scan resolves each
  matched entry back to its base row with one data-store read at this key, rather than
  decoding the index key's PK suffix (that suffix is encoded lossily for a NOCASE/RTRIM
  PK column, so it is not recoverable to SQL values). Entries are not covering — the row
  itself always lives in the data store.
- **Catalog keys**:
  - Tables: `{schema}.{table}` as a string (the `CREATE TABLE` bundle, with its index DDL and any exposed-implicit-index tag DDL)
  - Views: `\x00view\x00{schema}.{view}` (reserved-prefix; `generateViewDDL`)
  - Materialized views: `\x00mview\x00{schema}.{mv}` (reserved-prefix; `generateMaterializedViewDDL`)

This design eliminates redundant prefixes and groups related stores together by table name. The leading-`0x00` view/MV prefixes never collide with an unprefixed table key, so a view/MV may safely share a name with a table; a full catalog scan returns all three kinds intermixed and rehydrate classifies each by its key prefix.

**`IN`-list index seeks ("multi-seek").** An `IN`-list on an indexed column
(`where v in (1, 2, 3)`, including parameter-bound lists) is served from the index as one
deduplicated, key-ordered point seek per distinct list value, instead of a full scan with
a residual filter. `NULL` list values match nothing and are skipped, duplicate values
yield their rows once, and a composite index serves the cross-product of per-column lists
(`a in (1,2) and b in (10,20)` is four seeks). Very large lists (over 1000 seek keys) and
lists on semantically-ordered column types (TIMESPAN, JSON) fall back to the scan path —
still correct, just not accelerated. `IN` on the primary key currently scans (see backlog
`feat-store-pk-in-list-multiseek`). Index choice among several usable indexes is
first-match, not cheapest — see backlog `bug-store-index-choice-ignores-cost`.

The same multi-seek path also serves an `IN` whose values only exist once the query runs
— `where v in (select … )`, which the engine may materialize into a set and hand down as
a seek (its `KeySetSemiJoin`). **Nothing in this module distinguishes the two.** The
engine stamps a `FilterInfo` byte-identical in shape to a literal list's, so every gate
above applies unchanged: the 1000-key cap, the semantic-ordering decline, the key-collation
guard, the partial-index exclusion, and the primary-key arm's refusal of any `IN`. At plan
time such a set describes itself only by a ceiling (`PredicateConstraint.runtimeSet.maxCount`),
which is what the cost and cap arithmetic judges. The engine also re-checks every row the
seek returns, so an over-fetching window costs only time.

**Catalog DDL is re-persisted on catalog-only mutations.** `ALTER … SET TAGS` (and the programmatic `setTableTags` / `setColumnTags` / `setConstraintTags` / `setViewTags` / `setMaterializedViewTags`), plus `CREATE`/`DROP VIEW` and `CREATE`/`DROP MATERIALIZED VIEW`, never reach `module.alterTable`/`module.destroy`. The module subscribes to the engine's schema-change events (`table_modified`, the `view_*` events, and the `materialized_view_*` events) and writes the matching `__catalog__` entry when its `generate*DDL` output changes — table / column / constraint / **index** / **view** / **materialized-view** tags, and view/MV lifecycle, all survive close → reopen. A table's bundle is its `CREATE TABLE` DDL, one `CREATE [UNIQUE] INDEX` line per secondary index, and one trailing `alter index … set tags (…)` line per *exposed implicit index* carrying user tags (an exposed implicit index is never materialized in the store's *engine-facing* schema — only in its internal enforcement schema, see the implicit-index note below — so its `UniqueConstraintSchema.exposedIndexTags` has no `CREATE INDEX` line to ride; the alter line re-applies silently on import). These async writes are serialized and drained by `closeAll()` (or the `whenCatalogPersisted()` barrier) before the provider closes. On reopen, `rehydrateCatalog` classifies entries by key prefix and imports them in phases — tables → views → materialized views, all through the engine's `importCatalog` (MVs re-materialize silently via the shared create core, dependency-ordered for MV-over-MV by fixpoint retry). See [`docs/view-persistence.md`](../../docs/view-persistence.md#view-and-materialized-view-persistence) for the full design.

**How a UNIQUE constraint is enforced.** For each row written, the store looks for a conflicting row through the cheapest sound route available:

1. **A linked row-time covering materialized view** — its backing table answers the uniqueness question.
2. **A physical secondary index realizing the constraint** — one bounded seek into the index store. Available for **every** non-derived `UNIQUE` (see the implicit-index note below), for a constraint that came from a `CREATE UNIQUE INDEX` (it names its own index), and for any *full* (non-partial) index whose columns match the constraint's. The index need not itself be UNIQUE.
3. **A full scan of the data store** — always correct, and O(rows) per row written.

Route 2 turns a bulk insert from O(n²) into roughly O(n log n). It is skipped for a constraint the index cannot answer soundly:

- A **partial** index cannot serve a constraint it does not derive from: it physically omits its out-of-scope rows, so a seek would miss a conflict among them.
- Index-column bytes are encoded under the **table key collation** `K` (the `collation` module option, default `NOCASE`), not under the constraint's enforcement collation `C`. A seek returns exactly the rows `K`-equal to the new row, so it is a sound *superset* of the true conflict set only when `K` is coarser-than-or-equal-to `C` (a column that can never hold text; `C == K`; or `K = NOCASE` over `C = BINARY`). When `K` is finer — `K = BINARY` over `C = NOCASE`, or `K = NOCASE` over `C = RTRIM` — a seek would under-fetch and silently accept a real duplicate, so the constraint falls back to the full scan. "Can never hold text" is judged by physical representation, not by declared type name: an `ANY` or `JSON` column stores a string as a string, so neither is exempt.

Whichever route runs, the conflicting row is re-validated identically: the row being written is excluded by primary key, each constrained column is compared under its enforcement collation (a `CREATE UNIQUE INDEX … (col COLLATE x)` enforces `x`, else the column's declared collation), and a partial constraint's predicate must hold on the candidate.

Because route 2 trusts the index store to hold an entry for every live row, `CREATE INDEX` populates the new index from the table's **effective** rows — committed rows merged with the open transaction's pending writes. A row inserted earlier in that transaction is therefore indexed, and participates in `CREATE UNIQUE INDEX`'s duplicate check, rather than being invisible to every later seek. Index entries are written outside the transaction coordinator, so a later `ROLLBACK` leaves entries for rows that no longer exist; every reader resolves an index entry to its live row and drops it when the row is gone or no longer matches, so a stale entry can never manufacture a result.

**Implicit per-constraint index (`_uc_*`).** Every non-derived `UNIQUE` — declared inline at `CREATE TABLE` or added by `ALTER TABLE … ADD CONSTRAINT` — is backed by a hidden secondary index named `<constraint name>` or, when unnamed, `_uc_<columns>` (the same convention the memory backend and the engine's `implicitIndexName` use). This is what makes route 2 reach a plain `UNIQUE`, so a bulk load no longer degrades to O(n²). The index is:

- **Kept out of the engine.** It lives only in the StoreTable's *enforcement* schema, never in the engine-registered schema, so the read-query planner does not see it (a plain `UNIQUE` gets no read-side plan from it — matching the memory backend) and it is never written to the catalog as a `CREATE INDEX`.
- **Derived on open.** Reconstructing a StoreTable re-materializes the schema entry from `uniqueConstraints`; the physical index store persists on disk under its deterministic name and is reopened lazily. (A store written *before* this feature has no `_uc_*` store on disk — backwards compatibility is waived project-wide; reopening such a database would need the index rebuilt.)
- **Reconciled across ALTER and CREATE / DROP INDEX.** `ADD CONSTRAINT` builds the physical store from the existing rows (after the existing-row duplicate check passes); `DROP CONSTRAINT` tears it down (so a later re-`ADD` cannot reopen stale entries); `RENAME CONSTRAINT`, and a column rename that changes an unnamed constraint's implicit name, move the store; a PK / collation / data-type `ALTER` re-encodes it via the same rebuild that re-encodes explicit indexes.
- **Relocated / reclaimed with the table.** `DROP TABLE` deletes the `_uc_*` store alongside the data + explicit-index stores; `RENAME TABLE` relocates it under the new name. Both resolve the physical store list from the *enforcement* schema (not the engine-facing `.indexes`, which omits `_uc_*`), so the implicit store is never stranded on drop nor left behind on rename (which would leave the renamed table seeking an empty store and accepting a duplicate).
- **Skipped when an explicit index already realizes the constraint.** A `UNIQUE` whose columns are covered — in the same order — by a full (non-partial) `CREATE INDEX` whose per-column collations match the declared column collations gets no `_uc_*` at all: that index enforces it, so a write maintains one structure instead of two. Reuse is refused for a partial index, a partial `UNIQUE`, an index over different or reordered columns, and a collation-mismatched index; those still build the `_uc_*` and both structures coexist. The decision is recomputed whenever the schema changes and is never persisted, so `CREATE INDEX` over a constrained column tears the redundant `_uc_*` store down and `DROP INDEX` rebuilds it from the live rows.
- **DDL-committing when it tears a store down.** Deleting a `_uc_*` store (or an explicit index store) discards a KVStore handle the transaction coordinator may hold buffered writes against, so those DDL statements flush the module's pending transaction first — the same `ddlTransactionality: 'auto-commit'` posture the row-rewriting `ALTER` arms take. A `CREATE INDEX` that retires no `_uc_*` does not flush.

## Installation

```bash
npm install @quereus/store
```

For platform-specific implementations:
```bash
# Node.js
npm install @quereus/plugin-leveldb

# Browser
npm install @quereus/plugin-indexeddb
```

## Usage

### With a Provider

```typescript
import { Database } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';
// OR: import { createIndexedDBProvider } from '@quereus/plugin-indexeddb';

const db = new Database();

// Create provider for your platform
const provider = createLevelDBProvider({ basePath: './data' });

// Create the generic store module with your provider
const storeModule = new StoreModule(provider);
db.registerModule('store', storeModule);

// Use it in SQL
await db.exec(`
  create table users (id integer primary key, name text)
  using store
`);
```

### Custom Storage Backend

Implement `KVStore` and `KVStoreProvider` to create custom storage backends:

```typescript
import type { KVStore, KVStoreProvider } from '@quereus/store';

class MyCustomStore implements KVStore {
  async get(key: Uint8Array) { /* ... */ }
  async put(key: Uint8Array, value: Uint8Array) { /* ... */ }
  async delete(key: Uint8Array) { /* ... */ }
  async has(key: Uint8Array) { /* ... */ }
  iterate(options?: IterateOptions) { /* ... */ }
  batch() { /* ... */ }
  async close() { /* ... */ }
  async approximateCount(options?: IterateOptions) { /* ... */ }
}

class MyCustomProvider implements KVStoreProvider {
  async getStore(schemaName: string, tableName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getIndexStore(schemaName: string, tableName: string, indexName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getStatsStore(schemaName: string, tableName: string) {
    return new MyCustomStore(/* ... */);
  }
  async getCatalogStore() { /* ... */ }
  async closeStore(schemaName: string, tableName: string) { /* ... */ }
  async closeIndexStore(schemaName: string, tableName: string, indexName: string) { /* ... */ }
  async closeAll() { /* ... */ }
}

// Use it with StoreModule
const provider = new MyCustomProvider();
const module = new StoreModule(provider);
db.registerModule('store', module);
```

**Validate a new backend against the shared conformance suite.** `@quereus/store/testing`
exports `runKVStoreConformance(name, makeBackend)` — one parameterized battery of
behavioral tests written against the `KVStore` contract (point ops, ordering, range
iteration, streaming across page boundaries, batch semantics, optional persistence, and
cross-backend encoded-key ordering). Wire a tiny lifecycle adapter and run it under Mocha
so any drift from the contract fails a test:

```typescript
import { runKVStoreConformance } from '@quereus/store/testing';

runKVStoreConformance('MyCustomStore', () => ({
  open: async () => new MyCustomStore(/* ... */),
  // Omit `reopen` for a non-persistent backend; supply it (reopen the SAME keyspace
  // without wiping) to also exercise the persistence tier.
  teardown: async () => { /* close handles, remove backing storage */ },
}));
```

See `test/kv-conformance.spec.ts` (in-memory), and the LevelDB / IndexedDB plugins'
`test/conformance.spec.ts` for worked adapters.

**If your provider implements `beginAtomicBatch`, also run the provider suite.** The same
entry point exports `runKVProviderConformance(name, makeProviderBackend)` — the battery for
the provider-level contract that ops queued across SEVERAL of the provider's stores commit
in one durable, all-or-nothing physical write (multi-store commit landing only in each op's
own store, nothing visible until `write()`, mixed put + delete, a delete of a missing key,
same-key last-op-wins, `clear()` discarding, the empty `write()` no-op, and `MISUSE` on a
store handle from a different provider):

```typescript
import { runKVProviderConformance } from '@quereus/store/testing';

runKVProviderConformance('MyCustomProvider atomic batch', () => ({
  open: async () => new MyCustomProvider(/* fresh, empty keyspace */),
  // A SECOND provider over a DIFFERENT keyspace — source of the foreign handle that
  // must be rejected with MISUSE.
  openForeign: async () => new MyCustomProvider(/* another keyspace */),
  teardown: async () => { /* close both, remove backing storage */ },
}));
```

The LevelDB / IndexedDB plugins' `test/atomic-batch.spec.ts` run it, keeping only their
backend-specific cases (LevelDB's "no batch before the shared root is open", IndexedDB's
post-write read-cache invalidation) alongside.

## KVStore Interface

The `KVStore` interface is the foundation for all storage backends:

```typescript
interface KVStore {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  put(key: Uint8Array, value: Uint8Array): Promise<void>;
  delete(key: Uint8Array): Promise<void>;
  has(key: Uint8Array): Promise<boolean>;
  iterate(options?: IterateOptions): AsyncIterable<KVEntry>;
  batch(): WriteBatch;
  close(): Promise<void>;
  approximateCount(options?: IterateOptions): Promise<number>;
}

interface KVStoreProvider {
  // Get data store for a table
  getStore(schemaName: string, tableName: string): Promise<KVStore>;
  
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
  // names (from the schema) — build index store names from it via
  // buildIndexStoreName instead of prefix-scanning `{table}_idx_`, which would
  // also match a sibling table literally named `{table}_idx_<x>`.
  deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;
  deleteTableStores?(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void>;

  // Optional: Relocate a table's data + index stores for ALTER TABLE ... RENAME TO
  // (`indexNames` carries the same authoritative, exact index list).
  renameTableStores?(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void>;
}
```

## Module Capabilities

The `StoreModule` reports its capabilities via `getCapabilities()`:

```typescript
const storeModule = new StoreModule(provider);
const caps = storeModule.getCapabilities();

// {
//   isolation: false,      // Store module does NOT provide transaction isolation
//   savepoints: true,      // Coordinator-buffered ops support savepoints within a transaction
//   persistent: true,      // Data persists across restarts
//   secondaryIndexes: true,// Supports secondary indexes
//   rangeScans: true       // Supports range scans
// }
```

**Important:** The base `StoreModule` does not provide transaction isolation:
- No snapshot isolation: between connections, reads see only committed data, and concurrent readers may observe partial writes
- Within a transaction, reads through the table's shared coordinator DO see that transaction's own pending writes (read-your-own-writes). This extends to DML's own internal reads: the insert PK-conflict probe, the update/delete old-image reads, and the update PK-change conflict probe all read through the pending merge, so an INSERT/UPDATE/DELETE against a row written earlier in the same transaction sees that pending row — it raises a UNIQUE conflict (or evicts under `OR REPLACE`), cleans up secondary-index entries, tracks the correct row-count delta, and emits events carrying the pending `oldRow`
- Row-validating DDL reads the same effective stream: `create index` / `create unique index` populate from it (see above), and `alter table … add constraint … unique` plus the `set collate` re-validation of a covering non-PK UNIQUE scan it too — so a duplicate inserted earlier in the still-open transaction is rejected rather than surviving to commit
- Savepoints (create / release / rollback-to) work within a transaction via the coordinator's buffered op log
  - Caveat: a DDL-commit operation (`replaceContents` / `renameTable`, e.g. `refresh materialized view` or `alter table … rename`) commits the coordinator mid-transaction, clearing the savepoint stack. A later `rollback to` / `release` targeting a now-vanished savepoint degrades to a no-op (warn-and-return) rather than throwing; the committed DDL and everything before it stays committed

## Atomic multi-store commit (module-wide, cross-table)

A single `TransactionCoordinator` is shared by **every table of one storage
module** — it is the unit of cross-table atomicity. Every buffered op is
addressed by its explicit target `KVStore` handle (data ops, secondary-index
ops, and backing-host writes alike), so a transaction touching tables A and B
accumulates all of their stores' ops in one coordinator. Because the engine
commits virtual-table connections **sequentially** and the coordinator's
`commit()`/`rollback()` are **idempotent**, the first connection to commit
flushes **every** touched store of **every** table the transaction wrote; the
remaining connections no-op.

`TransactionCoordinator.commit()` thus writes each table's data store and each of
its secondary-index stores. By default it writes **one `KVStore.batch()` per
store, sequentially** — a crash between those batches can leave tables/indexes
divergent on disk, with no automatic healing (no worse than the prior per-table
commits, which were already non-atomic across tables).

A provider whose stores share a single durable commit domain can close that
window by implementing the optional `KVStoreProvider.beginAtomicBatch()`:

```typescript
interface AtomicBatch {
  put(store: KVStore, key: Uint8Array, value: Uint8Array): void;
  delete(store: KVStore, key: Uint8Array): void;
  write(): Promise<void>;   // one durable, all-or-nothing physical commit
  clear(): void;
}

interface KVStoreProvider {
  // ...
  // Open a batch spanning this provider's stores, or undefined when the provider
  // has no shared commit domain (the coordinator then falls back to per-store batch()).
  beginAtomicBatch?(): AtomicBatch | undefined;
}
```

The batch addresses stores by **`KVStore` handle**, so it composes with the
coordinator's existing per-store bucketing without a name lookup. When present,
`commit()` queues every pending op — every store of **every table** in the
transaction — into one `AtomicBatch` and issues a single `write()`; all of those
tables commit or roll back together. When absent — or when the factory returns
`undefined` — behavior is byte-identical to the per-store loop, so providers
without a shared domain are unaffected.

The capability surface spans **multiple stores of one provider** (every store of
every table the module owns), giving full module-wide cross-table atomicity with
no interface change. The
[`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb) provider implements it
over its single IndexedDB database (multiple object stores, one
`db.transaction(...,'readwrite')`), invalidating each touched store's read cache
after a successful write so read-your-own-writes survives the cache.

## Materialized-View Backing Host

The store module implements the engine's backing-host capability
(`StoreBackingHost`), so `create materialized view mv using store as <body>`
places the MV's backing table in persistent storage. Maintenance writes ride
the module's shared `TransactionCoordinator`'s pending state (committing/rolling
back in lockstep with the source write — and, since the coordinator is
module-wide, in the same all-or-nothing batch as a write to a same-module
source), mid-transaction reads of the MV see pending
maintenance through the read-your-own-writes merge, and the backing's text
primary-key columns are keyed under the store's `collation` arg (default
`NOCASE` — pass `using store(collation = 'BINARY')` for byte-exact keys). The
isolation wrapper forwards the capability automatically. See
[`docs/mv-backing-host.md` § The store host](../../docs/mv-backing-host.md#the-store-host-using-store).

## External Row-Write Entry Point

`StoreTable.applyExternalRowChanges(ops)` applies trusted, externally-originated
row writes (e.g. inbound replication) directly to a **source** table's committed
storage — table-owned data-key put/delete, **secondary-index maintenance**, and
stats tracking — and returns the effective `BackingRowChange[]` (the shape
`Database.ingestExternalRowChanges` consumes). It is the index-maintaining
sibling of the backing host (whose MV backing tables carry no indexes): a caller
writing the data `KVStore` directly would silently skip index and stats upkeep.

Resolve the table with `StoreModule.getTableForExternalWrite(db, schema, table)`
(same ownership/wrapper resolution as `getBackingHost`), read a row's current
image with `StoreTable.readRowByPk(pk)`, then apply one `ExternalRowOp` per row:

```typescript
const table = storeModule.getTableForExternalWrite(db, 'main', 'users');
if (table) {
  const changes = await table.applyExternalRowChanges([
    { op: 'upsert', row: [1, 'alice'] },   // full row, schema column order
    { op: 'delete', pk: [2] },             // PK values, PK-definition order
  ]);
}
```

Deliberately emits **no** module data events (the caller owns emission and the
`remote` flag), opens **no** coordinator transaction (writes commit at once,
last-writer-wins against any pending local transaction), and runs **no**
constraint validation (the origin is trusted). No-ops are suppressed: a delete
of an absent key and a value-identical upsert (byte-faithful) write nothing and
report nothing.

## Transaction Isolation

To add full ACID transaction semantics with snapshot isolation, wrap the store module with the `IsolationModule`:

```typescript
import { Database, MemoryTableModule } from '@quereus/quereus';
import { IsolationModule } from '@quereus/isolation';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const db = new Database();
const provider = createLevelDBProvider({ basePath: './data' });

// Option 1: Use the convenience function
const isolatedModule = createIsolatedStoreModule({ provider });
db.registerModule('store', isolatedModule);

// Option 2: Manual wrapping for more control
const storeModule = new StoreModule(provider);
const isolatedModule = new IsolationModule({
	underlying: storeModule,
	overlay: new MemoryTableModule(),
});
db.registerModule('store', isolatedModule);

// Now transactions have full isolation
await db.exec('BEGIN');
await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);

// Read-your-own-writes: sees uncommitted insert
const user = await db.get('SELECT * FROM users WHERE id = 1');
console.log(user.name); // 'Alice'

await db.exec('COMMIT'); // Or ROLLBACK to discard
```

The isolation layer provides:
- **Read-your-own-writes** within transactions
- **Snapshot isolation** for consistent reads
- **Savepoint support** via the overlay module

### Checking for Isolation Support

```typescript
import { hasIsolation } from '@quereus/store';

const storeModule = new StoreModule(provider);
console.log(hasIsolation(storeModule)); // false

const isolatedModule = createIsolatedStoreModule({ provider });
console.log(hasIsolation(isolatedModule)); // true
```

## API

### Core Exports

| Export | Description |
|--------|-------------|
| `KVStore` | Key-value store interface (type) |
| `KVStoreProvider` | Store factory interface (type) |
| `WriteBatch` | Batch write interface (type) |
| `AtomicBatch` | Cross-store all-or-nothing batch from `KVStoreProvider.beginAtomicBatch` (type) |
| `IterateOptions` | Iteration options (type) |
| `StoreModule` | Generic VirtualTableModule |
| `StoreTable` | Virtual table implementation (incl. `applyExternalRowChanges` / `readRowByPk` for externally-applied source writes) |
| `ExternalRowOp` | One externally-applied row op (`upsert`/`delete`) for `StoreTable.applyExternalRowChanges` (type) |
| `resolvePkKeyCollations` | Per-PK-column key collations (pass to `buildDataKey`/`buildIndexKey` to match `StoreTable`'s key bytes) |
| `StoreConnection` | Transaction connection |
| `TransactionCoordinator` | Transaction management |
| `StoreEventEmitter` | Event system for data/schema changes |

### Isolation Layer Utilities

| Export | Description |
|--------|-------------|
| `createIsolatedStoreModule` | Create store module with isolation layer |
| `hasIsolation` | Check if a module has isolation capability |
| `IsolatedStoreModuleConfig` | Configuration for isolated store module |

### Caching

| Export | Description |
|--------|-------------|
| `CachedKVStore` | Read-through LRU cache wrapper for any `KVStore` |
| `CacheOptions` | Configuration for cache (maxEntries, maxBytes, enabled) |

### Encoding Utilities

| Export | Description |
|--------|-------------|
| `encodeValue` | Encode a SQL value to sortable bytes |
| `decodeValue` | Decode bytes back to SQL value |
| `encodeCompositeKey` | Encode multiple values as composite key |
| `decodeCompositeKey` | Decode composite key to values |
| `BUILTIN_KEY_NORMALIZER_RESOLVER` | Built-ins-only key-normalizer resolver (`EncodeOptions.normalizers` default) |

### Serialization Utilities

| Export | Description |
|--------|-------------|
| `serializeRow` | Serialize a row to bytes |
| `deserializeRow` | Deserialize bytes to row |
| `serializeValue` | Serialize a single value |
| `deserializeValue` | Deserialize a single value |

### Key Building

| Export | Description |
|--------|-------------|
| `buildDataStoreName` | Build store name for table data |
| `buildIndexStoreName` | Build store name for an index |
| `buildStatsStoreName` | Build store name for table stats |
| `buildDataKey` | Build key for row data (encoded PK) |
| `buildIndexKey` | Build key for index entry |
| `buildCatalogKey` | Build key for a table's catalog entry (`{schema}.{table}`) |
| `buildViewCatalogKey` | Build key for a view's catalog entry (reserved `\x00view\x00` prefix) |
| `buildMaterializedViewCatalogKey` | Build key for an MV's catalog entry (reserved `\x00mview\x00` prefix) |
| `classifyCatalogKey` | Classify a loaded catalog key as `'table'` / `'view'` / `'materializedView'` |
| `buildFullScanBounds` | Build bounds for full table scan |
| `buildIndexPrefixBounds` | Build bounds for index prefix scan |
| `buildPkPrefixBounds` | Build bounds for a data-store PK prefix range (per-column DESC + key collations) |
| `buildCatalogScanBounds` | Build bounds for catalog scan |
| `CATALOG_STORE_NAME` | Reserved catalog store name constant |
| `STORE_SUFFIX` | Store name suffixes (INDEX, STATS) |

## Related Packages

- [`@quereus/plugin-leveldb`](../quereus-plugin-leveldb/) - LevelDB implementation for Node.js
- [`@quereus/plugin-indexeddb`](../quereus-plugin-indexeddb/) - IndexedDB implementation for browsers
- [`@quereus/sync`](../quereus-sync/) - CRDT sync layer

## License

MIT
