/**
 * A snapshot must carry its DDL in CAUSAL order, not `sm:` key order.
 *
 * Migrations are filed under `sm:⟨schema⟩⟨kind⟩⟨object⟩{version}`, so the key scan
 * yields every `index`-kind migration of a schema ahead of every `table`-kind one.
 * Both snapshot consumers replay the DDL list in order, so an unsorted list hands a
 * fresh receiver `create index note_idx on orders (...)` before `create table orders`
 * — which fails outright with `no such table: orders`, aborting the bootstrap.
 *
 * The producers therefore order by HLC (`sortMigrationsByHLC`), and both consumers
 * re-sort rather than trust the sender's list.
 */

import { expect } from 'chai';
import type { SnapshotChunk, SnapshotSchemaMigrationChunk } from '../../src/sync/protocol.js';
import { closePeer, collect, localWrite, makePeer, toStream, type Peer } from './_peer-harness.js';

const INDEX_NAME = 'note_idx';

const chunksOf = async (peer: Peer): Promise<SnapshotChunk[]> => {
	const chunks: SnapshotChunk[] = [];
	for await (const c of peer.manager.getSnapshotStream()) chunks.push(c);
	return chunks;
};

const hasIndex = (peer: Peer): boolean =>
	peer.db.schemaManager.findIndexOwner('main', INDEX_NAME)?.table.name === 'orders';

describe('snapshot DDL is ordered causally, not by key', () => {
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender', { createOrders: true });
		receiver = await makePeer('receiver'); // fresh: no `orders`, no index
		// An index whose migration sorts BEFORE its table's under `sm:` key order.
		await localWrite(sender, `create index ${INDEX_NAME} on orders (note)`);
		await localWrite(sender, "insert into orders (id, note) values (1, 'a')");
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('the streaming producer emits create_table before add_index', async () => {
		const migrations = (await chunksOf(sender))
			.filter((c): c is SnapshotSchemaMigrationChunk => c.type === 'schema-migration')
			.map(c => c.migration.type);

		expect(migrations.indexOf('create_table'), 'the table is created first')
			.to.be.lessThan(migrations.indexOf('add_index'));
	});

	it('a fresh receiver bootstraps table and index from a streamed snapshot', async () => {
		await receiver.manager.applySnapshotStream(toStream(await chunksOf(sender)));

		expect(hasIndex(receiver), 'the index bootstrapped').to.be.true;
		expect(await collect(receiver.db, 'select note from orders where id = 1'))
			.to.deep.equal([{ note: 'a' }]);
	});

	it('a fresh receiver bootstraps table and index from a whole snapshot', async () => {
		await receiver.manager.applySnapshot(await sender.manager.getSnapshot());

		expect(hasIndex(receiver), 'the index bootstrapped').to.be.true;
		expect(await collect(receiver.db, 'select note from orders where id = 1'))
			.to.deep.equal([{ note: 'a' }]);
	});

	it('a whole-snapshot consumer re-sorts a sender that shipped key order', async () => {
		// A peer on an older/other implementation may ship the raw `sm:` scan order.
		const snapshot = await sender.manager.getSnapshot();
		const reversed = { ...snapshot, schemaMigrations: [...snapshot.schemaMigrations].reverse() };

		await receiver.manager.applySnapshot(reversed);

		expect(hasIndex(receiver), 'the index bootstrapped despite the sender order').to.be.true;
	});

	it('a streaming consumer re-sorts a sender that shipped key order', async () => {
		const chunks = await chunksOf(sender);
		const migrations = chunks.filter(c => c.type === 'schema-migration').reverse();
		const rest = chunks.filter(c => c.type !== 'schema-migration');
		// Header first, then the reversed DDL, then the data — mirrors a sender that
		// keeps the DDL-before-data contract but not the causal order within it.
		const shuffled = [rest[0], ...migrations, ...rest.slice(1)];

		await receiver.manager.applySnapshotStream(toStream(shuffled));

		expect(hasIndex(receiver), 'the index bootstrapped despite the sender order').to.be.true;
	});

});

describe('snapshot DDL replays create-then-rename in causal order', () => {
	// Own peers, NOT the shared beforeEach above: that one inserts a PRE-rename row,
	// whose sync bookkeeping is keyed by table name and so would snapshot under the
	// old name — a table the replayed DDL has renamed away
	// (bug-sync-rename-and-pk-change-strand-crdt-metadata). Data here is inserted
	// only after the rename.
	let sender: Peer;
	let receiver: Peer;

	beforeEach(async () => {
		sender = await makePeer('sender', { createOrders: true });
		receiver = await makePeer('receiver');
		await localWrite(sender, 'alter table orders rename to orders2');
		await localWrite(sender, "insert into orders2 (id, note) values (2, 'renamed')");
	});

	afterEach(async () => {
		await closePeer(sender);
		await closePeer(receiver);
	});

	it('a fresh receiver bootstraps the renamed table from a streamed snapshot', async () => {
		// The rename must replay AFTER the create it renames — a fresh peer holds
		// neither name, so out-of-order replay would leave the rename undecidable
		// (converged without applying) and the receiver stuck on the old name.
		const chunks: SnapshotChunk[] = [];
		for await (const c of sender.manager.getSnapshotStream()) chunks.push(c);
		const migrations = chunks
			.filter((c): c is SnapshotSchemaMigrationChunk => c.type === 'schema-migration')
			.map(c => c.migration.type);
		expect(migrations.indexOf('create_table'), 'create emitted before rename')
			.to.be.lessThan(migrations.indexOf('rename_table'));

		await receiver.manager.applySnapshotStream(toStream(chunks));

		expect(receiver.db.schemaManager.getTable('main', 'orders2'), 'orders2 bootstrapped').to.not.be.undefined;
		expect(receiver.db.schemaManager.getTable('main', 'orders'), 'orders renamed away').to.be.undefined;
		expect(await collect(receiver.db, 'select note from orders2 where id = 2'))
			.to.deep.equal([{ note: 'renamed' }]);
	});

	it('a fresh receiver bootstraps the renamed table from a whole snapshot', async () => {
		await receiver.manager.applySnapshot(await sender.manager.getSnapshot());

		expect(receiver.db.schemaManager.getTable('main', 'orders2'), 'orders2 bootstrapped').to.not.be.undefined;
		expect(receiver.db.schemaManager.getTable('main', 'orders'), 'orders renamed away').to.be.undefined;
		expect(await collect(receiver.db, 'select note from orders2 where id = 2'))
			.to.deep.equal([{ note: 'renamed' }]);
	});
});
