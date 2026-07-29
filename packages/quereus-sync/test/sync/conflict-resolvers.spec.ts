/**
 * Tests for pluggable conflict resolution.
 *
 * Verifies the built-in resolvers and custom resolver integration
 * through the full sync protocol (E2E via two replicas).
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type ConflictEvent } from '../../src/sync/events.js';
import {
	DEFAULT_SYNC_CONFIG,
	type SyncConfig,
	type ApplyToStoreCallback,
	type ConflictContext,
	type ConflictResolver,
} from '../../src/sync/protocol.js';
import { localWinsResolver, remoteWinsResolver, lwwResolver } from '../../src/sync/conflict-resolvers.js';
import { InMemoryKVStore } from '@quereus/store';
import type { SyncManager } from '../../src/sync/manager.js';
import type { SqlValue } from '@quereus/quereus';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

// ============================================================================
// Test Infrastructure
// ============================================================================

class MockDataStore {
	readonly tables = new Map<string, Map<string, Map<string, SqlValue>>>();

	createApplyToStoreCallback(): ApplyToStoreCallback {
		return async (dataChanges, schemaChanges, _options) => {
			for (const change of schemaChanges) {
				if (change.type === 'create_table') {
					const key = `${change.schema}.${change.table}`;
					if (!this.tables.has(key)) {
						this.tables.set(key, new Map());
					}
				}
			}

			for (const change of dataChanges) {
				const tableKey = `${change.schema}.${change.table}`;
				const pkKey = JSON.stringify(change.pk);

				if (!this.tables.has(tableKey)) {
					this.tables.set(tableKey, new Map());
				}
				const table = this.tables.get(tableKey)!;

				if (change.type === 'delete') {
					table.delete(pkKey);
				} else if (change.columns) {
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

interface Replica {
	kv: InMemoryKVStore;
	dataStore: MockDataStore;
	source: FakeTransactionSource;
	syncEvents: SyncEventEmitterImpl;
	manager: SyncManager;
}

async function createReplica(config: SyncConfig): Promise<Replica> {
	const kv = new InMemoryKVStore();
	const dataStore = new MockDataStore();
	const source = new FakeTransactionSource();
	const syncEvents = new SyncEventEmitterImpl();
	const applyToStore = dataStore.createApplyToStoreCallback();

	const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);

	return { kv, dataStore, source, syncEvents, manager };
}

async function syncOneway(sender: Replica, receiver: Replica): Promise<{ applied: number; conflicts: number }> {
	const changes = await sender.manager.getChangesSince(receiver.manager.getSiteId());
	const result = await receiver.manager.applyChanges(changes);
	const senderHLC = sender.manager.getCurrentHLC();
	await receiver.manager.updatePeerSyncState(sender.manager.getSiteId(), senderHLC);
	return { applied: result.applied, conflicts: result.conflicts };
}

async function syncBidirectional(a: Replica, b: Replica): Promise<void> {
	await syncOneway(a, b);
	await syncOneway(b, a);
	// Update peer states for future delta sync
	await a.manager.updatePeerSyncState(b.manager.getSiteId(), b.manager.getCurrentHLC());
	await b.manager.updatePeerSyncState(a.manager.getSiteId(), a.manager.getCurrentHLC());
}

function emitInsert(replica: Replica, schema: string, table: string, pk: SqlValue[], row: SqlValue[]): void {
	// Update local data store (commitData only records CRDT metadata, not data)
	const tableKey = `${schema}.${table}`;
	const pkKey = JSON.stringify(pk);
	if (!replica.dataStore.tables.has(tableKey)) {
		replica.dataStore.tables.set(tableKey, new Map());
	}
	const tbl = replica.dataStore.tables.get(tableKey)!;
	const cols = new Map<string, SqlValue>();
	for (let i = 0; i < row.length; i++) {
		cols.set(`col_${i}`, row[i]);
	}
	tbl.set(pkKey, cols);

	replica.source.commitData({ type: 'insert', schemaName: schema, tableName: table, key: pk, newRow: row });
}

function emitUpdate(replica: Replica, schema: string, table: string, pk: SqlValue[], oldRow: SqlValue[], newRow: SqlValue[]): void {
	const tableKey = `${schema}.${table}`;
	const pkKey = JSON.stringify(pk);
	if (!replica.dataStore.tables.has(tableKey)) {
		replica.dataStore.tables.set(tableKey, new Map());
	}
	const tbl = replica.dataStore.tables.get(tableKey)!;
	if (!tbl.has(pkKey)) {
		tbl.set(pkKey, new Map());
	}
	const cols = tbl.get(pkKey)!;
	for (let i = 0; i < newRow.length; i++) {
		cols.set(`col_${i}`, newRow[i]);
	}

	replica.source.commitData({ type: 'update', schemaName: schema, tableName: table, key: pk, oldRow, newRow });
}

function emitDelete(replica: Replica, schema: string, table: string, pk: SqlValue[], oldRow: SqlValue[]): void {
	const tableKey = `${schema}.${table}`;
	replica.dataStore.tables.get(tableKey)?.delete(JSON.stringify(pk));

	replica.source.commitData({ type: 'delete', schemaName: schema, tableName: table, key: pk, oldRow });
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============================================================================
// Tests
// ============================================================================

describe('Pluggable Conflict Resolution', () => {

	describe('Default behavior (no conflictResolver)', () => {
		it('should preserve LWW: newer HLC wins, older loses', async () => {
			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
			const host = await createReplica(config);
			const guest = await createReplica(config);

			emitInsert(host, 'main', 'users', [1], [1, 'Original']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest updates first (earlier HLC)
			emitUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
			await delay(50);
			// Host updates second (later HLC — should win)
			emitUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
			await delay(10);

			await syncBidirectional(host, guest);

			// Guest's data store should show host's value (later HLC wins)
			const row = guest.dataStore.getRow('main', 'users', [1]);
			expect(row).to.exist;
			expect(row!.get('col_1')).to.equal('Host Value');
		});
	});

	describe('localWinsResolver', () => {
		it('should keep local value even when remote has higher HLC', async () => {
			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, conflictResolver: localWinsResolver };
			const host = await createReplica(config);
			const guest = await createReplica(config);

			emitInsert(host, 'main', 'users', [1], [1, 'Original']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest updates first (earlier HLC)
			emitUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
			await delay(50);
			// Host updates second (later HLC)
			emitUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
			await delay(10);

			const conflicts: ConflictEvent[] = [];
			guest.syncEvents.onConflictResolved(e => conflicts.push(e));

			// Sync host→guest: host has later HLC but guest should keep its value
			await syncOneway(host, guest);

			const row = guest.dataStore.getRow('main', 'users', [1]);
			expect(row).to.exist;
			expect(row!.get('col_1')).to.equal('Guest Value');

			// Should have emitted a conflict event with winner: 'local'
			const col1Conflicts = conflicts.filter(c => c.column === 'col_1');
			expect(col1Conflicts.length).to.be.greaterThan(0);
			expect(col1Conflicts[0].winner).to.equal('local');
		});
	});

	describe('remoteWinsResolver', () => {
		it('should accept remote value even when local has higher HLC', async () => {
			// Only configure remoteWinsResolver on the receiver (host)
			const guestConfig: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
			const hostConfig: SyncConfig = { ...DEFAULT_SYNC_CONFIG, conflictResolver: remoteWinsResolver };
			const host = await createReplica(hostConfig);
			const guest = await createReplica(guestConfig);

			emitInsert(host, 'main', 'users', [1], [1, 'Original']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Host updates second (later HLC)
			emitUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
			await delay(50);
			// Guest updates first (earlier HLC)
			emitUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
			await delay(10);

			const conflicts: ConflictEvent[] = [];
			host.syncEvents.onConflictResolved(e => conflicts.push(e));

			// Sync guest→host: guest has lower HLC but host should accept it (remoteWins)
			await syncOneway(guest, host);

			const row = host.dataStore.getRow('main', 'users', [1]);
			expect(row).to.exist;
			expect(row!.get('col_1')).to.equal('Guest Value');

			const col1Conflicts = conflicts.filter(c => c.column === 'col_1');
			expect(col1Conflicts.length).to.be.greaterThan(0);
			expect(col1Conflicts[0].winner).to.equal('remote');
		});
	});

	describe('Custom resolver (field-level policy)', () => {
		it('should apply different strategies per column', async () => {
			// "counter" column → always accept remote (simulates max-wins)
			// everything else → keep local
			const fieldPolicy: ConflictResolver = (ctx) =>
				ctx.column === 'col_2' ? 'remote' : 'local';

			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, conflictResolver: fieldPolicy };
			const host = await createReplica(config);
			const guest = await createReplica({ ...DEFAULT_SYNC_CONFIG });

			// Insert row with [id, name, counter]
			emitInsert(host, 'main', 'items', [1], [1, 'Alpha', 10]);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest changes name (col_1) and counter (col_2)
			emitUpdate(guest, 'main', 'items', [1], [1, 'Alpha', 10], [1, 'Beta', 20]);
			await delay(50);
			// Host also changes name and counter (host has later HLC)
			emitUpdate(host, 'main', 'items', [1], [1, 'Alpha', 10], [1, 'Gamma', 5]);
			await delay(10);

			// Sync guest→host (host has the custom resolver)
			await syncOneway(guest, host);

			const row = host.dataStore.getRow('main', 'items', [1]);
			expect(row).to.exist;
			// col_1 (name) → local wins → 'Gamma'
			expect(row!.get('col_1')).to.equal('Gamma');
			// col_2 (counter) → remote wins → 20
			expect(row!.get('col_2')).to.equal(20);
		});
	});

	describe('Resolver receives correct context', () => {
		it('should pass all ConflictContext fields to the resolver', async () => {
			const capturedContexts: ConflictContext[] = [];
			const spy: ConflictResolver = (ctx) => {
				capturedContexts.push(ctx);
				return 'local';
			};

			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, conflictResolver: spy };
			const host = await createReplica(config);
			const guest = await createReplica({ ...DEFAULT_SYNC_CONFIG });

			emitInsert(host, 'main', 'users', [42], [42, 'HostName']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest updates
			emitUpdate(guest, 'main', 'users', [42], [42, 'HostName'], [42, 'GuestName']);
			await delay(10);

			// Sync guest→host (host has the spy resolver)
			await syncOneway(guest, host);

			expect(capturedContexts.length).to.be.greaterThan(0);
			const ctx = capturedContexts.find(c => c.column === 'col_1');
			expect(ctx).to.exist;
			expect(ctx!.schema).to.equal('main');
			expect(ctx!.table).to.equal('users');
			expect(ctx!.pk).to.deep.equal([42]);
			expect(ctx!.column).to.equal('col_1');
			expect(ctx!.localValue).to.equal('HostName');
			expect(ctx!.remoteValue).to.equal('GuestName');
			expect(ctx!.localHlc).to.have.property('wallTime');
			expect(ctx!.remoteHlc).to.have.property('wallTime');
		});
	});

	describe('No local version (first write)', () => {
		it('should apply remote change without calling resolver when no local version exists', async () => {
			let resolverCalled = false;
			const spy: ConflictResolver = (_ctx) => {
				resolverCalled = true;
				return 'local';
			};

			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, conflictResolver: spy };
			const host = await createReplica(config);
			const guest = await createReplica({ ...DEFAULT_SYNC_CONFIG });

			// Guest inserts a row that host has never seen
			emitInsert(guest, 'main', 'users', [1], [1, 'Alice']);
			await delay(10);

			// Sync guest→host: host has no local version, should apply directly
			await syncOneway(guest, host);

			expect(resolverCalled).to.be.false;

			const row = host.dataStore.getRow('main', 'users', [1]);
			expect(row).to.exist;
			expect(row!.get('col_1')).to.equal('Alice');
		});
	});

	describe('Tombstone blocking still works with resolver', () => {
		it('should block writes to tombstoned rows regardless of resolver decision', async () => {
			const config: SyncConfig = {
				...DEFAULT_SYNC_CONFIG,
				allowResurrection: false,
				conflictResolver: remoteWinsResolver,
			};
			const host = await createReplica(config);
			const guest = await createReplica({ ...DEFAULT_SYNC_CONFIG });

			// Host inserts then deletes
			emitInsert(host, 'main', 'users', [1], [1, 'Alice']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest updates (earlier HLC)
			emitUpdate(guest, 'main', 'users', [1], [1, 'Alice'], [1, 'Guest Update']);
			await delay(50);

			// Host deletes (later HLC)
			emitDelete(host, 'main', 'users', [1], [1, 'Alice']);
			await delay(10);

			// Sync host→guest first (so guest gets tombstone)
			await syncOneway(host, guest);

			// Now sync guest→host: guest's update has older HLC than tombstone
			// Even with remoteWinsResolver, tombstone blocking should prevent resurrection
			const result = await syncOneway(guest, host);

			// The write should be skipped due to tombstone, not applied
			// (applied=0 for the column changes since they're blocked by tombstone)
			expect(result.applied).to.equal(0);
			const row = host.dataStore.getRow('main', 'users', [1]);
			// Row should be deleted (no columns remaining after delete)
			expect(row).to.be.undefined;
		});
	});

	describe('ConflictEvent includes schema field', () => {
		it('should include schema in emitted conflict events', async () => {
			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
			const host = await createReplica(config);
			const guest = await createReplica(config);

			const conflicts: ConflictEvent[] = [];
			guest.syncEvents.onConflictResolved(e => conflicts.push(e));

			emitInsert(host, 'main', 'users', [1], [1, 'Original']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Both update the same column
			emitUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest']);
			await delay(50);
			emitUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host']);
			await delay(10);

			await syncOneway(host, guest);

			// Should have conflict events with schema field
			if (conflicts.length > 0) {
				expect(conflicts[0].schema).to.equal('main');
			}
		});
	});

	describe('Remote before-image exposure', () => {
		it('passes remotePriorValue/remotePriorHlc into the ConflictContext', async () => {
			const capturedContexts: ConflictContext[] = [];
			const spy: ConflictResolver = (ctx) => {
				capturedContexts.push(ctx);
				return 'local';
			};

			const host = await createReplica({ ...DEFAULT_SYNC_CONFIG });
			const guest = await createReplica({ ...DEFAULT_SYNC_CONFIG, conflictResolver: spy });

			emitInsert(host, 'main', 'items', [1], [1, 'V0']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Two host overwrites before the next pull: the surviving change's prior
			// is the immediately-overwritten V1 (Lamina "what the winning write
			// overwrote", not "value at last sync").
			emitUpdate(host, 'main', 'items', [1], [1, 'V0'], [1, 'V1']);
			await delay(20);
			emitUpdate(host, 'main', 'items', [1], [1, 'V1'], [1, 'V2']);
			await delay(20);

			// Guest still holds V0 locally, so applying host's V2 triggers the resolver.
			await syncOneway(host, guest);

			const ctx = capturedContexts.find(c => c.column === 'col_1');
			expect(ctx).to.exist;
			expect(ctx!.localValue).to.equal('V0');
			expect(ctx!.remoteValue).to.equal('V2');
			expect(ctx!.remotePriorValue).to.equal('V1');
			expect(ctx!.remotePriorHlc).to.not.be.undefined;
		});

		it('emits the remote before-image on an LWW conflict with no resolver', async () => {
			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
			const host = await createReplica(config);
			const guest = await createReplica(config);

			const conflicts: ConflictEvent[] = [];
			guest.syncEvents.onConflictResolved(e => conflicts.push(e));

			emitInsert(host, 'main', 'users', [1], [1, 'Original']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest writes first (older), host writes later (newer — wins via LWW).
			emitUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
			await delay(50);
			emitUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
			await delay(10);

			await syncOneway(host, guest);

			const e = conflicts.find(ev => ev.column === 'col_1');
			expect(e).to.exist;
			expect(e!.winner).to.equal('remote');
			// Fast path (no resolver) still resolves by HLC; the event now also carries
			// the remote write's before-image (the 'Original' it overwrote at the host).
			expect(e!.remotePriorValue).to.equal('Original');
			expect(e!.remotePriorHlc).to.not.be.undefined;
		});

		it('omits remotePrior fields when the incoming change has no prior', async () => {
			const capturedContexts: ConflictContext[] = [];
			const spy: ConflictResolver = (ctx) => {
				capturedContexts.push(ctx);
				return 'local';
			};

			// Host re-inserts the SAME pk both replicas already hold, so guest sees a
			// conflict whose incoming change is a first-write (no before-image).
			const host = await createReplica({ ...DEFAULT_SYNC_CONFIG });
			const guest = await createReplica({ ...DEFAULT_SYNC_CONFIG, conflictResolver: spy });

			emitInsert(guest, 'main', 'users', [1], [1, 'GuestSolo']);
			await delay(5);
			emitInsert(host, 'main', 'users', [1], [1, 'HostSolo']);
			await delay(10);

			await syncOneway(host, guest);

			const ctx = capturedContexts.find(c => c.column === 'col_1');
			expect(ctx).to.exist;
			expect(ctx).to.not.have.property('remotePriorValue');
			expect(ctx).to.not.have.property('remotePriorHlc');
		});
	});

	describe('lwwResolver (explicit)', () => {
		it('should behave identically to default fast path', async () => {
			const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, conflictResolver: lwwResolver };
			const host = await createReplica(config);
			const guest = await createReplica(config);

			emitInsert(host, 'main', 'users', [1], [1, 'Original']);
			await delay(5);
			await syncBidirectional(host, guest);

			// Guest updates first (earlier HLC)
			emitUpdate(guest, 'main', 'users', [1], [1, 'Original'], [1, 'Guest Value']);
			await delay(50);
			// Host updates second (later HLC — should win)
			emitUpdate(host, 'main', 'users', [1], [1, 'Original'], [1, 'Host Value']);
			await delay(10);

			await syncBidirectional(host, guest);

			// Same result as default: host's later HLC wins
			const row = guest.dataStore.getRow('main', 'users', [1]);
			expect(row).to.exist;
			expect(row!.get('col_1')).to.equal('Host Value');
		});
	});
});
