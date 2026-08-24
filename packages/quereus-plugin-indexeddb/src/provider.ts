/**
 * IndexedDB KVStore provider implementation.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   __stats__                     - Unified stats store (row counts for all tables)
 *   __catalog__                   - Catalog store (DDL metadata)
 */

import type { AtomicBatch, KVCostProfile, KVStore, KVStoreProvider } from '@quereus/store';
import {
	buildDataStoreName,
	buildIndexStoreName,
	CachedKVStore,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
	type CacheOptions,
} from '@quereus/store';
import { QuereusError, StatusCode } from '@quereus/quereus';
import { IndexedDBStore, MultiStoreWriteBatch } from './store.js';
import { IndexedDBManager } from './manager.js';

/**
 * Options for creating an IndexedDB provider.
 */
export interface IndexedDBProviderOptions {
	/**
	 * Name for the unified IndexedDB database.
	 * All tables share this single database with separate object stores.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Read cache configuration.
	 * Wraps each data/index store with an in-memory LRU cache.
	 */
	cache?: CacheOptions;
}

/**
 * IndexedDB implementation of KVStoreProvider.
 *
 * Uses a unified single-database architecture where all tables share one
 * IndexedDB database with multiple object stores (one per table).
 */
export class IndexedDBProvider implements KVStoreProvider {
	/**
	 * What this backend's random reads cost, relative to one row read sequentially during
	 * a full scan (= 1.0). Every point read here is a separate request across the browser's
	 * IPC boundary, where a scan pages 256 entries per request — so the store's parity
	 * defaults (1.0 / 0.5), which fit an in-process block-cached backend like LevelDB,
	 * price an IndexedDB lookup at roughly a third of what it costs.
	 *
	 * Measured in `bench/README.md` (Chromium 151 / Windows 11, 200-byte rows, page size
	 * 256, medians). A full scan reads a row in 0.0047 ms at 20k rows and ~0.011 ms at
	 * 100k; the index path (bench arm A — today's two-store design) resolves a matched row
	 * in 0.0169–0.0175 ms at 20k and 0.0406–0.0465 ms at 100k.
	 *
	 * `pointRead` = arm A's per-row cost MINUS the index-entry paging it also pays, over
	 * arm C's per-scanned-row cost. Index entries are read sequentially, 256 per request;
	 * the bench's closest measurement of an entry read is arm B2 at 0.8× a data row, so
	 * entry paging is charged at 0.8. That subtraction is an ESTIMATE, not a measurement —
	 * the bench never timed two-store index paging on its own.
	 *
	 *   | size / clustering       | arm A /row | entry paging  | resolution | ÷ scan row | ratio |
	 *   |-------------------------|------------|---------------|------------|------------|-------|
	 *   | 20k, 25% sel, either    | 0.0169–0.0175 | 0.8 × 0.0047 | ~0.0131 ms | 0.0047     | 2.8   |
	 *   | 100k, 25%, clustered    | 0.0406     | 0.8 × 0.011   | ~0.0318 ms | 0.011      | 2.9   |
	 *   | 100k, 25%, uniform      | 0.0465     | 0.8 × 0.011   | ~0.0376 ms | 0.011      | 3.4   |
	 *
	 * Band 2.8–3.4 ⇒ declare 3.0.
	 *
	 * NOTE: 0.8 is a LOWER bound on arm A's entry paging, which biases the whole band — and
	 * therefore the declared 3.0 — to the pessimistic side. Arm B2 spends one request per
	 * entry page (`getAllKeys` over a carved value window); arm A spends two (`bench/arms.mjs`
	 * charges `requests += 2` per `readPage`, since a resumable two-store scan must read the
	 * entry keys AND their values). Charging arm A's paging at B2's price leaves too much
	 * cost in the "resolution" remainder, so the true `pointRead` is likely at or below 2.8.
	 * Harmless while the seek-vs-scan veto is clamped to the parity price (it is — see
	 * `store-module-access-plan.ts`), because an over-stated `pointRead` then only inflates
	 * what an index arm advertises and cannot switch an arm off. Re-derive from a bench arm
	 * that times two-store entry paging alone before the veto starts reading this number.
	 *
	 * `seekPositioning` prices one multi-seek key: an index window request PLUS a row read,
	 * neither amortized across a 256-entry page ⇒ ≈ 2 × the point-read cost above, i.e.
	 * 0.026 ms at 20k (5.5 scan-rows) and ~0.062 ms at 100k (5.7). Declared 5.0, rounded
	 * slightly DOWN so a borderline key-set seek keeps firing rather than being priced out
	 * on a rounding decision.
	 *
	 * Both numbers are request-latency dominated, so a slower device scales the seek path
	 * and the scan baseline together — which is why the profile is a ratio and not
	 * milliseconds.
	 *
	 * NOTE: this provider wraps every store in a `CachedKVStore` by default, and the bench
	 * measured RAW IndexedDB. A warm LRU cache makes point reads far cheaper than 3.0, but
	 * a cost profile is a static, cold-path declaration and cannot express a hit rate. The
	 * cold number is the safe one to plan against; if cache-hit rates ever become
	 * observable at plan time, revisit this.
	 */
	readonly costProfile: KVCostProfile = { pointRead: 3.0, seekPositioning: 5.0 };

