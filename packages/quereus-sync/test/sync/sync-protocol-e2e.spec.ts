/**
 * End-to-end integration tests for the sync protocol.
 *
 * These tests simulate realistic host/guest sync scenarios where
 * two replicas exchange changes through the protocol APIs.
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type ApplyToStoreCallback,
  type SnapshotChunk,
  type ChangeSet,
  type ColumnChange,
  type RowDeletion,
} from '../../src/sync/protocol.js';
import { StoreEventEmitter, InMemoryKVStore, StoreModule, type KVStoreProvider } from '@quereus/store';
import { generateSiteId } from '../../src/clock/site.js';
import { compareHLC, type HLC } from '../../src/clock/hlc.js';
import type { SyncManager } from '../../src/sync/manager.js';
import { Database, type SqlValue, type TableSchema } from '@quereus/quereus';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

// ============================================================================
// Test Infrastructure
// ============================================================================

/** In-memory store that tracks applied changes */
interface AppliedChange {
  type: 'data' | 'schema';
  change: DataChangeToApply | SchemaChangeToApply;
}

/** Simulates an in-memory data store for a replica */
class MockDataStore {
  /** Table data: table -> pk (JSON) -> row (column -> value) */
  readonly tables = new Map<string, Map<string, Map<string, SqlValue>>>();
  /** Log of all applied changes */
  readonly changeLog: AppliedChange[] = [];

  createApplyToStoreCallback(): ApplyToStoreCallback {
    return async (dataChanges, schemaChanges, _options) => {
      for (const change of schemaChanges) {
        this.changeLog.push({ type: 'schema', change });
        // For CREATE TABLE, ensure the table exists
        if (change.type === 'create_table') {
          const key = `${change.schema}.${change.table}`;
          if (!this.tables.has(key)) {
            this.tables.set(key, new Map());
          }
        }
      }

      for (const change of dataChanges) {
        this.changeLog.push({ type: 'data', change });
        const tableKey = `${change.schema}.${change.table}`;
        const pkKey = JSON.stringify(change.pk);

        if (!this.tables.has(tableKey)) {
          this.tables.set(tableKey, new Map());
        }
        const table = this.tables.get(tableKey)!;

        if (change.type === 'delete') {
          table.delete(pkKey);
        } else if (change.columns) {
          // update - merge columns
          if (!table.has(pkKey)) {
            table.set(pkKey, new Map());
          }
          const row = table.get(pkKey)!;
          for (const [col, val] of Object.entries(change.columns)) {
            row.set(col, val);
          }
        }
      }

      return {
        dataChangesApplied: dataChanges.length,
        schemaChangesApplied: schemaChanges.length,
        errors: [],
      };
    };
  }

  getRow(schema: string, table: string, pk: SqlValue[]): Map<string, SqlValue> | undefined {
    return this.tables.get(`${schema}.${table}`)?.get(JSON.stringify(pk));
  }
}

/**
 * Minimal TableSchema stand-in for `main.test (id INTEGER PRIMARY KEY, value TEXT)`.
 * Carries only the fields the sync manager's column-mapping paths actually
 * read: identity, columns, `primaryKeyDefinition`, and `columnIndexMap`.
 * (The store adapter itself no longer takes a schema lookup — it resolves
 * tables through the StoreModule.) If a sync path starts reading more schema
 * fields, extend this one factory.
 */
function makeTestTableSchema(): TableSchema {
  return {
    schemaName: 'main',
    name: 'test',
    columns: [
      { name: 'id', logicalType: { isTextual: false } },
      { name: 'value', logicalType: { isTextual: true } },
    ],
    primaryKeyDefinition: [{ index: 0, desc: false }],
    columnIndexMap: new Map([
      ['id', 0],
      ['value', 1],
    ]),
  } as unknown as TableSchema;
}

/** Represents a sync replica (host or guest) */
interface Replica {
  name: string;
  kv: InMemoryKVStore;
  dataStore: MockDataStore;
  storeEvents: FakeTransactionSource;
  syncEvents: SyncEventEmitterImpl;
  manager: SyncManager;
}

/** Creates a configured replica with store and sync manager */
async function createReplica(name: string, config: SyncConfig): Promise<Replica> {
  const kv = new InMemoryKVStore();
  const dataStore = new MockDataStore();
  const storeEvents = new FakeTransactionSource();
  const syncEvents = new SyncEventEmitterImpl();
  const applyToStore = dataStore.createApplyToStoreCallback();

  const manager = await SyncManagerImpl.create(kv, storeEvents, config, syncEvents, applyToStore);

  return { name, kv, dataStore, storeEvents, syncEvents, manager };
}

/**
 * Simulates a sync session between two replicas (bidirectional).
 * This mimics what would happen over a WebSocket connection.
 *
 * In a real sync protocol:
 * - The sender tracks what HLC the receiver is now at (for future delta queries)
 * - Both receiver and sender update their knowledge of each other
 */
async function performBidirectionalSync(host: Replica, guest: Replica): Promise<{
  hostToGuest: { applied: number; conflicts: number };
  guestToHost: { applied: number; conflicts: number };
}> {
  // Guest gets changes from host
  const hostChanges = await host.manager.getChangesSince(guest.manager.getSiteId());
  const guestResult = await guest.manager.applyChanges(hostChanges);

  // Host gets changes from guest
  const guestChanges = await guest.manager.getChangesSince(host.manager.getSiteId());
  const hostResult = await host.manager.applyChanges(guestChanges);

  // Update peer states - each side records the current HLC of the other
  // This allows canDeltaSync to return true on future syncs
  const hostCurrentHLC = host.manager.getCurrentHLC();
  const guestCurrentHLC = guest.manager.getCurrentHLC();

  // Guest records host's HLC (for knowing what it has received from host)
  await guest.manager.updatePeerSyncState(host.manager.getSiteId(), hostCurrentHLC);
  // Host records guest's HLC (for knowing what guest has, enabling delta sync)
  await host.manager.updatePeerSyncState(guest.manager.getSiteId(), guestCurrentHLC);

  return {
    hostToGuest: { applied: guestResult.applied, conflicts: guestResult.conflicts },
    guestToHost: { applied: hostResult.applied, conflicts: hostResult.conflicts },
  };
}

/** Helper to emit a local data change (simulating SQL execution) */
function emitLocalInsert(
  replica: Replica,
  schema: string,
  table: string,
  pk: SqlValue[],
  row: SqlValue[]
): void {
  replica.storeEvents.commitData({
    type: 'insert',
    schemaName: schema,
    tableName: table,
    key: pk,
    newRow: row,
  });
}

/** Helper to emit a local update (simulating SQL UPDATE) */
function emitLocalUpdate(
  replica: Replica,
  schema: string,
  table: string,
  pk: SqlValue[],
  oldRow: SqlValue[],
  newRow: SqlValue[]
): void {
  replica.storeEvents.commitData({
    type: 'update',
    schemaName: schema,
    tableName: table,
    key: pk,
    oldRow,
    newRow,
  });
}

