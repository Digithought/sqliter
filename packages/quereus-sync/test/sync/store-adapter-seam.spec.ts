/**
 * Integration tests for the store adapter's seam wiring: inbound sync changes
 * applied through `StoreTable.applyExternalRowChanges` (table-owned keying +
 * secondary-index maintenance) and reported through
 * `Database.ingestExternalRowChanges` (materialized-view maintenance,
 * `Database.watch` capture, opt-in parent-side FK actions).
 *
 * The headline gap this closes: a covering MV (or watch subscription) over a
 * synced table now converges on inbound apply — previously the adapter wrote
 * raw KV bytes and nothing downstream ever learned of the change.
 */

import { expect } from 'chai';
import { Database, type ChangeScope, type SqlValue, type TableSchema, type WatchEvent } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	buildFullScanBounds,
	type DataChangeEvent,
	type KVStoreProvider,
} from '@quereus/store';
import { createStoreAdapter, type SyncStoreAdapterOptions } from '../../src/sync/store-adapter.js';
import type { ApplyToStoreCallback, DataChangeToApply, Snapshot, SnapshotChunk } from '../../src/sync/protocol.js';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { encodeRawPkIdentity } from '../../src/metadata/keys.js';
import { SyncEventEmitterImpl, type SyncState, type UnknownTableEvent, type AssertionViolationEvent } from '../../src/sync/events.js';
import { DEFAULT_SYNC_CONFIG } from '../../src/sync/protocol.js';
import { generateSiteId } from '../../src/clock/site.js';
import { HLCManager } from '../../src/clock/hlc.js';
import { createInMemoryProvider, collect } from './_peer-harness.js';

/** Hand-built row-granular watch scope on a single-column-PK table. */
function rowsWatch(table: string, key: string, value: SqlValue): ChangeScope {
	return {
		watches: [{
			table: { schema: 'main', table },
			columns: new Set([key]),
			scope: { kind: 'rows', key: [key], values: [[value as never]] },
		}],
		nonDeterministicSources: [],
		unboundParameters: [],
	};
}

const upd = (table: string, pk: SqlValue[], columns: Record<string, SqlValue>): DataChangeToApply =>
	({ type: 'update', schema: 'main', table, pk, columns });
const del = (table: string, pk: SqlValue[]): DataChangeToApply =>
	({ type: 'delete', schema: 'main', table, pk });

