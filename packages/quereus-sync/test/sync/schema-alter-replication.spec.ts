/**
 * Table alterations actually reach a peer (`store-adapter.ts` § `decideAlterTable`
 * plus the scoped remote-event marking in `StoreEventEmitter`).
 *
 * Every `ALTER TABLE` statement's schema-change event carries the statement's
 * canonical SQL, recorded as an `alter_column` migration and re-executed on the
 * receiver. These specs drive each alteration arm end to end over two real
 * engines via `relayAll`, asserting with `generateTableDDL` — one comparison
 * that covers shape, order, types, nullability, collation, defaults and
 * constraints at once. `RENAME TO` is the exception: it records its own
 * `rename_table` migration carrying the old name (`fromTable`), decided by
 * `decideRenameTable` and routed through `computeBatchTableFates` so data for
 * the new name keeps flowing in the very batch that renames — see the
 * `rename to` block at the end.
 */

import { expect } from 'chai';
import { generateTableDDL } from '@quereus/quereus';
import { compareHLC } from '../../src/clock/hlc.js';
import {
	COLUMNS_PER_FRESH_INSERT,
	DEFAULT_ORDERS_DDL,
	closePeer,
	collect,
	localWrite,
	makePeer,
	relayAll,
	settle,
	type Peer,
} from './_peer-harness.js';

/** Wider `orders` shape for the arms that need a spare / typed column to work on. */
const WIDE_ORDERS_DDL =
	'create table orders (id integer primary key, note text, extra text null, qty text null) using store';

/** Two peers that each already created the identical `orders` table. */
async function makeSyncedPair(ordersDdl: string = DEFAULT_ORDERS_DDL): Promise<[Peer, Peer]> {
	const a = await makePeer('a', { createOrders: true, ordersDdl });
	const b = await makePeer('b', { createOrders: true, ordersDdl });
	return [a, b];
}

const tableDDL = (peer: Peer): string =>
	generateTableDDL(peer.db.schemaManager.getTable('main', 'orders')!);

/** Assert `b` renders the identical canonical table DDL as `a`. */
const expectConverged = (a: Peer, b: Peer): void => {
	expect(tableDDL(b), 'receiver table DDL').to.equal(tableDDL(a));
};

