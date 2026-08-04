/**
 * Table alterations actually reach a peer (`store-adapter.ts` § `decideAlterTable`
 * plus the scoped remote-event marking in `StoreEventEmitter`).
 *
 * Every `ALTER TABLE` statement's schema-change event carries the statement's
 * canonical SQL, recorded as an `alter_column` migration and re-executed on the
 * receiver. These specs drive each alteration arm end to end over two real
 * engines via `relayAll`, asserting with `generateTableDDL` — one comparison
 * that covers shape, order, types, nullability, collation, defaults and
 * constraints at once. `RENAME TO` is deliberately absent: replicating it needs
 * the old name on the wire and a data-routing fix (`sync-replicate-rename-table`).
 */

import { expect } from 'chai';
import { generateTableDDL } from '@quereus/quereus';
import {
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
