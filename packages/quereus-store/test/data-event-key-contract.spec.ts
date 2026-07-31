/**
 * The store module's half of the data-change event key contract
 * (docs/usage.md § Subscribing to Data Changes). Two clauses:
 *
 *  1. `key` is the primary key projected out of the event's OWN row image — `newRow` for an
 *     insert and an update, `oldRow` for a delete. An update therefore keys by its POST-image.
 *  2. An `update` never moves a row. A key change that RELOCATES the row is delivered as a
 *     `delete` at the old key then an `insert` at the new key, in that order. A rewrite that
 *     leaves the row in place (a NOCASE 'apple' → 'APPLE') stays one `update`.
 *
 * The store's relocation test is its own ENCODED data key: those bytes fold each primary-key
 * column's collation, so they agree with the memory backend's PK comparator on the NOCASE case
 * without either module consulting the other.
 *
 * The mirror of this file — same cases against the engine auto-event path and the memory
 * module's native path — is packages/quereus/test/data-event-key-contract.spec.ts. The one
 * deliberate divergence is `changedColumns`: the store omits it on every update and leaves the
 * per-column diff to the consumer.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert/strict';
import { Database, type DatabaseDataChangeEvent } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string) => {
		if (!stores.has(key)) stores.set(key, new InMemoryKVStore());
		return stores.get(key)!;
	};
	return {
		async getStore(s, t) { return get(`${s}.${t}`); },
		async getIndexStore(s, t, i) { return get(`${s}.${t}_idx_${i}`); },
		async getStatsStore(s, t) { return get(`${s}.${t}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** One event reduced to the fields the contract speaks about. */
interface EventShape {
	type: string;
	key: unknown;
	oldRow: unknown;
	newRow: unknown;
}

const shape = (e: DatabaseDataChangeEvent): EventShape =>
	({ type: e.type, key: e.key, oldRow: e.oldRow, newRow: e.newRow });

describe('data-change event key contract — store module', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: DatabaseDataChangeEvent[];
	let unsub: () => void;

	beforeEach(() => {
		provider = createInMemoryProvider();
		db = new Database();
		db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
		events = [];
		unsub = db.onDataChange(e => { if (e.tableName === 't') events.push(e); });
	});

	afterEach(async () => {
		unsub();
		await db.close();
		await provider.closeAll();
	});

	it('a relocating update is delivered as delete-at-old-key then insert-at-new-key', async () => {
		await db.exec('create table t (a integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 'x')");
		events.length = 0;

		await db.exec('update t set a = 2 where a = 1');

		assert.deepEqual(events.map(shape), [
			{ type: 'delete', key: [1], oldRow: [1, 'x'], newRow: undefined },
			{ type: 'insert', key: [2], oldRow: undefined, newRow: [2, 'x'] },
		]);
	});

	it('a NOCASE case-only key rewrite moves no row, so it stays ONE update keyed by the post-image', async () => {
		// The encoded data key folds the PK column's NOCASE collation, so 'apple' and 'APPLE'
		// encode identically — the row never left its slot, and the event is one in-place
		// `update` whose key is the post-image the table now holds.
		await db.exec('create table t (k text not null collate nocase, v text, primary key (k)) using store');
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

	it('an update that touches no key column is one update, keyed by the row it left in place', async () => {
		await db.exec('create table t (a integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 'x')");
		events.length = 0;

		await db.exec("update t set v = 'y' where a = 1");

		assert.deepEqual(events.map(shape), [
			{ type: 'update', key: [1], oldRow: [1, 'x'], newRow: [1, 'y'] },
		]);
		// Deliberate store divergence: no per-column diff is supplied.
		assert.equal(events[0].changedColumns, undefined);
	});

	it('a composite key relocates on ANY member changing', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a, b)) using store');
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
		// through the primary key's own declared conflict action. The displaced row dies
		// first, so a listener replaying the events never has two rows at key [2].
		await db.exec('create table t (a integer not null, v text, primary key (a) on conflict replace) using store');
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
		await db.exec('create table t (a integer not null, b integer not null unique, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 5, 'x')");
		events.length = 0;

		await db.exec("insert into t values (7, 5, 'z') on conflict (b) do update set a = 2");

		assert.deepEqual(events.map(shape), [
			{ type: 'delete', key: [1], oldRow: [1, 5, 'x'], newRow: undefined },
			{ type: 'insert', key: [2], oldRow: undefined, newRow: [2, 5, 'x'] },
		]);
	});
});
