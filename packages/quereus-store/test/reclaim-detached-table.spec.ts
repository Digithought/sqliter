/**
 * StoreModule.reclaimDetachedTable — the store-side reclaim-by-name helper the
 * sync layer's basis-eviction sweep targets (docs/migration.md § 4 Contract).
 *
 * It reclaims a detached basis table's lingering data / index / stats stores AND
 * its catalog DDL by name, WITHOUT emitting a schema-change event (the table is
 * already out of the engine schema). It must be idempotent: a second call, or a
 * call after a real `drop table` already removed the storage, is a clean no-op.
 *
 * Uses a persistent in-memory provider whose `deleteTableStores` keys off the
 * supplied index-name list (matching real-provider semantics — a `{table}_idx_`
 * prefix sweep would clobber a sibling table literally named `{table}_idx_<x>`).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import {
	StoreModule,
	StoreEventEmitter,
	InMemoryKVStore,
	buildCatalogKey,
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
		async closeAll() { /* data survives module close */ },
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

describe('StoreModule.reclaimDetachedTable', () => {
	let provider: ReturnType<typeof createPersistentProvider>;
	let events: StoreEventEmitter;
	let schemaDrops: string[];

	beforeEach(() => {
		provider = createPersistentProvider();
		events = new StoreEventEmitter();
		schemaDrops = [];
		events.onSchemaChange(e => { if (e.type === 'drop' && e.objectType === 'table') schemaDrops.push(e.objectName); });
	});

	afterEach(() => provider._hardClose());

	const has = (key: string) => provider.stores.has(key);
	async function catalogHas(table: string, schema = 'main'): Promise<boolean> {
		const catalog = await provider.getCatalogStore();
		return (await catalog.get(buildCatalogKey(schema, table))) !== undefined;
	}

	it('reclaims the data / index / stats stores + catalog DDL by name, with no drop event', async () => {
		const db = new Database();
		const mod = new StoreModule(provider, events);
		db.registerModule('store', mod);

		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10), (2, 20)`);

		// Preconditions: the data + index stores and the catalog entry exist. (Row
		// stats live in a unified store, not a per-table store, so they are not part
		// of the per-table reclaim — mirroring destroy().)
		expect(has('main.t'), 'data store').to.equal(true);
		expect(has('main.t_idx_ix_b'), 'index store').to.equal(true);
		expect(await catalogHas('t'), 'catalog DDL').to.equal(true);
		schemaDrops.length = 0;

		await mod.reclaimDetachedTable('main', 't', ['ix_b']);

		// All per-table physical storage + catalog DDL reclaimed.
		expect(has('main.t'), 'data store gone').to.equal(false);
		expect(has('main.t_idx_ix_b'), 'index store gone').to.equal(false);
		expect(await catalogHas('t'), 'catalog DDL gone').to.equal(false);
		// The engine already saw the detach — reclaim is silent.
		expect(schemaDrops, 'no schema-change drop event emitted').to.have.lengthOf(0);

		await db.close();
	});

	it('is idempotent: a second reclaim is a clean no-op', async () => {
		const db = new Database();
		const mod = new StoreModule(provider, events);
		db.registerModule('store', mod);
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);

		await mod.reclaimDetachedTable('main', 't', ['ix_b']);
		// Second call must not throw and leaves nothing behind.
		await mod.reclaimDetachedTable('main', 't', ['ix_b']);
		expect(has('main.t')).to.equal(false);
		expect(has('main.t_idx_ix_b')).to.equal(false);

		await db.close();
	});

	it('treats storage-already-gone as success (never-created table name)', async () => {
		const mod = new StoreModule(provider, events);
		// No table by this name was ever created — reclaim resolves without throwing.
		await mod.reclaimDetachedTable('main', 'ghost', ['idx_x']);
		expect(has('main.ghost')).to.equal(false);
	});
});