	// NOTE: no `expectedLatencyMs` declared, deliberately — and like the `costProfile` above
	// that is a MEASURED decision, not the absence of one. The provider therefore resolves to
	// the 0 default, i.e. the planner treats this backend as in-process for latency purposes.
	//
	// `bench/README.md` (Chromium 151 / Windows 11, 200-byte rows, medians) has the numbers:
	// the smallest whole round trip in the harness — arm B, 20 rows resolved in 1 request — is
	// 0.4 ms on a 20k-row table and 2.0-2.5 ms at 100k. Subtracting the row payload at the
	// measured full-scan rate leaves a first-row latency somewhere in the low tenths of a
	// millisecond to low single milliseconds, depending on table size. Two reasons that
	// number stays undeclared:
	//
	//  - EVERY GATE THAT TURNS THE LATENCY MACHINERY ON IS 25 ms. `batchedOuterThresholdMs`,
	//    `gatherThresholdMs` and `prefetchProbeThresholdMs` all default to 25
	//    (`planner/optimizer-tuning.ts`), chosen against a synthetic high-latency fixture.
	//    This backend's real latency clears none of them, so declaring it would not make
	//    batched seeks, gathers or prefetch probes fire.
	//  - THE ONE FORMULA IT DOES MOVE, IT MOVES BACKWARDS HERE. `expectedLatencyMs` reaches
	//    exactly one shared cost function, `indexNestedLoopJoinCost`, which charges it PER
	//    OUTER ROW to the seek plan. `rule-join-physical-selection` does charge the hash and
	//    merge candidates too, but only ONE open per side (they each read both inputs once),
	//    so the asymmetry stands: a positive declaration only makes index-nested-loop look
	//    worse against hash join — and on IndexedDB the hash join's full scan of the inner
	//    side is the catastrophic arm (bench arm C), because a scan here is thousands of
	//    round trips that the cost model prices as one.
	//
	// REVISIT WHEN a scan-side per-row latency exists —
	// `backlog/feat-per-row-latency-cost-for-remote-scans` — and re-derive both together;
	// declaring first-row latency alone before then is a net-negative plan skew. As with the
	// cost profile above, DELIBERATELY NO DECIMALS QUOTED: the bench README holds the tables,
	// this comment holds the decision.

