/**
 * Snapshot-bootstrap MV-maintenance deferral tests.
 *
 * A snapshot bootstrap is a known-complete wholesale load: every `applyToStore`
 * flush is a `bootstrap` flush (the adapter applies storage rows + remote module
 * events but SKIPS the engine seam — no per-flush MV maintenance, no per-row
 * watch capture), and a single `bootstrapFinalize` call at the end of the
 * transfer converges every MV via `Database.refreshAllMaterializedViews()` and
 * fires one coarse `Database.notifyExternalChange` per bootstrapped table.
 *
 * These tests pin: the seam is never called during the flushes, the convergence
 * runs exactly once, MV contents are correct afterward, base-table watchers see
 * one coarse invalidation, a failed bootstrap converges no MV and retries
 * cleanly, and a post-bootstrap incremental write maintains the MV normally.
 */

import { expect } from 'chai';
import { Database, type ChangeScope, type SqlValue, type WatchEvent } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter, type SyncStoreAdapterOptions } from '../../src/sync/store-adapter.js';
import type { ApplyToStoreCallback, ColumnVersionEntry, DataChangeToApply, Snapshot, SnapshotChunk } from '../../src/sync/protocol.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type SyncState } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG, SNAPSHOT_WIRE_FORMAT_VERSION } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { HLCManager, type HLC } from '../../src/clock/hlc.js';
import { createInMemoryProvider, collect, toStream } from './_peer-harness.js';

/** A whole-table `full` watch — fires on any change with empty hits. */
function fullWatch(table: string): ChangeScope {
	return {
		watches: [{
			table: { schema: 'main', table },
			columns: 'all',
			scope: { kind: 'full' },
		}],
		nonDeterministicSources: [],
		unboundParameters: [],
	};
}

const upd = (table: string, pk: SqlValue[], columns: Record<string, SqlValue>): DataChangeToApply =>
	({ type: 'update', schema: 'main', table, pk, columns });

/**
 * A streamed column-version entry: only the raw pk travels — the receiver
 * derives its own pk identity from it, so post-bootstrap pk-based lookups land
 * on the receiver's own keys by construction.
 */
const cvEntry = (pk: SqlValue[], column: string, hlc: HLC, value: SqlValue): ColumnVersionEntry =>
	({ column, hlc, value, pk });


/** Counters for the three engine entry points the bootstrap path drives. */
interface Spies {
	seamCalls: number;
	refreshCalls: number;
	notified: Array<{ table: string; schema?: string }>;
}

/** Wrap the spied methods on the live `db` instance the adapter closes over. */
function installSpies(db: Database): Spies {
	const spies: Spies = { seamCalls: 0, refreshCalls: 0, notified: [] };

	const origIngest = db.ingestExternalRowChanges.bind(db);
	db.ingestExternalRowChanges = (changes, options) => {
		spies.seamCalls++;
		return origIngest(changes, options);
	};

	const origRefresh = db.refreshAllMaterializedViews.bind(db);
	db.refreshAllMaterializedViews = () => {
		spies.refreshCalls++;
		return origRefresh();
	};

	const origNotify = db.notifyExternalChange.bind(db);
	db.notifyExternalChange = (table, schema) => {
		spies.notified.push({ table, schema });
		return origNotify(table, schema);
	};

	return spies;
}

/** The full-rebuild arm kind for a maintained table, read off the manager. */
function rowTimeKind(db: Database, mvKey: string): string | undefined {
	const mgr = (db as unknown as {
		materializedViewManager: { rowTime: Map<string, { kind: string }> };
	}).materializedViewManager;
	return mgr.rowTime.get(mvKey)?.kind;
}

function rowTimeHasPlan(db: Database, mvKey: string): boolean {
	const mgr = (db as unknown as {
		materializedViewManager: { rowTime: Map<string, unknown> };
	}).materializedViewManager;
	return mgr.rowTime.has(mvKey);
}

