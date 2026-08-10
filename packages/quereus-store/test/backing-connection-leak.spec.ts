/**
 * Regression: store connections must be registered under the schema-qualified
 * name so that `removeConnectionsForTable` can evict them on drop/rename.
 *
 * Both mint sites (`StoreBackingHost.connect` for MV-backing host connections
 * and `StoreTable.ensureCoordinator` for ordinary DML connections) previously
 * used the bare table name, which never matched the qualified form
 * `removeConnectionsForTable` expects — leaving every dropped/renamed table's
 * connection alive in `Database.activeConnections` forever. After the fix both
 * sites use `${schemaName}.${tableName}`, matching the memory module and the
 * engine's cleanup.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	type KVStoreProvider,
} from '../src/index.js';

function createPersistentProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	const dataKey = (s: string, t: string) => `${s}.${t}`;
	const statsKey = (s: string, t: string) => `${s}.${t}.__stats__`;
	const idxKey = (s: string, t: string, i: string) => `${s}.${t}_idx_${i}`;
	const move = (from: string, to: string) => {
		const v = stores.get(from);
		if (v) { stores.set(to, v); stores.delete(from); }
	};

	return {
		stores,
		async getStore(s: string, t: string) { return getOrCreate(dataKey(s, t)); },
		async getIndexStore(s: string, t: string, i: string) { return getOrCreate(idxKey(s, t, i)); },
		async getStatsStore(s: string, t: string) { return getOrCreate(statsKey(s, t)); },
		async getCatalogStore() { return getOrCreate('__catalog__'); },
		async closeStore() { /* durable */ },
		async closeIndexStore() { /* durable */ },
		async deleteIndexStore(s: string, t: string, i: string) { stores.delete(idxKey(s, t, i)); },
		async deleteTableStores(s: string, t: string, indexNames: readonly string[]) {
			stores.delete(dataKey(s, t));
			stores.delete(statsKey(s, t));
			for (const i of indexNames) stores.delete(idxKey(s, t, i));
		},
		async renameTableStores(s: string, oldName: string, newName: string, indexNames: readonly string[]) {
			move(dataKey(s, oldName), dataKey(s, newName));
			move(statsKey(s, oldName), statsKey(s, newName));
			for (const i of indexNames) move(idxKey(s, oldName, i), idxKey(s, newName, i));
		},
		async closeAll() { /* data survives module close */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

type DbWithConnections = { getAllConnections(): unknown[] };

describe('store connection name leak (drop/recreate must not grow activeConnections)', () => {
	let provider: ReturnType<typeof createPersistentProvider>;
	let events: StoreEventEmitter;

	beforeEach(() => {
		provider = createPersistentProvider();
		events = new StoreEventEmitter();
	});

	afterEach(() => provider._hardClose());

	it('MV-backing host connections are evicted on drop+recreate', async () => {
		const db = new Database();
		db.registerModule('store', new StoreModule(provider, events));

		// A long-lived sibling keeps baseline > 0.
		await db.exec(`create table src (id integer primary key, v integer) using store`);
		await db.exec(`insert into src values (1, 10)`);

		const baseline = (db as unknown as DbWithConnections).getAllConnections().length;

		for (let i = 0; i < 10; i++) {
			await db.exec(`create materialized view mv using store as select id, v from src`);
			await db.exec(`drop materialized view mv`);
		}

		expect((db as unknown as DbWithConnections).getAllConnections().length).to.equal(baseline);

		await db.close();
	});

	// The backing host's connection is a StoreConnection pinned to its owning StoreTable
	// (`StoreConnection.owner`), and `StoreModule.renameTable` discriminates on the class,
	// not on the pin — so it must be evicted alongside ordinary DML connections.
	it('MV-backing host connections are evicted on rename', async () => {
		const db = new Database();
		db.registerModule('store', new StoreModule(provider, events));

		await db.exec(`create table src (id integer primary key, v integer) using store`);
		await db.exec(`insert into src values (1, 10)`);
		await db.exec(`create materialized view mv using store as select id, v from src`);

		const baseline = (db as unknown as DbWithConnections).getAllConnections().length;

		for (let i = 0; i < 6; i++) {
			const from = i % 2 === 0 ? 'mv' : 'mv2';
			const to = i % 2 === 0 ? 'mv2' : 'mv';
			await db.exec(`insert into src values (${i + 2}, ${i})`);
			await db.exec(`alter table ${from} rename to ${to}`);
		}

		expect((db as unknown as DbWithConnections).getAllConnections().length).to.equal(baseline);

		await db.close();
	});

	it('ordinary DML connections are evicted on drop+recreate', async () => {
		const db = new Database();
		db.registerModule('store', new StoreModule(provider, events));

		await db.exec(`create table keep (id integer primary key) using store`);
		await db.exec(`insert into keep values (1)`);

		const baseline = (db as unknown as DbWithConnections).getAllConnections().length;

		for (let i = 0; i < 10; i++) {
			await db.exec(`create table churn (id integer primary key, v integer) using store`);
			await db.exec(`insert into churn values (1, ${i})`);
			await db.exec(`drop table churn`);
		}

		expect((db as unknown as DbWithConnections).getAllConnections().length).to.equal(baseline);

		await db.close();
	});

	it('connections are evicted on rename (no orphan per rename)', async () => {
		const db = new Database();
		db.registerModule('store', new StoreModule(provider, events));

		// A long-lived sibling keeps baseline > 0 and one live ping-pong table.
		await db.exec(`create table keep (id integer primary key) using store`);
		await db.exec(`insert into keep values (1)`);
		await db.exec(`create table a (id integer primary key, v integer) using store`);

		const baseline = (db as unknown as DbWithConnections).getAllConnections().length;

		// Ping-pong rename a<->b, writing after each so the fresh instance attaches a
		// connection. Without the rename-side eviction this grows +1 per rename.
		for (let i = 0; i < 6; i++) {
			const from = i % 2 === 0 ? 'a' : 'b';
			const to = i % 2 === 0 ? 'b' : 'a';
			await db.exec(`insert into ${from} values (${i + 2}, ${i})`);
			await db.exec(`alter table ${from} rename to ${to}`);
		}

		expect((db as unknown as DbWithConnections).getAllConnections().length).to.equal(baseline);

		await db.close();
	});
});
