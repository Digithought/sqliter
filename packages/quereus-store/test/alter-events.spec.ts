/**
 * Regression: a mid-transaction ALTER TABLE on a store-backed table must not deliver
 * change events describing the table as it was at write time — not in the pre-ALTER row
 * shape, not under a retired table name, and not under a retired primary key. The store's
 * TransactionCoordinator flushes its queued events into the engine's DatabaseEventEmitter
 * DURING the ALTER (StoreModule.ddlCommitPendingOps runs coordinator.commit() before the
 * row rewrite), so the engine-level fixups — DatabaseEventEmitter.remapBatchedDataEvents
 * (row shape), .renameBatchedEvents (table name) and .rekeyBatchedDataEvents (primary key),
 * all called from the runtime's ALTER arms — are what fix this path; this spec pins that
 * end to end.
 *
 * This is the primary home for the ALTER PRIMARY KEY re-key cases: the store re-keys in
 * place, so the rows survive the ALTER and each delivered `key` can be checked against the
 * row the committed table actually holds.
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

/** Assert the committed contents of a table, so a re-keyed event can be checked against it. */
async function assertRows(db: Database, sql: string, expected: unknown[]): Promise<void> {
	const rows: unknown[] = [];
	for await (const row of db.eval(sql)) rows.push(row);
	assert.deepEqual(rows, expected);
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

	it('ALTER PRIMARY KEY widening re-keys an insert recorded before it', async () => {
		// `key` is how a consumer addresses the row; after a widening re-key a one-value
		// key cannot be paired with any row the two-column-keyed table now holds.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].newRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('ALTER PRIMARY KEY narrowing re-keys an insert recorded before it', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a, b)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (a)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1]);
		assert.deepEqual(dml[0].newRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('ALTER PRIMARY KEY re-keys to a column that was not in the old key at all', async () => {
		// Neither a widen nor a narrow: the retired and the new key share no column, so a
		// re-key that merely padded or truncated the old value list would still be wrong.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [9]);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
	});

	it('an update crossing an ALTER PRIMARY KEY is re-keyed from its own row image', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		events.length = 0;

		await db.exec('begin');
		await db.exec("update t set v = 'y' where a = 1");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].type, 'update');
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].oldRow, [1, 9, 'x']);
		assert.deepEqual(dml[0].newRow, [1, 9, 'y']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'y' }]);
	});

	it('an update that MOVES the primary key keeps whichever image the producer keyed it by', async () => {
		// The three event producers disagree about whether a PK-moving update's `key` holds
		// the pre- or the post-update key (fix/bug-update-event-key-disagrees-across-producers).
		// The re-key must be neutral to that: it re-projects the SAME image the producer used.
		// So learn the producer's choice from a run with no ALTER at all, then assert the
		// re-keyed run delivers exactly that key with `b` appended — never the other image's.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		events.length = 0;
		await db.exec('update t set a = 2 where a = 1');
		const baseline = events.filter(e => e.tableName === 't');
		assert.equal(baseline.length, 1);
		assert.equal(baseline[0].key?.length, 1);
		const producerKeyedBy = baseline[0].key![0];

		await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into u values (1, 9, 'x')");
		events.length = 0;
		await db.exec('begin');
		await db.exec('update u set a = 2 where a = 1');
		await db.exec('alter table u alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 'u');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].type, 'update');
		assert.deepEqual(dml[0].key, [producerKeyedBy, 9]);
		await assertRows(db, 'select * from u', [{ a: 2, b: 9, v: 'x' }]);
	});

	it('a delete crossing an ALTER PRIMARY KEY is re-keyed from oldRow', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		events.length = 0;

		await db.exec('begin');
		await db.exec('delete from t where a = 1');
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.equal(dml[0].type, 'delete');
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].oldRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', []);
	});

	it('ALTER PRIMARY KEY re-keys events sitting in an open savepoint layer', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('savepoint s1');
		await db.exec("insert into t values (2, 8, 'y')");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('release s1');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.deepEqual(dml.map(e => e.key), [[1, 9], [2, 8]]);
		await assertRows(db, 'select * from t order by a', [
			{ a: 1, b: 9, v: 'x' },
			{ a: 2, b: 8, v: 'y' },
		]);
	});

	it('an autocommit ALTER PRIMARY KEY does not re-key an already-delivered event', async () => {
		// Nothing is batched, so the earlier write was delivered under the key the table
		// had at the time — correct, and it must stay put.
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec('alter table t alter primary key (a, b)');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1]);
	});

	it('an ALTER PRIMARY KEY on one table leaves another table\'s batched keys alone', async () => {
		await db.exec('create table t (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('create table u (a integer not null, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 9, 'x')");
		await db.exec("insert into u values (2, 8, 'y')");
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		assert.deepEqual(
			events.filter(e => e.tableName === 't' || e.tableName === 'u').map(e => [e.tableName, e.key]),
			[['t', [1, 9]], ['u', [2]]],
		);
	});

	it('a DROP COLUMN then an ALTER PRIMARY KEY in one transaction compose', async () => {
		// The re-key projects the ALREADY-remapped image, so its column indices must be
		// read against the post-drop layout, not the one the statement was written in.
		await db.exec('create table t (a integer not null, z text, b integer not null, v text, primary key (a)) using store');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'zz', 9, 'x')");
		await db.exec('alter table t drop column z');
		await db.exec('alter table t alter primary key (a, b)');
		await db.exec('commit');

		const dml = events.filter(e => e.tableName === 't');
		assert.equal(dml.length, 1);
		assert.deepEqual(dml[0].key, [1, 9]);
		assert.deepEqual(dml[0].newRow, [1, 9, 'x']);
		await assertRows(db, 'select * from t', [{ a: 1, b: 9, v: 'x' }]);
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