describe('store-adapter seam integration', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let stores: Map<string, InMemoryKVStore>;
	let events: StoreEventEmitter;
	let storeModule: StoreModule;
	let applyToStore: ApplyToStoreCallback;

	const makeAdapter = (overrides?: Partial<SyncStoreAdapterOptions>): ApplyToStoreCallback =>
		createStoreAdapter({ db, storeModule, events, ...overrides });

	beforeEach(() => {
		db = new Database();
		({ provider, stores } = createInMemoryProvider());
		events = new StoreEventEmitter();
		storeModule = new StoreModule(provider, events);
		db.registerModule('store', storeModule);
		applyToStore = makeAdapter();
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	describe('covering MV convergence', () => {
		beforeEach(async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create materialized view mv as select id, v from t');
		});

		it('inbound insert / column-update / delete converge the MV', async () => {
			let res = await applyToStore([upd('t', ['x'], { v: 'a' })], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'a' }]);

			res = await applyToStore([upd('t', ['x'], { v: 'b' })], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'b' }]);

			res = await applyToStore([del('t', ['x'])], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([]);
		});

		it('an update for an absent row lands as a PK+nulls partial insert, MV included', async () => {
			// Column changes can arrive before the rest of the row (UPSERT
			// semantics); the seam sees a full-row insert (PK + nulls).
			await db.exec('create table wide (id text primary key, a text, b text) using store');
			await db.exec('create materialized view mv_wide as select id, a, b from wide');

			const res = await applyToStore([upd('wide', ['k'], { b: 'beta' })], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id, a, b from wide')).to.deep.equal([{ id: 'k', a: null, b: 'beta' }]);
			expect(await collect(db, 'select id, a, b from mv_wide')).to.deep.equal([{ id: 'k', a: null, b: 'beta' }]);
		});
	});

	describe('Database.watch capture', () => {
		it('fires row-granular hits post-apply', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			const watchEvents: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { watchEvents.push(e); });

			await applyToStore([upd('t', ['x'], { v: 'a' })], [], { remote: true });
			sub.unsubscribe();

			expect(watchEvents).to.have.length(1);
			expect(watchEvents[0].matched[0].hits).to.deep.equal([['x']]);
		});
	});

	describe('secondary-index maintenance', () => {
		it('inbound apply maintains the index; an indexed query returns the row', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create index t_v on t(v)');

			await applyToStore([upd('t', ['x'], { v: 'needle' })], [], { remote: true });

			// The table's own index store gained the entry (raw-KV writes used to skip it).
			let indexEntries = 0;
			for await (const _e of stores.get('main.t_idx_t_v')!.iterate(buildFullScanBounds())) indexEntries++;
			expect(indexEntries).to.equal(1);

			expect(await collect(db, `select id from t where v = 'needle'`)).to.deep.equal([{ id: 'x' }]);

			// Delete removes the entry again.
			await applyToStore([del('t', ['x'])], [], { remote: true });
			indexEntries = 0;
			for await (const _e of stores.get('main.t_idx_t_v')!.iterate(buildFullScanBounds())) indexEntries++;
			expect(indexEntries).to.equal(0);
		});
	});

	describe('no-op suppression', () => {
		it('value-identical upsert and absent delete emit no event and do no seam work', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create materialized view mv as select id, v from t');
			await applyToStore([upd('t', ['x'], { v: 'a' })], [], { remote: true });

			const dataEvents: DataChangeEvent[] = [];
			events.onDataChange(e => dataEvents.push(e));
			const watchEvents: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { watchEvents.push(e); });

			const res = await applyToStore([
				upd('t', ['x'], { v: 'a' }),   // value-identical → suppressed
				del('t', ['absent']),          // absent key → suppressed
			], [], { remote: true });
			sub.unsubscribe();

			expect(res.errors).to.have.length(0);
			expect(res.dataChangesApplied).to.equal(2);
			expect(dataEvents, 'no module events for suppressed no-ops').to.deep.equal([]);
			expect(watchEvents, 'no watch dispatch (empty seam batch)').to.have.length(0);
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'a' }]);
		});
	});

	describe('delete-wins row grouping', () => {
		it('a delete and updates for one row in one batch resolve to delete, either order', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec(`insert into t values ('x', 'local'), ('y', 'local')`);

			const res = await applyToStore([
				upd('t', ['x'], { v: 'remote' }),
				del('t', ['x']),
				del('t', ['y']),
				upd('t', ['y'], { v: 'remote' }),
			], [], { remote: true });

			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id from t')).to.deep.equal([]);
		});
	});

	describe('module-event emission (remote: true, effective images)', () => {
		it('insert/update/delete events carry remote, oldRow/newRow, and changedColumns', async () => {
			await db.exec('create table t (id text primary key, a text, b text) using store');

			const dataEvents: DataChangeEvent[] = [];
			events.onDataChange(e => dataEvents.push(e));

			await applyToStore([upd('t', ['x'], { a: '1', b: '2' })], [], { remote: true });
			await applyToStore([upd('t', ['x'], { b: '3' })], [], { remote: true });
			await applyToStore([del('t', ['x'])], [], { remote: true });

			expect(dataEvents).to.have.length(3);

			expect(dataEvents[0].type).to.equal('insert');
			expect(dataEvents[0].remote).to.equal(true);
			expect(dataEvents[0].key).to.deep.equal(['x']);
			expect(dataEvents[0].newRow).to.deep.equal(['x', '1', '2']);

			expect(dataEvents[1].type).to.equal('update');
			expect(dataEvents[1].remote).to.equal(true);
			expect(dataEvents[1].oldRow, 'accurate before-image').to.deep.equal(['x', '1', '2']);
			expect(dataEvents[1].newRow).to.deep.equal(['x', '1', '3']);
			expect(dataEvents[1].changedColumns, 'effective changed columns').to.deep.equal(['b']);

			expect(dataEvents[2].type).to.equal('delete');
			expect(dataEvents[2].remote).to.equal(true);
			expect(dataEvents[2].oldRow, 'delete carries the before-image now').to.deep.equal(['x', '1', '3']);
		});
	});

	describe('foreign-key actions opt-in', () => {
		beforeEach(async () => {
			await db.exec(`
				create table p (id text primary key) using store;
				create table c (id text primary key, pid text not null references p(id) on delete cascade) using store;
				insert into p values ('p1');
				insert into c values ('c1', 'p1');
			`);
		});

		it('default off: inbound parent delete leaves local children untouched', async () => {
			const res = await applyToStore([del('p', ['p1'])], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id from p')).to.deep.equal([]);
			expect(await collect(db, 'select id from c'), 'stream is assumed to carry origin cascades').to.deep.equal([{ id: 'c1' }]);
		});

		it('opted in: inbound parent delete cascades; cascaded child writes are LOCAL (no remote flag)', async () => {
			const fkApply = makeAdapter({ applyForeignKeyActions: true });

			const dataEvents: DataChangeEvent[] = [];
			events.onDataChange(e => dataEvents.push(e));

			const res = await fkApply([del('p', ['p1'])], [], { remote: true });
			expect(res.errors).to.have.length(0);
			expect(await collect(db, 'select id from p')).to.deep.equal([]);
			expect(await collect(db, 'select id from c'), 'children cascaded').to.deep.equal([]);

			// The adapter's own parent-delete event is remote; the cascade re-enters
			// the DML pipeline, so the child delete emits WITHOUT remote and is
			// recorded as a local change that propagates outward.
			const parentEvent = dataEvents.find(e => e.tableName === 'p' && e.type === 'delete');
			expect(parentEvent?.remote).to.equal(true);
			const childEvent = dataEvents.find(e => e.tableName === 'c' && e.type === 'delete');
			void expect(childEvent, 'cascaded child delete emitted a module event').to.exist;
			expect(childEvent!.remote ?? false).to.equal(false);
		});
	});

	describe('partial failure (unresolvable table mid-invocation)', () => {
		it('errors recorded per change; other tables still apply and reach the seam', async () => {
			await db.exec('create table t (id text primary key, v text) using store');
			await db.exec('create materialized view mv as select id, v from t');

			const res = await applyToStore([
				upd('t', ['x'], { v: 'a' }),
				upd('no_such_table', ['k'], { v: 'b' }),
			], [], { remote: true });

			expect(res.dataChangesApplied).to.equal(1);
			expect(res.errors).to.have.length(1);
			expect((res.errors[0].change as DataChangeToApply).table).to.equal('no_such_table');
			// The resolvable table's change applied AND drove the MV through the seam.
			expect(await collect(db, 'select id, v from mv')).to.deep.equal([{ id: 'x', v: 'a' }]);
		});
	});

	describe('inbound assertion violation: detect-and-notify through the sync layer', () => {
		// A local commit-time global assertion that an inbound merge trips is
		// DETECT-AND-NOTIFY: trust-the-origin means the data must land, so the seam
		// runs in report mode — the batch commits (base table, MV, and watch
		// converge on the FIRST attempt) and the violation surfaces to the host as
		// an `onAssertionViolation` event rather than throwing. No divergence, no
		// retry, no MV refresh needed.
		/** One remote single-column change set against `main.t`. */
		const remoteChangeSet = (remoteHLC: HLCManager, remoteSiteId: Uint8Array, value: SqlValue) => [{
			siteId: remoteSiteId,
			transactionId: 'tx1',
			hlc: remoteHLC.tick(),
			changes: [{
				type: 'column' as const,
				schema: 'main',
				table: 't',
				pk: ['x'],
				column: 'v',
				value,
				hlc: remoteHLC.tick(),
			}],
			schemaMigrations: [],
		}];

		it('converges base/MV/watch on the first apply and notifies the host; idempotent re-apply does not re-fire', async () => {
			await db.exec('create table t (id text primary key, v integer) using store');
			await db.exec('create materialized view mv as select id, v from t');
			await db.exec('create assertion non_negative check (not exists (select 1 from t where v < 0))');

			const syncEvents = new SyncEventEmitterImpl();
			const violations: AssertionViolationEvent[] = [];
			syncEvents.onAssertionViolation(e => violations.push(e));

			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			// Watch the violating row: it must fire on the converging apply (it did
			// not before, when the throw unwound the derived effects).
			const watchEvents: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { watchEvents.push(e); });

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const changeSets = remoteChangeSet(remoteHLC, remoteSiteId, -5);

			// First (and only) attempt: applyChanges RESOLVES — no throw — and the
			// change is applied.
			const result = await syncManager.applyChanges(changeSets);
			expect(result.applied).to.be.greaterThan(0);
			sub.unsubscribe();

			// The violating row landed in the base table (trust-the-origin)...
			expect((await collect(db, 'select v from t')).map(r => Number(r.v))).to.deep.equal([-5]);
			// ...and the covering MV converged with it on the FIRST attempt — the
			// regression the old throw-then-suppress chain left divergent.
			expect((await collect(db, 'select v from mv')).map(r => Number(r.v))).to.deep.equal([-5]);
			// The row-granular watch fired for the converging change.
			expect(watchEvents).to.have.length(1);
			expect(watchEvents[0].matched[0].hits).to.deep.equal([['x']]);

			// CRDT metadata committed on the first attempt: the change relays to a
			// third peer immediately — no second attempt required.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(1);

			// The host was notified exactly once, naming the violated assertion with
			// non-empty diagnostic samples.
			expect(violations).to.have.length(1);
			expect(violations[0].assertion).to.equal('non_negative');
			expect(violations[0].samples.length).to.be.greaterThan(0);

			// A second identical apply is a value-identical no-op (empty seam batch →
			// no assertion re-evaluation): no new violation event, no double-relay.
			await syncManager.applyChanges(changeSets);
			expect(violations, 'no re-fire on benign idempotent retry').to.have.length(1);
			const relayedAfter = await syncManager.getChangesSince(generateSiteId());
			expect(relayedAfter.flatMap(cs => cs.changes)).to.have.length(1);
		});

		it('snapshot bootstrap of a violating row fires NO assertion event (the seam is skipped; finalize converges the MV)', async () => {
			// Detect-and-notify lives on the INCREMENTAL seam only. A snapshot bootstrap
			// installs one origin's already-converged state wholesale — its per-flush
			// writes pass `bootstrap: true` so the adapter skips the seam entirely, and
			// `finalizeBootstrap` converges via `refreshAllMaterializedViews` (which does
			// not evaluate assertions). So a bootstrapped row that would violate a local
			// assertion must NOT throw and must NOT notify — it just lands, MV and all.
			await db.exec('create table t (id text primary key, v integer) using store');
			await db.exec('create materialized view mv as select id, v from t');
			await db.exec('create assertion non_negative check (not exists (select 1 from t where v < 0))');

			const syncEvents = new SyncEventEmitterImpl();
			const violations: AssertionViolationEvent[] = [];
			syncEvents.onAssertionViolation(e => violations.push(e));

			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-assert-1';
			const chunks: SnapshotChunk[] = [
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), tableCount: 1, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 't', estimatedEntries: 0 },
				{ type: 'column-versions', schema: 'main', table: 't', entries: [[`${encodeRawPkIdentity(['x'])}:v`, remoteHLC.tick(), -7, ['x']]] },
				{ type: 'table-end', schema: 'main', table: 't', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 1, totalMigrations: 0 },
			];
			async function* stream(): AsyncIterable<SnapshotChunk> {
				for (const c of chunks) yield c;
			}

			// No throw despite the violating row...
			await syncManager.applySnapshotStream(stream());

			// ...the row landed and the MV converged via finalize (not the seam)...
			expect((await collect(db, 'select v from t')).map(r => Number(r.v))).to.deep.equal([-7]);
			expect((await collect(db, 'select v from mv')).map(r => Number(r.v))).to.deep.equal([-7]);
			// ...and the host was NOT notified — bootstrap is detect-nothing by design.
			expect(violations, 'bootstrap path does not evaluate assertions').to.have.length(0);
		});

		it('no CRDT echo: applying remote changes records nothing as local', async () => {
			await db.exec('create table t (id text primary key, v text) using store');

			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const result = await syncManager.applyChanges(remoteChangeSet(remoteHLC, remoteSiteId, 'a'));
			expect(result.applied).to.equal(1);
			expect(await collect(db, 'select id, v from t')).to.deep.equal([{ id: 'x', v: 'a' }]);

			// getChangesSince(origin) excludes the origin's own changes — anything
			// left would be an echo recorded under OUR site id. There must be none.
			const echoed = await syncManager.getChangesSince(remoteSiteId);
			expect(echoed.flatMap(cs => cs.changes)).to.have.length(0);
		});
	});

	describe('per-change apply errors abort with no metadata committed', () => {
		// The adapter collects per-change failures in `result.errors` rather than
		// throwing (it keeps applying other tables). The consumer must still treat
		// any non-empty `errors` like a whole-batch throw: emit error + throw, with
		// NO CRDT metadata committed, so the whole batch re-resolves next sync.
		//
		// The trigger here is a basis/store-ownership MISMATCH: the oracle reports
		// `no_such_table` as in-basis (so unknown-table detection passes it through
		// to the adapter rather than diverting it to quarantine), but no backing
		// store table exists, so the adapter's defensive `Table not found for
		// external write` throw fires as a per-change error. This is the exact net
		// the unknown-table-disposition work leaves in place for ownership drift —
		// distinct from a genuinely retired (out-of-basis) table, which is diverted.
		const makeSyncManager = (syncEvents: SyncEventEmitterImpl) =>
			SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName): TableSchema | undefined =>
					tableName === 'no_such_table'
						? ({} as TableSchema)
						: db.schemaManager.getTable(schemaName, tableName),
			);

		it('applyChanges: a per-change storage failure throws and commits no metadata; retry converges', async () => {
			await db.exec('create table t (id text primary key, v text) using store');

			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			// One change set spanning a resolvable table `t` and an unresolvable
			// `no_such_table`. Built once and reused so the HLCs are stable across
			// both attempts.
			const changeSets = [{
				siteId: remoteSiteId,
				transactionId: 'tx1',
				hlc: remoteHLC.tick(),
				changes: [
					{ type: 'column' as const, schema: 'main', table: 't', pk: ['x'], column: 'v', value: 'a', hlc: remoteHLC.tick() },
					{ type: 'column' as const, schema: 'main', table: 'no_such_table', pk: ['k'], column: 'v', value: 'b', hlc: remoteHLC.tick() },
				],
				schemaMigrations: [],
			}];

			// First attempt: `t` applies to storage, `no_such_table` fails → the
			// adapter records the error, applyChanges aggregates it into a throw
			// (carrying the failed change), and NO CRDT metadata is committed.
			let thrown: unknown;
			try {
				await syncManager.applyChanges(changeSets);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');
			// throwIfApplyErrors aggregates the failed change(s) into one Error and
			// chains the underlying store error as `cause`.
			expect(thrown).to.be.instanceOf(Error);
			expect((thrown as Error).message).to.contain('apply-to-store failed for');
			expect((thrown as Error).cause).to.be.instanceOf(Error);

			// Whole batch uncommitted: nothing to relay (neither `t` nor `no_such_table`).
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);

			// Create the missing table and re-apply the SAME change set: both apply,
			// metadata commits, both changes relay (convergence on idempotent retry).
			await db.exec('create table no_such_table (id text primary key, v text) using store');
			const retry = await syncManager.applyChanges(changeSets);
			expect(retry.applied).to.equal(2);
			const relayedAfter = await syncManager.getChangesSince(generateSiteId());
			expect(relayedAfter.flatMap(cs => cs.changes)).to.have.length(2);
		});

		it('a reported assertion violation is emitted BEFORE the co-occurring per-change abort throws', async () => {
			// The mixed batch: change B (`t` v=-5) resolves and trips `non_negative`
			// while change A (`no_such_table`) is a per-change storage failure. B's
			// report-mode seam COMMITS its row + MV delta durably, then the per-change
			// `errors` abort throws to block the metadata commit. The violation event
			// MUST fire before that throw — otherwise the retry's value-identical
			// suppression (empty seam batch → no assertion re-eval) means the host is
			// NEVER notified about durably-committed violating data.
			await db.exec('create table t (id text primary key, v integer) using store');
			await db.exec('create materialized view mv as select id, v from t');
			await db.exec('create assertion non_negative check (not exists (select 1 from t where v < 0))');

			const syncEvents = new SyncEventEmitterImpl();
			const violations: AssertionViolationEvent[] = [];
			syncEvents.onAssertionViolation(e => violations.push(e));
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			// One change set: a resolvable-but-violating `t` change and an
			// unresolvable `no_such_table` change. Built once, reused across both
			// attempts so the HLCs stay stable.
			const changeSets = [{
				siteId: remoteSiteId,
				transactionId: 'tx1',
				hlc: remoteHLC.tick(),
				changes: [
					{ type: 'column' as const, schema: 'main', table: 't', pk: ['x'], column: 'v', value: -5, hlc: remoteHLC.tick() },
					{ type: 'column' as const, schema: 'main', table: 'no_such_table', pk: ['k'], column: 'v', value: 'b', hlc: remoteHLC.tick() },
				],
				schemaMigrations: [],
			}];

			// First attempt: `no_such_table` fails → the abort throws, but the
			// violation event fired first.
			let thrown: unknown;
			try {
				await syncManager.applyChanges(changeSets);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');
			expect((thrown as Error).message).to.contain('apply-to-store failed for');

			// The violation surfaced BEFORE the throw (the regression this closes).
			expect(violations).to.have.length(1);
			expect(violations[0].assertion).to.equal('non_negative');
			expect(violations[0].samples.length).to.be.greaterThan(0);

			// B's row landed durably and the MV converged — the report-mode seam
			// committed despite the per-change abort blocking the metadata commit.
			expect((await collect(db, 'select v from t')).map(r => Number(r.v))).to.deep.equal([-5]);
			expect((await collect(db, 'select v from mv')).map(r => Number(r.v))).to.deep.equal([-5]);

			// No CRDT metadata committed — nothing relays after the abort.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);

			// Resolve A and re-apply the SAME change set: both apply, metadata
			// commits, both relay. B is now value-identical (its row already
			// committed) → suppressed → empty seam contribution → `non_negative` is
			// NOT re-evaluated, so the violation does NOT double-fire.
			await db.exec('create table no_such_table (id text primary key, v text) using store');
			const retry = await syncManager.applyChanges(changeSets);
			expect(retry.applied).to.equal(2);
			const relayedAfter = await syncManager.getChangesSince(generateSiteId());
			expect(relayedAfter.flatMap(cs => cs.changes)).to.have.length(2);
			expect(violations, 'no double-fire on value-identical retry').to.have.length(1);
		});

		it('applySnapshot: an unresolvable table throws before clearing/rewriting metadata', async () => {
			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshot: Snapshot = {
				siteId: remoteSiteId,
				hlc: remoteHLC.tick(),
				tables: [{
					schema: 'main',
					table: 'no_such_table',
					rows: [],
					// versionKey = `${pkIdentity}:${column}`; the raw pk rides in the entry.
					columnVersions: new Map([[`${encodeRawPkIdentity(['k'])}:v`, { hlc: remoteHLC.tick(), value: 'b', pk: ['k'] }]]),
				}],
				schemaMigrations: [],
				tombstones: [],
			};

			let thrown: unknown;
			try {
				await syncManager.applySnapshot(snapshot);
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');

			// Throw fired before the clear/rewrite phase → no column-version metadata committed.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);
		});

		it('applySnapshotStream: an unresolvable table throws and never emits status synced', async () => {
			const syncEvents = new SyncEventEmitterImpl();
			const states: SyncState[] = [];
			syncEvents.onSyncStateChange(s => states.push(s));
			const syncManager = await makeSyncManager(syncEvents);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-err-1';
			const chunks: SnapshotChunk[] = [
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), tableCount: 1, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 'no_such_table', estimatedEntries: 0 },
				{ type: 'column-versions', schema: 'main', table: 'no_such_table', entries: [[`${encodeRawPkIdentity(['k'])}:v`, remoteHLC.tick(), 'b', ['k']]] },
				{ type: 'table-end', schema: 'main', table: 'no_such_table', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 1, totalEntries: 1, totalMigrations: 0 },
			];
			async function* stream(): AsyncIterable<SnapshotChunk> {
				for (const c of chunks) yield c;
			}

			let thrown: unknown;
			try {
				await syncManager.applySnapshotStream(stream());
			} catch (e) {
				thrown = e;
			}
			expect(String(thrown)).to.contain('no_such_table');

			// The footer's data flush throws before `status: 'synced'` is emitted.
			expect(states.map(s => s.status)).to.include('error');
			expect(states.map(s => s.status)).to.not.include('synced');

			// Metadata batch is flushed only after the data flush → none committed.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);
		});
	});

	describe('out-of-basis table diverts to quarantine (real adapter)', () => {
		// Companion to the ownership-mismatch case above: there the oracle CLAIMS the
		// table so the change passes detection and the adapter's defensive throw
		// fires; here the oracle reports the table as genuinely out of basis
		// (`getTable` returns undefined), so Phase 1 diverts the change to quarantine
		// and it NEVER reaches the adapter — no throw, no per-change error. This
		// proves the unit-harness control flow holds against the production
		// `createStoreAdapter` seam end to end.
		it('diverts the change to quarantine without applying or throwing', async () => {
			await db.exec('create table t (id text primary key, v text) using store');

			const syncEvents = new SyncEventEmitterImpl();
			const states: SyncState[] = [];
			syncEvents.onSyncStateChange(s => states.push(s));
			const unknownEvents: UnknownTableEvent[] = [];
			syncEvents.onUnknownTable(e => unknownEvents.push(e));

			const syncManager = await SyncManagerImpl.create(
				new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				// 'orders' is retired (out of basis → undefined); 't' resolves live.
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const changeSets = [{
				siteId: remoteSiteId,
				transactionId: 'tx1',
				hlc: remoteHLC.tick(),
				changes: [{
					type: 'column' as const, schema: 'main', table: 'orders',
					pk: ['o1'], column: 'note', value: 'late', hlc: remoteHLC.tick(),
				}],
				schemaMigrations: [],
			}];

			// No throw despite there being no 'orders' backing store — the change
			// never reaches the adapter's defensive throw.
			const result = await syncManager.applyChanges(changeSets);
			expect(result.unknownTable).to.equal(1);
			expect(result.applied).to.equal(0);
			expect(states.map(s => s.status), 'no error state emitted').to.not.include('error');

			// Durably quarantined verbatim; telemetry fired.
			const held = await syncManager.quarantine.list('main', 'orders');
			expect(held).to.have.length(1);
			expect(held[0].change.table).to.equal('orders');
			expect(unknownEvents.map(e => e.table)).to.deep.equal(['orders']);

			// No CRDT metadata for the retired table — nothing to relay onward.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			expect(relayed.flatMap(cs => cs.changes)).to.have.length(0);
		});
	});

	describe('resumed snapshot stream preserves completed-table metadata', () => {
		// A resumed transfer's sender skips already-completed tables and never
		// re-emits their metadata. The receiver's up-front clear must consult the
		// persisted checkpoint and preserve those tables — otherwise their CRDT
		// state is wiped and never rewritten (metadata/data divergence).
		it('omitted completed table survives the clear; re-streamed table applies', async () => {
			// tableB is re-streamed → its rows flush to the store at table-end, so
			// the store must be able to resolve it. tableA is skipped entirely (but
			// exists locally, as it would after the earlier session streamed it);
			// tableC exists too — only its METADATA is stale/non-completed.
			await db.exec('create table tableB (id text primary key, v text) using store');
			await db.exec('create table tableA (id text primary key, v text) using store');
			await db.exec('create table tableC (id text primary key, v text) using store');

			const kv = new InMemoryKVStore();
			const syncEvents = new SyncEventEmitterImpl();
			const syncManager = await SyncManagerImpl.create(
				kv, undefined, { ...DEFAULT_SYNC_CONFIG }, syncEvents, applyToStore,
				(schemaName, tableName) => db.schemaManager.getTable(schemaName, tableName),
			);

			const remoteSiteId = generateSiteId();
			const remoteHLC = new HLCManager(remoteSiteId);
			const snapshotId = 'snap-resume-1';

			// Seed tableA's column version (the "already completed" table) and a
			// checkpoint that lists it completed — mirroring saveSnapshotCheckpoint's
			// serialization (hlc.wallTime as string, siteId arrays).
			await syncManager.columnVersions.setColumnVersion('main', 'tableA', ['a1'], 'v', {
				hlc: remoteHLC.tick(),
				value: 'survives',
			});
			// Also seed a tombstone and a change-log entry for the completed table,
			// plus a *non*-completed table (tableC) that the stream never re-emits.
			// The resume-aware clear must preserve tableA's tb:/cl: state (the two
			// branches of clearExistingMetadata that the cv assertions don't reach)
			// while still dropping tableC's — proving the preserve filter is
			// selective, not a blanket skip.
			await syncManager.tombstones.setTombstone('main', 'tableA', ['a2'], remoteHLC.tick());
			await syncManager.changeLog.recordColumnChange(remoteHLC.tick(), 'main', 'tableA', ['a1'], 'v');
			await syncManager.tombstones.setTombstone('main', 'tableC', ['c1'], remoteHLC.tick());
			await syncManager.changeLog.recordColumnChange(remoteHLC.tick(), 'main', 'tableC', ['c1'], 'v');
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
				{ type: 'header', siteId: remoteSiteId, hlc: remoteHLC.tick(), tableCount: 2, migrationCount: 0, snapshotId },
				{ type: 'table-start', schema: 'main', table: 'tableB', estimatedEntries: 0 },
				{ type: 'column-versions', schema: 'main', table: 'tableB', entries: [[`${encodeRawPkIdentity(['b1'])}:v`, remoteHLC.tick(), 'bval', ['b1']]] },
				{ type: 'table-end', schema: 'main', table: 'tableB', entriesWritten: 1 },
				{ type: 'footer', snapshotId, totalTables: 2, totalEntries: 1, totalMigrations: 0 },
			];
			async function* stream(): AsyncIterable<SnapshotChunk> {
				for (const c of chunks) yield c;
			}

			await syncManager.applySnapshotStream(stream());

			// tableA's metadata survived the resume-aware clear...
			const survived = await syncManager.columnVersions.getColumnVersion('main', 'tableA', ['a1'], 'v');
			void expect(survived, 'completed-table column version preserved on resume').to.exist;
			expect(survived!.value).to.equal('survives');

			// ...and tableB was applied (metadata + store row).
			const applied = await syncManager.columnVersions.getColumnVersion('main', 'tableB', ['b1'], 'v');
			void expect(applied, 'resumed table column version applied').to.exist;
			expect(applied!.value).to.equal('bval');
			expect(await collect(db, 'select id, v from tableB')).to.deep.equal([{ id: 'b1', v: 'bval' }]);

			// tableA's tombstone (tb:) and change-log entry (cl:) survived the clear...
			void expect(
				await syncManager.tombstones.getTombstone('main', 'tableA', ['a2']),
				'completed-table tombstone preserved on resume',
			).to.exist;
			const clTables = new Set<string>();
			for await (const e of syncManager.changeLog.getAllChanges()) clTables.add(e.table);
			void expect(clTables.has('tableA'), 'completed-table change-log entry preserved on resume').to.be.true;

			// ...while the non-completed tableC's tb:/cl: state was cleared.
			void expect(
				await syncManager.tombstones.getTombstone('main', 'tableC', ['c1']),
				'non-completed tombstone cleared on resume',
			).to.not.exist;
			void expect(clTables.has('tableC'), 'non-completed change-log entry cleared on resume').to.be.false;

			// Divergence angle: a full delta sync to a fresh peer still relays
			// tableA's change, proving the metadata is not orphaned from its data.
			const relayed = await syncManager.getChangesSince(generateSiteId());
			const tableAChange = relayed
				.flatMap(cs => cs.changes)
				.find(c => c.type === 'column' && c.table === 'tableA' && c.column === 'v');
			void expect(tableAChange, 'tableA change relayed after resume').to.exist;
		});
	});
});
