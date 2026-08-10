/**
 * Clean-shutdown marker consume-delete durability.
 *
 * `rehydrateCatalog` consumes the single-use `\x00meta\x00clean_shutdown` catalog
 * marker by reading it then deleting it. That delete now carries a `sync: true`
 * durability hint so it is forced to stable storage before any of the session's
 * data writes can become durable — otherwise a power loss could persist data
 * writes while losing the marker delete, resurrecting a consumed marker and
 * adopting a backing across a genuine crash window.
 *
 * These tests use a persistent in-memory provider (à la `mv-rehydrate-adopt`)
 * whose catalog store is a spy that records every `delete` and the `sync` flag it
 * was given, so we can assert the consume-delete fired exactly once, durably, and
 * that trust still resolves correctly (the sentinel oracle proves adopt-not-refill).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import {
	StoreModule,
	InMemoryKVStore,
	buildDataKey,
	serializeRow,
	buildMetaCatalogKey,
	bytesEqual,
	CLEAN_SHUTDOWN_META_NAME,
	type KVStoreProvider,
	type WriteOptions,
} from '../src/index.js';

/** InMemoryKVStore that records every delete() call and its durability hint. */
class SpyCatalogStore extends InMemoryKVStore {
	readonly deleteCalls: Array<{ key: Uint8Array; sync: boolean }> = [];

	async delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
		this.deleteCalls.push({ key: new Uint8Array(key), sync: options?.sync ?? false });
		return super.delete(key, options);
	}
}

function createSpyProvider(): KVStoreProvider & {
	stores: Map<string, InMemoryKVStore>;
	catalogSpy: SpyCatalogStore;
	_hardClose: () => void;
} {
	const stores = new Map<string, InMemoryKVStore>();
	const catalogSpy = new SpyCatalogStore();
	stores.set('__catalog__', catalogSpy);

	const getOrCreate = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) {
			s = new InMemoryKVStore();
			stores.set(key, s);
		}
		return s;
	};

	return {
		stores,
		catalogSpy,
		async getStore(schemaName: string, tableName: string) {
			return getOrCreate(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return getOrCreate(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore() {
			return getOrCreate('__stats__');
		},
		async getCatalogStore() {
			return catalogSpy;
		},
		async closeStore() { /* no-op: durable storage survives a logical close */ },
		async closeIndexStore() { /* no-op */ },
		async closeAll() { /* no-op: data survives module close, mirroring real disk */ },
		async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]) {
			stores.delete(`${schemaName}.${tableName}`);
			for (const i of indexNames) stores.delete(`${schemaName}.${tableName}_idx_${i}`);
		},
		_hardClose() {
			for (const s of stores.values()) void s.close();
			stores.clear();
		},
	};
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	return (await asyncIterableToArray(db.eval(sql))) as Record<string, unknown>[];
}

describe('clean-shutdown marker consume-delete durability', () => {
	let provider: ReturnType<typeof createSpyProvider>;

	beforeEach(() => { provider = createSpyProvider(); });
	afterEach(() => { provider._hardClose(); });

	function open(): { db: Database; mod: StoreModule } {
		const db = new Database();
		const mod = new StoreModule(provider);
		db.registerModule('store', mod);
		return { db, mod };
	}

	/** First session: a store source + store-backed MV, cleanly closed (marker armed). */
	async function seedSession(): Promise<void> {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10), (2, 20)');
		await db.exec('create materialized view mv using store as select id, v from src');
		await mod.closeAll();
	}

	const markerKey = buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME);
	const syncedMarkerDeletes = (): number =>
		provider.catalogSpy.deleteCalls.filter(c => c.sync && bytesEqual(c.key, markerKey)).length;
	const anyMarkerDeletes = (): number =>
		provider.catalogSpy.deleteCalls.filter(c => bytesEqual(c.key, markerKey)).length;

	it('deletes the present marker exactly once with sync:true and still adopts', async () => {
		await seedSession();
		// Plant a sentinel the body would never produce — its survival proves adopt.
		await provider.stores.get('main.mv')!.put(buildDataKey([99]), serializeRow([99, 990]));
		provider.catalogSpy.deleteCalls.length = 0; // ignore any close-side churn

		const { db, mod } = open();
		const result = await mod.rehydrateCatalog(db);

		expect(result.errors, 'rehydrate is clean').to.have.lengthOf(0);
		expect(result.materializedViews).to.deep.equal(['main.mv']);

		// The consume-delete fired exactly once, durably.
		expect(anyMarkerDeletes(), 'marker deleted exactly once').to.equal(1);
		expect(syncedMarkerDeletes(), 'the marker delete carried sync:true').to.equal(1);

		// The marker is gone (single-use) and the sentinel survived (adopt, not refill).
		expect(await provider.catalogSpy.get(markerKey), 'marker consumed').to.be.undefined;
		expect(await rows(db, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 99, v: 990 }]);
	});

	it('absent marker: no consume-delete, and the backing refills (no trust)', async () => {
		const { db, mod } = open();
		await db.exec('create table src (id integer primary key, v integer) using store');
		await db.exec('insert into src values (1, 10)');
		await db.exec('create materialized view mv using store as select id, v from src');
		// Flush the catalog WITHOUT a clean close — no marker is written.
		await mod.whenCatalogPersisted();
		await provider.stores.get('main.mv')!.put(buildDataKey([99]), serializeRow([99, 990]));
		provider.catalogSpy.deleteCalls.length = 0;

		const { db: db2, mod: mod2 } = open();
		const result = await mod2.rehydrateCatalog(db2);
		expect(result.errors).to.have.lengthOf(0);

		// Marker absent ⇒ consumeCleanShutdownMarker returns before any delete.
		expect(anyMarkerDeletes(), 'no marker, no consume-delete').to.equal(0);
		// Refill scrubbed the sentinel.
		expect(await rows(db2, 'select id, v from mv order by id'))
			.to.deep.equal([{ id: 1, v: 10 }]);
	});
});