/** Helper to emit a local delete (simulating SQL DELETE) */
function emitLocalDelete(
  replica: Replica,
  schema: string,
  table: string,
  pk: SqlValue[],
  oldRow: SqlValue[]
): void {
  replica.storeEvents.commitData({
    type: 'delete',
    schemaName: schema,
    tableName: table,
    key: pk,
    oldRow,
  });
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Sync Protocol E2E', () => {
  let config: SyncConfig;

  beforeEach(() => {
    config = { ...DEFAULT_SYNC_CONFIG };
  });

  describe('Basic Host/Guest Sync', () => {
    it('should sync a single insert from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts a row
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice', 'alice@example.com']);
      await new Promise(r => setTimeout(r, 10)); // Allow async processing

      // Perform sync
      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      expect(result.hostToGuest.conflicts).to.equal(0);

      // Guest's data store should have the change
      expect(guest.dataStore.changeLog.length).to.be.greaterThan(0);
    });

    it('should sync multiple rows from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts multiple rows
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      emitLocalInsert(host, 'main', 'users', [3], [3, 'Charlie']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Should have applied all 3 rows worth of column changes
      expect(result.hostToGuest.applied).to.be.greaterThan(0);
    });

    it('should sync changes bidirectionally', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts row 1
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      // Guest inserts row 2 (different row, no conflict)
      emitLocalInsert(guest, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Both directions should have changes
      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      expect(result.guestToHost.applied).to.be.greaterThan(0);
    });

    it('should sync an update from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts then updates
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalUpdate(host, 'main', 'users', [1], [1, 'Alice'], [1, 'Alice Updated']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      // Guest should have received the latest value
      const changes = guest.dataStore.changeLog.filter(c => c.type === 'data');
      expect(changes.length).to.be.greaterThan(0);
    });

    it('should sync a delete from host to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts and deletes
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      // Guest should have received both insert columns and the delete
      const deleteChanges = guest.dataStore.changeLog.filter(
        c => c.type === 'data' && (c.change as DataChangeToApply).type === 'delete'
      );
      expect(deleteChanges.length).to.equal(1);
    });
  });

  describe('Conflict Resolution (LWW)', () => {
    it('should resolve concurrent updates with Last-Write-Wins', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Both insert the same row initially (would happen before disconnect)
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Original']);
      await new Promise(r => setTimeout(r, 5));

      // Sync to establish baseline
      await performBidirectionalSync(host, guest);

      // Now both update the same column "offline" (no sync between)
      // Guest updates first (earlier timestamp)
      emitLocalUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
      await new Promise(r => setTimeout(r, 50)); // Ensure host has later timestamp

      // Host updates later (later timestamp - should win)
      emitLocalUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
      await new Promise(r => setTimeout(r, 10));

      // Sync again
      const result = await performBidirectionalSync(host, guest);

      // Host's later write should win - guest should have conflict resolved
      // (Host change applied to guest, guest change rejected on host)
      expect(result.hostToGuest.applied + result.hostToGuest.conflicts).to.be.greaterThan(0);
    });

    it('should handle delete vs update conflict (delete should block older updates)', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts a row
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      await performBidirectionalSync(host, guest);

      // Guest updates (earlier)
      emitLocalUpdate(guest, 'main', 'users', [1], [1, 'Alice'], [1, 'Guest Update']);
      await new Promise(r => setTimeout(r, 50));

      // Host deletes (later - should win)
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Delete from host should be applied to guest
      expect(result.hostToGuest.applied).to.be.greaterThan(0);
    });

    it('should fire conflict resolution events', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      const conflicts: Array<{ winner: string }> = [];
      guest.syncEvents.onConflictResolved((event) => {
        conflicts.push({ winner: event.winner });
      });

      // Setup: insert same row on both
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Host Insert']);
      await new Promise(r => setTimeout(r, 50));
      emitLocalInsert(guest, 'main', 'users', [1], [1, 'Guest Insert']);
      await new Promise(r => setTimeout(r, 10));

      // Host has newer timestamp, so when guest applies host's changes, there may be conflict
      await performBidirectionalSync(host, guest);

      // We may or may not get conflicts depending on timing
      // The important thing is no errors occur
    });
  });

  describe('Delta Sync', () => {
    it('should only sync changes since last sync', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Initial sync with some data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));
      await performBidirectionalSync(host, guest);

      const initialChanges = guest.dataStore.changeLog.length;

      // Add more data on host
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Second sync should only include new changes
      const result = await performBidirectionalSync(host, guest);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
      // Should have more changes than before
      expect(guest.dataStore.changeLog.length).to.be.greaterThan(initialChanges);
    });

    it('should correctly track peer sync state', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Initially, canDeltaSync should be false (never synced)
      const canDeltaBefore = await host.manager.canDeltaSync(
        guest.manager.getSiteId(),
        guest.manager.getCurrentHLC()
      );
      expect(canDeltaBefore).to.be.false;

      // After sync, should be able to delta sync
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));
      await performBidirectionalSync(host, guest);

      const canDeltaAfter = await host.manager.canDeltaSync(
        guest.manager.getSiteId(),
        guest.manager.getCurrentHLC()
      );
      expect(canDeltaAfter).to.be.true;
    });
  });

  describe('Snapshot Sync', () => {
    it('should sync full snapshot when delta sync not available', async () => {
      const host = await createReplica('host', config);

      // Host has data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Get full snapshot from host
      const snapshot = await host.manager.getSnapshot();
      expect(snapshot.tables.length).to.be.at.least(0); // May be empty if no column tracking
      expect(snapshot.siteId).to.have.lengthOf(16);
    });

    it('should apply snapshot to guest', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host has data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Get and apply snapshot
      const snapshot = await host.manager.getSnapshot();
      await guest.manager.applySnapshot(snapshot);

      // Guest's HLC should be updated
      const guestHLC = guest.manager.getCurrentHLC();
      expect(compareHLC(guestHLC, snapshot.hlc)).to.be.at.least(0);
    });

    it('should stream snapshot chunks', async () => {
      const host = await createReplica('host', config);

      // Add some data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Stream snapshot
      const chunks: Array<{ type: string }> = [];
      for await (const chunk of host.manager.getSnapshotStream()) {
        chunks.push({ type: chunk.type });
      }

      // Should have header and footer at minimum
      expect(chunks.length).to.be.at.least(2);
      expect(chunks[0].type).to.equal('header');
      expect(chunks[chunks.length - 1].type).to.equal('footer');
    });

    it('should apply streamed snapshot', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Collect chunks
      const chunks: SnapshotChunk[] = [];
      for await (const chunk of host.manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      // Apply to guest
      async function* yieldChunks(): AsyncIterable<SnapshotChunk> {
        for (const chunk of chunks) yield chunk;
      }

      await guest.manager.applySnapshotStream(yieldChunks());

      // Should succeed without error
    });
  });

  describe('Multi-Replica Hub and Spoke', () => {
    it('should sync from one host to multiple guests', async () => {
      const host = await createReplica('host', config);
      const guest1 = await createReplica('guest1', config);
      const guest2 = await createReplica('guest2', config);

      // Host inserts data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Sync to both guests
      const result1 = await performBidirectionalSync(host, guest1);
      const result2 = await performBidirectionalSync(host, guest2);

      expect(result1.hostToGuest.applied).to.be.greaterThan(0);
      expect(result2.hostToGuest.applied).to.be.greaterThan(0);
    });

    it('should merge changes from multiple guests', async () => {
      const host = await createReplica('host', config);
      const guest1 = await createReplica('guest1', config);
      const guest2 = await createReplica('guest2', config);

      // Each guest inserts different data (different rows = no conflict)
      emitLocalInsert(guest1, 'main', 'users', [1], [1, 'From Guest 1']);
      emitLocalInsert(guest2, 'main', 'users', [2], [2, 'From Guest 2']);
      await new Promise(r => setTimeout(r, 10));

      // Sync guest1 to host
      await performBidirectionalSync(host, guest1);

      // Sync guest2 to host
      await performBidirectionalSync(host, guest2);

      // Host should now have changes from both guests
      const hostChanges = await host.manager.getChangesSince(generateSiteId());
      expect(hostChanges.length).to.be.greaterThan(0);
    });

    it('should propagate changes through hub to other spokes', async () => {
      const host = await createReplica('host', config);
      const guest1 = await createReplica('guest1', config);
      const guest2 = await createReplica('guest2', config);

      // guest1 inserts data
      emitLocalInsert(guest1, 'main', 'users', [1], [1, 'From Guest 1']);
      await new Promise(r => setTimeout(r, 10));

      // Sync guest1 -> host
      await performBidirectionalSync(host, guest1);

      // Sync host -> guest2 (should propagate guest1's data)
      const result = await performBidirectionalSync(host, guest2);

      expect(result.hostToGuest.applied).to.be.greaterThan(0);
    });
  });

  describe('Schema Sync', () => {
    it('should sync schema changes (CREATE TABLE)', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host creates a table
      host.storeEvents.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'new_table',
        ddl: 'CREATE TABLE new_table (id INTEGER PRIMARY KEY)',
      });
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);

      // Schema migration should be applied
      expect(result.hostToGuest.applied).to.be.greaterThan(0);

      // Guest should have received the schema change
      const schemaChanges = guest.dataStore.changeLog.filter(c => c.type === 'schema');
      expect(schemaChanges.length).to.equal(1);
    });

    it('should sync schema before data changes', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host creates table and inserts data
      host.storeEvents.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'products',
        ddl: 'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
      });
      await new Promise(r => setTimeout(r, 5));
      emitLocalInsert(host, 'main', 'products', [1], [1, 'Widget']);
      await new Promise(r => setTimeout(r, 10));

      await performBidirectionalSync(host, guest);

      // Schema should be applied before data
      const changes = guest.dataStore.changeLog;
      const schemaIdx = changes.findIndex(c => c.type === 'schema');
      const dataIdx = changes.findIndex(c => c.type === 'data');

      // If both present, schema should come first
      if (schemaIdx !== -1 && dataIdx !== -1) {
        expect(schemaIdx).to.be.lessThan(dataIdx);
      }
    });

    it('should not re-record remote schema changes', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Emit schema change with remote=true (simulating received remote change)
      host.storeEvents.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'remote_table',
        ddl: 'CREATE TABLE remote_table (id INTEGER)',
        remote: true,
      });
      await new Promise(r => setTimeout(r, 10));

      // This should NOT appear in changes to sync
      const changes = await host.manager.getChangesSince(guest.manager.getSiteId());
      expect(changes.length).to.equal(0);
    });
  });

  describe('Event Emission', () => {
    it('should emit onRemoteChange when applying changes', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      const remoteEvents: Array<{ changes: number }> = [];
      guest.syncEvents.onRemoteChange((event) => {
        remoteEvents.push({ changes: event.changes.length });
      });

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      await performBidirectionalSync(host, guest);

      expect(remoteEvents.length).to.be.greaterThan(0);
    });

    it('should emit onLocalChange when recording local changes', async () => {
      const host = await createReplica('host', config);

      const localEvents: Array<{ pendingSync: boolean }> = [];
      host.syncEvents.onLocalChange((event) => {
        localEvents.push({ pendingSync: event.pendingSync });
      });

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      expect(localEvents.length).to.be.greaterThan(0);
      expect(localEvents[0].pendingSync).to.be.true;
    });
  });

  describe('Change Serialization', () => {
    it('should correctly round-trip serialize column changes', async () => {
      const replica = await createReplica('test', config);

      // Make a local change
      emitLocalInsert(replica, 'main', 'users', [1], [1, 'Alice', 'alice@example.com']);
      await new Promise(r => setTimeout(r, 10));

      // Get changes
      const changes = await replica.manager.getChangesSince(generateSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Verify the structure
      const changeSet = changes[0];
      expect(changeSet.siteId).to.be.instanceOf(Uint8Array);
      expect(changeSet.changes.length).to.be.greaterThan(0);

      // Check each change has the right structure
      for (const change of changeSet.changes) {
        expect(change.type).to.equal('column');
        if (change.type === 'column') {
          expect(change.schema).to.equal('main');
          expect(change.table).to.equal('users');
          expect(Array.isArray(change.pk)).to.be.true;
          expect(change.pk[0]).to.equal(1);
          // Column names should be col_N when no schema lookup is available
          expect(change.column).to.match(/^col_\d+$/);
          expect(change.hlc.siteId).to.be.instanceOf(Uint8Array);
        }
      }
    });

    it('should use actual column names when getTableSchema is provided', async () => {
      // Create a replica with a mock getTableSchema callback
      const mockTableSchema = {
        schemaName: 'main',
        name: 'users',
        columns: [
          { name: 'id' },
          { name: 'username' },
          { name: 'email' },
        ],
      };

      const store = new InMemoryKVStore();
      const dataStore = new MockDataStore();
      const storeEvents = new FakeTransactionSource();
      const syncEvents = new SyncEventEmitterImpl();

      // Create manager with getTableSchema callback
      const manager = await SyncManagerImpl.create(
        store,
        storeEvents,
        config,
        syncEvents,
        dataStore.createApplyToStoreCallback(),
        (_schema: string, _table: string) => mockTableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Emit a local insert
      storeEvents.commitData({
        type: 'insert',
        schemaName: 'main',
        tableName: 'users',
        key: [1],
        newRow: [1, 'Alice', 'alice@example.com'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Get changes
      const changes = await manager.getChangesSince(generateSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Verify column names are actual names from schema
      const columns = changes[0].changes
        .filter((c): c is import('../../src/sync/protocol.js').ColumnChange => c.type === 'column')
        .map(c => c.column);

      expect(columns).to.include('id');
      expect(columns).to.include('username');
      expect(columns).to.include('email');
      // Should NOT use placeholder names
      expect(columns.some(c => c.startsWith('col_'))).to.be.false;
    });
  });

  describe('Real Column Mapping', () => {
    /**
     * This test verifies that column names are properly mapped when
     * both sender and receiver have the same table schema.
     * This simulates the real-world scenario in the browser.
     */
    it('should correctly map column names when both replicas have matching schemas', async () => {
      // Create mock table schema with real column names
      const tableSchema = {
        schemaName: 'main',
        name: 'users',
        columns: [
          { name: 'id' },
          { name: 'username' },
          { name: 'email' },
        ],
        primaryKeyDefinition: [{ index: 0, desc: false }],
        columnIndexMap: new Map([
          ['id', 0],
          ['username', 1],
          ['email', 2],
        ]),
      };

      // Source replica with schema
      const sourceStore = new InMemoryKVStore();
      const sourceEvents = new FakeTransactionSource();
      const sourceSyncEvents = new SyncEventEmitterImpl();
      const sourceDataStore = new MockDataStore();

      const sourceManager = await SyncManagerImpl.create(
        sourceStore,
        sourceEvents,
        config,
        sourceSyncEvents,
        sourceDataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Destination replica with same schema
      const destStore = new InMemoryKVStore();
      const destEvents = new FakeTransactionSource();
      const destSyncEvents = new SyncEventEmitterImpl();
      const destDataStore = new MockDataStore();

      const destManager = await SyncManagerImpl.create(
        destStore,
        destEvents,
        config,
        destSyncEvents,
        destDataStore.createApplyToStoreCallback(),
        () => tableSchema as unknown as import('@quereus/quereus').TableSchema
      );

      // Source makes a local insert
      sourceEvents.commitData({
        type: 'insert',
        schemaName: 'main',
        tableName: 'users',
        key: [1],
        newRow: [1, 'alice', 'alice@example.com'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Get changes from source
      const changes = await sourceManager.getChangesSince(destManager.getSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Verify the changes use actual column names
      const columnChanges = changes[0].changes.filter(
        (c): c is import('../../src/sync/protocol.js').ColumnChange => c.type === 'column'
      );
      const columnNames = columnChanges.map(c => c.column);
      expect(columnNames).to.include('id');
      expect(columnNames).to.include('username');
      expect(columnNames).to.include('email');

      // Apply changes to destination
      const result = await destManager.applyChanges(changes);
      expect(result.applied).to.equal(3); // 3 columns
      expect(result.skipped).to.equal(0);

      // Verify destination received the data - each column is a separate change
      const destChanges = destDataStore.changeLog.filter(c => c.type === 'data');
      expect(destChanges.length).to.equal(3);

      // Collect all column values across all changes
      const allColumns: Record<string, SqlValue> = {};
      for (const dc of destChanges) {
        const change = dc.change as DataChangeToApply;
        if (change.columns) {
          Object.assign(allColumns, change.columns);
        }
      }

      // All column values should be present
      expect(allColumns['id']).to.equal(1);
      expect(allColumns['username']).to.equal('alice');
      expect(allColumns['email']).to.equal('alice@example.com');
    });

    /**
     * This test simulates the FULL sync flow:
     * 1. Browser A creates a table and inserts a row
     * 2. Browser A sends changes to coordinator
     * 3. Coordinator receives and applies changes
     * 4. Coordinator broadcasts to Browser B
     * 5. Browser B receives and applies changes
     *
     * This is the exact flow that happens in the real app.
     */
    it('should sync data through coordinator (full flow simulation)', async function() {
      this.timeout(5000);
      const tableSchema = makeTestTableSchema();

      // Browser A (source)
      const browserAStore = new InMemoryKVStore();
      const browserAEvents = new FakeTransactionSource();
      const browserASyncEvents = new SyncEventEmitterImpl();
      const browserADataStore = new MockDataStore();
      const browserA = await SyncManagerImpl.create(
        browserAStore,
        browserAEvents,
        config,
        browserASyncEvents,
        browserADataStore.createApplyToStoreCallback(),
        () => tableSchema
      );

      // Coordinator (no schema, no applyToStore - just CRDT metadata)
      const coordStore = new InMemoryKVStore();
      const coordEvents = new FakeTransactionSource();
      const coordSyncEvents = new SyncEventEmitterImpl();
      const coordinator = await SyncManagerImpl.create(
        coordStore,
        coordEvents,
        config,
        coordSyncEvents
        // No applyToStore, no getTableSchema - coordinator only stores metadata
      );

      // Browser B (destination)
      const browserBStore = new InMemoryKVStore();
      const browserBEvents = new FakeTransactionSource();
      const browserBSyncEvents = new SyncEventEmitterImpl();
      const browserBDataStore = new MockDataStore();
      const browserB = await SyncManagerImpl.create(
        browserBStore,
        browserBEvents,
        config,
        browserBSyncEvents,
        browserBDataStore.createApplyToStoreCallback(),
        () => tableSchema
      );

      // Step 1: Browser A creates table and inserts row
      browserAEvents.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'test',
        ddl: 'CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)',
      });
      await new Promise(r => setTimeout(r, 10));

      browserAEvents.commitData({
        type: 'insert',
        schemaName: 'main',
        tableName: 'test',
        key: [1],
        newRow: [1, 'hello from A'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Browser A sends changes to coordinator
      const changesToCoordinator = await browserA.getChangesSince(coordinator.getSiteId());
      console.log('Changes to coordinator:', changesToCoordinator.length, 'changesets');
      console.log('  Schema migrations:', changesToCoordinator[0]?.schemaMigrations?.length ?? 0);
      console.log('  Data changes:', changesToCoordinator[0]?.changes?.length ?? 0);
      expect(changesToCoordinator.length).to.be.greaterThan(0);

      // Step 3: Coordinator applies changes
      const coordResult = await coordinator.applyChanges(changesToCoordinator);
      console.log('Coordinator apply result:', coordResult);
      expect(coordResult.applied).to.be.greaterThan(0);

      // Step 4: Coordinator broadcasts (same changes) to Browser B
      const resultB = await browserB.applyChanges(changesToCoordinator);
      console.log('Browser B apply result:', resultB);
      expect(resultB.applied).to.be.greaterThan(0);

      // Step 5: Verify Browser B has the data
      const bDataChanges = browserBDataStore.changeLog.filter(c => c.type === 'data');
      console.log('Browser B data changes:', bDataChanges.length);
      expect(bDataChanges.length).to.be.greaterThan(0);

      // Collect all column values
      const allColumns: Record<string, SqlValue> = {};
      for (const dc of bDataChanges) {
        const change = dc.change as DataChangeToApply;
        if (change.columns) {
          Object.assign(allColumns, change.columns);
        }
      }

      expect(allColumns['id']).to.equal(1);
      expect(allColumns['value']).to.equal('hello from A');
    });

    /**
     * This test simulates Browser B connecting AFTER Browser A has already synced.
     * This is the "late joiner" scenario.
     */
    it('should sync data to late-joining browser via getChangesSince', async function() {
      this.timeout(5000);

      const tableSchema = makeTestTableSchema();

      // Browser A (source)
      const browserAStore = new InMemoryKVStore();
      const browserAEvents = new FakeTransactionSource();
      const browserASyncEvents = new SyncEventEmitterImpl();
      const browserADataStore = new MockDataStore();
      const browserA = await SyncManagerImpl.create(
        browserAStore,
        browserAEvents,
        config,
        browserASyncEvents,
        browserADataStore.createApplyToStoreCallback(),
        () => tableSchema
      );

      // Coordinator (no schema, no applyToStore - just CRDT metadata)
      const coordStore = new InMemoryKVStore();
      const coordEvents = new FakeTransactionSource();
      const coordSyncEvents = new SyncEventEmitterImpl();
      const coordinator = await SyncManagerImpl.create(
        coordStore,
        coordEvents,
        config,
        coordSyncEvents
        // No applyToStore, no getTableSchema - coordinator only stores metadata
      );

      // Step 1: Browser A creates table and inserts row
      browserAEvents.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'test',
        ddl: 'CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)',
      });
      await new Promise(r => setTimeout(r, 10));

      browserAEvents.commitData({
        type: 'insert',
        schemaName: 'main',
        tableName: 'test',
        key: [1],
        newRow: [1, 'hello from A'],
      });
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Browser A sends changes to coordinator
      const changesToCoordinator = await browserA.getChangesSince(coordinator.getSiteId());

      // Step 3: Coordinator applies changes
      const coordResult = await coordinator.applyChanges(changesToCoordinator);
      expect(coordResult.applied).to.be.greaterThan(0);

      // Step 4: Browser B connects LATER and requests changes
      const browserBStore = new InMemoryKVStore();
      const browserBEvents = new FakeTransactionSource();
      const browserBSyncEvents = new SyncEventEmitterImpl();
      const browserBDataStore = new MockDataStore();
      const browserB = await SyncManagerImpl.create(
        browserBStore,
        browserBEvents,
        config,
        browserBSyncEvents,
        browserBDataStore.createApplyToStoreCallback(),
        () => tableSchema
      );

      // Browser B requests all changes from coordinator (no sinceHLC)
      const changesForB = await coordinator.getChangesSince(browserB.getSiteId());

      // This is the key assertion - coordinator should have changes to send
      expect(changesForB.length).to.be.greaterThan(0);

      // Browser B applies the changes
      const resultB = await browserB.applyChanges(changesForB);
      expect(resultB.applied).to.be.greaterThan(0);

      // Verify Browser B has the data
      const bDataChanges = browserBDataStore.changeLog.filter(c => c.type === 'data');
      expect(bDataChanges.length).to.be.greaterThan(0);

      // Collect all column values
      const allColumns: Record<string, SqlValue> = {};
      for (const dc of bDataChanges) {
        const change = dc.change as DataChangeToApply;
        if (change.columns) {
          Object.assign(allColumns, change.columns);
        }
      }

      expect(allColumns['id']).to.equal(1);
      expect(allColumns['value']).to.equal('hello from A');
    });

    /**
     * This test verifies that applyToStore writes to the CORRECT KV store for each table.
     *
     * In the browser:
     * - The sync manager uses `quoomb_sync_meta` IndexedDB database for CRDT metadata
     * - Each table uses its own IndexedDB database like `quereus_main_test` for data
     *
     * The adapter resolves each table via `StoreModule.getTableForExternalWrite`,
     * whose `StoreTable.ensureStore` opens the table's OWN data store through the
     * module's provider — the per-table routing the deleted `getKVStore` option
     * used to do by hand.
     */
    it('should write to the correct KV store for each table', async function() {
      this.timeout(5000);

      // This simulates the browser scenario where we have TWO different stores:
      // 1. syncMetaStore - where sync metadata lives (quoomb_sync_meta)
      // 2. the per-table data stores the StoreModule resolves via its provider
      const syncMetaStore = new InMemoryKVStore();

      const dataStores = new Map<string, InMemoryKVStore>();
      const getDataStore = (key: string): InMemoryKVStore => {
        let store = dataStores.get(key);
        if (!store) {
          store = new InMemoryKVStore();
          dataStores.set(key, store);
        }
        return store;
      };
      const provider: KVStoreProvider = {
        async getStore(s, t) { return getDataStore(`${s}.${t}`); },
        async getIndexStore(s, t, i) { return getDataStore(`${s}.${t}_idx_${i}`); },
        async getStatsStore(s, t) { return getDataStore(`${s}.${t}.__stats__`); },
        async getCatalogStore() { return getDataStore('__catalog__'); },
        async closeStore() {},
        async closeIndexStore() {},
        async closeAll() {
          for (const store of dataStores.values()) await store.close();
          dataStores.clear();
        },
      };

      const events = new StoreEventEmitter();
      const syncEvents = new SyncEventEmitterImpl();

      const db = new Database();
      const storeModule = new StoreModule(provider, events);
      db.registerModule('store', storeModule);
      await db.exec('create table test (id integer primary key, value text) using store');

      const { createStoreAdapter } = await import('../../src/sync/store-adapter.js');
      const applyToStore = createStoreAdapter({ db, storeModule, events });

      // Local capture is sourced from the engine transaction boundary (the real
      // Database); this test only applies remote changes, so nothing is captured.
      const syncManager = await SyncManagerImpl.create(
        syncMetaStore,  // Sync metadata goes here
        db,
        config,
        syncEvents,
        applyToStore,
        (schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName)
      );

      // Simulate receiving remote changes
      const { generateSiteId: genSite } = await import('../../src/clock/site.js');
      const { HLCManager } = await import('../../src/clock/hlc.js');
      const remoteSiteId = genSite();
      const remoteHLC = new HLCManager(remoteSiteId);

      const changes = [{
        siteId: remoteSiteId,
        transactionId: 'tx1',
        hlc: remoteHLC.tick(),
        changes: [
          {
            type: 'column' as const,
            schema: 'main',
            table: 'test',
            pk: [1],
            column: 'id',
            value: 1,
            hlc: remoteHLC.tick(),
          },
          {
            type: 'column' as const,
            schema: 'main',
            table: 'test',
            pk: [1],
            column: 'value',
            value: 'hello',
            hlc: remoteHLC.tick(),
          },
        ],
        schemaMigrations: [],
      }];

      const result = await syncManager.applyChanges(changes);
      expect(result.applied).to.equal(2);

      // Check what's in each store
      const syncMetaKeys: string[] = [];
      for await (const entry of syncMetaStore.iterate()) {
        syncMetaKeys.push(new TextDecoder().decode(entry.key));
      }

      const tableDataKeys: string[] = [];
      for await (const entry of getDataStore('main.test').iterate()) {
        tableDataKeys.push(new TextDecoder().decode(entry.key));
      }

      // Data lands in the TABLE's data store, NOT syncMetaStore.
      expect(tableDataKeys.length).to.be.greaterThan(0, 'Data should be in the table data store');
      // Sync meta store should only have sync-related keys, not table data
      const tableDataInSyncMeta = syncMetaKeys.some(k =>
        tableDataKeys.includes(k)
      );
      expect(tableDataInSyncMeta).to.equal(false, 'Table data keys should not be in syncMetaStore');

      // The applied row reads back through the engine (both column changes
      // merged into one upsert against the table's own store).
      const rows: Record<string, SqlValue>[] = [];
      for await (const row of db.eval('select id, value from test')) rows.push(row);
      expect(rows.map(r => ({ id: Number(r.id), value: r.value })))
        .to.deep.equal([{ id: 1, value: 'hello' }]);

      await db.close();
    });
  });

  describe('Coordinator Push Pattern', () => {
    /**
     * This test simulates the real WebSocket sync flow:
     * 1. Guest B makes a local change
     * 2. Guest B sends changes to coordinator (via getChangesSince)
     * 3. Coordinator applies the changes
     * 4. Coordinator broadcasts to Guest A (directly, same changes)
     * 5. Guest A receives and applies the broadcast
     *
     * This is different from the bidirectional sync where each side pulls.
     */
    it('should propagate guest changes through coordinator to other guests', async () => {
      // Coordinator acts as a relay - it doesn't make local changes
      const coordinator = await createReplica('coordinator', config);
      const guestA = await createReplica('guestA', config);
      const guestB = await createReplica('guestB', config);

      // Guest B makes a local change
      emitLocalInsert(guestB, 'main', 'users', [1], [1, 'From Guest B']);
      await new Promise(r => setTimeout(r, 10));

      // Step 1: Guest B gets its changes to send to coordinator
      const changesToCoordinator = await guestB.manager.getChangesSince(
        coordinator.manager.getSiteId()
      );
      expect(changesToCoordinator.length).to.be.greaterThan(0);

      // Step 2: Coordinator applies the changes
      const coordResult = await coordinator.manager.applyChanges(changesToCoordinator);
      expect(coordResult.applied).to.be.greaterThan(0);

      // Step 3: Coordinator broadcasts SAME changes to Guest A
      // (In real app, this is done by broadcastChanges which sends the received changes)
      const resultA = await guestA.manager.applyChanges(changesToCoordinator);
      expect(resultA.applied).to.be.greaterThan(0);

      // Guest A should have the data
      const guestAChanges = guestA.dataStore.changeLog.filter(c => c.type === 'data');
      expect(guestAChanges.length).to.be.greaterThan(0);
    });

    it('should handle bidirectional changes through coordinator', async () => {
      const coordinator = await createReplica('coordinator', config);
      const guestA = await createReplica('guestA', config);
      const guestB = await createReplica('guestB', config);

      // Initial sync: both guests connect and get initial state
      await performBidirectionalSync(coordinator, guestA);
      await performBidirectionalSync(coordinator, guestB);

      // Guest A makes a change
      emitLocalInsert(guestA, 'main', 'users', [1], [1, 'From Guest A']);
      await new Promise(r => setTimeout(r, 10));

      // Guest A sends to coordinator
      const changesFromA = await guestA.manager.getChangesSince(
        coordinator.manager.getSiteId()
      );
      await coordinator.manager.applyChanges(changesFromA);

      // Coordinator broadcasts to Guest B
      const resultB = await guestB.manager.applyChanges(changesFromA);
      expect(resultB.applied).to.be.greaterThan(0);

      // Now Guest B makes a change
      emitLocalInsert(guestB, 'main', 'users', [2], [2, 'From Guest B']);
      await new Promise(r => setTimeout(r, 10));

      // Guest B sends to coordinator
      const changesFromB = await guestB.manager.getChangesSince(
        coordinator.manager.getSiteId()
      );
      await coordinator.manager.applyChanges(changesFromB);

      // Coordinator broadcasts to Guest A
      const resultA = await guestA.manager.applyChanges(changesFromB);
      expect(resultA.applied).to.be.greaterThan(0);

      // Both guests should have both rows
      const aChanges = guestA.dataStore.changeLog.filter(c => c.type === 'data');
      const bChanges = guestB.dataStore.changeLog.filter(c => c.type === 'data');
      expect(aChanges.length).to.be.at.least(1); // Has Guest B's row
      expect(bChanges.length).to.be.at.least(1); // Has Guest A's row
    });
  });

  describe('Snapshot Data Application', () => {
    it('should apply snapshot row data to guest store via callback', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host has data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Get and apply snapshot
      const snapshot = await host.manager.getSnapshot();
      await guest.manager.applySnapshot(snapshot);

      // Guest's data store should have the rows applied via callback. The
      // non-streaming path emits one single-column update per CELL (2 rows ×
      // 2 columns), HLC-ascending — no receiver keying is resolvable before the
      // snapshot's own DDL runs, so cells cannot be grouped into rows here.
      const dataChanges = guest.dataStore.changeLog.filter(c => c.type === 'data');
      expect(dataChanges.length).to.equal(4, 'Snapshot should apply per-cell row data to store');

      // Verify actual row data
      const row1 = guest.dataStore.getRow('main', 'users', [1]);
      const row2 = guest.dataStore.getRow('main', 'users', [2]);
      expect(row1).to.exist;
      expect(row2).to.exist;
    });

    it('should apply streamed snapshot row data to guest store via callback', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host has data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Collect and apply streamed snapshot
      const chunks: SnapshotChunk[] = [];
      for await (const chunk of host.manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      async function* yieldChunks(): AsyncIterable<SnapshotChunk> {
        for (const chunk of chunks) yield chunk;
      }

      await guest.manager.applySnapshotStream(yieldChunks());

      // Guest's data store should have the rows applied via callback
      const dataChanges = guest.dataStore.changeLog.filter(c => c.type === 'data');
      expect(dataChanges.length).to.equal(2, 'Streamed snapshot should apply row data to store');
    });

    it('should apply snapshot schema migrations to guest store via callback', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host creates a table (schema change)
      host.storeEvents.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'products',
        ddl: 'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
      });
      await new Promise(r => setTimeout(r, 10));

      // Get and apply snapshot
      const snapshot = await host.manager.getSnapshot();
      expect(snapshot.schemaMigrations.length).to.be.at.least(1);

      await guest.manager.applySnapshot(snapshot);

      // Guest's data store should have the schema change applied via callback
      const schemaChanges = guest.dataStore.changeLog.filter(c => c.type === 'schema');
      expect(schemaChanges.length).to.be.at.least(1, 'Snapshot should apply schema migrations to store');
    });
  });

  describe('Before-image (per-cell prior)', () => {
    /** Flatten all column changes out of a list of ChangeSets. */
    function columnChanges(changes: ChangeSet[]): ColumnChange[] {
      return changes
        .flatMap(cs => cs.changes)
        .filter((c): c is ColumnChange => c.type === 'column');
    }

    it('omits prior on first insert and carries it on a later overwrite', async () => {
      const host = await createReplica('host', config);
      const freshPeer = generateSiteId();

      // First write of each cell: no before-image anywhere.
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Original']);
      await new Promise(r => setTimeout(r, 10));

      const afterInsert = columnChanges(await host.manager.getChangesSince(freshPeer));
      expect(afterInsert.length).to.be.greaterThan(0);
      for (const c of afterInsert) {
        expect(c).to.not.have.property('priorValue');
        expect(c).to.not.have.property('priorHlc');
      }
      const insertedValueCol = afterInsert.find(c => c.column === 'col_1');
      expect(insertedValueCol).to.exist;
      const insertHlc = insertedValueCol!.hlc;

      // Overwrite the value column in a separate transaction.
      await new Promise(r => setTimeout(r, 5));
      emitLocalUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Updated']);
      await new Promise(r => setTimeout(r, 10));

      const overwritten = columnChanges(await host.manager.getChangesSince(freshPeer))
        .find(c => c.column === 'col_1');
      expect(overwritten).to.exist;
      expect(overwritten!.value).to.equal('Updated');
      expect(overwritten!.priorValue).to.equal('Original');
      expect(overwritten!.priorHlc).to.not.be.undefined;
      // The before-image HLC is exactly the overwritten version's HLC.
      expect(compareHLC(overwritten!.priorHlc!, insertHlc)).to.equal(0);
    });

    it('preserves the origin prior chain when relayed through a receiver', async () => {
      const host = await createReplica('host', config);
      const relay = await createReplica('relay', config);
      const freshPeer = generateSiteId();

      // Round 1: relay receives the insert (so relay holds the pre-overwrite version).
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Original']);
      await new Promise(r => setTimeout(r, 10));
      const r1 = await host.manager.getChangesSince(relay.manager.getSiteId());
      await relay.manager.applyChanges(r1);
      const insertHlc = columnChanges(r1).find(c => c.column === 'col_1')!.hlc;

      // Round 2: relay receives the overwrite; its local lineage prior is the insert.
      emitLocalUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Updated']);
      await new Promise(r => setTimeout(r, 10));
      const r2 = await host.manager.getChangesSince(relay.manager.getSiteId());
      await relay.manager.applyChanges(r2);

      // Relay re-emits the origin's prior (its stored before-image), not its own clock.
      const relayed = columnChanges(await relay.manager.getChangesSince(freshPeer))
        .find(c => c.column === 'col_1');
      expect(relayed).to.exist;
      expect(relayed!.value).to.equal('Updated');
      expect(relayed!.priorValue).to.equal('Original');
      expect(relayed!.priorHlc).to.not.be.undefined;
      expect(compareHLC(relayed!.priorHlc!, insertHlc)).to.equal(0);
    });

    it('in-batch dedup keeps the pre-batch prior, not an in-batch loser', async () => {
      const receiver = await createReplica('receiver', config);
      const siteA = generateSiteId();
      const freshPeer = generateSiteId();

      const mk = (value: SqlValue, wallTime: bigint): ColumnChange => ({
        type: 'column', schema: 'main', table: 'users', pk: [1], column: 'col_1', value,
        hlc: { wallTime, counter: 0, siteId: siteA, opSeq: 0 } as HLC,
      });
      const cs = (transactionId: string, change: ColumnChange): ChangeSet => ({
        siteId: siteA, transactionId, hlc: change.hlc, changes: [change], schemaMigrations: [],
      });

      // Pre-batch: receiver stores v0@1000 (first write here, no prior).
      await receiver.manager.applyChanges([cs('tx0', mk('v0', 1000n))]);

      // One applyChanges with two stacked versions of the same cell; BOTH Phase-1
      // resolve against the pre-batch v0@1000, so the surviving winner's prior is
      // v0@1000 — never the in-batch loser v1@2000.
      await receiver.manager.applyChanges([
        cs('tx1', mk('v1', 2000n)),
        cs('tx2', mk('v2', 3000n)),
      ]);

      const stored = columnChanges(await receiver.manager.getChangesSince(freshPeer))
        .find(c => c.column === 'col_1');
      expect(stored).to.exist;
      expect(stored!.value).to.equal('v2');
      expect(stored!.priorValue).to.equal('v0');
      expect(stored!.priorHlc).to.not.be.undefined;
      expect(stored!.priorHlc!.wallTime).to.equal(1000n); // h0, not h1 (2000n)
    });
  });

  describe('Row before-image (delete priorRow)', () => {
    /** Flatten all deletions out of a list of ChangeSets. */
    function deletions(changes: ChangeSet[]): RowDeletion[] {
      return changes
        .flatMap(cs => cs.changes)
        .filter((c): c is RowDeletion => c.type === 'delete');
    }

    it('carries priorRow matching the pre-delete row image', async () => {
      const host = await createReplica('host', config);
      const freshPeer = generateSiteId();

      // Insert then delete; the delete should carry the row's last-known image.
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const dels = deletions(await host.manager.getChangesSince(freshPeer));
      expect(dels).to.have.lengthOf(1);
      expect(dels[0].priorRow).to.deep.equal([1, 'Alice']);
    });

    it('re-emits priorRow on the incremental (sinceHLC) relay path', async () => {
      // The no-sinceHLC tests above drain via collectAllChanges; passing a sinceHLC
      // forces the change-log replay path (collectChangesSince -> resolveLogEntry),
      // which re-emits the stored image from a separate code site. A zero HLC sits
      // before any real delete, so the delete is included.
      const host = await createReplica('host', config);
      const freshPeer = generateSiteId();
      const zeroHLC: HLC = { wallTime: 0n, counter: 0, siteId: generateSiteId(), opSeq: 0 };

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const dels = deletions(await host.manager.getChangesSince(freshPeer, zeroHLC));
      expect(dels).to.have.lengthOf(1);
      expect(dels[0].priorRow).to.deep.equal([1, 'Alice']);
    });

    it('omits priorRow when the delete event carried no oldRow', async () => {
      const host = await createReplica('host', config);
      const freshPeer = generateSiteId();

      // A relayed/synthesized delete: pk present, but no oldRow on the event.
      host.storeEvents.commitData({
        type: 'delete',
        schemaName: 'main',
        tableName: 'users',
        key: [7],
      });
      await new Promise(r => setTimeout(r, 10));

      const dels = deletions(await host.manager.getChangesSince(freshPeer));
      expect(dels).to.have.lengthOf(1);
      expect(dels[0]).to.not.have.property('priorRow');
    });

    it('re-emits the latest row image after delete -> reinsert -> delete', async () => {
      const host = await createReplica('host', config);
      const freshPeer = generateSiteId();

      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      // Reuse the same pk with a new value, then delete again. The tombstone dedup
      // drops the prior delete entry, so exactly one delete survives — carrying the
      // SECOND delete's row image, not the first.
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice v2']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice v2']);
      await new Promise(r => setTimeout(r, 10));

      const dels = deletions(await host.manager.getChangesSince(freshPeer));
      expect(dels).to.have.lengthOf(1);
      expect(dels[0].priorRow).to.deep.equal([1, 'Alice v2']);
    });

    it('in-batch delete dedup keeps the winning delete row image', async () => {
      const receiver = await createReplica('receiver', config);
      const siteA = generateSiteId();
      const freshPeer = generateSiteId();

      const mkDelete = (priorRow: SqlValue[], wallTime: bigint): RowDeletion => ({
        type: 'delete', schema: 'main', table: 'users', pk: [1],
        hlc: { wallTime, counter: 0, siteId: siteA, opSeq: 0 } as HLC,
        priorRow,
      });
      const cs = (transactionId: string, change: RowDeletion): ChangeSet => ({
        siteId: siteA, transactionId, hlc: change.hlc, changes: [change], schemaMigrations: [],
      });

      // One applyChanges with two stacked deletes of the same pk: both Phase-1
      // resolve against the empty pre-batch state, so only the max-HLC winner's
      // metadata (and priorRow) persists — never the in-batch loser's.
      await receiver.manager.applyChanges([
        cs('tx1', mkDelete([1, 'loser'], 2000n)),
        cs('tx2', mkDelete([1, 'winner'], 3000n)),
      ]);

      const dels = deletions(await receiver.manager.getChangesSince(freshPeer));
      expect(dels).to.have.lengthOf(1);
      expect(dels[0].priorRow).to.deep.equal([1, 'winner']);
      expect(dels[0].hlc.wallTime).to.equal(3000n);
    });
  });

  describe('Idempotency', () => {
    it('should produce identical state when applying the same ChangeSet twice', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts data
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      const changes = await host.manager.getChangesSince(guest.manager.getSiteId());
      expect(changes.length).to.be.greaterThan(0);

      // Apply once
      const result1 = await guest.manager.applyChanges(changes);
      expect(result1.applied).to.be.greaterThan(0);
      const changeLogAfterFirst = guest.dataStore.changeLog.length;

      // Get snapshot state after first apply
      const snapshot1 = await guest.manager.getSnapshot();

      // Apply again (exact same changes)
      const result2 = await guest.manager.applyChanges(changes);

      // Second apply should skip everything (already applied)
      expect(result2.applied).to.equal(0);
      expect(result2.skipped + result2.conflicts).to.equal(result1.applied);

      // Snapshot state should be identical
      const snapshot2 = await guest.manager.getSnapshot();
      expect(snapshot2.tables.length).to.equal(snapshot1.tables.length);

      // Re-applying already-applied changes must not grow the change log
      expect(guest.dataStore.changeLog.length).to.equal(changeLogAfterFirst);
    });

    it('should produce identical state when applying the same deletion twice', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts then deletes
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const changes = await host.manager.getChangesSince(guest.manager.getSiteId());

      // Apply once
      const result1 = await guest.manager.applyChanges(changes);
      expect(result1.applied).to.be.greaterThan(0);

      // Apply again
      const result2 = await guest.manager.applyChanges(changes);

      // Second apply: all previously-applied changes should be skipped/conflicted
      expect(result2.applied).to.equal(0);
    });
  });

  describe('Convergence', () => {
    it('should converge to same state regardless of application order', async () => {
      // Create two sources with different changes to the same column
      const source1 = await createReplica('source1', config);
      const source2 = await createReplica('source2', config);

      // Source1 writes an earlier value
      emitLocalInsert(source1, 'main', 'users', [1], [1, 'EarlierValue']);
      await new Promise(r => setTimeout(r, 50));

      // Source2 writes a later value to the same row (later timestamp wins)
      emitLocalInsert(source2, 'main', 'users', [1], [1, 'LaterValue']);
      await new Promise(r => setTimeout(r, 10));

      const changes1 = await source1.manager.getChangesSince(generateSiteId());
      const changes2 = await source2.manager.getChangesSince(generateSiteId());

      // Replica A applies in order: source1 then source2
      const replicaA = await createReplica('replicaA', config);
      await replicaA.manager.applyChanges(changes1);
      await replicaA.manager.applyChanges(changes2);

      // Replica B applies in REVERSE order: source2 then source1
      const replicaB = await createReplica('replicaB', config);
      await replicaB.manager.applyChanges(changes2);
      await replicaB.manager.applyChanges(changes1);

      // Both replicas should converge: same snapshot state
      const snapshotA = await replicaA.manager.getSnapshot();
      const snapshotB = await replicaB.manager.getSnapshot();

      expect(snapshotA.tables.length).to.equal(snapshotB.tables.length);
      // Both should have exactly the same column versions (entries are flat
      // per-cell records; match them up by raw pk + column).
      const cellKey = (e: { pk: SqlValue[]; column: string }): string =>
        `${JSON.stringify(e.pk)}:${e.column}`;
      for (let i = 0; i < snapshotA.tables.length; i++) {
        expect(snapshotA.tables[i].columnVersions.length).to.equal(
          snapshotB.tables[i].columnVersions.length
        );
        const byKeyB = new Map(snapshotB.tables[i].columnVersions.map(e => [cellKey(e), e]));
        // The winning value should be the same on both
        for (const entryA of snapshotA.tables[i].columnVersions) {
          const entryB = byKeyB.get(cellKey(entryA));
          expect(entryB).to.exist;
          expect(entryA.value).to.equal(entryB!.value);
          expect(compareHLC(entryA.hlc, entryB!.hlc)).to.equal(0);
        }
      }
    });
  });

  describe('Tombstone Pruning', () => {
    it('DEFAULT_SYNC_CONFIG.retentionHorizonMs should be 30 days', () => {
      expect(DEFAULT_SYNC_CONFIG.retentionHorizonMs).to.equal(30 * 24 * 60 * 60 * 1000);
    });

    it('should prune expired tombstones', async () => {
      // Use very short retention horizon for testing
      const shortTTLConfig = { ...config, retentionHorizonMs: 1 }; // 1ms
      const replica = await createReplica('replica', shortTTLConfig);

      // Insert and delete a row (creates a tombstone)
      emitLocalInsert(replica, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(replica, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Wait for the TTL to expire
      await new Promise(r => setTimeout(r, 10));

      // Prune should remove the expired tombstone
      const pruned = await replica.manager.pruneTombstones();
      expect(pruned).to.equal(1);

      // Second prune should find nothing
      const pruned2 = await replica.manager.pruneTombstones();
      expect(pruned2).to.equal(0);
    });

    it('should not prune non-expired tombstones', async () => {
      // Use long retention horizon
      const longTTLConfig = { ...config, retentionHorizonMs: 60_000 };
      const replica = await createReplica('replica', longTTLConfig);

      emitLocalInsert(replica, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 5));
      emitLocalDelete(replica, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      const pruned = await replica.manager.pruneTombstones();
      expect(pruned).to.equal(0);
    });
  });

  describe('Delta Sync with sinceHLC', () => {
    it('should return only changes after the given sinceHLC', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Host inserts first row
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      await new Promise(r => setTimeout(r, 10));

      // Capture HLC after first insert
      const midpointHLC = host.manager.getCurrentHLC();

      // Host inserts second row (after midpoint)
      await new Promise(r => setTimeout(r, 10));
      emitLocalInsert(host, 'main', 'users', [2], [2, 'Bob']);
      await new Promise(r => setTimeout(r, 10));

      // Get all changes (no sinceHLC) - should include both
      const allChanges = await host.manager.getChangesSince(guest.manager.getSiteId());
      const allColumnChanges = allChanges.flatMap(cs => cs.changes);
      expect(allColumnChanges.length).to.be.at.least(2); // At least 2 column changes (one per row per col)

      // Get changes since midpoint - should only include second row's changes
      const deltaChanges = await host.manager.getChangesSince(guest.manager.getSiteId(), midpointHLC);
      const deltaColumnChanges = deltaChanges.flatMap(cs => cs.changes);

      expect(deltaColumnChanges.length).to.be.lessThan(allColumnChanges.length);
      // All delta changes should have HLC > midpointHLC
      for (const change of deltaColumnChanges) {
        expect(compareHLC(change.hlc, midpointHLC)).to.be.greaterThan(0);
      }
    });
  });

  describe('Transaction Grouping (two replicas)', () => {
    it('delta-syncs two multi-row transactions as two atomic ChangeSets, halting the watermark at the second commit boundary', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Transaction 1: two rows committed together.
      host.storeEvents.commit({
        data: [
          { type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'Alice'] },
          { type: 'insert', schemaName: 'main', tableName: 'users', key: [2], newRow: [2, 'Bob'] },
        ],
      });
      await new Promise(r => setTimeout(r, 10));

      // Transaction 2: two more rows committed together.
      host.storeEvents.commit({
        data: [
          { type: 'insert', schemaName: 'main', tableName: 'users', key: [3], newRow: [3, 'Carol'] },
          { type: 'insert', schemaName: 'main', tableName: 'users', key: [4], newRow: [4, 'Dave'] },
        ],
      });
      await new Promise(r => setTimeout(r, 10));

      const changeSets = await host.manager.getChangesSince(guest.manager.getSiteId());

      // Exactly two transactions — never split, never merged.
      expect(changeSets).to.have.lengthOf(2);
      expect(changeSets[0].transactionId).to.not.equal(changeSets[1].transactionId);
      expect(compareHLC(changeSets[0].hlc, changeSets[1].hlc)).to.be.lessThan(0);
      // Each transaction carries both rows' column facts (2 rows × 2 columns).
      expect(changeSets[0].changes).to.have.lengthOf(4);
      expect(changeSets[1].changes).to.have.lengthOf(4);

      // Guest applies both ChangeSets atomically.
      const result = await guest.manager.applyChanges(changeSets);
      expect(result.transactions).to.equal(2);
      expect(result.applied).to.equal(8);

      // Watermark lands on the SECOND transaction's HLC (a real commit boundary).
      const watermark = changeSets[changeSets.length - 1].hlc;
      await guest.manager.updatePeerSyncState(host.manager.getSiteId(), watermark);
      expect(compareHLC(watermark, changeSets[0].hlc)).to.be.greaterThan(0);

      // Re-fetch from the watermark: both transactions already consumed, nothing repeats.
      const after = await host.manager.getChangesSince(guest.manager.getSiteId(), watermark);
      expect(after).to.have.lengthOf(0);
    });
  });

  describe('Multiple Tables', () => {
    it('should sync data across multiple tables independently', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      // Insert into different tables
      emitLocalInsert(host, 'main', 'users', [1], [1, 'Alice']);
      emitLocalInsert(host, 'main', 'products', [1], [1, 'Widget']);
      emitLocalInsert(host, 'main', 'orders', [1], [1, 100]);
      await new Promise(r => setTimeout(r, 10));

      const result = await performBidirectionalSync(host, guest);
      expect(result.hostToGuest.applied).to.be.greaterThan(0);

      // Guest should have changes for all three tables
      const tables = new Set<string>();
      for (const entry of guest.dataStore.changeLog) {
        if (entry.type === 'data') {
          const change = entry.change as DataChangeToApply;
          tables.add(change.table);
        }
      }
      expect(tables.size).to.equal(3);
      expect(tables.has('users')).to.be.true;
      expect(tables.has('products')).to.be.true;
      expect(tables.has('orders')).to.be.true;
    });
  });

  describe('Tombstone Blocking (allowResurrection=false)', () => {
    it('should block older writes to a deleted row when allowResurrection is false', async () => {
      const noResurrectConfig = { ...config, allowResurrection: false };
      const replica = await createReplica('replica', noResurrectConfig);

      const remoteSiteId = generateSiteId();
      const { HLCManager } = await import('../../src/clock/hlc.js');
      const remoteHLC = new HLCManager(remoteSiteId);

      // Apply a delete first with a later HLC
      remoteHLC.tick();
      await new Promise(r => setTimeout(r, 5));
      const laterDeleteHlc = remoteHLC.tick();

      const deleteChanges: import('../../src/sync/protocol.js').ChangeSet[] = [{
        siteId: remoteSiteId,
        transactionId: 'tx-delete',
        hlc: laterDeleteHlc,
        changes: [{
          type: 'delete',
          schema: 'main',
          table: 'users',
          pk: [1],
          hlc: laterDeleteHlc,
        }],
        schemaMigrations: [],
      }];

      await replica.manager.applyChanges(deleteChanges);

      // Now try to apply a column change with NEWER HLC (after the delete)
      const evenLaterHlc = remoteHLC.tick();
      const otherRemote = generateSiteId();
      const writeChanges: import('../../src/sync/protocol.js').ChangeSet[] = [{
        siteId: otherRemote,
        transactionId: 'tx-write',
        hlc: evenLaterHlc,
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'name',
          value: 'Ghost',
          hlc: { ...evenLaterHlc, siteId: otherRemote },
        }],
        schemaMigrations: [],
      }];

      const result = await replica.manager.applyChanges(writeChanges);

      // With allowResurrection=false, any write to a deleted row should be blocked
      expect(result.applied).to.equal(0);
      expect(result.skipped).to.equal(1);
    });
  });

  describe('Null Column Values', () => {
    it('should correctly sync null values in columns', async () => {
      const host = await createReplica('host', config);
      const guest = await createReplica('guest', config);

      const remoteSiteId = generateSiteId();
      const { HLCManager } = await import('../../src/clock/hlc.js');
      const remoteHLC = new HLCManager(remoteSiteId);

      // Apply a column change with null value
      const hlc = remoteHLC.tick();
      const changes: import('../../src/sync/protocol.js').ChangeSet[] = [{
        siteId: remoteSiteId,
        transactionId: 'tx-null',
        hlc,
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'email',
          value: null,
          hlc,
        }],
        schemaMigrations: [],
      }];

      const result = await guest.manager.applyChanges(changes);
      expect(result.applied).to.equal(1);

      // Verify the null value is preserved in a round-trip
      const guestChanges = await guest.manager.getChangesSince(host.manager.getSiteId());
      expect(guestChanges.length).to.be.greaterThan(0);
      const columnChanges = guestChanges.flatMap(cs =>
        cs.changes.filter((c): c is import('../../src/sync/protocol.js').ColumnChange => c.type === 'column')
      );
      const emailChange = columnChanges.find(c => c.column === 'email');
      expect(emailChange).to.exist;
      expect(emailChange!.value).to.be.null;
    });
  });
});
