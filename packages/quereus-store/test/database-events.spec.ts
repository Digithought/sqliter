/**
 * Regression: store-backed DML must not double-emit on db.onDataChange /
 * db.onTransactionCommit when the StoreModule is constructed with a
 * StoreEventEmitter (the production config).
 *
 * Root cause: the DML executor's auto-event gate checked hasNativeEventSupport
 * on the vtab *instance* (StoreTable), which carries no getEventEmitter.  The
 * engine therefore also auto-emitted, producing 2 events per DML statement
 * alongside the module's own native emit.  The fix makes the gate check the
 * owning *module* instead, mirroring the already-correct schema-event gate.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'node:assert/strict';
import {
	Database,
	type DatabaseDataChangeEvent,
	type DatabaseSchemaChangeEvent,
	type TransactionCommitBatch,
} from '@quereus/quereus';
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

describe('Database-level events: store-backed DML single-emit', () => {
	let db: Database;
	let provider: KVStoreProvider;

	beforeEach(async () => {
		provider = createInMemoryProvider();
		db = new Database();
		db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
		await db.exec('create table t (id integer primary key, v text) using store');
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	it('insert emits exactly 1 onDataChange event', async () => {
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => events.push(e));
		try {
			await db.exec("insert into t values (1, 'a')");
			assert.equal(events.length, 1, `expected 1 data event, got ${events.length}`);
			assert.equal(events[0].type, 'insert');
		} finally {
			unsub();
		}
	});

	it('insert emits exactly 1 data event across all onTransactionCommit batches', async () => {
		const batches: TransactionCommitBatch[] = [];
		const unsub = db.onTransactionCommit(b => batches.push(b));
		try {
			await db.exec("insert into t values (1, 'a')");
			const totalDataEvents = batches.reduce((n, b) => n + b.dataEvents.length, 0);
			assert.equal(totalDataEvents, 1, `expected 1 data event across ${batches.length} batch(es), got ${totalDataEvents}`);
		} finally {
			unsub();
		}
	});

	it('update emits exactly 1 onDataChange event', async () => {
		await db.exec("insert into t values (1, 'a')");
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => events.push(e));
		try {
			await db.exec("update t set v = 'b' where id = 1");
			assert.equal(events.length, 1, `expected 1 data event, got ${events.length}`);
			assert.equal(events[0].type, 'update');
		} finally {
			unsub();
		}
	});

	it('update emits exactly 1 data event across all onTransactionCommit batches', async () => {
		await db.exec("insert into t values (1, 'a')");
		const batches: TransactionCommitBatch[] = [];
		const unsub = db.onTransactionCommit(b => batches.push(b));
		try {
			await db.exec("update t set v = 'b' where id = 1");
			const totalDataEvents = batches.reduce((n, b) => n + b.dataEvents.length, 0);
			assert.equal(totalDataEvents, 1, `expected 1 data event across ${batches.length} batch(es), got ${totalDataEvents}`);
		} finally {
			unsub();
		}
	});

	it('delete emits exactly 1 onDataChange event', async () => {
		await db.exec("insert into t values (1, 'a')");
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => events.push(e));
		try {
			await db.exec('delete from t where id = 1');
			assert.equal(events.length, 1, `expected 1 data event, got ${events.length}`);
			assert.equal(events[0].type, 'delete');
		} finally {
			unsub();
		}
	});

	it('delete emits exactly 1 data event across all onTransactionCommit batches', async () => {
		await db.exec("insert into t values (1, 'a')");
		const batches: TransactionCommitBatch[] = [];
		const unsub = db.onTransactionCommit(b => batches.push(b));
		try {
			await db.exec('delete from t where id = 1');
			const totalDataEvents = batches.reduce((n, b) => n + b.dataEvents.length, 0);
			assert.equal(totalDataEvents, 1, `expected 1 data event across ${batches.length} batch(es), got ${totalDataEvents}`);
		} finally {
			unsub();
		}
	});

	it('multi-row insert emits exactly N onDataChange events (no per-row doubling)', async () => {
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => events.push(e));
		try {
			await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
			assert.equal(events.length, 3, `expected 3 data events for 3 rows, got ${events.length}`);
			assert.deepEqual(events.map(e => e.type), ['insert', 'insert', 'insert']);
		} finally {
			unsub();
		}
	});

	it('memory table in the same DB still gets its auto-emitted event (single)', async () => {
		await db.exec('create table m (id integer primary key, v text)');
		const events: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => events.push(e));
		try {
			await db.exec("insert into m values (99, 'x')");
			assert.equal(events.length, 1, `expected 1 event for memory table, got ${events.length}`);
			assert.equal(events[0].type, 'insert');
			assert.equal(events[0].tableName, 'm');
		} finally {
			unsub();
		}
	});

	it('DDL create table using store emits exactly 1 onSchemaChange event (control)', async () => {
		const schemaEvents: unknown[] = [];
		const unsub = db.onSchemaChange(e => schemaEvents.push(e));
		try {
			await db.exec('create table t2 (id integer primary key) using store');
			assert.equal(schemaEvents.length, 1, `expected 1 schema event, got ${schemaEvents.length}`);
		} finally {
			unsub();
		}
	});

	// Same gate, ALTER side. The engine now raises its own schema event from every ALTER TABLE
	// arm for backends that ship no emitter — so a store-backed table (which HAS one) is exactly
	// where a second producer would show up as a doubled event.
	it('DDL alter table add column over a store table emits exactly 1 onSchemaChange event', async () => {
		const schemaEvents: DatabaseSchemaChangeEvent[] = [];
		const unsub = db.onSchemaChange(e => schemaEvents.push(e));
		try {
			await db.exec('alter table t add column w text null');
			assert.equal(schemaEvents.length, 1,
				`expected 1 schema event, got ${schemaEvents.length}: ${JSON.stringify(schemaEvents)}`);
			assert.equal(schemaEvents[0].type, 'alter');
			assert.equal(schemaEvents[0].objectName, 't');
		} finally {
			unsub();
		}
	});

	it('DDL alter table rename to over a store table emits exactly 1 onSchemaChange event', async () => {
		const schemaEvents: DatabaseSchemaChangeEvent[] = [];
		const unsub = db.onSchemaChange(e => schemaEvents.push(e));
		try {
			await db.exec('alter table t rename to t_renamed');
			assert.equal(schemaEvents.length, 1,
				`expected 1 schema event, got ${schemaEvents.length}: ${JSON.stringify(schemaEvents)}`);
			assert.equal(schemaEvents[0].type, 'alter');
		} finally {
			unsub();
		}
	});
});
