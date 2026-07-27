/**
 * Snapshot bootstrap: the RECEIVER derives row identity, never the sender.
 *
 * A relay-only coordinator (no store, no schema oracle — exactly what
 * `StoreManager.openStore` builds) keys its sync metadata by RAW pk values:
 * no case folding, no timespan normalization. A receiver that holds the table
 * definition derives a *different* identity for the same row, so if it filed
 * the relay's snapshot bookkeeping under the relay's identities verbatim, every
 * later pk-based lookup would miss — a deletion carried in the snapshot would
 * stop blocking stale writes, and last-writer-wins would restart from scratch.
 *
 * These specs pin the fix: the receiver derives its own identity from each
 * entry's raw pk, and collapses a raw-keyed sender's multiple spellings of one
 * row by greatest HLC (per cell / per tombstone) — one surviving record,
 * emitted once by `getChangesSince`, resolved by timestamp rather than by
 * chunk order.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
	DEFAULT_SYNC_CONFIG,
	SNAPSHOT_WIRE_FORMAT_VERSION,
	type ChangeSet,
	type ColumnChange,
	type Snapshot,
	type SnapshotChunk,
} from '../../src/sync/protocol.js';
import { createHLC, type HLC } from '../../src/clock/hlc.js';
import { generateSiteId, type SiteId } from '../../src/clock/site.js';
import { makePeer, closePeer, localWrite, collect, toStream, settle, type Peer } from './_peer-harness.js';

/** A bare relay-shaped manager: no store adapter, no schema oracle, no txn source. */
const makeRelay = (): Promise<SyncManagerImpl> =>
	SyncManagerImpl.create(
		new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
	);

/** One-column-change ChangeSet from a foreign site at an explicit HLC. */
function columnChangeSet(
	site: SiteId,
	hlc: HLC,
	table: string,
	pk: (string | number)[],
	column: string,
	value: string,
): ChangeSet {
	const change: ColumnChange = { type: 'column', schema: 'main', table, pk, column, value, hlc };
	return { siteId: site, transactionId: `tx-${value}`, hlc, changes: [change], schemaMigrations: [] };
}

/** Pull every chunk of a manager's snapshot stream into an array. */
async function collectStream(manager: SyncManagerImpl): Promise<SnapshotChunk[]> {
	const chunks: SnapshotChunk[] = [];
	for await (const c of manager.getSnapshotStream()) chunks.push(c);
	return chunks;
}

