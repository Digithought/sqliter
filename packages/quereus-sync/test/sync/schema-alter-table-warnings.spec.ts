/**
 * ALTER TABLE does not replicate today (see `tickets/backlog/feat-sync-replicate-alter-table.md`):
 * an `alter_column` migration always carries a blank DDL, so it crosses the wire
 * as an empty statement and the receiver runs nothing. Neither end used to say
 * so. These specs cover the warning added at each end — origin
 * (`recordSchemaMigration`, sync-manager-impl.ts) and receiver
 * (`applySchemaChange`, store-adapter.ts) — and that `create_table` / `drop_table`
 * / `add_index` / `drop_index`, which all carry real DDL, never trigger either
 * warning.
 */

import { expect } from 'chai';
import {
	DEFAULT_ORDERS_DDL,
	closePeer,
	localWrite,
	makePeer,
	relayAll,
	type Peer,
} from './_peer-harness.js';

const NOTE_INDEX = 'idx_orders_note_warn';
const CREATE_NOTE_INDEX = `create index ${NOTE_INDEX} on orders (note)`;

/** Two peers that each already created the identical `orders` table. */
async function makeSyncedPair(): Promise<[Peer, Peer]> {
	const a = await makePeer('a', { createOrders: true });
	const b = await makePeer('b', { createOrders: true });
	return [a, b];
}

/** Run `body` with `console.warn` captured; restores it even on throw. */
async function captureWarnings(body: () => Promise<void>): Promise<string[]> {
	const warns: string[] = [];
	const orig = console.warn;
	console.warn = (msg: string) => warns.push(msg);
	try {
		await body();
	} finally {
		console.warn = orig;
	}
	return warns;
}

describe('alter table sync warnings', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		[a, b] = await makeSyncedPair();
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('warns on the origin when an ALTER TABLE commits, and still records the migration', async () => {
		const versionBefore = await a.manager.schemaMigrations.getCurrentVersion('main', 'orders');

		const warns = await captureWarnings(async () => {
			await localWrite(a, 'alter table orders add column qty integer');
		});

		// One alter event → exactly one warning; the origin's wording ("will not reach
		// other synced devices") is what distinguishes it from the receiver's.
		const orderWarns = warns.filter(w => w.includes('main.orders'));
		expect(orderWarns).to.have.length(1);
		expect(orderWarns[0].toLowerCase()).to.include('alter_column');
		expect(orderWarns[0].toLowerCase()).to.include('not reach other synced devices');

		const versionAfter = await a.manager.schemaMigrations.getCurrentVersion('main', 'orders');
		expect(versionAfter).to.equal(versionBefore + 1);
	});

	it('warns on the receiver when relaying that migration, without error, and still advances its schema version', async () => {
		await localWrite(a, 'alter table orders add column qty integer');
		const versionBefore = await b.manager.schemaMigrations.getCurrentVersion('main', 'orders');

		const warns = await captureWarnings(async () => {
			await relayAll(a, b);
		});

		// Must be the RECEIVER's warning, not an origin one leaking into the window:
		// both name `main.orders` and `alter_column`, so key on the receive-side wording.
		const receiveWarns = warns.filter(w => w.includes('main.orders') && w.includes('Received'));
		expect(receiveWarns).to.have.length(1);
		expect(receiveWarns[0]).to.include('alter_column');
		expect(receiveWarns[0]).to.include('no DDL');

		const versionAfter = await b.manager.schemaMigrations.getCurrentVersion('main', 'orders');
		expect(versionAfter).to.equal(versionBefore + 1);

		// The blank-DDL migration ran nothing — b's table shape is unchanged.
		const columns = b.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase());
		expect(columns).to.not.include('qty');
	});

	// ADD COLUMN is only one of the alterations that lose their DDL: rename, drop and
	// constraint changes all emit the same bare `alter`/`table` event, so each must
	// warn too — otherwise the gap stays silent for exactly the cases an operator is
	// least likely to notice by looking at the data.
	const ALTER_FORMS = [
		'alter table orders rename column note to memo',
		'alter table orders add constraint orders_memo_u unique (memo)',
		'alter table orders drop column extra',
	];

	it('warns on the origin for every ALTER TABLE form, one warning each', async () => {
		const peer = await makePeer('forms', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, extra text) using store',
		});
		try {
			for (const sql of ALTER_FORMS) {
				const warns = await captureWarnings(async () => { await localWrite(peer, sql); });
				const orderWarns = warns.filter(w => w.includes('main.orders'));
				expect(orderWarns, sql).to.have.length(1);
				expect(orderWarns[0].toLowerCase(), sql).to.include('alter_column');
			}
		} finally {
			await closePeer(peer);
		}
	});

	it('never warns for create_table / drop_table / add_index / drop_index', async () => {
		const x = await makePeer('x');
		const y = await makePeer('y');
		try {
			const warns = await captureWarnings(async () => {
				await localWrite(x, DEFAULT_ORDERS_DDL);
				await relayAll(x, y);

				await localWrite(x, CREATE_NOTE_INDEX);
				await relayAll(x, y);

				await localWrite(x, `drop index ${NOTE_INDEX}`);
				await relayAll(x, y);

				await localWrite(x, 'drop table orders');
				await relayAll(x, y);
			});

			expect(warns).to.deep.equal([]);
		} finally {
			await closePeer(x);
			await closePeer(y);
		}
	});
});
