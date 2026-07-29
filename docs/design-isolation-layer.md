# Isolation Layer Design

## Overview

This document describes a **generic transaction isolation layer** that can wrap any `VirtualTableModule` to provide ACID transaction semantics with read-your-own-writes and savepoint support. It does **not** provide snapshot isolation or write-write conflict detection — see [Isolation Level Provided](#isolation-level-provided) below.

The goal is to decouple **storage** concerns from **isolation** concerns:

- **Storage modules** (memory, LevelDB, IndexedDB, custom) focus on persistence and indexing
- **Isolation layer** provides consistent transaction semantics across all modules

This enables module authors to implement simple read/write logic while getting full transaction support "for free."

---

## Motivation

### Current State

The memory virtual table module (`@quereus/quereus`) implements its own transaction isolation using `inheritree` B+Trees with copy-on-write inheritance. This works well but:

1. The isolation logic is tightly coupled to the storage implementation
2. Other modules (store, sync, custom) must re-implement isolation from scratch
3. Each implementation has different semantics and edge cases

The store modules (`quereus-store`) currently have no read isolation—queries see committed data only, not pending writes from the current transaction.

### Desired State

A composable isolation layer that:

- Wraps any underlying module transparently
- Provides read-your-own-writes isolation semantics (not a stable snapshot — see below)
- Handles savepoints via nested layers
- Is well-tested in one place rather than per-module

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   IsolationModule                        │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │         Overlay Module (e.g., memory vtab)         │ │
│  │                                                     │ │
│  │  - Stores pending inserts, updates, tombstones     │ │
│  │  - Supports range scans, index lookups, etc.       │ │
│  │  - Savepoints via module's own transaction support │ │
│  │  - Any module that supports isolation can serve    │ │
│  └────────────────────────────────────────────────────┘ │
│                          │                               │
│                          │ row-level merge               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐ │
│  │           Underlying Module (any)                   │ │
│  │                                                     │ │
│  │  - LevelDB / IndexedDB store                       │ │
│  │  - Custom module without isolation                 │ │
│  │  - Any VirtualTableModule supporting query/update  │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Key Principle: Row-Level Composition

The isolation layer operates purely at the **row level**, merging query results from two modules:

1. **Overlay module** — Stores uncommitted changes (inserts, updates, deletes as tombstones)
2. **Underlying module** — Stores committed data

Both modules are accessed through the standard `VirtualTable` and `VirtualTableConnection` interfaces. The isolation layer has no knowledge of BTrees, blocks, LevelDB, or any implementation details.

### Why Use a Module as Overlay Storage?

Using an existing module for overlay storage provides:

- **Range scan support** — The overlay module already implements efficient range iteration
- **Secondary index support** — The overlay module maintains its own indexes
- **Savepoint support** — The overlay module's transaction semantics handle savepoints
- **Consistency** — Same query semantics for overlay and underlying data

The isolation layer's only job is merging two row streams.

### Overlay Module Selection

The overlay module is configurable and can be any module that supports isolation:

| Overlay Module | Use Case |
|----------------|----------|
| Memory vtab | Default; fast, ephemeral, suitable for most transactions |
| LevelDB/IndexedDB | Large transactions, crash recovery of uncommitted work |
| Same as underlying | Uniform storage, useful for testing |

The key requirement is that the overlay module must support the capabilities needed for isolation (particularly savepoints if the isolation layer exposes savepoint support).

### Per-Connection Overlay Architecture

The isolation layer uses a **per-connection overlay** architecture:

```
IsolationModule
├── underlyingTables: Map<"schema.table", UnderlyingTableState>
│   └── underlyingTable (shared across all connections)
│
└── connectionOverlays: Map<"dbId:schema.table", ConnectionOverlayState>
    ├── Connection 1: overlayTable, hasChanges
    ├── Connection 2: overlayTable, hasChanges
    └── ...
```

**Key properties:**

1. **Underlying tables are shared** — All connections read from the same committed data
2. **Overlays are per-connection** — Each database instance gets its own overlay per table
3. **Overlays are created lazily** — No memory overhead until first write in a transaction
4. **Schema is discovered lazily** — Supports modules that load schema from persistent storage

This architecture ensures:
- Read-your-own-writes: A connection sees its own uncommitted changes
- Isolation: Other connections don't see uncommitted changes
- Efficiency: No overlay created for read-only transactions

#### Table identity: the connect-time name is authoritative

Both maps above are keyed on the same `(schemaName, tableName)` pair, and the commit flush
(`commitConnectionOverlays`) crosses between them: it strips the `dbId:` prefix from an overlay
key and looks the remainder up in `underlyingTables`. If the two maps ever key the same table
differently, that lookup misses and the staged rows are dropped — while the commit still reports
success.

The single identity for a table is therefore the `(schemaName, tableName)` pair passed to
`IsolationModule.create()` / `.connect()`, threaded into `IsolatedTable`'s constructor and used
for every keyed lookup it performs (overlay, pre-overlay savepoints, in-flight build coalescing,
the registered connection's qualified name).

`IsolatedTable` must **never** take its identity from `underlyingTable.schemaName` /
`.tableName`. `VirtualTable.tableName` is contracted bare (see `packages/quereus/src/vtab/table.ts`),
but an underlying module may violate that and report a schema-qualified name — `lamina-quereus`
does, using the field as a catalogue lookup key. Keying off the connect-time pair makes the two
maps agree by construction, whatever the underlying self-reports.

The same reasoning rules out keying off `underlyingTable.tableSchema` — that field is documented
as possibly populated lazily by the underlying module, so it may be absent at construction time.

#### Invariant: every staged overlay resolves to an underlying table at commit

Keying the two maps consistently is necessary but not sufficient — the entries must also both
still *exist* when `commitConnectionOverlays` crosses between them. The table-lifecycle hooks are
what keep that true, and each has to do explicit work:

- **`destroy()` (DROP TABLE)** removes the `underlyingTables` entry, so it also resolves the
  `connectionOverlays` and `preOverlaySavepoints` entries for that table across **every** db id.
  DROP TABLE is not transaction-scoped: the table is gone for all connections, so no overlay
  against it can ever be flushed. Who gets told differs by overlay. The **dropping connection's
  own** overlay is discarded silently (it issued the DROP). A **foreign** overlay with staged rows
  is **poisoned** and kept — sweeping it let that connection commit against an empty overlay set
  and report success after its rows were discarded, which is silent cross-connection data loss. A
  **foreign** overlay with no staged rows is discarded; nothing is lost. `preOverlaySavepoints` is
  swept for every key whose overlay did not survive (without this the single-table case leaked the
  overlay and its savepoint set for the lifetime of the `Database`); a surviving poisoned overlay
  keeps its set, which its owner's rollback reaps. See *ALTER / DROP overlay poison* below.
- **`renameTable()` (ALTER TABLE … RENAME TO)** evicts the cached underlying handle for the old
  name (the underlying module may have closed it — `StoreModule` closes and re-opens stores during
  a rename) and re-keys any staged overlay onto the new name. It must therefore **re-connect** a
  fresh underlying under the new name whenever it carried an overlay across, using the vtab module
  name and args from the pre-rename catalog entry (the hook's signature carries neither, and the
  engine updates the catalog only *after* the hook returns). With no overlay carried across there
  is nothing to flush, so the eviction alone suffices and the next `connect()` re-resolves lazily.
  It deliberately does **not** re-key `preOverlaySavepoints`: that set is maintained and cleared by
  the callbacks of the `IsolatedTable` the registered `IsolatedConnection` was built from, and that
  instance keeps the pre-rename name for the rest of the transaction. Moving the set would leave the
  old-name instance clearing a key nobody owns while the moved set leaked into the next transaction,
  where a matching `rollback to savepoint` depth would wrongly discard that transaction's overlay.
  The first statement after the rename registers a new connection under the new name and
  `Database.registerConnection` replays the active savepoint stack onto it, so nothing is lost.

A staged overlay (`hasChanges === true`) that still fails to resolve at commit is a violation of
this invariant, and `commitConnectionOverlays` raises `StatusCode.INTERNAL`. It never silently
drops the rows: doing so reported a *successful* commit that persisted nothing, and — because the
skipped overlay also never reached the clear-loop — left a zombie overlay that kept merging into
every later read on that `Database`, so the connection that lost the data was the last to notice.
A **clean** overlay (`hasChanges === false`) that fails to resolve staged nothing, so it is simply
discarded.

The invariant has a second dependency that lives outside this layer: **the wrapper's registered
`IsolatedConnection` must survive the underlying module's rename.** `Database` commits by calling
`commit()` on every registered connection — the loop is name-agnostic — so that connection is the
only thing that ever drives `commitConnectionOverlays`. An underlying module that evicts *every*
connection registered under the old table name (rather than only the ones it created itself)
therefore deletes the sole path from the staged overlay to storage, and the commit reports success
having written nothing. `StoreModule.renameTable` therefore evicts on class identity (`instanceof
StoreConnection`) *and* an exact qualified-name match, never on the name alone. See **Evicting
connections on `renameTable`** in [`module-authoring.md`](module-authoring.md) — the same rule binds
any module that means to be wrappable.

#### Mid-transaction rename on a store-backed table is a partial commit

`StoreModule.renameTable` DDL-commits its module-wide `TransactionCoordinator` — every table's
pending ops, not only the renamed table's — before it relocates the physical stores, because a
directory move cannot be rolled back through the coordinator. So an `alter table … rename to`
issued inside a transaction against a store-backed table *is*, by construction, a partial commit
of the store module's pending writes. The isolation layer does not change that; it only ensures
its own staged rows are flushed in the same batch instead of being dropped.

The asymmetry that follows is inherited from those store rename semantics, not introduced by the
isolation layer: a `rollback` after a mid-transaction rename still discards the overlay
(`IsolatedConnection.rollback` → `onConnectionRollback`), even though the store's own pre-rename
ops were already DDL-committed and cannot come back.

---

## Isolation Level Provided

It's worth being precise about what level of isolation this layer actually delivers,
since "MVCC-style" and "isolation layer" can suggest snapshot isolation. It does not
provide that. The actual guarantee is **read-committed reads plus read-your-own-writes**:

- **Read-your-own-writes** — a connection always sees its own uncommitted overlay
  changes (inserts/updates/deletes it has staged but not yet committed).
- **Reads of shared state are live, not a snapshot** — the merged read path
  (`IsolatedTable.query`) merges the overlay against the *live* underlying table on
  every read, and the underlying table is shared across all connections. If another
  connection commits between two reads in this transaction, the second read can
  observe that commit. There is no point-in-time view captured at `BEGIN`.
- **No write-write conflict detection** — this layer does not detect when two
  connections write the same row in overlapping transactions. At commit, each
  connection's overlay is flushed to the underlying independently
  (`flushOverlayToUnderlying`); whichever connection flushes last wins, silently
  overwriting the other's write.
- **Snapshotting, if needed, is the underlying module's job** — a module wrapped by
  this layer (the `underlying` module) is free to provide its own stable-snapshot
  reads; the isolation layer neither provides nor blocks that. If a consumer needs
  guaranteed snapshot isolation on top of a non-snapshotting underlying module, the
  intended extension point is an optional snapshotting pass-through module inserted
  *below* the isolation layer — no such module exists today.

This is intentional scope, not a gap to be closed here: this layer's job is
read-your-own-writes plus savepoints on top of an arbitrary underlying module: not
cross-connection consistency, which is a storage-layer concern.

---

## Core Concepts

### Overlay Storage

The overlay is a virtual table instance (typically from the memory vtab module) that stores uncommitted changes for a connection. It mirrors the schema of the underlying table, including:

- Primary key columns
- All data columns
- Secondary indexes

The overlay table has an additional hidden column or marker to distinguish tombstones (deleted rows) from regular rows.

### Change Types

The overlay stores three types of changes as rows:

1. **Insert** — New row not present in underlying module (stored as regular row)
2. **Update** — Modified row replacing one in underlying module (stored as regular row)
3. **Delete** — Tombstone marking a row as removed (stored with tombstone marker)

The isolation layer doesn't distinguish inserts from updates—both are simply "this PK should return this row." The distinction only matters at commit time when applying to the underlying module.

### Merge Semantics

When reading, the isolation layer merges overlay changes with underlying data:

```
For each row from underlying module:
  - If overlay has tombstone for this PK → skip row
  - If overlay has update for this PK → emit overlay row instead
  - Otherwise → emit underlying row

For each insert in overlay not yet emitted:
  - Emit at correct sort position
```

This is analogous to LSM-tree merge or 3-way merge in version control.

---

## Transaction Lifecycle

### Begin Transaction

1. Create new `OverlayState` for this connection (or inherit from existing if nested)
2. Call `underlyingConnection.begin()` to start underlying transaction

### Read Operations

1. Execute query against overlay first
2. Execute same query against underlying module
3. Merge results using primary key ordering
4. For secondary-index scans: one full scan of the overlay collects both the set of PKs the
   overlay modified (tombstones included, so the underlying's shadowed rows drop from the
   merge) and the overlay's live rows. The isolation layer itself re-applies the query's
   pushed constraints to those rows and sorts them by the scan's (indexKey, PK) key before
   merging — the overlay is never asked to resolve the scan's index name, because an
   underlying module may drive the scan under an index it minted per plan (e.g. lamina's
   `_compound_v_0`), a name no table schema (and therefore no overlay) declares

### Write Operations

1. Apply change to overlay only (insert/update/delete)
2. Update overlay's primary index
3. Update overlay's secondary indexes
4. Do NOT write to underlying module yet

### Savepoint

1. Call `overlayConnection.savepoint(n)` to create savepoint in overlay module
2. The overlay module handles the savepoint semantics internally

### Rollback to Savepoint

1. Call `overlayConnection.rollbackToSavepoint(n)` to revert overlay changes
2. The overlay module discards changes made after the savepoint

### Commit

The database drives commit as a **sequential loop over registered connections**, and the
isolation layer registers **one covering connection per table**. So a transaction that wrote
to *N* tables has *N* connections in that loop. To keep a multi-table commit atomic, the flush
does **not** run per connection; instead the **first** connection's commit drives one
transaction-wide, two-phase flush across **every** overlay the db-transaction staged
(`IsolationModule.commitConnectionOverlays`), and clears them all — so the remaining
connections in the loop find their overlay already gone and no-op. (Earlier, each connection
flushed *and committed* its own underlying table independently; table A's underlying commit
landed durably before table B had even applied, so a failure in B left A committed — a torn
transaction. The two-phase flush below is the fix.)

**Phase 1 — apply all (no commit).** For every staged overlay, `begin()` its underlying table
and apply the overlay's rows via `update()` calls, **tombstones (deletes) first, then
inserts/updates**, but do **not** commit. The delete-before-insert ordering matters when one
commit both writes a row and evicts a different row on a shared secondary UNIQUE (e.g. an
`INSERT OR REPLACE` that replaces a PK-colliding row *and* evicts a UNIQUE-colliding row at
another PK): the delete must free the constrained value before the colliding write, or the
underlying rejects it on a UNIQUE conflict. Each PK appears at most once in the overlay, so
reordering across PKs never inverts a same-PK delete/insert pair. The insert/update flushes
are issued as **trusted writes** (`trustedWrite: true`): the underlying module skips its own
per-write PK/UNIQUE re-enforcement and just persists the already-validated final state. This
is required because a value-swap cycle (e.g. two rows exchanging a UNIQUE value within one txn)
has no conflict-free row-by-row apply order — an intermediate row would transiently duplicate a
UNIQUE value and a naive per-write check would wrongly reject it. The merged-view pre-checks are
therefore the sole authority for the final committed state; secondary-index maintenance still
runs incrementally per write, and a transient duplicate index value is harmless because index
keys are suffixed with the PK. Any `constraint` result returned by an underlying `update()` here
is a violated invariant (the merged-view pre-checks should have resolved it before commit) and
is thrown as an INTERNAL error rather than silently swallowed.

**Phase-1 invariant — the flush must not read an underlying table once it has begun writing
that table.** Deciding insert-vs-update for a live overlay row is a read: a full-PK point lookup
that drives the underlying's primary index (`rowExistsInUnderlying`). Every one of those probes
is therefore resolved **up front**, before the first `update()` of that table's flush lands. An
underlying module is under no obligation to serve reads — least of all index-driven ones — over
its own uncommitted writes: a module that only authors its compound/secondary index entries when
the write batch resolves must *refuse* an index walk over staged state rather than answer from a
silently stale index (lamina's staged collection does exactly this). Probing inline in the write
loop consequently failed every probe after the first, breaking any transaction that wrote two or
more rows to one table with a compound primary key. Hoisting the probes is answer-preserving
because each PK appears at most once in the overlay, so no write in the flush can change another
entry's existence answer — and it costs one fewer read per written row. The invariant is
per table, not per commit: Phase 1 may legitimately probe table B after writing table A.

**Phase 2 — commit all.** Once **every** overlay has applied, `commit()` the affected
underlying tables. For a `quereus-store` underlying (whose tables share one module-wide
`TransactionCoordinator`) Phase 1's begins/applies all accumulate in that single coordinator,
so the first `commit()` flushes **every** table's ops in one atomic coordinator commit — a
single `AtomicBatch.write()` on a provider that exposes `beginAtomicBatch` (IndexedDB, LevelDB)
— and the remaining commits no-op. For an underlying with per-table transaction domains (the
default memory vtab) each table commits independently.

**On any Phase-1 error:** roll back every underlying begun so far and rethrow. Nothing was
committed, so the transaction aborts atomically.

Finally, clear all overlay state (and, per connection, its pre-overlay savepoint set).

### Rollback

1. Discard overlay state entirely
2. Call `underlyingConnection.rollback()`

---

## Capability Discovery

Modules should advertise their isolation support so consumers can make informed decisions.

### Capability Interface

```typescript
interface ModuleCapabilities {
  /** Module provides transaction isolation (read-your-own-writes; not necessarily snapshot reads — see the module's own docs for the actual isolation level) */
  isolation?: boolean;

  /** Module supports savepoints within transactions */
  savepoints?: boolean;

  /** Module persists data across restarts */
  persistent?: boolean;

  /** Module supports secondary indexes */
  secondaryIndexes?: boolean;

  /** Module supports range scans (not just point lookups) */
  rangeScans?: boolean;

  /**
   * Module owns ADD-COLUMN NOT-NULL-backfill semantics and opts out of the
   * engine-generic rejection of NOT-NULL-without-usable-DEFAULT on non-empty
   * tables (see `vtab/capabilities.ts` for full docs).
   */
  delegatesNotNullBackfill?: boolean;
}

interface VirtualTableModule {
  // ... existing methods

  /** Returns capability flags for this module */
  getCapabilities?(): ModuleCapabilities;
}
```

### Usage

```typescript
const module = db.getModule('store');
const caps = module.getCapabilities?.() ?? {};

if (!caps.isolation) {
  // Wrap with isolation layer, or warn user
  console.warn('Module does not provide isolation; queries may see partial writes');
}
```

### Wrapped Module Capabilities

When the isolation layer wraps a module, it augments the capabilities:

| Capability | Underlying | Wrapped Result |
|------------|------------|----------------|
| `isolation` | `false` | `true` |
| `savepoints` | `false` | `true` |
| `persistent` | (passthrough) | (passthrough) |
| `secondaryIndexes` | (passthrough) | (passthrough) |

---

## Secondary Index Handling

### Why the Overlay Must Have Matching Indexes

Consider a table with a secondary index on `email`:

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
CREATE INDEX idx_email ON users(email);
```

A query like:

```sql
SELECT * FROM users WHERE email = 'alice@example.com';
```

Uses the secondary index. If the overlay only tracks by primary key:

1. Query asks underlying module's index for `email = 'alice@example.com'`
2. Underlying returns row with `id = 5`
3. But overlay might have deleted id=5, or updated its email to something else!

The merge handles this by excluding every PK the overlay touched from the underlying's
stream and contributing the overlay's live rows instead (filtered to the query's window and
sorted by the scan's sort key — see *Read Operations* above; the merged read deliberately
never queries the overlay by the scan's index name, which may be a name the underlying
minted per plan). The overlay still copies the underlying's secondary indexes and UNIQUE
constraints so that:
- The overlay's own module natively enforces the table's UNIQUE constraints on staged rows
  (narrowed to live rows, below)
- Mid-transaction index DDL can validate the staged rows and adopt the new structure into an
  already-open overlay, keeping it in the same schema shape as the underlying

### Overlay Table Schema

The isolation layer creates an overlay table with:
- Same columns as underlying table
- Same primary key
- Same secondary indexes and UNIQUE constraints, each narrowed to live rows (below)
- Additional tombstone marker column

This is handled automatically when the isolation layer creates the overlay table instance.

A tombstone carries its row's primary key and `NULL` in every other column, so it is not a
row a UNIQUE structure should ever judge. Every copied secondary index and every copied
UNIQUE constraint therefore gets `<tombstone column> = 0` AND-ed onto whatever partial
predicate it already carried (`createOverlaySchema` in `isolation-module.ts`), scoping it to
live overlay rows only. Without this, a UNIQUE structure whose columns are entirely inside
the primary key would see two tombstones — or a tombstone and a live row — sharing a PK as
colliding duplicates, since tombstones carry real PK values. (A UNIQUE structure over an
ordinary, non-PK column never showed this: a tombstone's value there is `NULL`, and SQL
treats `NULL`s as distinct.) The overlay's own **primary-key** uniqueness is deliberately
*not* narrowed — it must keep covering tombstones so a re-insert at a tombstoned PK is
detected and converted into an overwrite rather than a fresh insert.

### Index Scan Merge

When scanning via secondary index:

1. Full-scan the overlay ONCE. Collect the set of PKs it modified (tombstones included) and,
   for each live (non-tombstone) row, keep it only if it satisfies the query's pushed
   constraints — the isolation layer re-applies that window itself (`buildConstraintMatcher`),
   because the overlay is never asked to resolve the scan's index name. That name may be one
   the underlying minted per plan (e.g. lamina's `_compound_v_0`), which no overlay declares.
2. Sort the kept overlay rows by the scan's `(indexKey…, pk…)` sort key — the full scan emits
   PK order, so the merge cannot rely on the overlay's emission order.
3. Execute the index scan on the underlying table → committed rows in sort-key order.
4. Merge the two sorted streams by sort key:
   - Underlying row whose PK is in the modified set → skip (overlay shadows it)
   - Otherwise interleave overlay and underlying rows by sort key

The set of PKs modified in the overlay (used to exclude shadowed underlying rows)
is keyed with the engine's canonical `serializeRowKey` encoder — one string
normalizer per PK column, drawn from that column's declared collation — **not**
`JSON.stringify`. `JSON.stringify` throws on a bigint PK value and ignores
collation, so under a NOCASE PK a case-only key rewrite (`'abc'` → `'ABC'`) would
fail to shadow the underlying row and surface both. The canonical encoder tags
bigint safely and maps collation-equal keys to identical strings, agreeing with
`getComparePK`/`keysEqual`. The encoder is built by `makePkKeySerializer`
(`overlay-rows.ts`), a thin wrapper over the engine's `makePkIdentitySerializer`
(`@quereus/quereus`, `util/key-serializer.ts`) — the single implementation of "are these
two primary keys the same row?", shared with the sync engine's per-row metadata keying, so
the two layers cannot drift.

Those normalizers resolve through the **owning connection** (`db.getKeyNormalizerResolver()`,
bound in the `IsolatedTable` constructor beside `getCollationResolver()`), never a
process-global built-ins table — otherwise a collation registered or overridden with
`db.registerCollation` would key the overlay row differently from the comparator that
merges it, and the staged row would again fail to shadow the base row. As a consequence, a
text PK column under a collation registered **without** a `normalizer` raises `collation
<name> has no key normalizer` on this path rather than silently under-shadowing; primary-key
scans, which need only the comparator, are unaffected. A PK column whose declared type can
never hold text (`n integer collate mycoll`) takes the identity normalizer and never
consults the collation, matching the engine's own hash-key sites.

---

## Key Ordering

### Which index is being scanned (scan-order source of truth)

Before it can merge, the layer must know the order the underlying scan emits — primary-key
order, or `(secondaryIndexKey…, pk…)` order. It reads that from **`FilterInfo.accessPath`**,
the planner's typed, validated {@link AccessPath} record (`resolveScanIndex` in
`isolated-table.ts`), **not** by pattern-matching the free-text `idxStr` wire string. The map is:

| `accessPath.kind`            | Merge order chosen                                             |
|------------------------------|---------------------------------------------------------------|
| `fullScan` / `empty`         | primary key (see the full-scan contract below)                |
| `index`, `role: 'primary'`   | primary key — **regardless of the index's name** (an alias like `_primary_1` still merges by PK) |
| `index`, `role: 'secondary'` | `(indexKey…, pk…)`, using the descriptor's full `keyColumns`   |
| `unresolvedIndex`            | **INTERNAL error** (see below)                                |

`role` is authoritative, not `name`. A module that mints a per-plan alias for its primary
key (lamina-quereus appends a counter: `_primary_` → `_primary_1`, `_primary_2`, …) is still
recognised as a PK walk because it returns an `indexDescriptor` with `role: 'primary'`. When
that primary walk reaches the overlay `MemoryTable` — which only knows its PK index by the
canonical name `_primary_` — `adaptFilterInfoForOverlay` retargets the FilterInfo's index name
to `_primary_` via the engine's `retargetFilterInfoIndex`, so the overlay re-plans the same
primary-key scan instead of failing to resolve a non-existent secondary index of the alias name.

**Full-scan merge contract.** A `fullScan` (or provably-`empty`) access path merges by primary
key because every underlying module the isolation layer wraps emits an unbounded scan in
primary-key order. That is a contract the underlying owes, not an inference the layer draws from
any string. The layer's own internal scans (overlay-merge, ALTER/DROP INDEX overlay migrations,
the commit flush, PK point lookups) build their FilterInfo through the engine's
`makeFullScanFilterInfo` / `makeIndexEqSeekFilterInfo` helpers, which always populate
`accessPath`; a hand-built FilterInfo that omits it makes a *dirty-overlay* read throw INTERNAL
(a clean, no-overlay read takes the fast path and never inspects `accessPath`).

**The INTERNAL error a module earns by aliasing without a descriptor.** If a module names an
index anything other than `_primary_` or a real schema index and does **not** return an
`indexDescriptor`, the engine cannot resolve it and records `accessPath.kind:
'unresolvedIndex'` (warning at plan time). The merge then has no way to know the scan's sort
order, so `resolveScanIndex` throws a `QuereusError` (`StatusCode.INTERNAL`) naming the
offending index rather than guessing primary-key order — guessing would silently reorder rows
(the exact corruption this design removes). Fix is on the module: return an `indexDescriptor`
from `getBestAccessPlan` (see `docs/module-authoring.md`). Note this fails loud only on the
merged read path; a committed-snapshot (`readCommitted`) or no-overlay read bypasses the merge.

### The Problem

For merge iteration to work correctly, the overlay must iterate in the **same order** as the underlying module. Different modules may use different orderings:

| Module | Ordering |
|--------|----------|
| Memory vtab | Its layer BTrees' primary-key comparator (`createPrimaryKeyFunctions`): per-column logical type, declared collation, and `DESC` direction |
| Store module | Binary-encoded keys (lexicographic byte order), with the same collation and direction folded into the bytes |

If these differ, merge produces incorrect results.

### Solution: Module-Provided Comparator

The underlying module must provide its key comparison function:

```typescript
interface IsolationCapableTable extends VirtualTable {
  /** Compare two rows by primary key, using module's native ordering */
  comparePrimaryKey(a: SqlValue[], b: SqlValue[]): number;

  /** Extract primary key values from a row */
  extractPrimaryKey(row: Row): SqlValue[];

  /** Compare index keys for a given index */
  compareIndexKey(indexName: string, a: SqlValue[], b: SqlValue[]): number;
}
```

The isolation layer passes these comparators to the overlay module (if configurable) or validates that the overlay and underlying modules use compatible orderings.

`comparePrimaryKey` is optional. When the underlying table does not expose it — every
store-backed table today — `IsolatedTable` falls back to its own comparator, which walks the
PK columns under their declared collations and declared `DESC` directions. Any underlying whose
native key order is not reproducible that way (a custom encoding, a locale-aware byte order)
**must** expose `comparePrimaryKey`.

### Collation Considerations

For text columns with non-binary collation (`NOCASE`, `RTRIM`, or one registered with
`db.registerCollation`):

- The underlying module's comparator must respect the collation
- Collation names resolve against the **owning connection** (`db.getCollationResolver()`, and
  `db.getKeyNormalizerResolver()` for the secondary-index merge's modified-PK set), never
  a process-global registry — an application may replace `NOCASE`/`RTRIM` per database
- The overlay uses the same comparator
- Both iterate in the same order
- A collation named on a **text** PK column must carry a `normalizer` if the table is ever
  scanned through a secondary index inside a transaction with pending writes

The store's *physical key bytes* are a separate matter: they come from an encoder registry that
does not consult the database, so a custom or overridden collation governs comparison but not
key layout. See the `COLLATE` section of `docs/sql.md` for the caveat this places on a store
table's `PRIMARY KEY` collation.

---

## Cross-Layer Constraint Detection

### Why Resolve at Write Time

UNIQUE and PRIMARY KEY constraints span the merged view: a write that does not
collide within the overlay may still collide with an un-tombstoned row in the
underlying table. Deferring detection to flush time would make overwrites silent
and lose the chance to honour `ON CONFLICT IGNORE`/`REPLACE` semantics. Detection
therefore happens in `IsolatedTable.update()` before the overlay write proceeds.

### PK Conflict (`checkMergedPKConflict`)

Called when an INSERT or PK-changing UPDATE produces a new PK with no overlay
entry at that key:

- Underlying has no row at the PK → no conflict.
- Underlying has a row → ABORT returns a constraint result (with `existingRow`
  populated), IGNORE silently no-ops, REPLACE returns null and lets the insert
  proceed (the overlay row will become an UPDATE at flush).

### Non-PK UNIQUE Conflict (`checkMergedUniqueConstraints`)

For each declared non-PK UNIQUE constraint:

- Skip if the new row is null on any constrained column (SQL NULL semantics).
- For partial UNIQUE (`create unique index ... where <predicate>`), skip the
  whole check when the new row's predicate does not unambiguously evaluate to
  TRUE — the row is outside the index's scope and contributes nothing to
  uniqueness. Predicate compilation is memoized per `UniqueConstraintSchema`
  identity via a `WeakMap`, so the hot write path doesn't recompile.
- Search the **merged view** — this connection's overlay superimposed on the
  underlying committed rows — for a row matching on all constrained columns,
  excluding the writer's own PK(s). The merged view splits cleanly along the
  overlay boundary, and each half is searched the way it is cheap to search:

  ```
  merged view  =  (overlay rows)  ∪  (underlying rows with no overlay entry)
  ```

  - **Phase 1 — scan the overlay** (`findOverlayUniqueConflict`). The overlay is
    the transaction's write set: small and already in memory. Skip tombstones and
    the writer's own PK(s); a matching live overlay row IS the merged row (its
    overlay value — not any stale underlying value — is what the merged view holds
    for that PK), so a candidate moved off the value earlier in the same txn no
    longer counts, and one moved *onto* it correctly does.
  - **Phase 2 — seek the underlying** (`findUnderlyingUniqueConflict`). Look up
    underlying rows matching the constrained columns, skipping the writer's own
    PK(s) **and** any PK the overlay already owns (Phase 1's territory, whatever
    the underlying still says). The lookup is an **index seek** when
    `canSeekForConstraint` allows it (below), else the pre-existing full scan;
    either way the per-column match still runs, so a module that ignores the index
    hint and returns extra rows stays correct. `getOverlayRow` now fires only for
    the candidates the seek returned, not once per underlying row.

  Both phases run the same matcher (`rowMatchesUniqueConstraint`) so they compare
  identically, and — for a partial UNIQUE — evaluate the predicate against the
  merged row. Together they cover the merged view exactly once with no row visited
  twice. Phase 1 runs first, so when the constraint was *already* violated an
  overlay-side conflict is reported in preference to an underlying one; under a
  satisfied constraint at most one conflicting row exists, so this tie-break only
  changes *which* row is named in that pre-violated case.
- ABORT returns the constraint result; IGNORE no-ops; REPLACE writes a
  tombstone for the conflicting PK so the row is evicted at flush, then continues.
  The evicted row is surfaced in the same user-facing schema shape whether it came
  from Phase 1 (an overlay row) or Phase 2 (an underlying row).

**When Phase 2 may seek (`canSeekForConstraint`).** Only when the constraint was
synthesized from a `CREATE UNIQUE INDEX` (`derivedFromIndex` names a live entry in
`tableSchema.indexes`) AND every key column's effective enforcement collation is
BINARY. The BINARY gate is load-bearing, not an optimisation choice: the store's
physical index key bytes come from a separate encoder registry that does **not**
consult the database's collation registry
(`backlog/debt-store-index-keys-use-column-collation`). Seeking a `NOCASE` index for
`'B@X'` would physically miss a committed `'b@x'` that the full scan catches, turning
a performance fix into a lost UNIQUE violation. A table-level `unique(a, b)` (no
backing index) or any non-BINARY-collated index falls back to the full scan. Widen
the gate to per-column enforcement collations generally only once that encoder defect
is fixed.

An INSERT that reuses a PK tombstoned earlier in the same transaction (reviving
the tombstone into a live row) runs this same merged UNIQUE check before the
overlay write — otherwise a revived row colliding on a non-PK UNIQUE would be
missed here and later flushed with `trustedWrite` (the store skips its own
re-check), producing an opaque INTERNAL error at commit or silent corruption.

### Tombstones for Evicted Rows

`insertTombstoneForPK` writes a row with PK columns populated and all other
columns (including the constrained UNIQUE columns) set to NULL, plus the
tombstone marker. The null UNIQUE columns ensure the tombstone itself never
matches a future merged-view UNIQUE check, and the underlying scan skips any
PK that has a tombstone in the overlay.

### Trade-offs

- Non-PK UNIQUE checks over an index-derived, BINARY-collated constraint seek the
  backing index (O(log n) + overlay scan) rather than scanning the underlying; a
  table-level `unique(...)` with no backing index, or a non-BINARY-collated one,
  still does the O(n) full scan (see `canSeekForConstraint`). The overlay's own
  UNIQUE enforcement covers overlay-only conflicts; the merged-view search fills the
  underlying-only gap. Phase 1 always scans the (small) overlay in full.
- Same-PK REPLACE returns null instead of carrying the replaced row back to
  the DML executor, so FK CASCADE side-effects do not fire for replacements
  resolved through the isolation layer (tracked separately).

---

## Challenges and Mitigations

### 1. Merge Iteration Complexity

**Challenge:** Merging two ordered streams while handling inserts, updates, and deletes is error-prone.

**Mitigation:**
- Implement as a standalone, well-tested `MergeIterator` utility
- Use property-based testing (fast-check) to verify invariants:
  - Output is correctly ordered
  - All overlay changes appear in output
  - Deleted rows never appear
  - Updates replace originals exactly once
- Keep stateless: input two async iterables, output one

### 2. Cursor Invalidation During Mutation

**Challenge:** If a query is iterating and a write occurs, the cursor may be invalid.

**Mitigation:**
- Writes go to overlay module, which has its own cursor safety semantics
- If overlay module supports snapshot isolation (memory vtab does), iteration is safe
- Document behavior based on overlay module's capabilities

### 3. Commit Failure Recovery

**Challenge:** If a commit that spans several tables fails partway through, some tables must
not be left committed while others roll back (a *torn* transaction).

**Mitigation — apply-all, then commit-all (see § Commit).** The flush is transaction-wide and
two-phase: Phase 1 begins every touched underlying table and applies its overlay rows *without*
committing; Phase 2 commits them only once **all** have applied. All the fallible data work
(constraint re-checks, injected/IO write errors) happens in Phase 1, before any commit, so a
data-driven failure aborts cleanly — Phase 1 rolls back every begun table and nothing was
committed. The overlays remain intact, so the ensuing transaction rollback discards them and the
user can retry.

**Atomicity contract — depends on the underlying's commit domain.**
- **Shared atomic commit domain (full crash-atomicity).** When the underlying commits its tables
  through one shared atomic domain — the `quereus-store` module-wide `TransactionCoordinator`
  plus a provider that exposes `beginAtomicBatch` (IndexedDB, LevelDB) — Phase 2's first
  `commit()` writes *every* table's ops in a single atomic batch and the rest no-op. The
  multi-table commit is then fully atomic even against a crash mid-commit.
- **Per-table commit domains (data-driven-clean only).** For an underlying whose tables commit
  independently (the default memory vtab), Phase 2 commits each table in turn. Because all
  fallible work already completed in Phase 1, a *data-driven* abort is still clean (nothing
  committed). But a bare infrastructure/IO failure *during the commit phase itself* can still
  leave earlier tables committed — the isolation layer cannot prevent this without an atomic
  underlying. Full crash-atomicity is therefore **contingent on the underlying's capability**;
  the isolation layer does not attempt distributed two-phase commit or capability negotiation.

This is distinct from the deliberately out-of-scope cross-*connection* "last writer wins / no
write-write conflict detection" behavior documented above — that concerns two different
connections racing on the same row, not atomicity within a single connection's own commit.

### 4. Performance Overhead

**Challenge:** Every read now goes through overlay check + merge.

**Mitigation:**
- Fast path: if overlay is empty, delegate directly to underlying
- Track "has changes" flag to skip merge when unnecessary
- For point lookups: check overlay first (O(log n)), only hit underlying if not found
- Accept some overhead in exchange for correctness and simplicity

### 5. Large Transaction Storage

**Challenge:** Large transactions may accumulate many uncommitted changes in the overlay.

**Mitigation:**
- The overlay module is configurable—use memory vtab for small/fast transactions
- For large transactions, use a persistent overlay module (e.g., temp LevelDB instance)
- This is a deployment/configuration choice, not a limitation of the architecture

### 6. Schema Operations (DDL)

**Challenge:** CREATE INDEX, ALTER TABLE, DROP TABLE don't fit the row-based overlay model.

**Mitigation:**
- DDL mutates the shared underlying module directly — it is not transaction-scoped and the underlying auto-commits immediately, so it is not isolated in the same way as DML.
- Schema changes may have their own transactional semantics.
- **Open overlays are migrated in place, not bypassed and not rebuilt.** Any per-connection overlay holding staged rows in the *old* column layout would be structurally inconsistent with the post-DDL schema, so `IsolationModule` carries each affected overlay forward rather than ignoring it. Every path does that **in place** — through the overlay module's own `alterSchema` / `createIndex` / `dropIndex`, or through ordinary overlay writes — never by copying the staged rows into a freshly created staging table. That distinction is load-bearing: a copy flattens the overlay's layer chain, so the transaction's savepoint stack is replayed *above* the copied rows and a later `rollback to savepoint` discards rows staged **before** the savepoint. `createIndex` / `dropIndex` adopt the structure into the open overlay, so a new index is both usable by a merged secondary-index scan and *enforced* against the rest of the transaction's writes. `alterTable` forwards per change type: ADD / DROP / RENAME COLUMN reshape the open layers (ADD COLUMN backfills each staged row exactly as the committed path does; tombstone rows get NULL); `alter column … set data type` / `set collate` / `set default` forward straight through, with one preparation step: a `set collate` that re-keys the **primary key** first discards the deletion markers the new key collapses onto another staged row (a marker and a live row that become one key are that row's before- and after-image, not two rows — see *SET COLLATE on a primary key* below); `alter column … set not null` is withheld from the overlay (tombstones carry placeholder NULLs the overlay module would wrongly backfill or reject) and the staged live rows' NULLs are filled by ordinary overlay writes instead; `add constraint … unique` lands as a tombstone-narrowed unique **index**; `add constraint … check` forwards verbatim (schema-only — enforcement is engine-side, and the copy exists so a later DROP / RENAME resolves it); `add constraint … foreign key` does not forward at all (enforcement is engine-side and the unregistered `_overlay_*` staging table cannot serve the underlying's catalog-query validation), so DROP / RENAME CONSTRAINT is presence-guarded and no-ops for a constraint the overlay never carried. `alter primary key` is the one change no overlay can follow — see below. See *ALTER / DROP overlay poison* below.
- **The overlay's tombstone column name is reserved against ALTER.** Every overlay carries one extra column (`_tombstone` by default, host-configurable) as its deletion marker, so `add column` / `rename column` targeting that name is rejected `UNSUPPORTED` *before* `underlying.alterTable` runs. Forwarding it would make the overlay module raise a duplicate-name `ERROR` — not a data condition, so it rethrows — after the underlying had irreversibly applied, leaving the catalog a column behind the base and the next write landing values against the wrong columns. The check is unconditional, so the answer does not depend on whether a transaction happens to be open. (A `create table` declaring the name is *not* rejected: it produces a duplicate entry in the overlay's column list that every consumer reaches past by index. See the `NOTE` on `createOverlaySchema`.)
- **Row-validating DDL judges the issuer's rows, not the underlying's.** `create unique index` and `alter table … add constraint … unique` (and `alter column … set collate`, plus the value-rewriting `alter column … set data type` / `set not null`, whose rewrite can collapse two distinct values onto one) must see the rows the *issuing* connection can see — committed rows merged with its own overlay. The underlying module holds only committed rows, so `IsolationModule` hands it that merged stream through the optional `EffectiveRowSource` parameter. A *foreign* connection's overlay never contributes: its staged duplicates are its own problem at commit, exactly as a concurrent duplicate insert would be. See [module-authoring.md](module-authoring.md) § "When the pending rows live outside your module".
- **Open overlays are never orphaned, and never silently discarded.** `destroy` (DROP TABLE) discards the dropping connection's own overlay and every clean one, and **poisons** any foreign overlay holding staged rows; `renameTable` re-connects an underlying under the new name whenever it re-keys an overlay onto it. See *Invariant: every staged overlay resolves to an underlying table at commit* above — a residual miss on a staged, un-poisoned overlay is an `INTERNAL` error, never a silent discard.

#### ALTER / DROP overlay poison

A **poisoned** overlay is one a cross-connection DDL left permanently unflushable. `ConnectionOverlayState.poison = { message }` records why. Three DDLs poison — `alterTable` (staged rows stuck in the pre-alter column layout, or keyed by a primary key the table no longer has), `createIndex` (a foreign overlay's staged rows violate the UNIQUE index another connection just declared, so the overlay cannot adopt it), and `destroy` (the table itself is gone) — and all raise the same `StatusCode.CONSTRAINT`; the **message**, not the code, distinguishes them. The common guarantee: **no connection loses staged writes without being told.**

An adoption that a staged row rejects never leaves a half-changed overlay: the overlay module validates its rows *before* mutating anything, so the overlay stays whole, in its pre-DDL shape, alongside its poison flag. One preparation step is the exception, and only for a *foreign* overlay: a primary-key re-keying `set collate` drops the deletion markers the new key collapses (below), and a refusal *after* that leaves them dropped — the issuer's are restored, a foreign overlay's are not. Inert because poison is terminal: the only exit is a rollback that discards the overlay whole. Making poison recoverable means restoring those markers first. For the **issuing** connection the same failure is an `INTERNAL` error rather than poison — the DDL's own validation pass judged a superset of exactly those rows and accepted them, so a rejection means validation and migration have drifted. The one exception is a retryable `BUSY`, which the overlay module raises for a re-key its own layer chain cannot physically represent — a condition the isolation layer's validation pass never claimed to judge. That is rethrown verbatim for the issuer (not dressed as drift) and poisons a foreign overlay.

##### ALTER: migrate, or poison

`alterTable` is the one DDL that can change row shape (ADD/DROP COLUMN) *and* rewrite row values (`alter column … set not null` filling staged NULLs from the column's DEFAULT, `alter column … set data type` converting every staged value), so its overlay handling is the most involved. The underlying converts only its own committed rows, so each of those value rewrites has an overlay-side half here — without it an accepted retype would commit staged rows still holding the OLD physical type. Because the underlying base auto-commits irreversibly, the blast radius is made **isolation-faithful**: an ALTER never depends on another connection's uncommitted data.

The machinery that does the carrying — deriving the per-change-type constants, dry-running one overlay against them, reshaping it forward, and building the poison message — lives in `alter-migration.ts` as free functions over one overlay. `IsolationModule.alterTable` in `isolation-module.ts` owns the surrounding lifecycle: which overlays are in scope, the issuer/foreign tiering below, error routing, and the `alter primary key` overlay swap.

The affected overlays are partitioned into the **issuer's own** (the connection that ran the ALTER) and **foreign** ones, handled in three tiers:

1. **Partition.** Compare each affected overlay's key against the issuer's `makeConnectionOverlayKey(db, …)`. Foreign overlays already marked poisoned (from an earlier ALTER) are skipped entirely — they hold pre-alter rows and must not be re-read or re-migrated.
2. **Validate issuer-own first (atomic abort).** The issuer's own overlay is dry-run validated (per-row `NOT NULL` backfill, per-value `set data type` conversion, primary-key collision under a new collation, tombstone-present guard) **before** the irreversible `underlying.alterTable`. A primary-key re-keying `set collate` additionally **pre-flights the overlay module's own `alterSchema`** in validate-only mode (`VirtualTable.alterSchema(change, true)`), because that call is itself fallible and would otherwise run in tier 3, after the underlying had already re-keyed. Any throw in this tier leaves underlying + catalog + every overlay untouched — the issuer's ALTER fails clean or fully applies. (The issuer staged both the data and the DDL, so rejecting up front is least-surprising and matches the engine's own pre-mutation `validateNotNullBackfill` — though that engine-side probe only ever sees the ISSUING connection's rows (committed + its own staged), never a foreign connection's, which is why tier 3 below re-validates NOT NULL per foreign overlay rather than trusting the engine to have already caught it.)
3. **Mutate, then per-foreign migrate-or-poison.** After the underlying is altered, the issuer's own overlay migrates forward in place — reshaped to the new column layout *and* value-rewritten (NOT NULL backfill / retype conversion / marker collapse) to match what the underlying did to its committed rows. Each foreign overlay is then validated individually: a per-row `NOT NULL` (`CONSTRAINT`) failure — either an `add column … default new.<col>` evaluator producing NULL for a staged row, or a mandatory `add column` with no usable DEFAULT for a staged row to inherit — or an unconvertible value under a retype (`MISMATCH`) **poisons** that one overlay (`ConnectionOverlayState.poison = { message }`) and leaves its pre-alter rows in place; a healthy foreign overlay migrates forward. A foreign overlay whose own `alterSchema` refuses the change — `CONSTRAINT`, or the retryable `BUSY` an unrepresentable re-key raises — is poisoned too. All of these poison rather than rethrow because the underlying has already been mutated by this point — rethrowing would abort the issuer's ALTER after the fact, exactly the divergence the tiering exists to prevent. A layer-invariant failure (`INTERNAL`, e.g. a missing tombstone column) is **rethrown** loud for everyone rather than poisoned. Validation is per overlay, so one bad foreign overlay poisons only itself.

##### SET COLLATE on a primary key: collapsing deletion markers

Changing the collation of a primary-key column re-keys the table, and two old keys can become one new key (`'A'` and `'a'` under `NOCASE`). Inside a transaction that deleted a row and re-inserted a case-variant replacement, the overlay stages a **deletion marker** for the old key and a **live row** for the new one — and under the re-keyed primary key those two land on the same key. They are one logical row's before- and after-image, not two rows: the live row's flush write already subsumes the delete, so the marker is dropped before the re-key is forwarded to the overlay. Markers alone together on one key are one deletion, so all but one are dropped. **Two live rows** on one key stay a genuine duplicate and are refused (`CONSTRAINT`, with the same message the memory module raises).

The drops go through the overlay's ordinary write path, so its layer chain and savepoint snapshots survive — a `rollback to savepoint` taken before the ALTER restores the marker. Because they must happen *before* the pre-flight in tier 2, but the underlying's own row-content check must still judge the pre-drop view (a dropped marker un-shadows the committed row it deletes), the issuer's effective rows are snapshotted first, and any refusal reinserts the dropped marker rows verbatim so the ALTER is net-untouched.

Some shapes remain unrepresentable and are refused as retryable `BUSY` — notably when a savepoint could restore both a marker and its replacement at one re-keyed key. That refusal comes from the overlay module's own representability check, is the same answer a plain (non-isolated) memory table gives for the equivalent statement sequence, and — thanks to the tier-2 pre-flight — arrives before the shared table mutates, leaving the transaction intact.

##### ALTER PRIMARY KEY: the one change no overlay can follow

An overlay's layer trees are keyed by the table's **old** primary key, and a staged deletion marker identifies the row it deletes *by that key* — under a new key its identity columns may be placeholder NULLs, i.e. garbage. So `alter primary key` cannot be forwarded to an overlay at all, and gets its own three-way handling:

- **Issuer with staged rows** — rejected `UNSUPPORTED` **before** `underlying.alterTable` runs, so the ALTER fails atomically rather than stranding rows it cannot re-key. The connection commits or rolls back first, then retries.
- **Foreign overlay with staged rows** — poisoned, exactly as an unconvertible retype poisons one.
- **Clean overlay (nothing staged)** — swapped for a fresh empty staging table built from the post-alter schema, so the rest of the transaction's writes key by the new primary key. There are no pre-existing staged rows to lose, and the fresh table's connection registers on its first write, which replays the active savepoint stack onto it.

The bundled `MemoryTableModule` now re-keys `alter primary key` in place (as the store always has), so this path is reachable with either built-in underlying. The refusal for an issuer with staged rows is about the OVERLAY's representation — a staged tombstone's identity columns are meaningless under the new key — not about the underlying's capability.

##### DROP TABLE: discard, or poison

`destroy` cannot migrate anything — the table is gone. It decides per overlay key (see the `destroy()` bullet under *Invariant: every staged overlay resolves to an underlying table at commit*): the **dropping connection's own** overlay is discarded silently, a **foreign dirty** overlay is poisoned and kept, a **foreign clean** overlay is discarded. Poisoning a kept overlay is what makes the commit path work unchanged: `commitConnectionOverlays` checks `state.poison` *before* the `underlyingTables` lookup, so the surviving overlay raises its poison message rather than the `INTERNAL` orphan error. An already-poisoned overlay keeps its **original** message — the first cause is the one worth reporting.

The drop poison is deliberately over-strict for a connection that unwinds all its staged rows past the drop and could arguably commit clean: the poison rides on the `ConnectionOverlayState`, not on the rows. The table is gone either way, so failing is the safe answer.

The own-overlay branch discards the state whether or not it was already poisoned, so a connection carrying an ALTER poison escapes it for the table it drops. That is the intended reading — the rows it discards belong to a table it just asked to remove — and it clears the poison only for that table; an overlay poisoned on any other table still aborts the commit.

##### Observing poison

A poisoned overlay always has `hasChanges === true`, so `IsolatedTable` errors (`QuereusError`, `CONSTRAINT`) at the data-op chokepoints — `update` (before staging), the *merged* branch of `query`, and the commit flush (`flushAndClearOverlay`) — but never on the committed-snapshot (`readCommitted`) read path, which bypasses the overlay and stays usable. This means a poisoned connection fails its next read/write/commit even if it never touches the table again, while a `committed.<table>` reader keeps working.

##### Poison lifecycle

Poison is cleared only by discarding the `ConnectionOverlayState`: a **full rollback** (`onConnectionRollback`) or a rollback to a **pre-overlay savepoint** drops the overlay (and its poison). A rollback to a savepoint taken **after** the overlay existed does *not* replace the state, so poison correctly persists — the DDL is permanent (pre-alter rows, or a table that no longer exists), so even if the offending row was rolled back the overlay stays unflushable until the transaction ends. Identical for both poison sources.

A poisoned overlay must also never be carried through the layer's other overlay-migration paths, which would reshape its layout-mismatched rows and — where the path replaces the state object, as the `alter primary key` clean-overlay swap does — silently un-poison a connection that must still roll back. All such paths therefore **skip** a poisoned overlay, leaving it poisoned: `alterTable` skips it *before* the issuer/foreign split (so even the poisoned connection's own later ALTER does not migrate it), and `createIndex` / `dropIndex` skip it in their post-DDL adoption loop. `renameTable` is safe as-is — it re-keys the state object in place, carrying the `poison` field along.

---

## Relationship to Memory VTab

### Current Memory VTab Architecture

The memory vtab uses `inheritree` BTrees for both storage and isolation in a tightly integrated design:

- Base data stored in BTrees
- Transaction layers created via BTree copy-on-write inheritance
- Efficient single-layer design, but couples storage and isolation

### Future Options

**Option A: Keep Memory VTab Special**

Memory vtab continues using integrated approach for performance. Isolation layer used only for store and custom modules.

- Pros: No performance regression for memory vtab
- Cons: Two isolation implementations to maintain

**Option B: Unify Under Isolation Layer**

Create a "raw memory module" (BTrees, no isolation) and wrap with isolation layer.

- Pros: Single isolation implementation, simpler memory vtab
- Cons: Some performance overhead, two layers of BTrees

**Recommendation:** Start with Option A. Measure performance of Option B. Migrate if overhead is acceptable.

---

## API Surface

### Wrapping a Module

```typescript
import { IsolationModule } from '@quereus/isolation';
import { StoreModule } from '@quereus/store';
import { MemoryModule } from '@quereus/quereus';

// Create underlying module (the persistent storage)
const storeModule = new StoreModule(leveldb);

// Create overlay module (for uncommitted changes)
const overlayModule = new MemoryModule();  // Or another StoreModule, etc.

// Wrap with isolation
const isolatedModule = new IsolationModule({
  underlying: storeModule,
  overlay: overlayModule,
});

// Register with database
db.registerModule('store', isolatedModule);
```

### Checking Capabilities

```typescript
const caps = isolatedModule.getCapabilities();
// { isolation: true, savepoints: true, persistent: true, ... }
```

### Transparent Usage

Once wrapped, usage is identical to any other module:

```sql
CREATE VIRTUAL TABLE users USING store (...);
BEGIN;
INSERT INTO users VALUES (1, 'Alice');
SELECT * FROM users WHERE id = 1;  -- Returns Alice (read-your-own-write)
ROLLBACK;
SELECT * FROM users WHERE id = 1;  -- Returns nothing
```

---

## Testing Strategy

### Unit Tests

- `OverlayState`: insert, update, delete, iteration, savepoints
- `MergeIterator`: all combinations of overlay/underlying states
- Secondary index tracking: insert, update, delete propagation

### Property-Based Tests

Using fast-check or similar:

- Generate random sequences of operations
- Apply to isolated module and a reference implementation
- Verify results match

### Integration Tests

- Wrap memory vtab with isolation layer, run existing memory vtab tests
- Wrap store module with isolation layer, verify read-your-own-writes
- Multi-table transactions with mixed modules

---

## TODO

### Phase 1: Core Infrastructure ✅

- [x] Define `ModuleCapabilities` interface in `@quereus/quereus`
- [x] Add `getCapabilities()` to `VirtualTableModule` interface
- [x] Implement capabilities for memory module
- [x] Define `IsolationCapableTable` interface with key extraction and comparison

### Phase 2: Merge Iterator ✅

- [x] Implement `mergeStreams()` for combining two row streams by primary key
- [x] Handle all cases: overlay insert, overlay update, overlay tombstone, passthrough
- [x] Comprehensive unit tests for ordering and completeness invariants
- [x] Test with various key types and orderings (integer, composite, text)

### Phase 3: Isolation Layer Core ✅

- [x] Implement `IsolationModule` wrapping `VirtualTableModule`
- [x] Implement `IsolatedTable` wrapping `VirtualTable`
- [x] Implement `IsolatedConnection` wrapping `VirtualTableConnection`
- [x] Create overlay table with matching schema + tombstone column
- [x] Wire up transaction lifecycle (begin, commit, rollback, savepoints)

### Phase 4: Query Routing ✅

- [x] Route writes to overlay table with tombstone support
- [x] Route reads through merge iterator (overlay + underlying)
- [x] Implement commit flush (apply overlay to underlying with independent transaction)
- [x] Implement `clearOverlay()` for overlay reset after commit/rollback
- [x] Per-connection overlay storage (each DB instance gets its own overlay per table)
- [x] Lazy overlay creation (overlay created on first write, using schema from underlying)
- [x] Proper transaction isolation (rollback doesn't affect committed data)
- [x] Handle index scans via overlay indexes (streaming merge with sort key comparators)

### Phase 5: Integration

- [x] Add isolation layer to store module (opt-in via `createIsolatedStoreModule()`)
- [x] Implement capabilities for store module (`getCapabilities()` reports `isolation: false`)
- [x] Update store module documentation (show example of using memory table backed isolation layer)
- [x] Run store module tests with isolation enabled (basic read-your-own-writes tests pass)
- [ ] Full integration testing (autocommit mode, savepoint coordination with underlying store)

### Phase 6: Optimization

- [ ] Switch Quoomb Web's Store and Sync modes to use isolated.
- [x] O(log n) PK point lookups via `buildPKPointLookupFilter()` (overlay reads and underlying existence checks)
- [x] O(1) `clearOverlay()` via reference discard instead of row-by-row deletion
- [ ] Performance benchmarking vs. non-isolated access

---

## Optimization Strategies

### Current Overhead Analysis

For a single-statement autocommit write (the most common case), the current flow is:

```
Statement.run()
  → _beginImplicitTransaction()
  → IsolatedTable.update()
      → ensureConnection()
      → ensureOverlay()           ← Creates overlay table + indexes
      → write to overlay          ← Memory allocation, BTree insert
  → _commitImplicitTransaction()
      → flushOverlayToUnderlying()
          → full scan overlay     ← Iterate all overlay entries
          → for each entry:
              → rowExistsInUnderlying()  ← Full scan to check existence!
              → underlying.update()
          → underlying.commit()
      → clearOverlay()
```

**Key inefficiencies:**

1. **Overlay creation overhead** — Schema cloning, index creation, even for a single row
2. **Double write** — Row written to overlay, then copied to underlying
3. **Full scan for existence check** — `rowExistsInUnderlying()` does a full table scan per row
4. **Overlay scan at commit** — Even for one row, we iterate the overlay

### Optimization 1: Direct Passthrough for Write-Only Autocommit

**Scenario:** Single DML statement in autocommit mode with no subsequent reads.

**Insight:** If we're just doing `INSERT INTO t VALUES (...)` with no reads, we don't need the overlay at all. The write can go directly to the underlying module.

**Detection:**
- Autocommit mode (no explicit `BEGIN`)
- Statement is pure DML (INSERT/UPDATE/DELETE) without RETURNING
- No reads from the same table within the statement

**Implementation:**

```typescript
interface IsolationModuleConfig {
  // ... existing
  
  /** Enable direct passthrough for write-only autocommit statements */
  enableDirectPassthrough?: boolean;  // default: true
}

class IsolatedTable {
  private directPassthroughMode = false;
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    // Check if we can use direct passthrough
    if (this.canUseDirectPassthrough()) {
      this.directPassthroughMode = true;
      return this.underlyingTable.update(args);
    }
    
    // ... existing overlay logic
  }
  
  private canUseDirectPassthrough(): boolean {
    return (
      this.db.getAutocommit() &&           // Autocommit mode
      !this.hasChanges &&                   // No prior writes in this "transaction"
      !this.overlayTable &&                 // Overlay not yet created
      !this.pendingReads                    // No reads pending (would need overlay)
    );
  }
  
  async commit(): Promise<void> {
    if (this.directPassthroughMode) {
      // Already written to underlying, just commit
      await this.underlyingTable.commit?.();
      this.directPassthroughMode = false;
      return;
    }
    // ... existing flush logic
  }
}
```

**Benefit:** Eliminates all overlay overhead for simple writes.

**Risk:** Must ensure no reads occur after the write within the same implicit transaction. The planner/executor could hint this.

### Optimization 2: Lazy Overlay with Deferred Creation

**Current:** Overlay created on first write.

**Improvement:** Defer overlay creation until a read-after-write occurs.

```typescript
class IsolatedTable {
  /** Pending writes before overlay is created */
  private pendingWrites: UpdateArgs[] = [];
  
  async update(args: UpdateArgs): Promise<Row | undefined> {
    if (!this.overlayTable && this.db.getAutocommit()) {
      // Buffer the write, don't create overlay yet
      this.pendingWrites.push(args);
      this.hasChanges = true;
      // Return optimistic result
      return args.values;
    }
    
    // ... existing logic if overlay exists or explicit transaction
  }
  
  query(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (this.pendingWrites.length > 0) {
      // Read-after-write detected, materialize overlay now
      await this.materializePendingWrites();
    }
    // ... existing merge logic
  }
  
  async commit(): Promise<void> {
    if (this.pendingWrites.length > 0 && !this.overlayTable) {
      // No reads occurred, apply directly to underlying
      for (const write of this.pendingWrites) {
        await this.underlyingTable.update(write);
      }
      await this.underlyingTable.commit?.();
      this.pendingWrites = [];
      return;
    }
    // ... existing flush logic
  }
}
```

**Benefit:** Avoids overlay creation for write-only transactions.

### Optimization 3: Existence Check via Point Lookup

**Current:** `rowExistsInUnderlying()` does a full table scan.

**Fix:** Use primary key lookup instead.

```typescript
private async rowExistsInUnderlying(pk: SqlValue[]): Promise<boolean> {
  if (!this.underlyingTable.query) return false;
  
  // Build point lookup filter using PK constraints
  const pkFilter = this.buildPKPointLookupFilter(pk);
  
  for await (const _row of this.underlyingTable.query(pkFilter)) {
    return true;  // Found it
  }
  return false;
}

private buildPKPointLookupFilter(pk: SqlValue[]): FilterInfo {
  const pkIndices = this.getPrimaryKeyIndices();
  const constraints = pkIndices.map((colIdx, i) => ({
    column: colIdx,
    op: IndexConstraintOp.EQ,
    value: pk[i],
  }));
  
  return {
    idxNum: 0,
    idxStr: '_pk_point_lookup',
    constraints,
    args: pk,
    // ... rest of FilterInfo
  };
}
```

> This optimization is now implemented, but the real `buildPKPointLookupFilter` delegates to
> the engine's `makeIndexEqSeekFilterInfo` (via `makePkPointLookupFilter`) so the FilterInfo
> also carries a typed `accessPath` — required by the merge's scan-order resolution above. The
> `idxStr: '_pk_point_lookup'` sketch here predates that and does not reflect the current shape.

**Benefit:** O(log n) instead of O(n) for existence checks.

### Optimization 4: Batch Commit

**Current:** Each overlay entry applied individually to underlying.

**Improvement:** Collect all changes and apply via batch API if available.

```typescript
private async flushOverlayToUnderlying(): Promise<void> {
  // ... collect overlay entries ...
  
  // Check if underlying supports batch writes
  if (this.underlyingTable.batchUpdate) {
    await this.underlyingTable.batchUpdate(overlayEntries.map(e => ({
      operation: e.isTombstone ? 'delete' : 'upsert',
      values: e.dataRow,
      key: e.pk,
    })));
  } else {
    // Fallback to individual updates
    for (const entry of overlayEntries) {
      // ... existing logic
    }
  }
}
```

**Benefit:** Reduces round-trips for underlying modules that support batching (LevelDB, IndexedDB).

### Optimization 5: Read-Only Transaction Fast Path

**Scenario:** Transaction with only reads (SELECT).

**Current:** Overlay is never created (good), but merge logic still checks `hasChanges`.

**Already Implemented:** The `query()` method has this fast path:

```typescript
// Fast path: no overlay or no changes, skip merge overhead
if (!this.overlayTable || !this.hasChanges) {
  return this.underlyingTable.query(filterInfo);
}
```

**Enhancement:** Could also skip connection registration for read-only access.

### Optimization 6: Upsert Semantics

**Current:** At commit, we check `rowExistsInUnderlying()` to decide insert vs update.

**Improvement:** If underlying module supports UPSERT (INSERT OR REPLACE), use it.

```typescript
private async flushOverlayToUnderlying(): Promise<void> {
  const supportsUpsert = this.underlyingTable.capabilities?.upsert;
  
  for (const entry of overlayEntries) {
    if (entry.isTombstone) {
      await this.underlyingTable.update({ operation: 'delete', ... });
    } else if (supportsUpsert) {
      // Skip existence check, let underlying handle it
      await this.underlyingTable.update({
        operation: 'insert',
        onConflict: ConflictResolution.REPLACE,
        values: entry.dataRow,
      });
    } else {
      // ... existing check-then-insert/update logic
    }
  }
}
```

**Benefit:** Eliminates existence check overhead for modules supporting upsert.

### Optimization 7: Planner Hints

The query planner knows the statement structure. It could provide hints to the isolation layer:

```typescript
interface IsolationHints {
  /** Statement is write-only (no reads from written tables) */
  writeOnly?: boolean;
  
  /** Statement is read-only */
  readOnly?: boolean;
  
  /** Tables that will be read after write */
  readAfterWriteTables?: string[];
  
  /** Single-row operation (point insert/update/delete) */
  singleRow?: boolean;
}
```

The executor could pass these hints, allowing the isolation layer to choose optimal strategies.

### Optimization Summary

| Optimization | Benefit | Complexity | Priority |
|-------------|---------|------------|----------|
| Direct passthrough | Eliminates overlay for write-only | Medium | High |
| PK point lookup | O(log n) existence check | Low | High |
| Upsert semantics | Skip existence check | Low | High |
| Deferred overlay | Avoid overlay for write-only | Medium | Medium |
| Batch commit | Fewer round-trips | Medium | Medium |
| Planner hints | Informed optimization | High | Low |

### Recommended Implementation Order

1. **PK point lookup** — Simple fix with immediate benefit
2. **Upsert semantics** — Leverage existing module capabilities  
3. **Direct passthrough** — Major win for common case
4. **Batch commit** — Depends on underlying module support
5. **Planner hints** — Requires cross-layer coordination

---

## References

- [SQLite Virtual Table docs](https://sqlite.org/vtab.html) — Transaction semantics
- [LSM-Tree](https://en.wikipedia.org/wiki/Log-structured_merge-tree) — Similar merge concepts
- Memory VTab source — Reference implementation for overlay module with isolation support

