/**
 * Streaming-snapshot chunk ORDER: DDL before data.
 *
 * `applySnapshotStream` flushes accumulated rows to the store every
 * DATA_FLUSH_SIZE (100) entries. Those flushes carry whatever schema changes have
 * arrived so far, and the store adapter applies DDL before DML within one call —
 * so a `create table` that arrives AFTER the rows cannot save a flush that already
 * went out. The sender therefore emits every `schema-migration` chunk immediately
 * after the header, ahead of the first `table-start`.
 *
 * These tests pin both halves: the producer's order, and a real fresh-receiver
 * bootstrap of a table larger than the flush bound.
 */

import { expect } from 'chai';
import type { SnapshotChunk } from '../../src/sync/protocol.js';
import { DATA_FLUSH_SIZE } from '../../src/sync/snapshot-stream.js';
import { closePeer, collect, localWrite, makePeer, toStream, type Peer } from './_peer-harness.js';

/** Rows per table, above the receiver's flush bound so it flushes mid-table. */
const ROWS = DATA_FLUSH_SIZE + 50;

const chunksOf = async (peer: Peer): Promise<SnapshotChunk[]> => {
	const chunks: SnapshotChunk[] = [];
	for await (const c of peer.manager.getSnapshotStream()) chunks.push(c);
	return chunks;
};

const countRows = async (peer: Peer, table: string): Promise<number> =>
	Number((await collect(peer.db, `select count(*) as n from ${table}`))[0].n);

/** Create `table` and fill it with ROWS rows in one source transaction. */
async function seedBigTable(peer: Peer, table = 'big'): Promise<void> {
	await peer.db.exec(`create table ${table} (id integer primary key, v text) using store`);
	const values = Array.from({ length: ROWS }, (_, i) => `(${i + 1}, 'v${i + 1}')`).join(', ');
	await localWrite(peer, `insert into ${table} (id, v) values ${values}`);
}

describe('streaming snapshot emits schema before data', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender');
		receiver = await makePeer('receiver'); // fresh: no `big` table
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('every schema-migration chunk precedes the first table-start', async () => {
		await seedBigTable(sender);

		const types = (await chunksOf(sender)).map(c => c.type);

		expect(types[0], 'header first').to.equal('header');
		const firstTableStart = types.indexOf('table-start');
		const lastMigration = types.lastIndexOf('schema-migration');
		expect(lastMigration, 'the sender carries at least one migration').to.be.greaterThan(-1);
		expect(firstTableStart, 'the sender carries table data').to.be.greaterThan(-1);
		expect(lastMigration, 'all DDL precedes the first table section').to.be.lessThan(firstTableStart);
	});

	it('a fresh receiver bootstraps a table larger than the mid-table flush bound', async () => {
		await seedBigTable(sender);

		// Before DDL-first ordering this threw:
		//   apply-to-store failed for 100 change(s): main.big (update):
		//   Table not found for external write: main.big
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));

		expect(await countRows(receiver, 'big'), 'all rows bootstrapped').to.equal(ROWS);
		expect(await collect(receiver.db, `select v from big where id = ${ROWS}`), 'the last row is intact')
			.to.deep.equal([{ v: `v${ROWS}` }]);
	});

	it('bootstraps a SECOND large table, whose table-start finds no pending DDL', async () => {
		// The first `table-start` flushes every migration; later ones must be harmless
		// no-ops that still carry the prior table's trailing (sub-flush-bound) rows.
		await seedBigTable(sender, 'big');
		await seedBigTable(sender, 'big2');

		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));

		expect(await countRows(receiver, 'big'), 'first table complete').to.equal(ROWS);
		expect(await countRows(receiver, 'big2'), 'second table complete').to.equal(ROWS);
	});

	it('re-applying the same stream is idempotent (re-emitted DDL does not collide)', async () => {
		await seedBigTable(sender);
		const chunks = await chunksOf(sender);

		await receiver.manager.applySnapshotStream(toStream(chunks));
		// A resumed/retried transfer re-emits every migration; `decideSchemaChange`
		// skips a `create_table` whose object is already in the wanted state.
		await receiver.manager.applySnapshotStream(toStream(chunks));

		expect(await countRows(receiver, 'big'), 'no duplication').to.equal(ROWS);
	});
});
