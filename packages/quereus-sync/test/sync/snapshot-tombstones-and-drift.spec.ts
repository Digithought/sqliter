/**
 * Snapshot tombstone survival + pre-commit clock-drift rejection.
 *
 * Two robustness properties, each able to permanently de-converge two replicas:
 *
 *  1. **Tombstones travel in snapshots.** A row deleted before a snapshot must stay
 *     deleted after a fresh replica bootstraps from that snapshot — otherwise a later
 *     stale write for the row (older than the deletion) resurrects it, and the two
 *     replicas permanently disagree. The producer emits a GLOBAL tombstone pass, so a
 *     fully-deleted row (a tombstone with no live column-versions) still travels.
 *
 *  2. **Clock drift is rejected pre-commit.** A peer whose `wallTime` exceeds the
 *     drift bound is rejected in the validation phase, BEFORE any data or CRDT
 *     metadata is written — the wire path at the top of `applyChanges`, the snapshot
 *     path at the header before `clearExistingMetadata`. Nothing lands on rejection.
 */

import { expect } from 'chai';
import { SNAPSHOT_WIRE_FORMAT_VERSION, type ChangeSet, type ColumnChange, type SnapshotChunk } from '../../src/sync/protocol.js';
import { createHLC, MAX_DRIFT_MS, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { makePeer, closePeer, localWrite, collect, toStream, type Peer } from './_peer-harness.js';

const TEXT_ORDERS = 'create table orders (id text primary key, note text) using store';

const count = async (peer: Peer, sql: string): Promise<number> =>
	Number((await collect(peer.db, sql))[0].n);

describe('snapshot carries tombstones', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender', { createOrders: true, ordersDdl: TEXT_ORDERS });
		// The receiver bootstraps from the snapshot: it does NOT pre-create `orders`, so
		// the snapshot's own `create_table` migration installs the table (and would
		// conflict if the receiver already had it). This is the realistic fresh-replica flow.
		receiver = await makePeer('receiver');
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('a deleted row stays deleted after snapshot bootstrap; a stale older write is tombstone-blocked', async () => {
		// Sender: write R, then delete R. The delete leaves a tombstone but NO live
		// column-versions, so R's table is absent from the column-version pass — only the
		// global tombstone pass carries it.
		await localWrite(sender, "insert into orders (id, note) values ('r1', 'hello')");
		await localWrite(sender, "delete from orders where id = 'r1'");

		const chunks: SnapshotChunk[] = [];
		for await (const c of sender.manager.getSnapshotStream()) chunks.push(c);
		expect(chunks.some(c => c.type === 'tombstone'), 'snapshot carries a tombstone chunk').to.equal(true);

		await receiver.manager.applySnapshotStream(toStream(chunks));

		// The receiver ends with the sender's tombstone for R.
		const ts = await receiver.manager.tombstones.getTombstone('main', 'orders', ['r1']);
		expect(ts, 'receiver has a tombstone for the deleted row after bootstrap').to.not.equal(undefined);

		// Deliver a stale write for R with HLC strictly older than the deletion, from a
		// foreign site (so it is not self-origin-skipped).
		const foreignSite = generateSiteId();
		const staleHlc = createHLC(ts!.hlc.wallTime - 1n, 0, foreignSite);
		const staleChange: ColumnChange = {
			type: 'column', schema: 'main', table: 'orders', pk: ['r1'], column: 'note', value: 'resurrected', hlc: staleHlc,
		};
		const cs: ChangeSet = {
			siteId: foreignSite, transactionId: 'stale-tx', hlc: staleHlc, changes: [staleChange], schemaMigrations: [],
		};
		await receiver.manager.applyChanges([cs]);

		// The stale write is tombstone-blocked: R does NOT resurrect.
		expect(await count(receiver, "select count(*) as n from orders where id = 'r1'"))
			.to.equal(0);
		// The tombstone is still in place.
		expect(await receiver.manager.tombstones.getTombstone('main', 'orders', ['r1']))
			.to.not.equal(undefined);
	});
});

