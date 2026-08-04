/**
 * Idempotent application of replicated DDL (`store-adapter.ts` §
 * `decideSchemaChange`).
 *
 * Two offline peers can each run the same `create table orders`, and whichever
 * migration wins the HLC comparison is then admitted at a peer that ALREADY has
 * the table. Re-exec'ing the raw DDL there threw "Table main.orders already
 * exists", which aborted the whole admission unit — so the receiver's CRDT
 * metadata never committed, its peer watermark never advanced, and it re-applied
 * (and re-failed) the same batch on every subsequent sync, forever.
 *
 * Two levels of coverage:
 *   - end-to-end over two real engines via `relayAll` (the full changeset,
 *     schema migrations INCLUDED — `relay` strips them, which is why no existing
 *     spec saw this);
 *   - adapter-level, driving `createStoreAdapter` with synthetic
 *     `SchemaChangeToApply` records — the cheapest way to pin one branch of
 *     `decideSchemaChange` at a time.
 *
 * The drop/index branches now also have an end-to-end driver: real DDL flows for
 * create/drop table and create/drop index (see
 * `schema-ddl-replication.spec.ts`). A blank `ddl` remains reachable for
 * `alter_column`, so the blank-DDL cases at the bottom of this file still guard
 * live behaviour.
 */

import { expect } from 'chai';
import { Database, generateIndexDDL, generateTableDDL } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, type KVStoreProvider, type SchemaChangeEvent } from '@quereus/store';
import { createStoreAdapter } from '../../src/sync/store-adapter.js';
import type { ApplyToStoreCallback, SchemaChangeToApply } from '../../src/sync/protocol.js';
import {
	DEFAULT_ORDERS_DDL,
	closePeer,
	collect,
	createInMemoryProvider,
	localWrite,
	makePeer,
	relayAll,
	type Peer,
} from './_peer-harness.js';

const DIVERGENT_ORDERS_DDL =
	'create table orders (id integer primary key, note text, extra integer) using store';

/**
 * Two peers that each created `orders` INDEPENDENTLY while offline.
 *
 * `a` is created first and `localWrite` settles 25ms between the two, so `b`'s
 * create_table migration always carries the strictly greater HLC wall time. That
 * makes the failure direction deterministic: relaying b → a admits b's migration
 * at a peer that already has the table (a → b is HLC-dominated and skipped).
 */
async function makeDivergedPair(bDdl: string = DEFAULT_ORDERS_DDL): Promise<[Peer, Peer]> {
	const a = await makePeer('a');
	const b = await makePeer('b');
	await localWrite(a, DEFAULT_ORDERS_DDL);
	await localWrite(b, bDdl);
	return [a, b];
}

