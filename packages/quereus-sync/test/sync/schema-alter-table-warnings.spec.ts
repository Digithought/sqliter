/**
 * ALTER TABLE replicates: the schema-change event carries the statement's canonical DDL
 * (see `SchemaChangeInfo.ddl` in the engine), so an `alter_column` migration crosses the
 * wire with real text and the receiver re-executes it. These specs pin the ends of that
 * path — the origin records a non-blank migration without the old "will not reach other
 * synced devices" warning, the receiver applies the alteration without the old "no DDL"
 * warning — and that `create_table` / `drop_table` / `add_index` / `drop_index` still
 * never warn. The two warnings themselves remain in the code for migrations from
 * older-build peers, which can still arrive blank.
 */

import { expect } from 'chai';
import type { TransactionCommitBatch } from '@quereus/quereus';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
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

describe('alter table sync replication', () => {
	let a: Peer;
	let b: Peer;

	beforeEach(async () => {
		[a, b] = await makeSyncedPair();
	});

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('records a non-blank alter_column migration on the origin, with no warning', async () => {
		const versionBefore = await a.manager.schemaMigrations.getCurrentVersion('main', 'table', 'orders');

		const warns = await captureWarnings(async () => {
			await localWrite(a, 'alter table orders add column qty integer null');
		});

		// The old origin-side "will not reach other synced devices" warning fired on a
		// blank-DDL alter_column; the event now carries the statement's canonical SQL.
		expect(warns.filter(w => w.includes('main.orders'))).to.deep.equal([]);

		const versionAfter = await a.manager.schemaMigrations.getCurrentVersion('main', 'table', 'orders');
		expect(versionAfter).to.equal(versionBefore + 1);
	});

	it('the receiver executes the relayed alteration, with no warning', async () => {
		await localWrite(a, 'alter table orders add column qty integer null');
		const versionBefore = await b.manager.schemaMigrations.getCurrentVersion('main', 'table', 'orders');

		const warns = await captureWarnings(async () => {
			await relayAll(a, b);
		});

		// No receive-side "no DDL" warning: the migration carried real text.
		expect(warns.filter(w => w.includes('main.orders'))).to.deep.equal([]);

		const versionAfter = await b.manager.schemaMigrations.getCurrentVersion('main', 'table', 'orders');
		expect(versionAfter).to.equal(versionBefore + 1);

		// The migration's DDL actually ran — b's table gained the column.
		const columns = b.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase());
		expect(columns).to.include('qty');
	});

	// ADD COLUMN is only one of the alterations; rename, drop and constraint changes all
	// emit the same one-event-per-statement `alter`/`table` shape and must carry their
	// own statement text the same way.
	const ALTER_FORMS = [
		'alter table orders rename column note to memo',
		'alter table orders add constraint orders_memo_u unique (memo)',
		'alter table orders drop column extra',
	];

	it('no ALTER TABLE form warns on the origin', async () => {
		const peer = await makePeer('forms', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, extra text) using store',
		});
		try {
			for (const sql of ALTER_FORMS) {
				const warns = await captureWarnings(async () => { await localWrite(peer, sql); });
				expect(warns.filter(w => w.includes('main.orders')), sql).to.deep.equal([]);
			}
		} finally {
			await closePeer(peer);
		}
	});

	it('every ALTER TABLE form replicates to the peer', async () => {
		const x = await makePeer('forms-x', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, extra text) using store',
		});
		const y = await makePeer('forms-y', {
			createOrders: true,
			ordersDdl: 'create table orders (id integer primary key, note text, extra text) using store',
		});
		try {
			for (const sql of ALTER_FORMS) {
				await localWrite(x, sql);
				await relayAll(x, y);
			}
			const columns = y.db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name.toLowerCase());
			expect(columns).to.deep.equal(['id', 'memo']);
			const uniques = (y.db.schemaManager.getTable('main', 'orders')!.uniqueConstraints ?? []).map(uc => uc.name);
			expect(uniques).to.include('orders_memo_u');
		} finally {
			await closePeer(x);
			await closePeer(y);
		}
	});

	// The two warnings themselves remain, for third-party modules / older-build
	// peers that still produce DDL-less events or blank migrations. A real
	// ALTER TABLE can no longer reach them (every arm carries text), so drive
	// them synthetically.
	it('the origin-side warning still fires for a DDL-less alter event', async () => {
		const batch: TransactionCommitBatch = {
			dataEvents: [],
			schemaEvents: [{
				type: 'alter',
				objectType: 'table',
				moduleName: 'store',
				schemaName: 'main',
				objectName: 'orders',
				remote: false,
			}],
		};

		const warns = await captureWarnings(async () => {
			a.manager.enqueueTransactionCommit(batch);
			await a.manager.whenCommitsSettled();
		});

		expect(warns.some(w => w.includes('main.orders') && w.includes('no DDL')),
			`expected the blank-DDL migration warning, got: ${JSON.stringify(warns)}`).to.equal(true);
	});

	it('the receive-side warning still fires for a blank-DDL alter_column migration', async () => {
		const applyToStore = createStoreAdapter({ db: b.db, storeModule: b.storeModule, events: b.events });

		const warns = await captureWarnings(async () => {
			const result = await applyToStore(
				[],
				[{ type: 'alter_column', schema: 'main', table: 'orders', ddl: '' }],
				{ remote: true },
			);
			// Still counted applied — it just runs nothing.
			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
		});

		expect(warns.some(w => w.includes('main.orders') && w.includes('no DDL')),
			`expected the blank-DDL migration warning, got: ${JSON.stringify(warns)}`).to.equal(true);
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