describe('alter table replication', () => {
	describe('each alteration arm replicates', () => {
		let a: Peer;
		let b: Peer;

		beforeEach(async () => {
			[a, b] = await makeSyncedPair(WIDE_ORDERS_DDL);
		});

		afterEach(async () => {
			await closePeer(a);
			await closePeer(b);
		});

		it('add column, and data lands in the new column afterwards', async () => {
			await localWrite(a, 'alter table orders add column sku text null');
			await relayAll(a, b);
			expectConverged(a, b);

			await localWrite(a, "insert into orders (id, note, sku) values (1, 'n', 'S-1')");
			await relayAll(a, b);
			expect(await collect(b.db, 'select id, sku from orders')).to.deep.equal([{ id: 1, sku: 'S-1' }]);
		});

		it('drop column, and rows for surviving columns still land', async () => {
			await localWrite(a, 'alter table orders drop column extra');
			await relayAll(a, b);
			expectConverged(a, b);
			expect(b.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase()))
				.to.not.include('extra');

			await localWrite(a, "insert into orders (id, note) values (1, 'kept')");
			await relayAll(a, b);
			expect(await collect(b.db, 'select id, note from orders')).to.deep.equal([{ id: 1, note: 'kept' }]);
		});

		it('rename column, and data addressed by the new name flows', async () => {
			await localWrite(a, 'alter table orders rename column note to memo');
			await relayAll(a, b);
			expectConverged(a, b);

			await localWrite(a, "insert into orders (id, memo) values (1, 'renamed')");
			await relayAll(a, b);
			expect(await collect(b.db, 'select id, memo from orders')).to.deep.equal([{ id: 1, memo: 'renamed' }]);
		});

		it('add constraint, and the replicated constraint ENFORCES on the receiver', async () => {
			await localWrite(a, 'alter table orders add constraint orders_note_u unique (note)');
			await relayAll(a, b);
			expectConverged(a, b);

			await b.db.exec("insert into orders (id, note) values (1, 'dup')");
			let caught: Error | undefined;
			try {
				await b.db.exec("insert into orders (id, note) values (2, 'dup')");
			} catch (e) {
				caught = e as Error;
			}
			expect(caught, 'duplicate rejected on b').to.be.instanceOf(Error);
		});

		it('drop constraint', async () => {
			await localWrite(a, 'alter table orders add constraint orders_note_u unique (note)');
			await relayAll(a, b);
			await localWrite(a, 'alter table orders drop constraint orders_note_u');
			await relayAll(a, b);
			expectConverged(a, b);
			expect((b.db.schemaManager.getTable('main', 'orders')!.uniqueConstraints ?? [])
				.map(uc => uc.name)).to.not.include('orders_note_u');
		});

		it('rename constraint', async () => {
			await localWrite(a, 'alter table orders add constraint orders_note_u unique (note)');
			await relayAll(a, b);
			await localWrite(a, 'alter table orders rename constraint orders_note_u to orders_note_uq');
			await relayAll(a, b);
			expectConverged(a, b);
			expect((b.db.schemaManager.getTable('main', 'orders')!.uniqueConstraints ?? [])
				.map(uc => uc.name)).to.include('orders_note_uq');
		});

		it('alter column set data type', async () => {
			await localWrite(a, 'alter table orders alter column qty set data type integer');
			await relayAll(a, b);
			expectConverged(a, b);
			expect(b.db.schemaManager.getTable('main', 'orders')!
				.columns.find(c => c.name.toLowerCase() === 'qty')!.logicalType.name).to.equal('INTEGER');
		});

		it('alter column drop not null / set not null', async () => {
			await localWrite(a, 'alter table orders alter column note drop not null');
			await relayAll(a, b);
			expectConverged(a, b);
			expect(b.db.schemaManager.getTable('main', 'orders')!
				.columns.find(c => c.name.toLowerCase() === 'note')!.notNull).to.equal(false);

			await localWrite(a, 'alter table orders alter column note set not null');
			await relayAll(a, b);
			expectConverged(a, b);
			expect(b.db.schemaManager.getTable('main', 'orders')!
				.columns.find(c => c.name.toLowerCase() === 'note')!.notNull).to.equal(true);
		});

		it('alter column set default / drop default', async () => {
			await localWrite(a, "alter table orders alter column note set default 'pending'");
			await relayAll(a, b);
			expectConverged(a, b);

			await localWrite(a, 'alter table orders alter column note drop default');
			await relayAll(a, b);
			expectConverged(a, b);
			expect(b.db.schemaManager.getTable('main', 'orders')!
				.columns.find(c => c.name.toLowerCase() === 'note')!.defaultValue).to.equal(null);
		});

		it('alter column set collate', async () => {
			await localWrite(a, 'alter table orders alter column note set collate nocase');
			await relayAll(a, b);
			expectConverged(a, b);
			expect(b.db.schemaManager.getTable('main', 'orders')!
				.columns.find(c => c.name.toLowerCase() === 'note')!.collation.toLowerCase()).to.equal('nocase');
		});

		it('alter primary key', async () => {
			await localWrite(a, 'alter table orders alter primary key (id, note)');
			await relayAll(a, b);
			expectConverged(a, b);
			const pk = b.db.schemaManager.getTable('main', 'orders')!;
			expect(pk.primaryKeyDefinition.map(d => pk.columns[d.index].name.toLowerCase()))
				.to.deep.equal(['id', 'note']);
		});
	});

	describe('convergence and divergence', () => {
		let a: Peer;
		let b: Peer;

		beforeEach(async () => {
			[a, b] = await makeSyncedPair();
			// Reconcile the two independent `create table orders` migrations FIRST, so
			// later relays carry only the alterations under test. Without this, a's
			// table drifts from its original CREATE via the alteration, and b's
			// still-unreconciled create_table migration then conflicts against the
			// drifted definition — a pre-existing property of the create_table
			// comparison, not the alteration path.
			await relayAll(a, b);
			await relayAll(b, a);
		});

		afterEach(async () => {
			await closePeer(a);
			await closePeer(b);
		});

		it('both peers independently run the identical alteration and converge, both directions', async () => {
			// `localWrite` settles 25ms between the two, so b's migration always carries
			// the strictly greater HLC. a → b is then absorbed by the version guard in
			// `change-applicator`; b → a is ADMITTED and reaches `decideAlterTable`'s
			// already-applied arm — both directions are needed to cover both gates.
			await localWrite(a, 'alter table orders add column sku text null');
			await localWrite(b, 'alter table orders add column sku text null');

			await relayAll(a, b);
			await relayAll(b, a);

			for (const peer of [a, b]) {
				const cols = peer.db.schemaManager.getTable('main', 'orders')!.columns
					.filter(c => c.name.toLowerCase() === 'sku');
				expect(cols, `${peer.name} sku column`).to.have.lengthOf(1);
			}
			expectConverged(a, b);
		});

		it('two alterations of one table in one relay apply in order', async () => {
			await localWrite(a, 'alter table orders add column c1 text null');
			await localWrite(a, 'alter table orders add column c2 text null');

			await relayAll(a, b);

			expect(b.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase()))
				.to.deep.equal(['id', 'note', 'c1', 'c2']);
			expectConverged(a, b);
		});

		it('the same batch applied twice converges', async () => {
			await localWrite(a, 'alter table orders add column sku text null');
			const sets = await a.manager.getChangesSince(b.manager.getSiteId());

			await b.manager.applyChanges(sets);
			await b.manager.applyChanges(sets);

			expect(b.db.schemaManager.getTable('main', 'orders')!.columns
				.filter(c => c.name.toLowerCase() === 'sku')).to.have.lengthOf(1);
		});

		it('a divergent same-name add column surfaces a conflict naming both types', async () => {
			await localWrite(a, 'alter table orders add column sku text null');
			await localWrite(b, 'alter table orders add column sku integer null');

			let caught: Error | undefined;
			try {
				await relayAll(b, a);
			} catch (e) {
				caught = e as Error;
			}

			expect(caught, 'expected the divergent add column to be surfaced').to.be.instanceOf(Error);
			expect(caught!.message).to.include('main.orders');
			expect(caught!.message).to.include('sku');
			expect(caught!.message).to.include('TEXT');
			expect(caught!.message).to.include('INTEGER');
		});

		it('a genuine LOCAL alteration on the receiver is still captured after a relay', async () => {
			// The regression the old one-for-one expectation registry produced: residue
			// from a replicated statement swallowed the next local DDL of the same
			// signature, so it never replicated.
			await localWrite(a, 'alter table orders add column sku text null');
			await relayAll(a, b);

			await localWrite(b, 'alter table orders add column local_col text null');

			const sets = await b.manager.getChangesSince(a.manager.getSiteId());
			const migrations = sets.flatMap(cs => [...cs.schemaMigrations]);
			expect(
				migrations.some(m => m.type === 'alter_column' && m.ddl.toLowerCase().includes('local_col')),
				'local alteration present in b\'s outbound changes',
			).to.equal(true);

			await relayAll(b, a);
			expect(a.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase()))
				.to.include('local_col');
		});
	});

	describe('rename to', () => {
		let a: Peer;
		let b: Peer;

		const hasTable = (peer: Peer, name: string): boolean =>
			peer.db.schemaManager.getTable('main', name) !== undefined;

		const ddlOf = (peer: Peer, name: string): string =>
			generateTableDDL(peer.db.schemaManager.getTable('main', name)!);

		beforeEach(async () => {
			[a, b] = await makeSyncedPair();
			// Reconcile the two independent `create table orders` migrations first —
			// same reason as the convergence describe, plus one rename-specific twist:
			// after a renames `orders` away, an unreconciled create_table for `orders`
			// arriving later from b would find the name free and re-create it.
			await relayAll(a, b);
			await relayAll(b, a);
		});

		afterEach(async () => {
			await closePeer(a);
			await closePeer(b);
		});

		it('the rename reaches the peer: b has orders2, no orders, identical DDL', async () => {
			await localWrite(a, 'alter table orders rename to orders2');

			const res = await relayAll(a, b);

			expect(res.unknownTable ?? 0, 'nothing diverted').to.equal(0);
			expect(hasTable(b, 'orders2'), 'b has orders2').to.equal(true);
			expect(hasTable(b, 'orders'), 'b no longer has orders').to.equal(false);
			expect(ddlOf(b, 'orders2'), 'receiver table DDL').to.equal(ddlOf(a, 'orders2'));
		});

		it('data keeps flowing across the rename (the headline case)', async () => {
			// Pre-rename row lands on b under the old name first (incremental sync).
			await localWrite(a, "insert into orders (id, note) values (1, 'before')");
			const preSets = await a.manager.getChangesSince(b.manager.getSiteId());
			await b.manager.applyChanges(preSets);
			await settle();
			expect(await collect(b.db, 'select note from orders where id = 1'))
				.to.deep.equal([{ note: 'before' }]);

			// Watermark the way a real consumer does — `lastSyncHLC = ChangeSet.hlc`
			// (each set's MAX fact HLC) — so the next pull is a true incremental
			// delta: [rename, post-rename row] in one batch. (`getCurrentHLC` reads
			// clock STATE, which equals the last transaction's base — not past it.)
			const since = preSets
				.map(cs => cs.hlc)
				.reduce((max, h) => (compareHLC(h, max) > 0 ? h : max));
			await localWrite(a, 'alter table orders rename to orders2');
			await localWrite(a, "insert into orders2 (id, note) values (2, 'after')");

			const sets = await a.manager.getChangesSince(b.manager.getSiteId(), since);
			const res = await b.manager.applyChanges(sets);
			await settle();

			expect(res.unknownTable ?? 0, 'no rows filed under an unknown table').to.equal(0);
			// The post-rename row landed, and the pre-rename row survived the rename.
			expect(await collect(b.db, 'select id, note from orders2 order by id')).to.deep.equal([
				{ id: 1, note: 'before' },
				{ id: 2, note: 'after' },
			]);
			expect(hasTable(b, 'orders'), 'b no longer has orders').to.equal(false);
			expect(ddlOf(b, 'orders2')).to.equal(ddlOf(a, 'orders2'));
		});

		it('a rename in the same transaction as writes files every fact under the new name', async () => {
			// The engine's renameBatchedEvents relabels the batched insert to the new
			// name before commit, so the wire batch never mentions `orders` for data.
			await a.db.exec('begin');
			await a.db.exec("insert into orders (id, note) values (7, 'tx')");
			await a.db.exec('alter table orders rename to orders2');
			await a.db.exec('commit');
			await settle();

			const sets = await a.manager.getChangesSince(b.manager.getSiteId());
			const txChanges = sets.flatMap(cs => [...cs.changes]);
			expect(txChanges.length, 'the insert was captured').to.be.greaterThan(0);
			expect(txChanges.every(c => c.table === 'orders2'), 'all facts under the new name').to.equal(true);

			const res = await b.manager.applyChanges(sets);
			await settle();
			expect(res.unknownTable ?? 0).to.equal(0);
			expect(await collect(b.db, 'select note from orders2 where id = 7'))
				.to.deep.equal([{ note: 'tx' }]);
		});

		it('rename onto an independently created table throws naming both, and half-applies nothing', async () => {
			await localWrite(b, 'create table orders2 (x text primary key) using store');
			await localWrite(a, 'alter table orders rename to orders2');

			let caught: Error | undefined;
			try {
				await relayAll(a, b);
			} catch (e) {
				caught = e as Error;
			}

			expect(caught, 'the collision surfaces').to.be.instanceOf(Error);
			expect(caught!.message).to.include('orders');
			expect(caught!.message).to.include('orders2');
			// Nothing half-applied: b keeps its own orders AND its own orders2 shape.
			expect(hasTable(b, 'orders'), 'b keeps orders').to.equal(true);
			expect(b.db.schemaManager.getTable('main', 'orders2')!.columns.map(c => c.name.toLowerCase()))
				.to.deep.equal(['x']);
		});

		it('both peers independently rename and converge, both directions', async () => {
			// Same two-gate shape as the identical-alteration test: a → b absorbed by
			// the version guard, b → a admitted and resolved by decideRenameTable's
			// already-applied arm (old absent, new present).
			await localWrite(a, 'alter table orders rename to orders2');
			await localWrite(b, 'alter table orders rename to orders2');

			await relayAll(a, b);
			await relayAll(b, a);

			for (const peer of [a, b]) {
				expect(hasTable(peer, 'orders2'), `${peer.name} has orders2`).to.equal(true);
				expect(hasTable(peer, 'orders'), `${peer.name} has no orders`).to.equal(false);
			}
			expect(ddlOf(b, 'orders2')).to.equal(ddlOf(a, 'orders2'));
		});

		it('a rename of a table the receiver dropped converges without applying (drop wins)', async () => {
			await localWrite(b, 'drop table orders');
			await localWrite(a, 'alter table orders rename to orders2');

			const res = await relayAll(a, b);

			expect(res, 'no throw').to.be.an('object');
			expect(hasTable(b, 'orders'), 'orders stays dropped').to.equal(false);
			expect(hasTable(b, 'orders2'), 'nothing was renamed into being').to.equal(false);
		});

		it('a rename_table without fromTable (an omitting peer) is undecidable and converges', async () => {
			await localWrite(a, 'alter table orders rename to orders2');
			const sets = await a.manager.getChangesSince(b.manager.getSiteId());
			const stripped = sets.map(cs => ({
				...cs,
				schemaMigrations: cs.schemaMigrations.map(m =>
					m.type === 'rename_table' ? (({ fromTable: _ft, ...rest }) => rest)(m) : m),
			}));

			const res = await b.manager.applyChanges(stripped);
			await settle();

			expect(res, 'no throw').to.be.an('object');
			expect(hasTable(b, 'orders'), 'b keeps orders — the rename was undecidable').to.equal(true);
			expect(hasTable(b, 'orders2')).to.equal(false);
		});

		it('chained rename orders → orders2 → orders3 in one batch leaves only orders3', async () => {
			await localWrite(a, 'alter table orders rename to orders2');
			await localWrite(a, 'alter table orders2 rename to orders3');

			const res = await relayAll(a, b);

			expect(res.unknownTable ?? 0).to.equal(0);
			expect(hasTable(b, 'orders'), 'orders gone').to.equal(false);
			expect(hasTable(b, 'orders2'), 'orders2 gone').to.equal(false);
			expect(hasTable(b, 'orders3'), 'orders3 present').to.equal(true);
			expect(ddlOf(b, 'orders3')).to.equal(ddlOf(a, 'orders3'));
		});

		it('rename then drop in one batch leaves neither name', async () => {
			await localWrite(a, 'alter table orders rename to orders2');
			await localWrite(a, 'drop table orders2');

			await relayAll(a, b);

			expect(hasTable(b, 'orders'), 'orders gone').to.equal(false);
			expect(hasTable(b, 'orders2'), 'orders2 gone').to.equal(false);
		});

		it('rename then rename back in one batch leaves the original name', async () => {
			await localWrite(a, 'alter table orders rename to orders2');
			await localWrite(a, 'alter table orders2 rename to orders');

			await relayAll(a, b);

			expect(hasTable(b, 'orders'), 'orders back').to.equal(true);
			expect(hasTable(b, 'orders2'), 'orders2 gone').to.equal(false);
			expect(ddlOf(b, 'orders')).to.equal(ddlOf(a, 'orders'));
		});

		it('a relayed rename keeps fromTable and stays decidable at a third peer', async () => {
			// The receiver records the inbound migration into its own metadata; if that
			// record dropped fromTable, b's re-relay (and its snapshots) would ship the
			// rename undecidable and c would silently keep the old name.
			await localWrite(a, 'alter table orders rename to orders2');
			await relayAll(a, b);

			const c = await makePeer('c');
			try {
				const outbound = (await b.manager.getChangesSince(c.manager.getSiteId()))
					.flatMap(cs => [...cs.schemaMigrations]);
				const rename = outbound.find(m => m.type === 'rename_table');
				expect(rename, 'b re-relays the rename').to.not.equal(undefined);
				expect(rename!.fromTable, 'with the old name intact').to.equal('orders');

				await relayAll(b, c);
				expect(c.db.schemaManager.getTable('main', 'orders2'), 'c applied the rename').to.not.be.undefined;
				expect(c.db.schemaManager.getTable('main', 'orders'), 'c has no orders').to.be.undefined;
			} finally {
				await closePeer(c);
			}
		});

		it('the same rename batch delivered twice is absorbed by the version guard', async () => {
			await localWrite(a, 'alter table orders rename to orders2');
			const sets = await a.manager.getChangesSince(b.manager.getSiteId());

			await b.manager.applyChanges(sets);
			const second = await b.manager.applyChanges(sets);
			await settle();

			expect(second.applied, 'nothing new on the second pass').to.equal(0);
			expect(hasTable(b, 'orders2')).to.equal(true);
			expect(hasTable(b, 'orders')).to.equal(false);
		});
	});

	/**
	 * The two DECLINED renames from the `rename to` block above — `a rename of a table the
	 * receiver dropped converges without applying (drop wins)` and `a rename_table without
	 * fromTable (an omitting peer) is undecidable and converges` — replayed with the origin
	 * also writing ROWS under the new name in the very same batch.
	 *
	 * The receiver must NOT route those rows to the new name. It never applies the rename,
	 * so the new name does not exist, and the store adapter's external-write lookup throws:
	 * the whole batch aborts with its watermark unadvanced, and the SAME batch then re-throws
	 * on every subsequent sync, with every later change from that peer stuck behind it. Rows
	 * for a declined rename take the ordinary unknown-table route instead. Each case
	 * re-delivers the batch, because the user-visible symptom was the endless retry rather
	 * than the single throw.
	 *
	 * These peers are asymmetric on purpose, unlike the `makeSyncedPair` block above: the
	 * receiver takes `orders` by REPLICATION rather than creating its own. Two peers that
	 * each run `create table orders` locally file competing `create_table` migrations at
	 * schemaVersion 1, and which one is HLC-dominated turns on the random site-id tie-break
	 * — so whether the receiver still holds `orders` would flip between runs.
	 */
	describe('rename to, carrying rows for the new name', () => {
		let origin: Peer;
		let receiver: Peer;

		const hasTable = (peer: Peer, name: string): boolean =>
			peer.db.schemaManager.getTable('main', name) !== undefined;

		beforeEach(async () => {
			origin = await makePeer('origin', { createOrders: true });
			receiver = await makePeer('receiver');
			await relayAll(origin, receiver);
			expect(hasTable(receiver, 'orders'), 'the receiver took orders by replication').to.equal(true);
		});

		afterEach(async () => {
			await closePeer(origin);
			await closePeer(receiver);
		});

		it('a rename of a table the receiver dropped diverts its rows instead of wedging the batch', async () => {
			await localWrite(receiver, 'drop table orders');
			await localWrite(origin, 'alter table orders rename to orders2');
			await localWrite(origin, "insert into orders2 (id, note) values (5, 'after')");

			const first = await relayAll(origin, receiver);

			// The rename migration is recorded (applied) but decided `already-applied` —
			// neither name exists here — and the re-delivered create_table is dominated.
			expect(first.applied, 'the rename_table migration is recorded').to.equal(1);
			expect(first.skipped, 'the dominated create_table').to.equal(1);
			expect(first.unknownTable, 'the row took the unknown-table route')
				.to.equal(COLUMNS_PER_FRESH_INSERT);
			expect(hasTable(receiver, 'orders'), 'orders stays dropped').to.equal(false);
			expect(hasTable(receiver, 'orders2'), 'nothing was renamed into being').to.equal(false);
			expect(await receiver.manager.quarantine.list('main', 'orders2'))
				.to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

			const second = await relayAll(origin, receiver);

			expect(second.applied, 'nothing new on the second pass').to.equal(0);
			expect(second.skipped, 'both migrations now dominated').to.equal(2);
			expect(second.unknownTable).to.equal(COLUMNS_PER_FRESH_INSERT);
			expect(hasTable(receiver, 'orders2')).to.equal(false);
		});

		it('a rename_table without fromTable diverts its rows instead of wedging the batch', async () => {
			await localWrite(origin, 'alter table orders rename to orders2');
			await localWrite(origin, "insert into orders2 (id, note) values (5, 'after')");

			const sets = await origin.manager.getChangesSince(receiver.manager.getSiteId());
			const stripped = sets.map(cs => ({
				...cs,
				schemaMigrations: cs.schemaMigrations.map(m =>
					m.type === 'rename_table' ? (({ fromTable: _ft, ...rest }) => rest)(m) : m),
			}));

			const first = await receiver.manager.applyChanges(stripped);
			await settle();

			expect(first.applied, 'the rename_table migration is recorded').to.equal(1);
			expect(first.skipped, 'the dominated create_table').to.equal(1);
			expect(first.unknownTable, 'the row took the unknown-table route')
				.to.equal(COLUMNS_PER_FRESH_INSERT);
			expect(hasTable(receiver, 'orders'), 'the receiver keeps orders — the rename was undecidable')
				.to.equal(true);
			expect(hasTable(receiver, 'orders2')).to.equal(false);
			expect(await receiver.manager.quarantine.list('main', 'orders2'))
				.to.have.lengthOf(COLUMNS_PER_FRESH_INSERT);

			const second = await receiver.manager.applyChanges(stripped);
			await settle();

			expect(second.applied, 'nothing new on the second pass').to.equal(0);
			expect(second.skipped, 'both migrations now dominated').to.equal(2);
			expect(second.unknownTable).to.equal(COLUMNS_PER_FRESH_INSERT);
			expect(hasTable(receiver, 'orders'), 'still orders').to.equal(true);
			expect(hasTable(receiver, 'orders2')).to.equal(false);
		});

		it('an undecidable rename still admits the same batch\'s rows for the OLD name', async () => {
			// The other half of the case above: an undecidable `rename_table` mentions no old
			// name, so the simulation records no fate for it at all and the row-admission gate
			// falls back to the basis. `orders` is still there, so its rows must land — only
			// the rows for the name the rename failed to bring into being are diverted.
			await localWrite(origin, "insert into orders (id, note) values (4, 'before')");
			await localWrite(origin, 'alter table orders rename to orders2');
			await localWrite(origin, "insert into orders2 (id, note) values (5, 'after')");

			const sets = await origin.manager.getChangesSince(receiver.manager.getSiteId());
			const stripped = sets.map(cs => ({
				...cs,
				schemaMigrations: cs.schemaMigrations.map(m =>
					m.type === 'rename_table' ? (({ fromTable: _ft, ...rest }) => rest)(m) : m),
			}));

			const result = await receiver.manager.applyChanges(stripped);
			await settle();

			expect(result.applied, 'the rename migration plus the pre-rename row\'s columns')
				.to.equal(1 + COLUMNS_PER_FRESH_INSERT);
			expect(result.unknownTable, 'only the post-rename row is diverted')
				.to.equal(COLUMNS_PER_FRESH_INSERT);
			expect(await collect(receiver.db, 'select id, note from orders order by id'))
				.to.deep.equal([{ id: 4, note: 'before' }]);
			expect(hasTable(receiver, 'orders2')).to.equal(false);
		});
	});

	describe('declarative apply schema', () => {
		it('an apply that adds and drops a column in one round replicates both alterations', async () => {
			const [a, b] = await makeSyncedPair(
				'create table orders (id integer primary key, note text null, extra text null) using store',
			);
			try {
				await a.db.exec(`
					declare schema main {
						table orders {
							id INTEGER PRIMARY KEY,
							note TEXT NULL,
							sku TEXT NULL
						}
					}
				`);
				await a.db.exec('apply schema main;');
				await settle();

				await relayAll(a, b);

				expect(b.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase()))
					.to.deep.equal(['id', 'note', 'sku']);
				expectConverged(a, b);
			} finally {
				await closePeer(a);
				await closePeer(b);
			}
		});
	});
});
