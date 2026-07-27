/**
 * Regression: a mid-transaction ALTER TABLE on a store-backed table must not deliver
 * change events in the pre-ALTER row shape. The store's TransactionCoordinator flushes
 * its queued events into the engine's DatabaseEventEmitter DURING the ALTER
 * (StoreModule.ddlCommitPendingOps runs coordinator.commit() before the row rewrite),
 * so the engine-level remap (DatabaseEventEmitter.remapBatchedDataEvents, called from
 * the runtime's ALTER arms) is what fixes this path — this spec pins that end to end.
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

describe('Store-backed ALTER TABLE mid-transaction: events keep the delivered schema shape', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let events: DatabaseDataChangeEvent[];
	let unsub: () => void;

	beforeEach(async () => {
		provider = createInMemoryProvider();
		db = new Database();
		db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
		events = [];
		unsub = db.onDataChange(e => events.push(e));
	});

	afterEach(async () => {
		unsub();
		await db.close();
		await provider.closeAll();
	});

	it('DROP COLUMN reshapes an earlier insert to the post-drop arity', async () => {
		await db.exec('create table t (id integer primary key, v text, w text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a', 'p')");
		await db.exec('alter table t drop column w');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].newRow, [1, 'a']);
	});

	it('ADD COLUMN with a literal default fills earlier inserts with that default', async () => {
		await db.exec('create table t (id integer primary key, v text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("alter table t add column w text default 'z'");
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].newRow, [1, 'a', 'z']);
	});

	it('an update whose oldRow crosses the ALTER reshapes both images', async () => {
		await db.exec('create table t (id integer primary key, v text, w text) using store');
		await db.exec("insert into t values (1, 'a', 'p')");
		events.length = 0;

		await db.exec('begin');
		await db.exec("update t set v = 'b' where id = 1");
		await db.exec('alter table t drop column w');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].type, 'update');
		assert.deepEqual(dml[0].oldRow, [1, 'a']);
		assert.deepEqual(dml[0].newRow, [1, 'b']);
		// The store deliberately omits `changedColumns` (consumers diff the rows
		// themselves); the reshape must not start synthesizing one, or the delivered
		// shape would depend on whether the transaction happened to run DDL.
		assert.equal(dml[0].changedColumns, undefined);
	});

	it('an update event outside any ALTER also omits changedColumns (the shape the reshape must preserve)', async () => {
		await db.exec('create table t (id integer primary key, v text, w text) using store');
		await db.exec("insert into t values (1, 'a', 'p')");
		events.length = 0;

		await db.exec("update t set v = 'b' where id = 1");

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].changedColumns, undefined);
	});

	it('RENAME TO relabels an insert recorded before it', async () => {
		// Same mechanism, name instead of shape: ddlCommitPendingOps flushes the queued
		// event into the engine batch under the OLD name, and
		// DatabaseEventEmitter.renameBatchedEvents relabels it. Note the deliberate absence
		// of the `tableName === 't'` filter the other cases use — that is the bug.
		await db.exec('create table t (id integer primary key, v text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('alter table t rename to t2');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't' || e.tableName === 't2');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].tableName, 't2');
		assert.deepEqual(dml[0].newRow, [1, 'a']);
	});

	it('mixed arity inside one commit batch is normalized to one shape', async () => {
		await db.exec('create table t (id integer primary key, v text) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("alter table t add column w text default 'z'");
		await db.exec("insert into t values (2, 'b', 'c')");
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 2);
		assert.deepEqual(dml[0].newRow, [1, 'a', 'z']);
		assert.deepEqual(dml[1].newRow, [2, 'b', 'c']);
	});
});