	private databaseName: string;
	private stores = new Map<string, KVStore>();
	/**
	 * Maps each table's data store name to the set of its own index store names.
	 * Populated as index stores are opened via `getIndexStore`, this is the
	 * authoritative per-table index list the provider would otherwise lack:
	 * `invalidateCache` consults it to clear exactly a table's own caches rather
	 * than prefix-scanning `{data}_idx_`, which also matches a sibling table
	 * literally named `{table}_idx_<x>` (data store `{schema}.{table}_idx_<x>`).
	 */
	private indexStoresByTable = new Map<string, Set<string>>();
	private catalogStore: IndexedDBStore | null = null;
	private statsStore: IndexedDBStore | null = null;
	private manager: IndexedDBManager;
	private cacheOptions: CacheOptions | undefined;

	constructor(options: IndexedDBProviderOptions = {}) {
		this.databaseName = options.databaseName ?? 'quereus';
		this.manager = IndexedDBManager.getInstance(this.databaseName);
		this.cacheOptions = options.cache;
	}

	// NOTE: the physical store name is used verbatim as an IndexedDB object-store name.
	// Per spec those are `DOMString`s compared by code unit, so an unpaired surrogate
	// SHOULD survive intact (unlike LevelDB, whose sublevel names go through UTF-8 and
	// fold every unpaired surrogate to U+FFFD) — but that has not been verified against a
	// real browser here. It does not affect correctness: `buildDataStoreName` /
	// `buildIndexStoreName` reject such an identifier above every provider, so no name
	// reaching here can carry one.
	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		const storeName = buildDataStoreName(schemaName, tableName);
		return this.getOrCreateStore(storeName);
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		this.registerIndexStore(buildDataStoreName(schemaName, tableName), storeName);
		return this.getOrCreateStore(storeName);
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables
		if (!this.statsStore) {
			this.statsStore = await IndexedDBStore.openForTable(
				this.databaseName,
				STATS_STORE_NAME
			);
		}
		return this.statsStore;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			this.catalogStore = await IndexedDBStore.openForTable(
				this.databaseName,
				CATALOG_STORE_NAME
			);
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const storeName = buildDataStoreName(schemaName, tableName);
		await this.closeStoreByName(storeName);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		await this.closeStoreByName(storeName);
	}

	async closeAll(): Promise<void> {
		for (const store of this.stores.values()) {
			await store.close();
		}
		this.stores.clear();
		this.indexStoresByTable.clear();

		if (this.catalogStore) {
			await this.catalogStore.close();
			this.catalogStore = null;
		}

		if (this.statsStore) {
			await this.statsStore.close();
			this.statsStore = null;
		}

		// Close the shared database manager
		await this.manager.close();
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const storeName = buildIndexStoreName(schemaName, tableName, indexName);
		await this.closeStoreByName(storeName);
		await this.manager.deleteObjectStore(storeName);
		// Drop the stale mapping so a sibling table that later reuses this physical
		// name (allowed once the index is gone) is not mistaken for this table's index.
		this.indexStoresByTable.get(buildDataStoreName(schemaName, tableName))?.delete(storeName);
	}

	async renameTableStores(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void> {
		const oldDataStoreName = buildDataStoreName(schemaName, oldName);
		const newDataStoreName = buildDataStoreName(schemaName, newName);

		// Up-front collision guard, mirroring LevelDB's "destination already exists".
		if (this.manager.hasObjectStore(newDataStoreName)) {
			throw new Error(`Cannot rename table '${oldName}' to '${newName}': data store '${newDataStoreName}' already exists`);
		}

		// Build the rename list from the data store (if it materialized) plus the
		// table's authoritative index stores. We map each schema index name to its
		// exact store name rather than prefix-scanning `{oldName}_idx_`, which would
		// also catch a sibling table named `{oldName}_idx_<x>`.
		const renameList: Array<{ from: string; to: string }> = [];
		if (this.manager.hasObjectStore(oldDataStoreName)) {
			renameList.push({ from: oldDataStoreName, to: newDataStoreName });
		}

		for (const indexName of indexNames) {
			const from = buildIndexStoreName(schemaName, oldName, indexName);
			// An index store may not have materialized yet; only move what exists.
			if (!this.manager.hasObjectStore(from)) continue;
			const to = buildIndexStoreName(schemaName, newName, indexName);
			if (this.manager.hasObjectStore(to)) {
				throw new Error(`Cannot rename table '${oldName}' to '${newName}': index store '${to}' already exists`);
			}
			renameList.push({ from, to });
		}

		// Evict cached handles for every source store BEFORE the relocation so no
		// stale IndexedDBStore/CachedKVStore points at an object store that is about
		// to be deleted. __stats__ is the unified stats store and is left untouched —
		// StoreModule.renameTable relocates the stats key itself.
		for (const { from } of renameList) {
			await this.closeStoreByName(from);
		}

		await this.manager.renameObjectStores(renameList);

		// The old table's index mapping is now stale (its stores were relocated and
		// their handles evicted). Drop it; the renamed table re-registers its index
		// stores on next access via `getIndexStore`.
		this.indexStoresByTable.delete(oldDataStoreName);
	}

	async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void> {
		const dataStoreName = buildDataStoreName(schemaName, tableName);

		// Close and delete data store
		await this.closeStoreByName(dataStoreName);
		if (this.manager.hasObjectStore(dataStoreName)) {
			await this.manager.deleteObjectStore(dataStoreName);
		}

		// Stats are in the unified __stats__ store, so no need to delete a separate store
		// here. The individual stats entry is removed by the caller — see
		// StoreModule.tearDownTableStorage — before this method runs.

		// Delete exactly the table's index stores (by name), not every object store
		// matching the `{table}_idx_` prefix — that prefix also matches a sibling
		// table literally named `{table}_idx_<x>`.
		for (const indexName of indexNames) {
			const storeName = buildIndexStoreName(schemaName, tableName, indexName);
			if (!this.manager.hasObjectStore(storeName)) continue;
			await this.closeStoreByName(storeName);
			await this.manager.deleteObjectStore(storeName);
		}

		// The table is gone; forget its index mapping so a future table reusing this
		// data store name does not inherit stale index store associations.
		this.indexStoresByTable.delete(dataStoreName);
	}

	/**
	 * Get the underlying IndexedDB manager for advanced operations.
	 */
	getManager(): IndexedDBManager {
		return this.manager;
	}

	/**
	 * Open an atomic batch across this provider's object stores.
	 *
	 * All of this provider's stores live in one IndexedDB database, so a single
	 * `db.transaction(storeNames, 'readwrite')` (driven by {@link MultiStoreWriteBatch})
	 * commits them atomically and durably. The transaction coordinator uses this
	 * to commit a table's data + secondary-index stores in one physical batch.
	 */
	beginAtomicBatch(): AtomicBatch {
		return new IndexedDBAtomicBatch(
			this.manager,
			(store) => this.resolveStoreName(store),
			(storeName) => this.invalidateStore(storeName),
		);
	}

	/**
	 * Map a {@link KVStore} handle this provider handed out back to its object
	 * store name. Handles are `CachedKVStore(IndexedDBStore)` (or a raw
	 * `IndexedDBStore` when caching is disabled). A handle not produced by this
	 * provider — wrong type, or an `IndexedDBStore` bound to a different manager —
	 * is a programming error.
	 */
	private resolveStoreName(store: KVStore): string {
		const raw = store instanceof CachedKVStore ? store.getUnderlying() : store;
		if (!(raw instanceof IndexedDBStore) || raw.getManager() !== this.manager) {
			throw new QuereusError(
				'AtomicBatch received a KVStore handle not produced by this provider',
				StatusCode.MISUSE,
			);
		}
		return raw.getStoreName();
	}

	/**
	 * Invalidate the read cache for a specific table's data and index stores.
	 * Called by cross-tab sync when remote data changes are detected.
	 */
	invalidateCache(schemaName: string, tableName: string): void {
		const dataStoreName = buildDataStoreName(schemaName, tableName);
		this.invalidateStore(dataStoreName);

		// Clear only this table's own index stores. We never prefix-scan
		// `{data}_idx_`: that prefix also matches a sibling table literally named
		// `{table}_idx_<x>` (data store `{schema}.{table}_idx_<x>`), and clearing it
		// would needlessly drop an unrelated table's read cache.
		const indexStores = this.indexStoresByTable.get(dataStoreName);
		if (indexStores) {
			for (const indexStoreName of indexStores) {
				this.invalidateStore(indexStoreName);
			}
		}
	}

	/** Invalidate a single store's read cache, if that store is currently cached. */
	private invalidateStore(storeName: string): void {
		const store = this.stores.get(storeName);
		if (store instanceof CachedKVStore) {
			store.invalidateAll();
		}
	}

	/**
	 * Invalidate all read caches. Called on remote data change events
	 * when the affected store is unknown.
	 */
	invalidateAllCaches(): void {
		for (const store of this.stores.values()) {
			if (store instanceof CachedKVStore) {
				store.invalidateAll();
			}
		}
	}

	/** Record that `indexStoreName` is an index store belonging to `dataStoreName`. */
	private registerIndexStore(dataStoreName: string, indexStoreName: string): void {
		let indexStores = this.indexStoresByTable.get(dataStoreName);
		if (!indexStores) {
			indexStores = new Set<string>();
			this.indexStoresByTable.set(dataStoreName, indexStores);
		}
		indexStores.add(indexStoreName);
	}

	private async getOrCreateStore(storeName: string): Promise<KVStore> {
		let store = this.stores.get(storeName);

		if (!store) {
			const raw = await IndexedDBStore.openForTable(this.databaseName, storeName);

			if (!raw) {
				throw new Error(`IndexedDBStore.openForTable returned null/undefined for ${storeName}`);
			}

			store = this.cacheOptions?.enabled === false
				? raw
				: new CachedKVStore(raw, this.cacheOptions);
			this.stores.set(storeName, store);
		}

		return store;
	}

	private async closeStoreByName(storeName: string): Promise<void> {
		const store = this.stores.get(storeName);
		if (store) {
			await store.close();
			this.stores.delete(storeName);
		}
	}
}

