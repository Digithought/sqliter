/**
 * Cross-tab read-cache invalidation in `IndexedDBProvider.invalidateCache`.
 *
 * When another tab reports a data change for table `t`, this tab clears the read
 * caches of `t`'s data and index stores. The provider holds only physical store
 * *names*, so it cannot tell a real index store of `t` (`main.t_idx_<index>`)
 * apart from a sibling table literally named `t_idx_<x>` (data store
 * `main.t_idx_<x>`) by name alone — both share the `main.t_idx_` prefix. The old
 * prefix-scan therefore over-invalidated the sibling. The provider now tracks each
 * table's own index store names (registered as index stores are opened) and clears
 * exactly those, never prefix-matching.
 *
 * These wire the real `IndexedDBProvider` over `fake-indexeddb/auto` with a real
 * `Database` + `StoreModule` so the stores materialize through normal DDL/DML, then
 * exercise `invalidateCache` against the live cached handles.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { Database } from '@quereus/quereus';
import { StoreModule, CachedKVStore } from '@quereus/store';
import { IndexedDBProvider, createIndexedDBProvider } from '../src/provider.js';
import { IndexedDBManager } from '../src/manager.js';

describe('IndexedDB invalidateCache prefix collision', () => {
	const testDbName = 'test-invalidate-cache-db';
	let db: Database;
	let provider: IndexedDBProvider;
	let mod: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createIndexedDBProvider({ databaseName: testDbName });
		mod = new StoreModule(provider);
		db.registerModule('store', mod);
	});

	afterEach(async () => {
		try {
			await mod.closeAll();
		} catch {
			/* may already be closed by the test */
		}
		IndexedDBManager.resetInstance(testDbName);

		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(testDbName);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	});

	const KEY = new Uint8Array([1]);
	const CACHED = new Uint8Array([0xca]);
	const FRESH = new Uint8Array([0xfe]);

	/**
	 * Warm `store`'s cache with CACHED, then mutate its underlying store behind the
	 * cache's back to FRESH. While the cache stands, `get(KEY)` serves the stale
	 * CACHED; once invalidated, it re-reads FRESH. This lets us observe, per store,
	 * whether `invalidateCache` cleared it.
	 */
	async function makeStale(store: CachedKVStore): Promise<void> {
		await store.put(KEY, CACHED);            // write-through: cache + underlying = CACHED
		await store.getUnderlying().put(KEY, FRESH); // underlying = FRESH, cache still CACHED
	}

	it('invalidateCache(t) clears t data + real index caches but NOT a sibling t_idx_<x>', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		// Sibling whose data store (main.t_idx_archive) shares t's index prefix.
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100)`);

		// The provider returns the same cached handles it holds in its store map.
		const tData = await provider.getStore('main', 't') as CachedKVStore;
		const tIndex = await provider.getIndexStore('main', 't', 'ix_b') as CachedKVStore;
		const sibling = await provider.getStore('main', 't_idx_archive') as CachedKVStore;
		expect(tData, 't data store is cached').to.be.instanceOf(CachedKVStore);
		expect(tIndex, 't index store is cached').to.be.instanceOf(CachedKVStore);
		expect(sibling, 'sibling data store is cached').to.be.instanceOf(CachedKVStore);

		await makeStale(tData);
		await makeStale(tIndex);
		await makeStale(sibling);

		// Cross-tab data-change broadcast for table `t`.
		provider.invalidateCache('main', 't');

		// t's own data + index caches were cleared → a re-read sees FRESH.
		expect(await tData.get(KEY), 't data cache invalidated').to.deep.equal(FRESH);
		expect(await tIndex.get(KEY), 't real index cache invalidated').to.deep.equal(FRESH);
		// The sibling was left alone → still serves the stale CACHED. Under the old
		// prefix-scan its cache was wrongly dropped and this would surface FRESH.
		expect(await sibling.get(KEY), 'sibling cache untouched').to.deep.equal(CACHED);
	});

	it('after DROP INDEX + sibling reuse, invalidateCache(t) leaves the reused sibling alone', async () => {
		// `t` first owns an index literally named `archive` → store main.t_idx_archive.
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index "archive" on t (b)`);
		await db.exec(`insert into t values (1, 10)`);

		// Dropping the index frees the physical name; a sibling table may then
		// legitimately reuse it (create-time collision detection now permits this).
		await db.exec(`drop index "archive"`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`insert into "t_idx_archive" values (1, 100)`);

		const sibling = await provider.getStore('main', 't_idx_archive') as CachedKVStore;
		expect(sibling, 'sibling data store is cached').to.be.instanceOf(CachedKVStore);
		await makeStale(sibling);

		provider.invalidateCache('main', 't');

		// The dropped `archive` index must have been purged from t's tracking, so the
		// reused sibling store is not mistaken for t's index and keeps its cache.
		expect(await sibling.get(KEY), 'reused sibling cache untouched').to.deep.equal(CACHED);
	});

	it('invalidateAllCaches clears every cached store including a sibling', async () => {
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create table "t_idx_archive" (id integer primary key, v integer) using store`);
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`insert into "t_idx_archive" values (1, 100)`);

		const tData = await provider.getStore('main', 't') as CachedKVStore;
		const sibling = await provider.getStore('main', 't_idx_archive') as CachedKVStore;
		await makeStale(tData);
		await makeStale(sibling);

		// The unscoped path deliberately clears everything (used when the affected
		// table is unknown) — both the data store and the sibling re-read FRESH.
		provider.invalidateAllCaches();

		expect(await tData.get(KEY)).to.deep.equal(FRESH);
		expect(await sibling.get(KEY)).to.deep.equal(FRESH);
	});

	it('after RENAME, invalidateCache(new name) clears the re-registered index store', async () => {
		// `renameTableStores` drops the old table's index mapping; the renamed table
		// re-registers its index stores lazily on the next `getIndexStore`. Assert the
		// new name's cross-tab invalidation reaches that re-registered index — the real
		// post-rename correctness path, not just the harmless old-name no-op.
		await db.exec(`create table t (id integer primary key, b integer) using store`);
		await db.exec(`create index ix_b on t (b)`);
		await db.exec(`insert into t values (1, 10)`);
		await db.exec(`alter table t rename to t2`);

		// Re-open under the new name → getIndexStore re-registers main.t2_idx_ix_b.
		const t2Data = await provider.getStore('main', 't2') as CachedKVStore;
		const t2Index = await provider.getIndexStore('main', 't2', 'ix_b') as CachedKVStore;
		expect(t2Data, 't2 data store is cached').to.be.instanceOf(CachedKVStore);
		expect(t2Index, 't2 index store is cached').to.be.instanceOf(CachedKVStore);
		await makeStale(t2Data);
		await makeStale(t2Index);

		provider.invalidateCache('main', 't2');

		expect(await t2Data.get(KEY), 't2 data cache invalidated').to.deep.equal(FRESH);
		expect(await t2Index.get(KEY), 't2 re-registered index cache invalidated').to.deep.equal(FRESH);
	});
});
