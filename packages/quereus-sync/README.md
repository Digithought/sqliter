# @quereus/sync

> **Stability: Experimental** — a research track; the API, the wire protocol, and the
> stored bytes may change or disappear without notice, in any release including a patch.
> See [Stability Tiers](../../docs/stability.md#tiers).

CRDT-based multi-master sync framework for [Quereus](https://github.com/gotchoices/quereus). Enables offline-first applications with automatic conflict resolution.

## Features

- **Multi-master replication**: Any replica can write, changes merge automatically
- **Column-level LWW**: Last-Write-Wins at the column level for fine-grained conflict resolution
- **Hybrid Logical Clocks**: Causally-ordered timestamps that work offline
- **Transport agnostic**: Bring your own WebSocket, HTTP, or WebRTC transport
- **Offline-first**: Local changes sync when connectivity returns
- **Schema sync**: DDL changes (CREATE TABLE, ALTER TABLE) propagate across replicas

## Installation

```bash
npm install @quereus/sync @quereus/store
```

## Quick Start

```typescript
import { StoreEventEmitter, LevelDBStore } from '@quereus/store';
import { createSyncModule, createStoreAdapter } from '@quereus/sync';

// Create the store with event emitter
const storeEvents = new StoreEventEmitter();
const kv = await LevelDBStore.open({ path: './sync-metadata' });

// Create sync module (tracks CRDT metadata, emits sync events).
// `db` is the Quereus Database; `storeModule` is the StoreModule the synced
// tables use — the adapter resolves each table through it, so inbound writes
// get table-owned key encoding, secondary-index maintenance, and post-apply
// reporting through the engine (materialized views, Database.watch).
//
// `transactionSource: db` wires local-change capture to the engine's
// transaction-commit boundary: the HLC ticks once per committed transaction and
// every fact of that transaction shares its base HLC (differing only by opSeq).
const { syncManager, syncEvents } = await createSyncModule(kv, {
  transactionSource: db,
  applyToStore: createStoreAdapter({ db, storeModule, events: storeEvents }),
  getTableSchema: (schema, table) => db.schemaManager.getTable(schema, table),
});

// Subscribe to sync events for UI
syncEvents.onRemoteChange((event) => {
  console.log('Remote changes applied:', event.changes.length);
});

// Get changes to send to another replica
const changes = await syncManager.getChangesSince(peerSiteId);

// Apply received changes from a remote replica
const result = await syncManager.applyChanges(changeSets);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Application                             │
├─────────────────────────────────────────────────────────────┤
│  SyncManager                                                 │
│  ├── HLCManager (Hybrid Logical Clock)                      │
│  ├── ColumnVersionStore (LWW metadata)                      │
│  ├── TombstoneStore (deletion tracking)                     │
│  ├── ChangeLogStore (HLC-indexed changes)                   │
│  ├── PeerStateStore (delta sync state)                      │
│  ├── SchemaMigrationStore (DDL tracking)                    │
│  └── SchemaVersionStore (schema conflict resolution)        │
├─────────────────────────────────────────────────────────────┤
│  @quereus/store (KVStore)                                   │
└─────────────────────────────────────────────────────────────┘
```

## Sync Protocol

### Delta Sync

When replicas have synced before:

```typescript
// Check if delta sync is possible
if (await syncManager.canDeltaSync(peerSiteId)) {
  // Get changes since last sync
  const changes = await syncManager.getChangesSince(peerSiteId, sinceHLC);
  // Apply received changes (applyToStore callback set at construction)
  const result = await syncManager.applyChanges(changeSets);
  // result: { applied, skipped, conflicts, transactions }
}
```

### Snapshot Sync

For new replicas or when delta sync isn't available:

```typescript
// Stream snapshot chunks
for await (const chunk of syncManager.getSnapshotStream(1000)) {
  sendToPeer(chunk);
}

// Apply received snapshot stream
await syncManager.applySnapshotStream(chunks, (progress) => {
  console.log(`${progress.tablesProcessed}/${progress.totalTables} tables`);
});

// Or use non-streaming full snapshot
const snapshot = await syncManager.getSnapshot();
await syncManager.applySnapshot(snapshot);
```

### Checkpoint / Resume

Streaming snapshots support checkpoint-based resumption:

```typescript
// Save checkpoint during long snapshot transfers
const checkpoint = await syncManager.getSnapshotCheckpoint(snapshotId);

// Resume from where we left off
if (checkpoint) {
  for await (const chunk of syncManager.resumeSnapshotStream(checkpoint)) {
    sendToPeer(chunk);
  }
}
```

## Events

Subscribe to sync events for UI updates:

```typescript
syncEvents.onLocalChange((event) => {
  console.log('Local changes:', event.changes.length, 'pending:', event.pendingSync);
});

syncEvents.onRemoteChange((event) => {
  console.log('Remote changes from:', event.siteId, event.changes.length);
  refreshUI();
});

syncEvents.onConflictResolved((event) => {
  console.log('Conflict:', event.table, event.column, 'winner:', event.winner);
});

syncEvents.onSyncStateChange((state) => {
  console.log('Sync state:', state.status);
});
```

## Conflict Resolution

Conflicts are resolved automatically using Last-Write-Wins at the column level:

- Each column has an associated HLC timestamp
- When merging, the column with the higher HLC wins
- Ties are broken by site ID (deterministic ordering)

This means concurrent updates to *different* columns of the same row both apply, while updates to the *same* column use the latest value.

## API

### Core Exports

- `createSyncModule(kv, options?)` - Factory to create sync manager and event emitter. Pass `transactionSource` (the engine `Database`) to capture local changes at the transaction boundary; omit it for a relay-only deployment (e.g. a coordinator)
- `createStoreAdapter({ db, storeModule, events, applyForeignKeyActions? })` - Creates an `ApplyToStoreCallback` for applying remote changes. Applies rows through `StoreTable.applyExternalRowChanges` (table-owned keying, secondary-index maintenance) and reports each invocation as one `Database.ingestExternalRowChanges` batch (materialized-view maintenance, `Database.watch` capture, commit-time assertions). `applyForeignKeyActions` (default `false`) opts inbound update/delete into parent-side FK actions — only enable when the replication stream does not already carry the origin's cascade effects; cascaded child writes are recorded as *local* changes and propagate outward. The callback is host-driven: never invoke it from within statement execution, and don't drive it while holding an open explicit transaction on `db`. Inbound **assertion** violations are *detect-and-notify*: a local commit-time global assertion the merged batch trips is reported via `onAssertionViolation` while the data and its derived effects (MV, `Database.watch`) converge on the first apply — no divergence, no throw, no retry (trust-the-origin: the data must land regardless). A genuine per-change **storage** failure still aborts: it is collected in `ApplyToStoreResult.errors`, the consumer leaves CRDT metadata uncommitted, and the next sync attempt re-resolves and converges (value-identical re-application is suppressed)
- `registerBasisLifecycleTvf(db, syncManager)` - Opt-in: register the `quereus_basis_lifecycle()` introspection TVF against an engine `Database`, so a developer can list legacy / retirement-candidate basis tables from SQL (`select "table", state, "unmappedSince" from quereus_basis_lifecycle() where state = 'derivation-source-only'`). A pure read-only convenience over `SyncManager.getBasisTableLifecycle()`; call once after `createSyncModule(...)`
- `SyncManager` - Main sync coordination interface
- `SyncEventEmitter` / `SyncEventEmitterImpl` - Event subscription interface and implementation

### Clock Exports

- `HLCManager` - Hybrid Logical Clock manager
- `generateSiteId()` - Generate unique 16-byte site identifier
- `siteIdToBase64(id)` / `siteIdFromBase64(str)` - Site ID serialization
- `compareHLC(a, b)` / `hlcEquals(a, b)` - HLC comparison utilities

### Protocol Types

- `ChangeSet` - Collection of changes from one transaction
- `Change` (`ColumnChange | RowDeletion`) - Single column or row change
- `SchemaMigration` - Schema change (CREATE/ALTER/DROP TABLE)
- `SnapshotChunk` - Streaming snapshot data (header, table-start, column-versions, table-end, schema-migration, footer)
- `ApplyResult` - Result of applying changes (applied, skipped, conflicts, transactions)
- `SyncConfig` / `DEFAULT_SYNC_CONFIG` - Configuration (retentionHorizonMs, allowResurrection, etc.)

## Related Packages

- [`@quereus/store`](../quereus-store/) - Storage base layer (required)
- [`@quereus/sync-client`](../quereus-sync-client/) - WebSocket sync client (handles connection, reconnection, batching)
- [`@quereus/sync-coordinator`](../sync-coordinator/) - Server-side coordinator

## License

MIT