describe('schema replication idempotency', () => {
	describe('two peers, same table created offline (end-to-end)', () => {
		let a: Peer;
		let b: Peer;

		beforeEach(async () => {
			[a, b] = await makeDivergedPair();
		});

		afterEach(async () => {
			await closePeer(a);
			await closePeer(b);
		});

		it('converges both directions, twice, without re-executing the duplicate create', async () => {
			await localWrite(a, "insert into orders values (1, 'from A')");
			await localWrite(b, "insert into orders values (2, 'from B')");

			// Round 1: the direction carrying the dominating create_table (b → a)
			// used to throw "Table main.orders already exists" here.
			await relayAll(a, b);
			await relayAll(b, a);

			for (const peer of [a, b]) {
				const rows = await collect(peer.db, 'select id, note from orders order by id');
				expect(rows, `${peer.name} rows`).to.deep.equal([
					{ id: 1, note: 'from A' },
					{ id: 2, note: 'from B' },
				]);
			}

			// Round 2: the migration metadata committed in round 1, so the duplicate
			// create is now HLC-dominated on both sides and nothing is re-applied.
			// (Before the fix the aborted metadata commit made this re-throw forever.)
			const secondAtoB = await relayAll(a, b);
			const secondBtoA = await relayAll(b, a);
			expect(secondAtoB.applied, 'a → b round 2 applied').to.equal(0);
			expect(secondBtoA.applied, 'b → a round 2 applied').to.equal(0);
		});

		it('leaves the receiving peer able to relay the merged rows onward', async () => {
			// The metadata commit is what makes inbound rows relayable; the aborted
			// batch used to leave `a` holding b's row with no column versions for it.
			await localWrite(a, "insert into orders values (1, 'from A')");
			await localWrite(b, "insert into orders values (2, 'from B')");
			await relayAll(b, a);

			const c = await makePeer('c');
			await localWrite(c, DEFAULT_ORDERS_DDL);
			try {
				await relayAll(a, c);
				const rows = await collect(c.db, 'select id, note from orders order by id');
				expect(rows).to.deep.equal([
					{ id: 1, note: 'from A' },
					{ id: 2, note: 'from B' },
				]);
			} finally {
				await closePeer(c);
			}
		});
	});

	describe('two peers, divergent same-name table (end-to-end)', () => {
		let a: Peer;
		let b: Peer;

		beforeEach(async () => {
			[a, b] = await makeDivergedPair(DIVERGENT_ORDERS_DDL);
		});

		afterEach(async () => {
			await closePeer(a);
			await closePeer(b);
		});

		it('surfaces a conflict naming the table and both definitions', async () => {
			await localWrite(b, "insert into orders values (2, 'from B', 7)");

			let caught: Error | undefined;
			try {
				await relayAll(b, a);
			} catch (e) {
				caught = e as Error;
			}

			expect(caught, 'expected the divergent create to be surfaced').to.be.instanceOf(Error);
			expect(caught!.message).to.include('main.orders');
			expect(caught!.message).to.include('create_table');
			// Both definitions are printed so an operator can see WHAT diverged.
			expect(caught!.message).to.include('local:');
			expect(caught!.message).to.include('remote:');
			expect(caught!.message).to.include('"extra"');
		});
	});

	describe('adapter-level, synthetic schema changes', () => {
		let db: Database;
		let provider: KVStoreProvider;
		let events: StoreEventEmitter;
		let storeModule: StoreModule;
		let applyToStore: ApplyToStoreCallback;
		let schemaEvents: SchemaChangeEvent[];

		const schemaChange = (
			type: SchemaChangeToApply['type'],
			table: string,
			ddl: string,
		): SchemaChangeToApply => ({ type, schema: 'main', table, ddl });

		const apply = (...changes: SchemaChangeToApply[]) =>
			applyToStore([], changes, { remote: true });

		/** Canonical `CREATE INDEX` for a live local index, as the origin would emit it. */
		const localIndexDDL = (table: string, indexName: string): string => {
			const tableSchema = db.schemaManager.getTable('main', table)!;
			const index = tableSchema.indexes!.find(i => i.name.toLowerCase() === indexName)!;
			return generateIndexDDL(index, tableSchema);
		};

		beforeEach(async () => {
			db = new Database();
			({ provider } = createInMemoryProvider());
			events = new StoreEventEmitter();
			storeModule = new StoreModule(provider, events);
			db.registerModule('store', storeModule);
			applyToStore = createStoreAdapter({ db, storeModule, events });
			await db.exec(DEFAULT_ORDERS_DDL);
			// Subscribe AFTER the fixture DDL so `schemaEvents` holds only what the
			// adapter caused.
			schemaEvents = [];
			events.onSchemaChange(e => schemaEvents.push(e));
		});

		afterEach(async () => {
			await db.close();
			await provider.closeAll();
		});

		it('executes a create_table for a table the receiver does not have', async () => {
			const ddl = 'CREATE TABLE "main"."widgets" ("id" INTEGER NOT NULL PRIMARY KEY) USING store';
			const result = await apply(schemaChange('create_table', 'widgets', ddl));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			expect(db.schemaManager.getTable('main', 'widgets')).to.not.be.undefined;
		});

		it('counts a matching duplicate create_table applied without re-executing', async () => {
			const ddl = generateTableDDL(db.schemaManager.getTable('main', 'orders')!);
			const result = await apply(schemaChange('create_table', 'orders', ddl));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			// Nothing ran, so the module emitted no event at all.
			expect(schemaEvents).to.deep.equal([]);
		});

		it('matches a duplicate create_table across whitespace, trailing `;` and casing', async () => {
			const canonical = generateTableDDL(db.schemaManager.getTable('main', 'orders')!);
			const noisy = `  ${canonical.replace(/ /g, '\n  ').toLowerCase()} ;  `;
			const result = await apply(schemaChange('create_table', 'orders', noisy));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
		});

		it('reports a conflict for a same-name create_table with a different shape', async () => {
			const ddl = 'CREATE TABLE "main"."orders" ("id" INTEGER NOT NULL PRIMARY KEY, "note" TEXT NOT NULL, "extra" INTEGER NOT NULL) USING store';
			const result = await apply(schemaChange('create_table', 'orders', ddl));

			expect(result.schemaChangesApplied).to.equal(0);
			expect(result.errors).to.have.lengthOf(1);
			expect(result.errors[0].error.message).to.include('main.orders');
			expect(result.errors[0].error.message).to.include('"extra"');
		});

		it('counts a drop_table for a table the receiver does not have applied', async () => {
			const result = await apply(
				schemaChange('drop_table', 'gone', 'DROP TABLE "main"."gone"'),
			);

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			expect(schemaEvents).to.deep.equal([]);
		});

		it('executes a drop_table for a table the receiver still has', async () => {
			const result = await apply(
				schemaChange('drop_table', 'orders', 'DROP TABLE "main"."orders"'),
			);

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			expect(db.schemaManager.getTable('main', 'orders')).to.be.undefined;
			expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote]))
				.to.deep.equal([['drop', 'table', 'orders', true]]);
		});

		it('executes an add_index the receiver does not have, marked remote', async () => {
			const result = await apply(schemaChange(
				'add_index',
				'idx_orders_note',
				'CREATE INDEX "idx_orders_note" ON "main"."orders" ("note")',
			));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			// The event signature must match what the module emits (create/index),
			// or the receiver records the replicated DDL as its own local migration
			// and broadcasts it straight back out.
			expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote]))
				.to.deep.equal([['create', 'index', 'idx_orders_note', true]]);
		});

		it('counts a matching duplicate add_index applied without re-executing', async () => {
			await db.exec('create index idx_orders_note on orders (note)');
			schemaEvents = [];

			const result = await apply(schemaChange(
				'add_index',
				'idx_orders_note',
				localIndexDDL('orders', 'idx_orders_note'),
			));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			expect(schemaEvents).to.deep.equal([]);
		});

		it('reports a conflict for a same-name add_index over different columns', async () => {
			await db.exec('create index idx_orders_note on orders (note)');

			const result = await apply(schemaChange(
				'add_index',
				'idx_orders_note',
				'CREATE INDEX "idx_orders_note" ON "main"."orders" ("id")',
			));

			expect(result.schemaChangesApplied).to.equal(0);
			expect(result.errors).to.have.lengthOf(1);
			expect(result.errors[0].error.message).to.include('idx_orders_note');
			expect(result.errors[0].error.message).to.include('add_index');
		});

		it('counts a drop_index for an index the receiver does not have applied', async () => {
			const result = await apply(schemaChange(
				'drop_index',
				'idx_orders_note',
				'DROP INDEX "idx_orders_note"',
			));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			expect(schemaEvents).to.deep.equal([]);
		});

		it('executes a drop_index for an index the receiver still has, marked remote', async () => {
			await db.exec('create index idx_orders_note on orders (note)');
			schemaEvents = [];

			const result = await apply(schemaChange(
				'drop_index',
				'idx_orders_note',
				'drop index idx_orders_note',
			));

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(1);
			expect(db.schemaManager.getTable('main', 'orders')!.indexes ?? []).to.deep.equal([]);
			expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote]))
				.to.deep.equal([['drop', 'index', 'idx_orders_note', true]]);
		});

		it('leaves blank-DDL migrations as the no-ops they are today', async () => {
			// A blank `ddl` still reaches the adapter for `alter_column` (ALTER TABLE
			// migrations are tracked separately), and any peer running an older build
			// still sends blank drop/index migrations. Those must keep behaving exactly
			// as before — counted applied, changing nothing.
			const result = await apply(
				schemaChange('drop_table', 'orders', ''),
				schemaChange('add_index', 'idx_orders_note', ''),
			);

			expect(result.errors).to.deep.equal([]);
			expect(result.schemaChangesApplied).to.equal(2);
			expect(db.schemaManager.getTable('main', 'orders')).to.not.be.undefined;
		});

		it('leaves no remote-marking residue behind for a blank-DDL migration', async () => {
			// A blank statement emits nothing. Under the old one-for-one expectation
			// registry, residue from it would swallow the NEXT genuine local DDL of
			// the same signature, marking it remote so the SyncManager dropped it from
			// its local-fact capture and it never replicated. Scoped remote marking
			// closes in a `finally`, so nothing lingers — pin that.
			await apply(
				schemaChange('add_index', 'idx_orders_note', ''),
				schemaChange('alter_column', 'orders', ''),
			);

			await db.exec('create index idx_orders_note on orders (note)');
			await db.exec('alter table orders add column qty integer');

			expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote ?? false]))
				.to.deep.equal([
					['create', 'index', 'idx_orders_note', false],
					['alter', 'table', 'orders', false],
				]);
		});

		describe('alter_column decision table', () => {
			const alter = (ddl: string) => schemaChange('alter_column', 'orders', ddl);

			/** Run `body` with `console.warn` captured; restores it even on throw. */
			const captureWarnings = async (body: () => Promise<void>): Promise<string[]> => {
				const warns: string[] = [];
				const orig = console.warn;
				console.warn = (msg: string) => warns.push(msg);
				try {
					await body();
				} finally {
					console.warn = orig;
				}
				return warns;
			};

			it('executes an add column the receiver does not have, marked remote', async () => {
				const result = await apply(alter('alter table "orders" add column sku text null'));

				expect(result.errors).to.deep.equal([]);
				expect(result.schemaChangesApplied).to.equal(1);
				expect(db.schemaManager.getTable('main', 'orders')!.columns.map(c => c.name)).to.include('sku');
				expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote]))
					.to.deep.equal([['alter', 'table', 'orders', true]]);
			});

			it('counts an add column for a same-typed existing column applied without re-executing', async () => {
				await db.exec('alter table orders add column sku varchar(80) null');
				schemaEvents = [];

				// A different spelling of the same LOGICAL type (varchar IS text) converges.
				const result = await apply(alter('alter table "orders" add column sku text null'));

				expect(result.errors).to.deep.equal([]);
				expect(result.schemaChangesApplied).to.equal(1);
				expect(schemaEvents).to.deep.equal([]);
			});

			it('reports a conflict for a same-name add column with a different type', async () => {
				await db.exec('alter table orders add column sku text null');

				const result = await apply(alter('alter table "orders" add column sku integer null'));

				expect(result.schemaChangesApplied).to.equal(0);
				expect(result.errors).to.have.lengthOf(1);
				expect(result.errors[0].error.message).to.include('sku');
				expect(result.errors[0].error.message).to.include('TEXT');
				expect(result.errors[0].error.message).to.include('INTEGER');
			});

			it('counts a drop column for an absent column applied', async () => {
				const result = await apply(alter('alter table "orders" drop column gone'));

				expect(result.errors).to.deep.equal([]);
				expect(result.schemaChangesApplied).to.equal(1);
				expect(schemaEvents).to.deep.equal([]);
			});

			it('rename column: converges when only the new name exists, warns when neither does', async () => {
				await db.exec('alter table orders rename column note to memo');
				schemaEvents = [];

				const done = await apply(alter('alter table "orders" rename column note to memo'));
				expect(done.errors).to.deep.equal([]);
				expect(schemaEvents).to.deep.equal([]);

				const warns = await captureWarnings(async () => {
					const neither = await apply(alter('alter table "orders" rename column ghost to phantom'));
					expect(neither.errors).to.deep.equal([]);
					expect(neither.schemaChangesApplied).to.equal(1);
				});
				expect(warns.some(w => w.includes('ghost') && w.includes('phantom'))).to.equal(true);
			});

			it('add constraint: an existing name, or an equivalent unnamed UNIQUE, converges', async () => {
				await db.exec('alter table orders add column sku text null');
				await db.exec('alter table orders add constraint orders_sku_u unique (sku)');
				await db.exec('alter table orders add constraint u_note_sku unique (note, sku)');
				schemaEvents = [];

				const named = await apply(alter('alter table "orders" add constraint orders_sku_u unique (sku)'));
				expect(named.errors).to.deep.equal([]);
				// Unnamed UNIQUE over the same column set, column order reversed.
				const unnamed = await apply(alter('alter table "orders" add unique (sku, note)'));
				expect(unnamed.errors).to.deep.equal([]);
				expect(schemaEvents).to.deep.equal([]);
			});

			it('drop / rename constraint converge when the name is already gone', async () => {
				const dropped = await apply(alter('alter table "orders" drop constraint ghost_uc'));
				expect(dropped.errors).to.deep.equal([]);
				expect(dropped.schemaChangesApplied).to.equal(1);

				await db.exec('alter table orders add constraint orders_note_u unique (note)');
				await db.exec('alter table orders rename constraint orders_note_u to orders_note_uq');
				schemaEvents = [];
				const renamed = await apply(alter('alter table "orders" rename constraint orders_note_u to orders_note_uq'));
				expect(renamed.errors).to.deep.equal([]);
				expect(schemaEvents).to.deep.equal([]);
			});

			it('alter column sub-forms converge when the local column already matches', async () => {
				await db.exec('alter table orders add column qty integer null');
				await db.exec("alter table orders alter column note set default 'pending'");
				await db.exec('alter table orders alter column note set collate nocase');
				schemaEvents = [];

				for (const ddl of [
					'alter table "orders" alter column qty set data type bigint', // bigint IS integer
					'alter table "orders" alter column note set not null',        // already not null
					'alter table "orders" alter column qty drop not null',        // already nullable
					'alter table "orders" alter column note set default \'pending\'',
					'alter table "orders" alter column note set collate NOCASE',
				]) {
					const result = await apply(alter(ddl));
					expect(result.errors, ddl).to.deep.equal([]);
					expect(result.schemaChangesApplied, ddl).to.equal(1);
				}
				expect(schemaEvents).to.deep.equal([]);
			});

			it('alter column sub-forms execute when the local column differs', async () => {
				const result = await apply(alter('alter table "orders" alter column note drop not null'));

				expect(result.errors).to.deep.equal([]);
				expect(db.schemaManager.getTable('main', 'orders')!
					.columns.find(c => c.name === 'note')!.notNull).to.equal(false);
				expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote]))
					.to.deep.equal([['alter', 'table', 'orders', true]]);
			});

			it('alter column over a locally dropped column converges with a warning', async () => {
				// Most-destructive-wins: a local DROP COLUMN beats the alteration.
				const warns = await captureWarnings(async () => {
					const result = await apply(alter('alter table "orders" alter column ghost set not null'));
					expect(result.errors).to.deep.equal([]);
					expect(result.schemaChangesApplied).to.equal(1);
				});
				expect(warns.some(w => w.includes('ghost'))).to.equal(true);
				expect(schemaEvents).to.deep.equal([]);
			});

			it('alter primary key converges when the key already matches, executes when it differs', async () => {
				const same = await apply(alter('alter table "orders" alter primary key (id)'));
				expect(same.errors).to.deep.equal([]);
				expect(schemaEvents).to.deep.equal([]);

				const different = await apply(alter('alter table "orders" alter primary key (id, note)'));
				expect(different.errors).to.deep.equal([]);
				const table = db.schemaManager.getTable('main', 'orders')!;
				expect(table.primaryKeyDefinition.map(d => table.columns[d.index].name)).to.deep.equal(['id', 'note']);
			});

			it('a migration whose table no longer exists locally converges with a warning', async () => {
				const warns = await captureWarnings(async () => {
					const result = await apply(schemaChange('alter_column', 'widgets',
						'alter table "widgets" add column sku text null'));
					expect(result.errors).to.deep.equal([]);
					expect(result.schemaChangesApplied).to.equal(1);
				});
				expect(warns.some(w => w.includes('main.widgets'))).to.equal(true);
				expect(schemaEvents).to.deep.equal([]);
			});

			it('a parse failure executes the DDL so the engine error is what surfaces', async () => {
				const origError = console.error;
				const errors: string[] = [];
				console.error = (msg: string) => errors.push(String(msg));
				let result;
				try {
					result = await apply(alter('alter table orders frobnicate the widget'));
				} finally {
					console.error = origError;
				}

				expect(result.schemaChangesApplied).to.equal(0);
				expect(result.errors).to.have.lengthOf(1);
				expect(errors.some(e => e.includes('Could not parse'))).to.equal(true);

				// The failed exec's `finally` closed the remote-marking scope, so the
				// next genuine LOCAL DDL is captured normally (the case the old
				// `clearExpectedRemoteSchemaEvent` existed to handle).
				await db.exec('alter table orders add column after_fail text null');
				expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote ?? false]))
					.to.deep.equal([['alter', 'table', 'orders', false]]);
			});

			it('a replicated statement that emits no event leaves no scope residue', async () => {
				// The tag arms announce nothing. With scoped remote marking the scope
				// closes empty, and the NEXT genuine local DDL is captured normally —
				// the zero-event case the old expectation registry could not survive.
				const result = await apply(alter('alter table "orders" set tags (owner = \'x\')'));
				expect(result.errors).to.deep.equal([]);
				expect(schemaEvents).to.deep.equal([]);

				await db.exec('alter table orders add column fresh text null');
				expect(schemaEvents.map(e => [e.type, e.objectType, e.objectName, e.remote ?? false]))
					.to.deep.equal([['alter', 'table', 'orders', false]]);
			});
		});
	});
});