describe('snapshot bootstrap defers MV maintenance', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: StoreEventEmitter;
	let storeModule: StoreModule;
	let applyToStore: ApplyToStoreCallback;

	const makeAdapter = (overrides?: Partial<SyncStoreAdapterOptions>): ApplyToStoreCallback =>
		createStoreAdapter({ db, storeModule, events, ...overrides });

	const makeSyncManager = (kv: InMemoryKVStore, syncEvents: SyncEventEmitterImpl) =>
		SyncManagerImpl.create(
			kv, undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
			(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
		);

	beforeEach(() => {
		db = new Database();
		({ provider } = createInMemoryProvider());
		events = new StoreEventEmitter();
		storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		applyToStore = makeAdapter();
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('streamed bootstrap over a full-rebuild MV: seam skipped, one convergence, contents correct', async () => {
		await db.exec('create table t (id text primary key, v text) using store');
		// DISTINCT is a floor-only shape: maintained by full-rebuild — the arm that
		// would otherwise rebuild once per flush.
		await db.exec('create materialized view mv as select distinct v from t');
		expect(rowTimeKind(db, 'main.mv'), 'full-rebuild arm registered').to.equal('full-rebuild');

		const spies = installSpies(db);
		const syncManager = await makeSyncManager(new InMemoryKVStore(), new SyncEventEmitterImpl());

		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const headerHLC = remoteHLC.tick();
		const ROWS = 150; // > DATA_FLUSH_SIZE (100) → multiple bootstrap flushes
		const entries: ColumnVersionEntry[] = [];
		for (let i = 0; i < ROWS; i++) {
			entries.push(cvEntry([`r${i}`], 'v', remoteHLC.tick(), `val${i % 3}`));
		}
		const snapshotId = 'snap-bootstrap-1';
		const chunks: SnapshotChunk[] = [
			{ type: 'header', siteId: remoteSiteId, hlc: headerHLC, snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 1, migrationCount: 0, snapshotId },
			{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: ROWS },
			{ type: 'column-versions', schema: 'main', table: 't', entries },
			{ type: 'table-end', schema: 'main', table: 't', entriesWritten: ROWS },
			{ type: 'footer', snapshotId, totalTables: 1, totalEntries: ROWS, totalMigrations: 0 },
		];

		await syncManager.applySnapshotStream(toStream(chunks));

		expect(spies.seamCalls, 'seam skipped across every bootstrap flush').to.equal(0);
		expect(spies.refreshCalls, 'converged exactly once at finalize').to.equal(1);
		expect(Number((await collect(db, 'select count(*) as n from t'))[0].n)).to.equal(ROWS);
		expect(await collect(db, 'select v from mv order by v'))
			.to.deep.equal([{ v: 'val0' }, { v: 'val1' }, { v: 'val2' }]);
	});

	it('non-streamed applySnapshot bootstraps: seam skipped, one convergence, contents correct', async () => {
		await db.exec('create table t (id text primary key, v text) using store');
		await db.exec('create materialized view mv as select distinct v from t');

		const spies = installSpies(db);
		const syncManager = await makeSyncManager(new InMemoryKVStore(), new SyncEventEmitterImpl());

		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const columnVersions: ColumnVersionEntry[] = [];
		for (let i = 0; i < 5; i++) {
			columnVersions.push(cvEntry([`r${i}`], 'v', remoteHLC.tick(), `val${i % 2}`));
		}
		const snapshot: Snapshot = {
			siteId: remoteSiteId,
			hlc: remoteHLC.tick(),
			snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
			tables: [{ schema: 'main', table: 't', rows: [], columnVersions }],
			schemaMigrations: [],
			tombstones: [],
		};

		await syncManager.applySnapshot(snapshot);

		expect(spies.seamCalls, 'seam skipped on the single bootstrap apply').to.equal(0);
		expect(spies.refreshCalls, 'converged exactly once at finalize').to.equal(1);
		expect(await collect(db, 'select v from mv order by v')).to.deep.equal([{ v: 'val0' }, { v: 'val1' }]);
	});

	it('a base-table watcher receives one coarse invalidation, not per-row capture', async () => {
		await db.exec('create table t (id text primary key, v text) using store');

		const spies = installSpies(db);
		const watchEvents: WatchEvent[] = [];
		const sub = db.watch(fullWatch('t'), e => { watchEvents.push(e); });

		const syncManager = await makeSyncManager(new InMemoryKVStore(), new SyncEventEmitterImpl());
		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const ROWS = 150; // would fire the full watch once per flush under per-row capture
		const entries: ColumnVersionEntry[] = [];
		for (let i = 0; i < ROWS; i++) entries.push(cvEntry([`r${i}`], 'v', remoteHLC.tick(), `v${i}`));
		const snapshotId = 'snap-watch-1';
		const chunks: SnapshotChunk[] = [
			{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 1, migrationCount: 0, snapshotId },
			{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: ROWS },
			{ type: 'column-versions', schema: 'main', table: 't', entries },
			{ type: 'table-end', schema: 'main', table: 't', entriesWritten: ROWS },
			{ type: 'footer', snapshotId, totalTables: 1, totalEntries: ROWS, totalMigrations: 0 },
		];

		await syncManager.applySnapshotStream(toStream(chunks));
		sub.unsubscribe();

		expect(spies.seamCalls, 'no per-row capture during bootstrap').to.equal(0);
		expect(watchEvents, 'exactly one coarse invalidation').to.have.length(1);
		expect(watchEvents[0].matched[0].hits, 'coarse: empty hits').to.deep.equal([]);
	});

	it('resumed snapshot: finalize converges all MVs and notifies all completed tables', async () => {
		await db.exec('create table tableA (id text primary key, v text) using store');
		await db.exec('create table tableB (id text primary key, v text) using store');
		await db.exec('create materialized view mvB as select distinct v from tableB');

		const spies = installSpies(db);
		const kv = new InMemoryKVStore();
		const syncManager = await makeSyncManager(kv, new SyncEventEmitterImpl());

		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const snapshotId = 'snap-resume-bootstrap-1';

		// Seed tableA as already-completed: a column version + a checkpoint listing it
		// (the sender skips it on resume and never re-emits its metadata).
		await syncManager.columnVersions.setColumnVersion('main', 'tableA', ['a1'], 'v', {
			hlc: remoteHLC.tick(),
			value: 'aval',
		});
		const checkpoint = {
			snapshotId,
			siteId: remoteSiteId,
			hlc: remoteHLC.tick(),
			lastTableIndex: 1,
			lastEntryIndex: 1,
			completedTables: ['main.tableA'],
			entriesProcessed: 1,
			createdAt: 0,
		};
		const ckptJson = JSON.stringify({
			...checkpoint,
			hlc: {
				wallTime: checkpoint.hlc.wallTime.toString(),
				counter: checkpoint.hlc.counter,
				siteId: Array.from(checkpoint.hlc.siteId),
				opSeq: checkpoint.hlc.opSeq,
			},
			siteId: Array.from(checkpoint.siteId),
		});
		await kv.put(new TextEncoder().encode(`sc:${snapshotId}`), new TextEncoder().encode(ckptJson));

		// Resumed stream: header (full table count) + tableB only + footer.
		const chunks: SnapshotChunk[] = [
			{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 2, migrationCount: 0, snapshotId },
			{ type: 'table-start', schema: 'main', table: 'tableB', estimatedEntries: 1 },
			{ type: 'column-versions', schema: 'main', table: 'tableB', entries: [cvEntry(['b1'], 'v', remoteHLC.tick(), 'bval')] },
			{ type: 'table-end', schema: 'main', table: 'tableB', entriesWritten: 1 },
			{ type: 'footer', snapshotId, totalTables: 2, totalEntries: 1, totalMigrations: 0 },
		];

		await syncManager.applySnapshotStream(toStream(chunks));

		expect(spies.refreshCalls, 'converged exactly once').to.equal(1);
		const notifiedTables = spies.notified.map(n => n.table);
		// completedTables = checkpoint's tableA (skipped) + re-streamed tableB.
		expect(notifiedTables, 'completed tableA coarse-notified').to.include('tableA');
		expect(notifiedTables, 'completed tableB coarse-notified').to.include('tableB');
		expect(notifiedTables, 'refreshed MV coarse-notified').to.include('mvB');
		expect(await collect(db, 'select v from mvB order by v')).to.deep.equal([{ v: 'bval' }]);
	});

	it('mid-bootstrap failure: no MV converged, snapshot retriable, retry succeeds', async () => {
		// Table `t` does not exist yet (and the snapshot carries no DDL for it) →
		// the receiver cannot resolve pk keying for its entries and aborts before
		// the footer's finalize. Same terminal outcome as the old data-flush
		// failure, hit earlier.
		const spies = installSpies(db);
		const kv = new InMemoryKVStore();
		const syncEvents = new SyncEventEmitterImpl();
		const states: SyncState[] = [];
		syncEvents.onSyncStateChange(s => states.push(s));
		const syncManager = await makeSyncManager(kv, syncEvents);

		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const snapshotId = 'snap-fail-1';
		const entries: ColumnVersionEntry[] = [];
		for (let i = 0; i < 3; i++) entries.push(cvEntry([`r${i}`], 'v', remoteHLC.tick(), `val${i % 2}`));
		const buildChunks = (): SnapshotChunk[] => [
			{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 1, migrationCount: 0, snapshotId },
			{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: 3 },
			{ type: 'column-versions', schema: 'main', table: 't', entries },
			{ type: 'table-end', schema: 'main', table: 't', entriesWritten: 3 },
			{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 3, totalMigrations: 0 },
		];

		let thrown: unknown;
		try {
			await syncManager.applySnapshotStream(toStream(buildChunks()));
		} catch (e) {
			thrown = e;
		}
		expect(String(thrown)).to.contain('No table schema for main.t');
		expect(spies.refreshCalls, 'no MV converged on a failed bootstrap').to.equal(0);
		expect(states.map(s => s.status), 'emitted status:error').to.include('error');
		expect(states.map(s => s.status), 'never reached synced').to.not.include('synced');

		// Retry: create the table + MV and re-apply the SAME snapshot → converges cleanly.
		await db.exec('create table t (id text primary key, v text) using store');
		await db.exec('create materialized view mv as select distinct v from t');
		await syncManager.applySnapshotStream(toStream(buildChunks()));

		expect(spies.seamCalls, 'retry still bootstraps (seam skipped)').to.equal(0);
		expect(spies.refreshCalls, 'retry converged once').to.equal(1);
		expect(await collect(db, 'select v from mv order by v')).to.deep.equal([{ v: 'val0' }, { v: 'val1' }]);
	});

	it('assertion-violating bootstrap succeeds — trust-the-origin (deliberate inverse of store-adapter-seam.spec.ts "assertion failure propagates")', async () => {
		// Bootstrap replaces (one origin's converged state, wholesale), whereas
		// incremental merges and must enforce. No assertion is evaluated at finalize.
		await db.exec('create table t (id text primary key, v integer) using store');
		await db.exec('create assertion non_negative check (not exists (select 1 from t where v < 0))');

		const spies = installSpies(db);
		const kv = new InMemoryKVStore();
		const syncEvents = new SyncEventEmitterImpl();
		const states: SyncState[] = [];
		syncEvents.onSyncStateChange(s => states.push(s));
		const syncManager = await makeSyncManager(kv, syncEvents);

		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const snapshotId = 'snap-assertion-trust-1';
		const chunks: SnapshotChunk[] = [
			{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 1, migrationCount: 0, snapshotId },
			{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: 1 },
			{ type: 'column-versions', schema: 'main', table: 't', entries: [cvEntry(['r1'], 'v', remoteHLC.tick(), -5)] },
			{ type: 'table-end', schema: 'main', table: 't', entriesWritten: 1 },
			{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 1, totalMigrations: 0 },
		];

		// Must not throw despite violating the assertion — bootstrap trusts the origin.
		await syncManager.applySnapshotStream(toStream(chunks));

		// Converged row is present with the violating value.
		expect(await collect(db, 'select v from t')).to.deep.equal([{ v: -5 }]);
		// Seam was never called — no assertion evaluation during bootstrap.
		expect(spies.seamCalls, 'seam skipped: no assertion evaluated during bootstrap').to.equal(0);
		// Finalize converged exactly once.
		expect(spies.refreshCalls, 'finalized exactly once').to.equal(1);
		// Snapshot checkpoint was cleared — success path.
		expect(await kv.get(new TextEncoder().encode(`sc:${snapshotId}`)), 'checkpoint cleared').to.be.undefined;
		// Sync state reached synced, never error.
		expect(states.map(s => s.status), 'reached synced').to.include('synced');
		expect(states.map(s => s.status), 'no error state').to.not.include('error');
	});

	it('post-bootstrap incremental write maintains the MV (seam runs; no stale row-time plan)', async () => {
		await db.exec('create table t (id text primary key, v text) using store');
		await db.exec('create materialized view mv as select distinct v from t');

		const spies = installSpies(db);
		const syncManager = await makeSyncManager(new InMemoryKVStore(), new SyncEventEmitterImpl());

		const remoteSiteId = generateSiteId();
		const remoteHLC = new HLCManager(remoteSiteId);
		const snapshotId = 'snap-incr-1';
		const chunks: SnapshotChunk[] = [
			{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 1, migrationCount: 0, snapshotId },
			{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: 2 },
			{
				type: 'column-versions', schema: 'main', table: 't',
				entries: [cvEntry(['r0'], 'v', remoteHLC.tick(), 'a'), cvEntry(['r1'], 'v', remoteHLC.tick(), 'b')],
			},
			{ type: 'table-end', schema: 'main', table: 't', entriesWritten: 2 },
			{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 2, totalMigrations: 0 },
		];
		await syncManager.applySnapshotStream(toStream(chunks));

		expect(spies.refreshCalls, 'bootstrap converged once').to.equal(1);
		expect(spies.seamCalls, 'bootstrap skipped the seam').to.equal(0);
		expect(await collect(db, 'select v from mv order by v')).to.deep.equal([{ v: 'a' }, { v: 'b' }]);

		// Finalize re-registered the row-time plan — present, not detached/stale.
		void expect(rowTimeHasPlan(db, 'main.mv'), 'row-time plan re-registered after finalize').to.be.true;

		// An incremental (non-bootstrap) write runs the seam normally and maintains the MV.
		const res = await applyToStore([upd('t', ['r2'], { v: 'c' })], [], { remote: true });
		expect(res.errors).to.have.length(0);
		expect(spies.seamCalls, 'incremental write ran the seam').to.equal(1);
		expect(await collect(db, 'select v from mv order by v')).to.deep.equal([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
	});

	// A whole-batch throw (e.g. a commit-time global-assertion failure over the
	// inbound batch) is distinct from the per-change `errors` shape: the adapter
	// throws outright rather than collecting failures. Before the unified admission
	// core, the snapshot/stream paths called `applyToStore` BARE, so such a throw
	// propagated WITHOUT the `status:'error'` emit the wire path produces. The
	// shared `applyDataToStore` seam now emits it exactly once on both paths.
	describe('whole-batch throw surfaces status:error (unified admission core)', () => {
		// applyToStore that throws outright on the data flush — independent of `db`.
		const throwingApply: ApplyToStoreCallback = async (data, _schema, options) => {
			// The bootstrapFinalize call carries no data — let it pass so the test
			// only exercises the data-apply seam, never reaching finalize anyway.
			if (options.bootstrapFinalize) return { dataChangesApplied: 0, schemaChangesApplied: 0, errors: [] };
			if (data.length === 0) return { dataChangesApplied: 0, schemaChangesApplied: 0, errors: [] };
			throw new Error('whole-batch boom');
		};

		const makeThrowingSyncManager = (kv: InMemoryKVStore, syncEvents: SyncEventEmitterImpl) =>
			SyncManagerImpl.create(
				kv, undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, throwingApply,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

		it('non-streamed applySnapshot whole-batch throw emits exactly one status:error, commits no metadata', async () => {
			const kv = new InMemoryKVStore();
			const syncEvents = new SyncEventEmitterImpl();
			const states: SyncState[] = [];
			syncEvents.onSyncStateChange(s => states.push(s));
			const syncManager = await makeThrowingSyncManager(kv, syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const columnVersions: ColumnVersionEntry[] = [cvEntry(['r1'], 'v', remoteHLC.tick(), 'x')];
			const snapshot: Snapshot = {
				siteId: remoteSiteId,
				hlc: remoteHLC.tick(),
				snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
				tables: [{ schema: 'main', table: 't', rows: [], columnVersions }],
				schemaMigrations: [],
				tombstones: [],
			};

			let thrown: unknown;
			try {
				await syncManager.applySnapshot(snapshot);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown), 'whole-batch throw propagates').to.contain('whole-batch boom');

			// Exactly one status:error, never synced (the wire-path invariant, now shared).
			expect(states.filter(s => s.status === 'error'), 'exactly one error event').to.have.length(1);
			expect(states.map(s => s.status), 'never reached synced').to.not.include('synced');

			// Throw fired before the clear/rewrite phase → no column-version metadata committed.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes), 'no CRDT metadata committed').to.have.length(0);
		});

		it('streamed applySnapshotStream whole-batch flush throw emits exactly one status:error, leaves checkpoint', async () => {
			// The table must exist locally so the receiver's pk-keying derivation
			// succeeds — this test's subject is the DATA FLUSH throw, which comes after.
			await db.exec('create table t (id text primary key, v text) using store');
			const kv = new InMemoryKVStore();
			const syncEvents = new SyncEventEmitterImpl();
			const states: SyncState[] = [];
			syncEvents.onSyncStateChange(s => states.push(s));
			const syncManager = await makeThrowingSyncManager(kv, syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-wholebatch-throw-1';
			const chunks: SnapshotChunk[] = [
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 1, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: 1 },
				{ type: 'column-versions', schema: 'main', table: 't', entries: [cvEntry(['r1'], 'v', remoteHLC.tick(), 'x')] },
				{ type: 'table-end', schema: 'main', table: 't', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 1, totalMigrations: 0 },
			];

			let thrown: unknown;
			try {
				await syncManager.applySnapshotStream(toStream(chunks));
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown), 'whole-batch flush throw propagates').to.contain('whole-batch boom');

			expect(states.filter(s => s.status === 'error'), 'exactly one error event').to.have.length(1);
			expect(states.map(s => s.status), 'never reached synced').to.not.include('synced');

			// The footer flush throws before `batch.write()` → the accumulated
			// column-version metadata is never committed (nothing to relay).
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes), 'no CRDT metadata committed').to.have.length(0);
		});
	});
});