describe('non-streaming snapshot carries tombstones', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender', { createOrders: true, ordersDdl: TEXT_ORDERS });
		// Fresh replica: the snapshot's own `create_table` migration installs `orders`.
		receiver = await makePeer('receiver');
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('a deleted row stays deleted after applySnapshot bootstrap; a stale older write is tombstone-blocked', async () => {
		// Sender: write R, then delete R. The delete leaves a tombstone but NO live
		// column-versions, so R's table is absent from the column-version pass — only the
		// global tombstone pass carries it (the fully-deleted-row case).
		await localWrite(sender, "insert into orders (id, note) values ('r1', 'hello')");
		await localWrite(sender, "delete from orders where id = 'r1'");

		const snap = await sender.manager.getSnapshot();
		// The global pass carried the tombstone even though R has no live column-versions;
		// a per-table collection keyed off `snap.tables` would miss it (R's table is absent).
		expect(snap.tombstones.length, 'snapshot carries the tombstone globally').to.be.greaterThan(0);
		// The producer carries the delete before-image (the engine `oldRow`) into the snapshot.
		const snapTs = snap.tombstones.find(t => t.table === 'orders' && String(t.pk[0]) === 'r1');
		expect(snapTs?.priorRow, 'snapshot tombstone carries the before-image').to.deep.equal(['r1', 'hello']);

		await receiver.manager.applySnapshot(snap);

		// The receiver ends with the sender's tombstone for R.
		const ts = await receiver.manager.tombstones.getTombstone('main', 'orders', ['r1']);
		expect(ts, 'receiver has a tombstone for the deleted row after bootstrap').to.not.equal(undefined);
		// The before-image round-trips: applySnapshot forwards priorRow to setTombstoneBatch,
		// so the receiver's reconstructed tombstone still carries it.
		expect(ts!.priorRow, 'receiver tombstone preserves the before-image after bootstrap')
			.to.deep.equal(['r1', 'hello']);

		// Deliver a stale write for R with HLC strictly older than the deletion, from a
		// foreign site (so it is not self-origin-skipped).
		const foreignSite = generateSiteId();
		const staleHlc = createHLC(ts!.hlc.wallTime - 1n, 0, foreignSite);
		const staleChange: ColumnChange = {
			type: 'column', schema: 'main', table: 'orders', pk: ['r1'], column: 'note', value: 'resurrected', hlc: staleHlc,
		};
		const cs: ChangeSet = {
			siteId: foreignSite, transactionId: 'stale-tx', hlc: staleHlc, changes: [staleChange], schemaMigrations: [],
		};
		await receiver.manager.applyChanges([cs]);

		// The stale write is tombstone-blocked: R does NOT resurrect.
		expect(await count(receiver, "select count(*) as n from orders where id = 'r1'"))
			.to.equal(0);
		// The tombstone is still in place.
		expect(await receiver.manager.tombstones.getTombstone('main', 'orders', ['r1']))
			.to.not.equal(undefined);
	});
});

describe('clock drift is rejected pre-commit', () => {
	let receiver: Peer;

	beforeEach(async () => {
		receiver = await makePeer('receiver', { createOrders: true, ordersDdl: TEXT_ORDERS });
	});

	afterEach(async () => {
		await closePeer(receiver);
	});

	it('a drifted wire batch is rejected with nothing committed (no data, no column-version)', async () => {
		const states: string[] = [];
		receiver.manager.syncEvents.onSyncStateChange(s => states.push(s.status));

		const foreignSite = generateSiteId();
		const driftedHlc = createHLC(BigInt(Date.now()) + MAX_DRIFT_MS + 1000n, 0, foreignSite);
		const change: ColumnChange = {
			type: 'column', schema: 'main', table: 'orders', pk: ['r9'], column: 'note', value: 'x', hlc: driftedHlc,
		};
		const cs: ChangeSet = {
			siteId: foreignSite, transactionId: 'drift-tx', hlc: driftedHlc, changes: [change], schemaMigrations: [],
		};

		let thrown: unknown;
		try {
			await receiver.manager.applyChanges([cs]);
		} catch (e) {
			thrown = e;
		}
		expect(String(thrown), 'drifted batch is rejected').to.contain('too far in future');

		// Nothing landed: no store row and no CRDT column-version metadata.
		expect(await count(receiver, "select count(*) as n from orders where id = 'r9'")).to.equal(0);
		expect(await receiver.manager.columnVersions.getColumnVersion('main', 'orders', ['r9'], 'note'))
			.to.equal(undefined);
		// Error state emitted for UI parity with the data-apply failure path.
		expect(states, 'emitted status:error').to.include('error');
	});

	it('a drifted snapshot header is rejected before clear — pre-existing metadata survives', async () => {
		const states: string[] = [];
		receiver.manager.syncEvents.onSyncStateChange(s => states.push(s.status));

		// Seed a pre-existing column-version that the bootstrap clear would wipe.
		const localHlc: HLC = createHLC(BigInt(Date.now()), 0, receiver.manager.getSiteId());
		await receiver.manager.columnVersions.setColumnVersion('main', 'orders', ['r5'], 'note', {
			hlc: localHlc, value: 'keep-me',
		});

		const remoteSite = generateSiteId();
		const driftedHeaderHlc = createHLC(BigInt(Date.now()) + MAX_DRIFT_MS + 5000n, 0, remoteSite);
		const snapshotId = 'snap-drift-header-1';
		const chunks: SnapshotChunk[] = [
			{ type: 'header', siteId: remoteSite, hlc: driftedHeaderHlc, snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION, tableCount: 0, migrationCount: 0, snapshotId },
			{ type: 'footer', snapshotId, totalTables: 0, totalEntries: 0, totalMigrations: 0 },
		];

		let thrown: unknown;
		try {
			await receiver.manager.applySnapshotStream(toStream(chunks));
		} catch (e) {
			thrown = e;
		}
		expect(String(thrown), 'drifted snapshot header is rejected').to.contain('too far in future');

		// The clear never ran: the pre-existing column-version survives.
		const cv = await receiver.manager.columnVersions.getColumnVersion('main', 'orders', ['r5'], 'note');
		expect(cv, 'pre-existing metadata not cleared').to.not.equal(undefined);
		expect(cv?.value).to.equal('keep-me');
		expect(states, 'emitted status:error').to.include('error');
	});
});
