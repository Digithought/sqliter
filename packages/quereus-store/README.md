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
  matched entry back to its base row by reading this key, rather than decoding the index
  key's PK suffix (that suffix is encoded lossily for a NOCASE/RTRIM PK column, so it is
  not recoverable to SQL values). Entries are not covering — the row itself always lives
  in the data store. The resolution is **batched**: the scan collects surviving index
  entries (across every window of an `IN`-list seek, not just one) up to
  `ROW_RESOLUTION_BATCH` = 256 and resolves each batch with a single `KVStore.getMany`,
  so an indexed read of *N* rows costs about *N*/256 data-store round trips rather than
  *N* serialized point reads — on IndexedDB, one readonly transaction per batch instead
  of one per row. The trade is early termination: a `limit 1` collects one batch rather
  than one row (the same trade `iterate`'s pager already makes).
- **Catalog keys**:
  - Tables: `{schema}.{table}` as a string (the `CREATE TABLE` bundle, with its index DDL and any exposed-implicit-index tag DDL)
  - Views: `\x00view\x00{schema}.{view}` (reserved-prefix; `generateViewDDL`)
  - Materialized views: `\x00mview\x00{schema}.{mv}` (reserved-prefix; `generateMaterializedViewDDL`)

This design eliminates redundant prefixes and groups related stores together by table name. The leading-`0x00` view/MV prefixes never collide with an unprefixed table key, so a view/MV may safely share a name with a table; a full catalog scan returns all three kinds intermixed and rehydrate classifies each by its key prefix.

**Which predicate shapes become a seek.** Everything else is answered by a full scan plus
a re-check of the pushed predicate, which is always correct — the shapes below are the ones
that also *narrow the bytes read*:

| Shape | Served by |
|-------|-----------|
| Equality on every primary-key column | one data-store point read |
| `<` / `<=` / `>` / `>=` on the **leading** primary-key column | one data-store byte window |
| Equality on a contiguous **leading prefix** of a secondary index | one index byte window (`plan=2`) |
| `IN` on a contiguous leading prefix of a secondary index | one index window per distinct list value (`plan=5`, see below) |
| `<` / `<=` / `>` / `>=` on the **leading** column of a secondary index | one index byte window (`plan=3`) |
| Equality on a **strict** leading prefix of a secondary index **plus** a bound on the very next index column | one index byte window covering just the bounded slice inside the prefix (`plan=7`) |

The last row is what makes `where entity = ? and date between ? and ?` over an index on
`(entity, date)` read only the dated slice rather than every row of the entity. It needs the
prefix pinned to a **single** value per column — a multi-value `IN` prefix keeps the
multi-seek above and leaves the bound as a residual — and it gives up the narrowing (falling
back to the plain prefix window, answer unchanged) when the bounded column's key bytes do not
reproduce its collation's order, or when its bound value has no faithful key position under a
semantically-ordered type. A bound on a *later* index column than the one right after the
prefix is not seeked at all. No ordering is advertised for this path, so an `ORDER BY` on the
bounded column keeps its `Sort`.

**A seek priced above a full scan is dropped.** A secondary-index seek reads two things per
matched row — the index entry, then the row it names — while a scan reads one, so the module
charges that second read and then compares the arm against its own sequential-scan cost,
returning the scan when the seek prices higher. The predicate stays as a residual either
way, so the rows are identical and only the speed differs. The module keeps no per-column
statistics, so how many rows a predicate matches is guessed as a fixed fraction of the table
(10% for an equality, 30% for a range); that makes the comparison per-*index-shape* rather
than per-query, and today it only fires where the guess is the whole table. Multi-seeks are
exempt from the comparison — the engine reads their cost as a curve to decide its own key-set
rewrites, and answering it with a scan would switch that feature off.

**`IN`-list index seeks ("multi-seek").** An `IN`-list on an indexed column
(`where v in (1, 2, 3)`, including parameter-bound lists) is served from the index as one
deduplicated, key-ordered point seek per distinct list value, instead of a full scan with
a residual filter. `NULL` list values match nothing and are skipped, duplicate values
yield their rows once, and a composite index serves the cross-product of per-column lists
(`a in (1,2) and b in (10,20)` is four seeks). Very large lists (over 1000 seek keys) and
lists on semantically-ordered column types (TIMESPAN, JSON) fall back to the scan path —
still correct, just not accelerated. `IN` on the primary key currently scans (see backlog
`feat-store-pk-in-list-multiseek`). When several secondary indexes can serve the same
predicate, the lowest-cost seek wins (equal costs keep the first-declared index), so
declaration order no longer decides whether a query does one seek or hundreds. The primary-key
arms still take precedence over any secondary index whenever they apply.

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
- Index-column bytes are encoded under each index column's **own** key collation (the index's per-column `COLLATE`, else the table column's declared collation), and the constraint re-validates candidates under its enforcement collation `C` (the same resolution). For every index a designed path can hand the check the two are identical by construction, so the seek window is exactly the `C`-equal set. The check is kept because one undesigned path can still disagree — a user index whose name collides with the `_uc_*` a constraint would have minted lets a same-columns index with different collations be selected — and there a seek would under-fetch and silently accept a real duplicate, so the constraint falls back to the full scan. The **table key collation** `K` (the `collation` module option, default `NOCASE`) is not part of this decision; it is the fallback for an undecorated *primary-key* member only. "Can never hold text" (exempt — key bytes are type-native) is judged by physical representation, not by declared type name: an `ANY` or `JSON` column stores a string as a string, so neither is exempt — and because their `compare` ignores collation, they key hard-`BINARY`, so an `ANY`/`JSON` column carrying a declared `COLLATE` is exactly the shape that declines.

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
import { defaultGetMany, type KVStore, type KVStoreProvider } from '@quereus/store';

class MyCustomStore implements KVStore {
  async get(key: Uint8Array) { /* ... */ }
  // Positional batch point-read. Override it when the backend has a native multi-get or a
  // way to issue every request on one round trip; otherwise `defaultGetMany(this, keys)`.
  getMany(keys: readonly Uint8Array[]) { return defaultGetMany(this, keys); }
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
iteration, streaming across page boundaries, batch semantics, optional persistence,
cross-backend encoded-key ordering, bounded iteration, and the batch point-read). Wire a
tiny lifecycle adapter and run it under Mocha so any drift from the contract fails a test:

```typescript
import { runKVStoreConformance } from '@quereus/store/testing';

runKVStoreConformance('MyCustomStore', () => ({
  open: async () => new MyCustomStore(/* ... */),
  // Omit `reopen` for a non-persistent backend; supply it (reopen the SAME keyspace
  // without wiping) to also exercise the persistence tier.
  teardown: async () => { /* close handles, remove backing storage */ },
  // Optional. The battery holds only a KVStore handle and cannot see what the backend
  // reads underneath, so supply a counter over whatever the store reads FROM plus the
  // backend's batch size, and the bounded-iteration tier also measures reads. Omit it
  // and that tier still checks that abandoning an iteration releases resources.
  readMeter: { entriesRead: () => myBackingReads, maxReadAhead: 1 },
  // Also optional, and a DIFFERENT counter: `readMeter` counts entries an iteration
  // yields, so it cannot see a point read. Supply this — trips to backing storage, one
  // per `get`, one per native multi-get — and the batch point-read tier additionally
  // asserts that `getMany` over K keys costs exactly ONE trip. Omit it on a backend whose
  // `getMany` is the shared fallback; that tier's correctness cases still run.
  pointReadMeter: { roundTrips: () => myBackingRoundTrips },
}));
```

See `test/kv-conformance.spec.ts` (in-memory), and the `test/conformance.spec.ts` of each
backend plugin — LevelDB, IndexedDB, React Native LevelDB, NativeScript SQLite — for worked
adapters. The two mobile plugins run against an in-process stand-in for their native module
(a mock LevelDB, and better-sqlite3 behind the NativeScript SQLite interface), which is what
makes them testable off-device; the NativeScript one uses a temp file database so it also
drives the persistence tier.

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

**Every provider runs the store-name distinctness battery.** `runStoreNameDistinctness(name,
makeNamingBackend)` holds a provider to the one naming rule the engine depends on: two
logical stores it considers distinct never share one physical store. A provider must build
its names with `buildDataStoreName` / `buildIndexStoreName` and escape them into its own
namespace injectively; a name the namespace cannot represent must be *rejected*, never folded
onto another. The battery asserts this behaviorally — it opens a corpus of adversarial
`(schema, table)` and `(schema, table, index)` names, writes a distinct marker into each under
one shared key, and checks each still reads back its own — plus that two spellings of one
case-insensitive identifier land on the SAME store, and that a user table named `__stats__` or
`__catalog__` stays off the reserved stores:

```typescript
import { runStoreNameDistinctness } from '@quereus/store/testing';

runStoreNameDistinctness('MyCustomProvider store names', () => ({
  open: async () => new MyCustomProvider(/* fresh, empty keyspace */),
  teardown: async () => { /* close the provider, remove backing storage */ },
}));
```

All four backend plugins register it in their `test/conformance.spec.ts`. LevelDB and
IndexedDB are its reference implementations, so a failure there means the battery is wrong
rather than the plugin. `assertStoreNamesDistinct` — its core assertion — is exported
standalone; `test/store-name-distinctness.spec.ts` drives it against provider doubles built
to fold, truncate, and over-reject, so the guard itself is watched failing.

## KVStore Interface

The `KVStore` interface is the foundation for all storage backends:

```typescript
interface KVStore {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  // Positional: result[i] belongs to keys[i], `undefined` for an absent key, the array is
  // always keys.length long, and a repeated key is answered at every position it occupies
  // in its own buffer. No internal paging — the CALLER sizes the batch.
  getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;
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
  // (`indexNames` carries the same authoritative, exact index list). Omit it and the
  // module copies every entry through getStore/getIndexStore instead — correct on any
  // provider, but O(table size); implement this for a native move.
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
- A **schema-only** DDL statement that fails is a clean no-op: `create index` / `drop index` and every `alter table` path that rewrites no row data (`add` / `drop` / `rename constraint`, `rename column`, and the `alter column` shapes with no value rewrite, key re-encode or index rebuild — `drop not null`, `set default`, a `set not null` over rows holding no NULL, a `set collate` on an unindexed non-PK column) put the connected table's cached schema back when the catalog write throws. Without that undo the module's in-memory schema stayed one statement ahead of both the engine and the catalog for the rest of the session, and the *next* successful catalog write — from any later statement — made the refused change durable
  - Not so for the **row-rewriting** paths (`add` / `drop column`, `alter primary key`, and the `alter column` shapes that convert values, re-key, or rebuild indexes): by the time they persist they have already re-encoded the store outside any transaction, so restoring the old schema would misread the new bytes. An IO error between the rewrite and the catalog write leaves the two diverged until the statement is re-run — an accepted tradeoff whose real fix is one durable marker covering the whole physical rewrite
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
| `resolveIndexKeyCollations` | Per-index-column key collations (the index half of `buildIndexKey`: index COLLATE ?? column collation ?? BINARY) |
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
