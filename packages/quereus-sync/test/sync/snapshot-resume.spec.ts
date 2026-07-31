/**
 * Interrupted-then-resumed snapshot transfer.
 *
 * `applySnapshotStream` names a table "done" in a persisted checkpoint
 * (`completedTables`) so a resumed transfer can skip it (`resumeSnapshotStream`)
 * and the receiver can preserve its CRDT metadata through the resumed clear
 * (`clearExistingMetadata`'s `preserveTables`). That is only safe if a table is
 * added to `completedTables` AFTER every one of its rows has actually returned
 * from `applyDataToStore` — otherwise a checkpoint can tell a resumed sender to
 * skip a table whose trailing rows never made it to the receiver's store, and
 * those rows are then never sent again.
 *
 * `applySnapshotStream` upholds this by staging a just-finished table in
 * `stagedCompletedTables` and only graduating it into `completedTables` inside
 * `flushDataToStore`, once `applyDataToStore` has returned. Before that change
 * the property held only as an INCIDENTAL side effect of the `tombstone` chunk
 * handler's unconditional `flushDataToStore()` call (added for DDL ordering, see
 * that handler's comment) — commenting out that call reproduced 50 lost rows in
 * one run even though nothing else changed. Do not "simplify away" that flush;
 * it is one of the paths this invariant now depends on structurally, not just
 * incidentally.
 *
 * Two tests:
 *  - an end-to-end interrupt + resume over two tables, proving no rows are lost;
 *  - a checkpoint-invariant probe (mirroring the manual verification that found
 *    the gap) asserting every checkpoint this run saves is fully backed by rows
 *    already durable in the store.
 */

import { expect } from 'chai';
import type { WriteOptions } from '@quereus/store';
import type { ApplyToStoreCallback, SnapshotChunk, SnapshotHeaderChunk } from '../../src/sync/protocol.js';
import { DATA_FLUSH_SIZE } from '../../src/sync/snapshot-stream.js';
import { closePeer, collect, localWrite, makePeer, toStream, type Peer } from './_peer-harness.js';

/** The table under test: above the DATA_FLUSH_SIZE bound so it leaves a trailing sub-batch. */
const ROWS = DATA_FLUSH_SIZE + 50;

/**
 * Large enough that its OWN column-version writes, combined with ROWS' carried-over
 * (unflushed) metadata batch, cross the receiver's internal BATCH_FLUSH_SIZE (1000)
 * bound well before this table's row loop finishes — the only way to force a real
 * mid-stream checkpoint save without reaching into module internals.
 */
const FILLER_ROWS = 1000;

/** Above BATCH_FLUSH_SIZE (1000) so a fully-deleted table's tombstone flush crosses it. */
const GHOST_ROWS = 1200;

const chunksOf = async (peer: Peer): Promise<SnapshotChunk[]> => {
	const chunks: SnapshotChunk[] = [];
	for await (const c of peer.manager.getSnapshotStream()) chunks.push(c);
	return chunks;
};

const countRows = async (peer: Peer, table: string): Promise<number> =>
	Number((await collect(peer.db, `select count(*) as n from ${table}`))[0].n);

/** Create `table` and fill it with `rows` rows in one source transaction. */
async function seedTable(peer: Peer, table: string, rows: number): Promise<void> {
	await peer.db.exec(`create table ${table} (id integer primary key, v text) using store`);
	const values = Array.from({ length: rows }, (_, i) => `(${i + 1}, 'v${i + 1}')`).join(', ');
	await localWrite(peer, `insert into ${table} (id, v) values ${values}`);
}

/**
 * Replay `chunks` until one of type `stopBeforeType`, then throw instead of
 * yielding it — a dropped connection mid-transfer, never reaching the footer
 * (or whatever chunk type is named).
 */
async function* interruptedStream(
	chunks: SnapshotChunk[],
	stopBeforeType: SnapshotChunk['type'],
): AsyncIterable<SnapshotChunk> {
	for (const c of chunks) {
		if (c.type === stopBeforeType) throw new Error('simulated connection drop mid-transfer');
		yield c;
	}
}

