/**
 * The data-change event key contract, pinned across both in-engine producers
 * (docs/usage.md § Subscribing to Data Changes). Two clauses:
 *
 *  1. `key` is the primary key projected out of the event's OWN row image — `newRow` for an
 *     insert and an update, `oldRow` for a delete. An update therefore keys by its POST-image.
 *  2. An `update` never moves a row. A key change that RELOCATES the row — its key values
 *     differ under the primary key's own comparator, which is collation- and type-aware — is
 *     delivered as a `delete` at the old key then an `insert` at the new key, in that order.
 *     A rewrite that leaves the row in place (a NOCASE 'apple' → 'APPLE') stays one `update`.
 *
 * Before this contract the three producers disagreed on all of it: the engine auto path keyed a
 * PK-moving update by the PRE-image, the store by the post-image, and the memory module split
 * it — so a listener could not tell which row an event addressed without knowing the schema.
 *
 * Both producers here are observed through `db.onDataChange`, the surface an application sees:
 *  - the engine auto-event path (plain `new Database()`: memory module with no emitter, events
 *    synthesized by the DML executor);
 *  - the memory module's native path (`new MemoryTableModule(emitter)`: events recorded in each
 *    TransactionLayer's pending-change log and delivered at the table's own commit).
 * The third producer, the store module, is pinned by the mirror of this file at
 * packages/quereus-store/test/data-event-key-contract.spec.ts.
 */

import assert from 'node:assert/strict';
import {
	Database,
	DefaultVTableEventEmitter,
	MemoryTableModule,
	type DatabaseDataChangeEvent,
} from '../src/index.js';

/** One event reduced to the fields the contract speaks about. */
interface EventShape {
	type: string;
	key: unknown;
	oldRow: unknown;
	newRow: unknown;
}

const shape = (e: DatabaseDataChangeEvent): EventShape =>
	({ type: e.type, key: e.key, oldRow: e.oldRow, newRow: e.newRow });

const producers: Array<{ name: string; create: () => Database }> = [
	{
		name: 'engine auto-event path (default Database)',
		create: () => new Database(),
	},
	{
		name: 'memory module native path (MemoryTableModule with an emitter)',
		create: () => {
			const db = new Database();
			db.registerModule('memory_events', new MemoryTableModule(new DefaultVTableEventEmitter()));
			db.setDefaultVtabName('memory_events');
			return db;
		},
	},
];

for (const producer of producers) {
	describe(`data-change event key contract — ${producer.name}`, () => {
		let db: Database;
		let events: DatabaseDataChangeEvent[];
		let unsub: () => void;

		beforeEach(() => {
			db = producer.create();
			events = [];
			unsub = db.onDataChange(e => { if (e.tableName === 't') events.push(e); });
		});

		afterEach(async () => {
			unsub();
			await db.close();
		});

		it('a relocating update is delivered as delete-at-old-key then insert-at-new-key', async () => {
			await db.exec('create table t (a integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 'x')");
			events.length = 0;

			await db.exec('update t set a = 2 where a = 1');

			assert.deepEqual(events.map(shape), [
				{ type: 'delete', key: [1], oldRow: [1, 'x'], newRow: undefined },
				{ type: 'insert', key: [2], oldRow: undefined, newRow: [2, 'x'] },
			]);
		});

		it('a relocating update carries no changedColumns on either half', async () => {
			// The split trades `changedColumns` — and the "same row" link between the two
			// events — for an identity a listener can act on without knowing the key columns.
			// That cost is the contract, so pin it rather than let it drift back.
			await db.exec('create table t (a integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 'x')");
			events.length = 0;

			await db.exec("update t set a = 2, v = 'y' where a = 1");

			assert.equal(events.length, 2);
			assert.equal(events[0].changedColumns, undefined);
			assert.equal(events[1].changedColumns, undefined);
		});

		it('a NOCASE case-only key rewrite moves no row, so it stays ONE update keyed by the post-image', async () => {
			// The relocation test is the primary key's own comparator, not byte identity:
			// under NOCASE 'apple' and 'APPLE' are the same key, so the row never left its
			// slot. Clause 1 then makes `key` the post-image the table now holds — the old
			// bug handed listeners key bytes no row in the table carried.
			await db.exec('create table t (k text not null collate nocase, v text, primary key (k))');
			await db.exec("insert into t values ('apple', 'x')");
			events.length = 0;

			await db.exec("update t set k = 'APPLE' where k = 'apple'");

			assert.deepEqual(events.map(shape), [
				{ type: 'update', key: ['APPLE'], oldRow: ['apple', 'x'], newRow: ['APPLE', 'x'] },
			]);
			const stored: unknown[] = [];
			for await (const row of db.eval('select k from t')) stored.push(row);
			assert.deepEqual(stored, [{ k: 'APPLE' }]);
		});

		it('an update that touches no key column is one update, keyed and diffed as before', async () => {
			await db.exec('create table t (a integer not null, v text, primary key (a))');
			await db.exec("insert into t values (1, 'x')");
			events.length = 0;

			await db.exec("update t set v = 'y' where a = 1");

			assert.deepEqual(events.map(shape), [
				{ type: 'update', key: [1], oldRow: [1, 'x'], newRow: [1, 'y'] },
			]);
			assert.deepEqual(events[0].changedColumns, ['v']);
		});

		it('a composite key relocates on ANY member changing', async () => {
			await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a, b))');
			await db.exec("insert into t values (1, 9, 'x')");
			events.length = 0;

			await db.exec('update t set b = 8 where a = 1');

			assert.deepEqual(events.map(shape), [
				{ type: 'delete', key: [1, 9], oldRow: [1, 9, 'x'], newRow: undefined },
				{ type: 'insert', key: [1, 8], oldRow: undefined, newRow: [1, 8, 'x'] },
			]);
		});

		it('a relocation onto an occupied key under REPLACE delivers evict-delete, move-delete, move-insert', async () => {
			// `update or replace` does not parse in this dialect; the REPLACE path is reached
			// through the primary key's own declared conflict action. Three events, in the
			// substrate's own evict-then-move order: the displaced row dies first, so a
			// listener replaying them never has two rows at key [2].
			await db.exec('create table t (a integer not null, v text, primary key (a) on conflict replace)');
			await db.exec("insert into t values (1, 'x')");
			await db.exec("insert into t values (2, 'y')");
			events.length = 0;

			await db.exec('update t set a = 2 where a = 1');

			assert.deepEqual(events.map(shape), [
				{ type: 'delete', key: [2], oldRow: [2, 'y'], newRow: undefined },
				{ type: 'delete', key: [1], oldRow: [1, 'x'], newRow: undefined },
				{ type: 'insert', key: [2], oldRow: undefined, newRow: [2, 'x'] },
			]);
		});

		it('an UPSERT DO UPDATE that relocates the row splits too', async () => {
			// The conflict-resolution arm is the same producer and owes the same contract:
			// `on conflict (b) do update set a = ...` moves the row it found.
			await db.exec('create table t (a integer not null, b integer not null unique, v text, primary key (a))');
			await db.exec("insert into t values (1, 5, 'x')");
			events.length = 0;

			await db.exec("insert into t values (7, 5, 'z') on conflict (b) do update set a = 2");

			assert.deepEqual(events.map(shape), [
				{ type: 'delete', key: [1], oldRow: [1, 5, 'x'], newRow: undefined },
				{ type: 'insert', key: [2], oldRow: undefined, newRow: [2, 5, 'x'] },
			]);
		});
	});
}