describe('snapshot receiver derives row identity (relay-as-sender bootstrap)', () => {
	let a: Peer;
	let b: Peer;
	let relay: SyncManagerImpl;

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('nocase: metadata bootstrapped from a raw-keyed relay is findable by pk, and the tombstone still blocks a stale write', async () => {
		a = await makePeer('A');
		b = await makePeer('B'); // fresh: bootstraps the table from the snapshot's own DDL
		relay = await makeRelay();

		await a.db.exec(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('Apple', 'v1')`);
		await localWrite(a, `insert into t values ('Banana', 'v2')`);
		await localWrite(a, `delete from t where k = 'BANANA'`);
		await settle();

		// The relay ingests A's full log (data + the create_table migration) and
		// serves its snapshot — filed under RAW identities ('Apple', 'Banana').
		await relay.applyChanges(await a.manager.getChangesSince(relay.getSiteId()));
		await b.manager.applySnapshotStream(toStream(await collectStream(relay)));

		expect(await collect(b.db, `select k, v from t`), 'live row bootstrapped')
			.to.deep.equal([{ k: 'Apple', v: 'v1' }]);

		// B derives its own NOCASE identity, so lookups under ANY spelling hit.
		expect(
			await b.manager.columnVersions.getColumnVersion('main', 't', ['APPLE'], 'v'),
			'column version findable under another spelling',
		).to.not.equal(undefined);
		const ts = await b.manager.tombstones.getTombstone('main', 't', ['banana']);
		expect(ts, 'tombstone findable under another spelling').to.not.equal(undefined);

		// A stale pre-delete write for yet another spelling must NOT resurrect the row.
		const foreign = generateSiteId();
		const staleHlc = createHLC(ts!.hlc.wallTime - 1n, 0, foreign);
		await b.manager.applyChanges([
			columnChangeSet(foreign, staleHlc, 't', ['BANANA'], 'v', 'resurrected'),
		]);
		expect(await collect(b.db, `select k, v from t`), 'stale write stays tombstone-blocked')
			.to.deep.equal([{ k: 'Apple', v: 'v1' }]);
	});

	it('nocase: two spellings of one row on the relay collapse to one record — later HLC wins, emitted once', async () => {
		a = await makePeer('A');
		b = await makePeer('B');
		relay = await makeRelay();

		await a.db.exec(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'old')`);
		await settle();
		await relay.applyChanges(await a.manager.getChangesSince(relay.getSiteId()));

		// A foreign site writes the SAME row under another spelling with a later
		// HLC. The relay keys raw, so it now holds TWO cell records for what a
		// schema-holding receiver considers one row.
		const foreign = generateSiteId();
		const laterHlc = createHLC(BigInt(Date.now()) + 50n, 0, foreign);
		await relay.applyChanges([columnChangeSet(foreign, laterHlc, 't', ['APPLE'], 'v', 'new')]);

		await b.manager.applySnapshotStream(toStream(await collectStream(relay)));

		// One row, carrying the later value — not resolved by chunk order.
		expect(await collect(b.db, `select v from t`), 'later write wins the collapse')
			.to.deep.equal([{ v: 'new' }]);
		const cv = await b.manager.columnVersions.getColumnVersion('main', 't', ['apple'], 'v');
		expect(cv?.value, 'surviving cell record carries the later value').to.equal('new');

		// Exactly one change-log entry survives per collapsed cell, so the change
		// relays once — not once per sender spelling.
		const relayed = await b.manager.getChangesSince(generateSiteId());
		const cellChanges = relayed
			.flatMap(cs => cs.changes)
			.filter(c => c.type === 'column' && c.table === 't' && c.column === 'v');
		expect(cellChanges, 'collapsed cell emitted exactly once').to.have.length(1);
		expect((cellChanges[0] as ColumnChange).value).to.equal('new');
	});

	it('timespan: PT1H/PT60M collapse the same way (semantic key transform, not collation)', async () => {
		a = await makePeer('A');
		b = await makePeer('B');
		relay = await makeRelay();

		await a.db.exec(`create table t (d timespan primary key, v text) using store`);
		await localWrite(a, `insert into t values ('PT1H', 'old')`);
		await settle();
		await relay.applyChanges(await a.manager.getChangesSince(relay.getSiteId()));

		const foreign = generateSiteId();
		const laterHlc = createHLC(BigInt(Date.now()) + 50n, 0, foreign);
		await relay.applyChanges([columnChangeSet(foreign, laterHlc, 't', ['PT60M'], 'v', 'new')]);

		await b.manager.applySnapshotStream(toStream(await collectStream(relay)));

		expect(await collect(b.db, `select v from t`), 'one row, later value')
			.to.deep.equal([{ v: 'new' }]);
		expect(
			(await b.manager.columnVersions.getColumnVersion('main', 't', ['PT1H'], 'v'))?.value,
			'findable under the other spelling, carrying the later value',
		).to.equal('new');

		const relayed = await b.manager.getChangesSince(generateSiteId());
		const cellChanges = relayed
			.flatMap(cs => cs.changes)
			.filter(c => c.type === 'column' && c.table === 't' && c.column === 'v');
		expect(cellChanges, 'collapsed cell emitted exactly once').to.have.length(1);
	});

	it('non-streaming applySnapshot collapses spellings the same way', async () => {
		a = await makePeer('A');
		b = await makePeer('B');
		relay = await makeRelay();

		await a.db.exec(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'old')`);
		await settle();
		await relay.applyChanges(await a.manager.getChangesSince(relay.getSiteId()));

		const foreign = generateSiteId();
		const laterHlc = createHLC(BigInt(Date.now()) + 50n, 0, foreign);
		await relay.applyChanges([columnChangeSet(foreign, laterHlc, 't', ['APPLE'], 'v', 'new')]);

		await b.manager.applySnapshot(await relay.getSnapshot());

		expect(await collect(b.db, `select v from t`), 'later write wins at the data level too')
			.to.deep.equal([{ v: 'new' }]);
		expect(
			(await b.manager.columnVersions.getColumnVersion('main', 't', ['apple'], 'v'))?.value,
			'one surviving cell record with the later value',
		).to.equal('new');
		const relayed = await b.manager.getChangesSince(generateSiteId());
		expect(
			relayed.flatMap(cs => cs.changes).filter(c => c.type === 'column' && c.column === 'v'),
			'collapsed cell emitted exactly once',
		).to.have.length(1);
	});
});

describe('snapshot wire-format gate', () => {
	let receiver: Peer;

	beforeEach(async () => {
		receiver = await makePeer('receiver');
	});

	afterEach(async () => {
		await closePeer(receiver);
	});

	it('applySnapshotStream refuses a mismatched (or missing) snapshotFormat before touching state', async () => {
		// Seed metadata that a header-passing snapshot's clear would wipe.
		await receiver.db.exec(`create table t (id text primary key, v text) using store`);
		await localWrite(receiver, `insert into t values ('r1', 'keep-me')`);
		await settle();

		const remoteSite = generateSiteId();
		const snapshotId = 'snap-bad-format-1';
		const chunks: SnapshotChunk[] = [
			{
				type: 'header', siteId: remoteSite, hlc: createHLC(BigInt(Date.now()), 0, remoteSite),
				snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION + 1, tableCount: 0, migrationCount: 0, snapshotId,
			},
			{ type: 'footer', snapshotId, totalTables: 0, totalEntries: 0, totalMigrations: 0 },
		];

		let thrown: unknown;
		try {
			await receiver.manager.applySnapshotStream(toStream(chunks));
		} catch (e) {
			thrown = e;
		}
		expect(String(thrown), 'mismatched format refused').to.contain('wire format');
		expect(String(thrown), 'names the recovery').to.contain('regenerate');

		// The clear never ran: pre-existing metadata survives.
		expect(
			await receiver.manager.columnVersions.getColumnVersion('main', 't', ['r1'], 'v'),
			'pre-existing metadata untouched',
		).to.not.equal(undefined);
	});

	it('applySnapshot refuses a mismatched snapshotFormat', async () => {
		const remoteSite = generateSiteId();
		const snapshot: Snapshot = {
			siteId: remoteSite,
			hlc: createHLC(BigInt(Date.now()), 0, remoteSite),
			snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION + 1,
			tables: [],
			schemaMigrations: [],
			tombstones: [],
		};

		let thrown: unknown;
		try {
			await receiver.manager.applySnapshot(snapshot);
		} catch (e) {
			thrown = e;
		}
		expect(String(thrown), 'mismatched format refused').to.contain('wire format');
	});
});