describe('resuming an interrupted snapshot transfer', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender');
		receiver = await makePeer('receiver');
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('a table completed before the drop keeps every row; a table still in flight is replayed in full', async function () {
		this.timeout(10000);

		await seedTable(sender, 'big', ROWS);
		await seedTable(sender, 'filler', FILLER_ROWS);

		const chunks = await chunksOf(sender);
		const header = chunks.find((c): c is SnapshotHeaderChunk => c.type === 'header');
		if (!header) throw new Error('sender stream has no header chunk');

		let thrown: unknown;
		try {
			await receiver.manager.applySnapshotStream(interruptedStream(chunks, 'footer'));
		} catch (error) {
			thrown = error;
		}
		expect(thrown, 'the dropped connection surfaces as a rejection').to.be.instanceOf(Error);

		const checkpoint = await receiver.manager.getSnapshotCheckpoint(header.snapshotId);
		expect(checkpoint, 'a checkpoint survived the interruption').to.not.equal(undefined);
		expect(checkpoint!.completedTables, 'only the fully-flushed table is marked complete')
			.to.deep.equal(['main.big']);

		await receiver.manager.applySnapshotStream(sender.manager.resumeSnapshotStream(checkpoint!));

		expect(await countRows(receiver, 'big'), 'the completed table kept every row').to.equal(ROWS);
		expect(await collect(receiver.db, `select v from big where id = ${ROWS}`), 'its last row is intact')
			.to.deep.equal([{ v: `v${ROWS}` }]);

		expect(await countRows(receiver, 'filler'), 'the resumed table caught up fully').to.equal(FILLER_ROWS);
		expect(await collect(receiver.db, `select v from filler where id = ${FILLER_ROWS}`), 'its last row is intact')
			.to.deep.equal([{ v: `v${FILLER_ROWS}` }]);

		expect(await receiver.manager.getSnapshotCheckpoint(header.snapshotId), 'checkpoint cleared on completion')
			.to.equal(undefined);
	});
});

describe('checkpoint invariant probe', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender');
		receiver = await makePeer('receiver');
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('every checkpoint this run saves is fully backed by rows already applied', async function () {
		this.timeout(10000);

		// `big` gives a table whose trailing (sub-DATA_FLUSH_SIZE) rows must survive.
		// `ghost` is inserted then fully deleted so its 1200 tombstones (no live
		// column-versions) push the receiver's tombstone flush past BATCH_FLUSH_SIZE
		// (1000) — the exact combination that fires a real mid-stream checkpoint save.
		await seedTable(sender, 'big', ROWS);
		await sender.db.exec('create table ghost (id integer primary key, v text) using store');
		const ghostValues = Array.from({ length: GHOST_ROWS }, (_, i) => `(${i + 1}, 'v${i + 1}')`).join(', ');
		await localWrite(sender, `insert into ghost (id, v) values ${ghostValues}`);
		await localWrite(sender, 'delete from ghost');

		const chunks = await chunksOf(sender);

		// Count rows actually returned from `applyDataToStore` (durably applied),
		// not merely handed to it.
		let rowsApplied = 0;
		const managerInternals = receiver.manager as unknown as { applyToStore?: ApplyToStoreCallback };
		const originalApplyToStore = managerInternals.applyToStore;
		managerInternals.applyToStore = async (dataChanges, schemaChanges, options) => {
			const result = await originalApplyToStore!(dataChanges, schemaChanges, options);
			rowsApplied += dataChanges.length;
			return result;
		};

		// Snapshot `rowsApplied` at the moment of every `sc:` checkpoint write.
		const checkpointSaves: Array<{ completedTables: string[]; rowsAppliedAtSave: number }> = [];
		const originalPut = receiver.manager.kv.put.bind(receiver.manager.kv);
		receiver.manager.kv.put = async (key: Uint8Array, value: Uint8Array, options?: WriteOptions) => {
			if (new TextDecoder().decode(key).startsWith('sc:')) {
				const parsed = JSON.parse(new TextDecoder().decode(value)) as { completedTables: string[] };
				checkpointSaves.push({ completedTables: [...parsed.completedTables], rowsAppliedAtSave: rowsApplied });
			}
			return originalPut(key, value, options);
		};

		await receiver.manager.applySnapshotStream(toStream(chunks));

		expect(checkpointSaves.length, 'the ghost tombstone flush fired exactly one mid-stream checkpoint')
			.to.equal(1);
		for (const save of checkpointSaves) {
			if (save.completedTables.includes('main.big')) {
				expect(save.rowsAppliedAtSave, 'big is claimed complete only once all its rows are durable')
					.to.be.at.least(ROWS);
			}
		}

		expect(await countRows(receiver, 'big'), 'all of big landed').to.equal(ROWS);
	});
});