/**
 * {@link AtomicBatch} over the unified IndexedDB database.
 *
 * Wraps {@link MultiStoreWriteBatch} (one `db.transaction(storeNames, 'readwrite')`
 * = native IDB multi-store atomicity), translating each {@link KVStore} handle to
 * its object store name via the provider's `resolveStoreName`. After a successful
 * `write()` the atomic write has bypassed every `CachedKVStore` wrapper, so each
 * touched store's read cache would be stale; the batch invalidates them via the
 * provider's `invalidateStore` to preserve read-your-own-writes across the cache.
 */
class IndexedDBAtomicBatch implements AtomicBatch {
	private readonly batch: MultiStoreWriteBatch;

	constructor(
		manager: IndexedDBManager,
		private readonly resolveStoreName: (store: KVStore) => string,
		private readonly invalidateStore: (storeName: string) => void,
	) {
		this.batch = new MultiStoreWriteBatch(manager);
	}

	put(store: KVStore, key: Uint8Array, value: Uint8Array): void {
		this.batch.putToStore(this.resolveStoreName(store), key, value);
	}

	delete(store: KVStore, key: Uint8Array): void {
		this.batch.deleteFromStore(this.resolveStoreName(store), key);
	}

	async write(): Promise<void> {
		// Capture before write() — a successful write() clears the batch's ops and
		// store names, so read the names up front for post-write cache invalidation.
		const storeNames = this.batch.getStoreNames();
		await this.batch.write();
		for (const storeName of storeNames) {
			this.invalidateStore(storeName);
		}
	}

	clear(): void {
		this.batch.clear();
	}
}

/**
 * Create an IndexedDB provider with the given options.
 */
export function createIndexedDBProvider(options?: IndexedDBProviderOptions): IndexedDBProvider {
	return new IndexedDBProvider(options);
}
