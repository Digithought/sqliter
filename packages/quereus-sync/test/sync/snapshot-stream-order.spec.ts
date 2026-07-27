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
import { closePeer, collect, localWrite, makePeer, type Peer } from './_peer-harness.js';

async function* toStream(chunks: SnapshotChunk[]): AsyncIterable<SnapshotChunk> {
	for (const c of chunks) yield c;
}

/** Rows well above DATA_FLUSH_SIZE (100), so the receiver flushes mid-table. */
const ROWS = 150;

async function seedBigTable(peer: Peer): Promise<void> {
	await peer.db.exec('create table big (id integer primary key, v text) using store');
	const values = Array.from({ length: ROWS }, (_, i) => `(${i + 1}, 'v${i + 1}')`).join(', ');
	await localWrite(peer, `insert into big (id, v) values ${values}`);
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

		const types: string[] = [];
		for await (const chunk of sender.manager.getSnapshotStream()) types.push(chunk.type);

		expect(types[0], 'header first').to.equal('header');
		const firstTableStart = types.indexOf('table-start');
		const lastMigration = types.lastIndexOf('schema-migration');
		expect(lastMigration, 'the sender carries at least one migration').to.be.greaterThan(-1);
		expect(firstTableStart, 'the sender carries table data').to.be.greaterThan(-1);
		expect(lastMigration, 'all DDL precedes the first table section').to.be.lessThan(firstTableStart);
	});

	it('a fresh receiver bootstraps a table larger than the mid-table flush bound', async () => {
		await seedBigTable(sender);

		const chunks: SnapshotChunk[] = [];
		for await (const c of sender.manager.getSnapshotStream()) chunks.push(c);

		// Before DDL-first ordering this threw:
		//   apply-to-store failed for 100 change(s): main.big (update):
		//   Table not found for external write: main.big
		await receiver.manager.applySnapshotStream(toStream(chunks));

		expect(Number((await collect(receiver.db, 'select count(*) as n from big'))[0].n), 'all rows bootstrapped')
			.to.equal(ROWS);
		expect(await collect(receiver.db, 'select v from big where id = 150'), 'the last row is intact')
			.to.deep.equal([{ v: 'v150' }]);
	});

	it('re-applying the same stream is idempotent (re-emitted DDL does not collide)', async () => {
		await seedBigTable(sender);

		const chunks: SnapshotChunk[] = [];
		for await (const c of sender.manager.getSnapshotStream()) chunks.push(c);

		await receiver.manager.applySnapshotStream(toStream(chunks));
		// A resumed/retried transfer re-emits every migration; `decideSchemaChange`
		// skips a `create_table` whose object is already in the wanted state.
		await receiver.manager.applySnapshotStream(toStream(chunks));

		expect(Number((await collect(receiver.db, 'select count(*) as n from big'))[0].n), 'no duplication')
			.to.equal(ROWS);
	});
});
