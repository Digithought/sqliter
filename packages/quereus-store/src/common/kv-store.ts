/**
 * Abstract key-value store interface.
 * Implemented by LevelDBStore (Node.js) and IndexedDBStore (browser).
 */

import type { KVCostProfile } from './cost-profile.js';

/**
 * Options for iterating over key-value pairs.
 */
export interface IterateOptions {
	/** Start key (inclusive). If omitted, starts from beginning. */
	gte?: Uint8Array;
	/** Start key (exclusive). */
	gt?: Uint8Array;
	/** End key (inclusive). */
	lte?: Uint8Array;
	/** End key (exclusive). If omitted, iterates to end. */
	lt?: Uint8Array;
	/** Iterate in reverse order. */
	reverse?: boolean;
	/**
	 * Maximum number of entries to return. Omitted means unbounded and `0` means no
	 * entries; a NEGATIVE limit is not a valid input — backends disagree on it
	 * (`abstract-level` reads `-1` as unbounded, the in-memory store as zero).
	 */
	limit?: number;
}

/**
 * A key-value pair from iteration.
 */
export interface KVEntry {
	key: Uint8Array;
	value: Uint8Array;
}

/**
 * Per-write durability hint for the point-write surface (`put`/`delete`).
 */
export interface WriteOptions {
	/**
	 * Flush this write to stable storage before resolving. Default false.
	 *
	 * Backends without a durability knob (in-memory, and any backend that cannot
	 * sync) silently ignore it — best-effort, never an error. IndexedDB is already
	 * durable at transaction `oncomplete`; `sync` additionally requests
	 * `durability: 'strict'` where the engine supports it.
	 *
	 * Used by the materialized-view clean-shutdown marker consume-delete to force
	 * the delete durable before any of the session's data writes can become durable
	 * (otherwise a power loss could resurrect a consumed marker — see
	 * `docs/mv-backing-host.md` § Cross-module atomicity).
	 */
	sync?: boolean;
}

/**
 * Batch operation types.
 */
export type BatchOp =
	| { type: 'put'; key: Uint8Array; value: Uint8Array }
	| { type: 'delete'; key: Uint8Array };

/**
 * Write batch for atomic operations.
 *
 * Queued operations apply in the order they were queued. When two operations
 * target the same key, the later one wins: `put(k, a); delete(k)` leaves `k`
 * absent, and `delete(k); put(k, a)` leaves `k` set to `a`. Ordering is only
 * defined *within* one batch; `write()` remains all-or-nothing.
 */
export interface WriteBatch {
	/** Queue a put operation. On a key already queued in this batch, supersedes it. */
	put(key: Uint8Array, value: Uint8Array): void;
	/** Queue a delete operation. On a key already queued in this batch, supersedes it. */
	delete(key: Uint8Array): void;
	/** Execute all queued operations atomically. */
	write(): Promise<void>;
	/** Discard all queued operations. */
	clear(): void;
}

/**
 * An atomic batch spanning multiple stores of ONE provider. `write()` commits
 * every queued op across every referenced store in a single durable,
 * all-or-nothing physical commit. Obtained from
 * {@link KVStoreProvider.beginAtomicBatch}; a provider exposes that method iff
 * its stores share one atomic commit domain. All stores passed to `put`/`delete`
 * must have been produced by the same provider.
 *
 * Stores are addressed by {@link KVStore} handle (matching how the transaction
 * coordinator already tracks each op's target store), not by name — so it
 * composes with the coordinator's per-store bucketing without a name lookup.
 *
 * Same-key ordering matches {@link WriteBatch}: queued ops apply in queue order,
 * so for one (store, key) pair the later op wins. The coordinator replays its
 * pending ops into one atomic batch without collapsing duplicates, so a
 * transaction that writes then deletes the same row depends on this.
 *
 * SINGLE USE: a batch is spent once `write()` resolves — queue one commit's ops, write
 * once, drop it (what the coordinator does). Reuse after `write()` is deliberately
 * unspecified and backends differ: LevelDB's chained batch is closed by `write()` and
 * throws on any later call, while IndexedDB's merely resets its op list and keeps working.
 *
 * NOTE: there is also no dispose — a batch that is built and then abandoned without
 * `write()` (only reachable today if queueing throws MISUSE, i.e. a programming error)
 * leaks whatever the backend holds until GC. If an abandoned-batch path ever becomes
 * ordinary, give this interface a `close()` and make both behaviors conformance-tested.
 */
export interface AtomicBatch {
	/** Queue a put against the given store. */
	put(store: KVStore, key: Uint8Array, value: Uint8Array): void;
	/** Queue a delete against the given store. */
	delete(store: KVStore, key: Uint8Array): void;
	/** Commit all queued ops across all referenced stores atomically + durably. */
	write(): Promise<void>;
	/** Discard all queued ops. */
	clear(): void;
}

/**
 * Abstract key-value store interface.
 * Provides sorted key-value storage with range iteration support.
 *
 * BUFFER OWNERSHIP. Every buffer crossing this interface is independent of the store's
 * internal state: `get` and `iterate` hand back buffers the caller may scribble on
 * without corrupting stored data, and `put`/`delete` do not retain the caller's buffer,
 * so mutating it afterwards changes nothing stored. A backend that deserializes per read
 * (LevelDB, IndexedDB) gets this for free; one holding live buffers (the in-memory store,
 * a cache wrapper) must copy at the boundary. Tiers 1 and 3 of
 * `runKVStoreConformance` enforce it.
 */
export interface KVStore {
	/**
	 * Get a value by key.
	 * @returns The value, or undefined if not found.
	 */
	get(key: Uint8Array): Promise<Uint8Array | undefined>;

	/**
	 * Point-read several keys at once.
	 *
	 * POSITIONAL. `result[i]` is the value for `keys[i]`, `undefined` when that key is
	 * absent. The result array is always exactly `keys.length` long — a missing key must
	 * never shorten it or shift the ones after it — and a key repeated in `keys` yields
	 * its value at every position it occupies. `getMany([])` resolves to `[]` without
	 * touching backing storage.
	 *
	 * ONE ROUND TRIP WHERE THE BACKEND HAS ONE. This exists because the caller-side
	 * alternative — awaiting `get` per key — serializes N round trips, and on IndexedDB
	 * each `get` opens its own readonly transaction, so resolving the rows behind an
	 * index scan cost one transaction PER ROW. A backend with a native multi-get
	 * (`abstract-level`) or a way to issue every request on one transaction (IndexedDB)
	 * must override; everything else delegates to {@link defaultGetMany}, which is
	 * correct but no faster than the loop it replaces.
	 *
	 * BOUNDED BY THE CALLER. Unlike {@link iterate} there is no internal paging: the
	 * implementation reads exactly the keys it was handed, so the CALLER owns peak
	 * memory and must pass a bounded batch (`StoreTableScan` pages at
	 * `ROW_RESOLUTION_BATCH`).
	 *
	 * Same buffer-ownership rule as {@link get}: the caller may scribble on what it gets
	 * back without corrupting stored data. That extends ACROSS positions — a key repeated
	 * in `keys` must come back as two independent buffers, not one object at two indices,
	 * or scribbling on one silently rewrites the other.
	 */
	getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]>;

	/**
	 * Put a key-value pair.
	 * @param options - Optional per-write durability hint (see {@link WriteOptions}).
	 */
	put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void>;

	/**
	 * Delete a key.
	 * @param options - Optional per-write durability hint (see {@link WriteOptions}).
	 */
	delete(key: Uint8Array, options?: WriteOptions): Promise<void>;

	/**
	 * Check if a key exists.
	 */
	has(key: Uint8Array): Promise<boolean>;

	/**
	 * Iterate over key-value pairs in sorted order.
	 * Keys are compared lexicographically by bytes.
	 *
	 * BOUNDED PEAK. Peak memory must be independent of how many entries the range
	 * holds. An implementation may buffer a FIXED-SIZE batch — IndexedDB pages 256
	 * entries at a time, `abstract-level` hands back one entry per `next()` — but it
	 * must never read the whole range before yielding the first entry. Reason: a full
	 * table scan calls `iterate(buildFullScanBounds())` with NO limit, and the mobile
	 * backends that run this code have the least memory headroom of any of them.
	 *
	 * A backend whose dataset is already wholly resident in memory by construction
	 * (`InMemoryKVStore`) satisfies this trivially — the requirement bounds reads from
	 * BACKING STORAGE, and such a backend has none.
	 *
	 * EARLY TERMINATION IS CHEAP. A consumer that stops after k entries must cost
	 * roughly k entries of work, not the size of the range: `limit: 10` over a million
	 * rows must not read a million rows. Concretely, reads from backing storage must
	 * stay within `k + (one batch)`, whatever the implementation's batch size is.
	 *
	 * TOTAL WORK IS LINEAR. Draining the whole range must read about one entry per
	 * entry. A paged backend resumes from the LAST KEY SEEN — never by re-reading from
	 * the start and discarding a growing prefix. `limit`/`offset` paging is O(n²) reads
	 * yet still looks fine to a peak-memory check, so this is stated separately.
	 *
	 * EARLY TERMINATION RELEASES RESOURCES. When the consumer `break`s or throws, the
	 * returned iterable's `return()`/`throw()` runs; the implementation must close its
	 * cursor / transaction / statement there — a `try/finally` around the yield loop —
	 * not only on natural exhaustion. After an abandoned iteration the store must still
	 * serve `get`/`iterate` normally and `close()` must still resolve.
	 *
	 * NO SNAPSHOT PROMISE. Batching splits one logical read into several physical ones,
	 * so a write committed mid-scan may become visible partway through a scan where a
	 * single-shot read could not have shown it. `iterate` therefore does NOT promise a
	 * point-in-time view and consumers must not assume one. This is honest about what
	 * the stack already does: `StoreTable`'s scan merges the transaction coordinator's
	 * pending ops over the committed range, and the store stack declares
	 * `readCommittedSnapshot: false`. A real snapshot read is separate, future work.
	 *
	 * Backends without a streaming cursor (a SQL `select` hands back a whole result set)
	 * should page with {@link pagedIterate} rather than re-deriving the resume edge.
	 * `runKVStoreConformance`'s bounded-iteration tier enforces all of the above for any
	 * backend whose adapter supplies a read meter.
	 */
	iterate(options?: IterateOptions): AsyncIterable<KVEntry>;

	/**
	 * Create a write batch for atomic operations.
	 */
	batch(): WriteBatch;

	/**
	 * Close the store and release resources.
	 */
	close(): Promise<void>;

	/**
	 * Get approximate number of keys in a range.
	 * Used for query planning cost estimation.
	 */
	approximateCount(options?: IterateOptions): Promise<number>;
}

/**
 * The {@link KVStore.getMany} every backend without a real batch point-read delegates to:
 * one `get` per key, issued together and awaited as a group.
 *
 * Concurrency is all it buys — the reads still cost one round trip each — but it is the
 * CORRECT default everywhere, so adding `getMany` to the interface cannot break a backend
 * and each one opts into a genuine batch when it has one to opt into. Reading through
 * `store.get` (rather than the backend's internals) also keeps a wrapper's own `get` in
 * the path, which is what lets `CachedKVStore` and the counting test doubles keep working.
 *
 * `Promise.all([])` resolves to `[]`, satisfying the empty-input rule without a special case.
 *
 * NOTE: because no `get` is issued for an empty key list, a backend delegating here answers
 * `getMany([])` with `[]` even after `close()`, where LevelDB and IndexedDB check open first
 * and reject. Unspecified rather than wrong — every caller guards the empty case before it
 * reaches a store (`StoreTableBase.readEffectiveRowsByKeys`). Pin one behavior in tier 8 if
 * a caller ever hands an empty batch to a closed store.
 */
export function defaultGetMany(
	store: Pick<KVStore, 'get'>,
	keys: readonly Uint8Array[],
): Promise<(Uint8Array | undefined)[]> {
	return Promise.all(keys.map(key => store.get(key)));
}

/**
 * Factory function to open a KVStore.
 */
export type KVStoreFactory = (options: KVStoreOptions) => Promise<KVStore>;

/**
 * Options for opening a KVStore.
 */
export interface KVStoreOptions {
	/** Storage path (LevelDB) or database name (IndexedDB). */
	path: string;
	/** Create if doesn't exist. Default: true. */
	createIfMissing?: boolean;
	/** Throw error if already exists. Default: false. */
	errorIfExists?: boolean;
}

/**
 * Provider interface for creating/getting KVStore instances.
 *
 * This abstraction allows different storage backends (LevelDB, IndexedDB,
 * React Native AsyncStorage, etc.) to be used with the StoreModule.
 *
 * Storage naming convention:
 *   {schema}.{table}              - Data store (row data)
 *   {schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   {prefix}.__stats__            - Unified stats store (row counts for all tables)
 *   __catalog__                   - Catalog store (DDL metadata)
 *
 * An implementation MUST build those names with `buildDataStoreName` /
 * `buildIndexStoreName` rather than composing its own. It may prefix or escape the result
 * to reach a legal native name, but that escaping must be INJECTIVE (decodable in
 * principle) — two distinct logical names must never produce one native name. A native
 * namespace that genuinely cannot represent a name must REJECT it, never fold it onto
 * another. `runStoreNameDistinctness` (`@quereus/store/testing`) enforces this behaviorally.
 *
 * Implementations should manage store lifecycle and caching. Cache by the BUILT store name,
 * so two spellings of one logical store cannot produce two cached handles.
 */
// NOTE: this interface hands providers the raw `(schemaName, tableName[, indexName])`
// identifiers and trusts each one to call the shared builders. Taking an already-built
// store name instead would make the whole "provider re-derives its own names" defect class
// unrepresentable, rather than merely tested for — but it touches five packages and every
// StoreModule call site, so the shared battery was judged the better trade. If a provider is
// ever again found re-deriving names, or a sixth provider lands, revisit and change these
// signatures to take the built name.
export interface KVStoreProvider {
	/**
	 * How expensive this backend's basic read operations are, relative to reading one row
	 * sequentially during a full scan. Omitted (and every omitted field within it) means
	 * the parity defaults, which reproduce the module's pre-profile cost constants exactly
	 * — so a provider that declares nothing plans byte-identically to before.
	 *
	 * Declared on the PROVIDER rather than on a store because a cost profile is a property
	 * of the BACKEND, one provider is the per-backend singleton, and `StoreModuleBase`
	 * already holds the provider without having to open anything.
	 *
	 * Declare only MEASURED numbers. An unmeasured guess here is worse than the parity
	 * default: it changes advertised costs for every query on the backend. See
	 * {@link KVCostProfile}.
	 */
	readonly costProfile?: KVCostProfile;

	/**
	 * Get or create a KVStore for a table's row data.
	 * Store name: {schema}.{table}
	 * @param schemaName - The schema name (e.g., 'main')
	 * @param tableName - The table name
	 * @param options - Additional options passed from CREATE TABLE
	 * @returns The KVStore instance
	 */
	getStore(schemaName: string, tableName: string, options?: Record<string, unknown>): Promise<KVStore>;

	/**
	 * Get or create a KVStore for a secondary index.
	 * Store name: {schema}.{table}_idx_{indexName}
	 * @param schemaName - The schema name
	 * @param tableName - The table name
	 * @param indexName - The index name
	 * @returns The KVStore instance for the index
	 */
	getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore>;

	/**
	 * Get or create the unified KVStore for table statistics.
	 * All table statistics are stored in a single __stats__ store, keyed by {schema}.{table}.
	 * Note: schemaName and tableName parameters are ignored (kept for API compatibility).
	 * @param schemaName - Unused (kept for API compatibility)
	 * @param tableName - Unused (kept for API compatibility)
	 * @returns The unified __stats__ KVStore instance
	 */
	getStatsStore(schemaName: string, tableName: string): Promise<KVStore>;

	/**
	 * Get or create a KVStore for catalog/DDL metadata.
	 * Store name: __catalog__
	 * @returns The KVStore instance for catalog data
	 */
	getCatalogStore(): Promise<KVStore>;

	/**
	 * Close a specific table's data store.
	 * @param schemaName - The schema name
	 * @param tableName - The table name
	 */
	closeStore(schemaName: string, tableName: string): Promise<void>;

	/**
	 * Close a specific index store.
	 * @param schemaName - The schema name
	 * @param tableName - The table name
	 * @param indexName - The index name
	 */
	closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void>;

	/**
	 * Close all stores managed by this provider.
	 */
	closeAll(): Promise<void>;

	/**
	 * Delete an index store entirely (when dropping an index).
	 *
	 * "Delete" means ERASE, not "close the handle": see {@link deleteTableStores} for
	 * exactly what an implementation has to accomplish. Closing a cached handle is not
	 * enough — stores are re-opened lazily by name, so the next index created under this
	 * name would read the dropped index's entries.
	 *
	 * @param schemaName - The schema name
	 * @param tableName - The table name
	 * @param indexName - The index name
	 */
	deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;

	/**
	 * Delete a table's data store and the named index stores. Called when dropping a table.
	 *
	 * NOT the table's row-count statistics: those live as one ENTRY in the unified
	 * `__stats__` store (see {@link getStatsStore}), which a provider must leave alone —
	 * removing that entry is the caller's business, not a store deletion.
	 *
	 * "Delete" means ERASE the physical storage, not merely drop a cached handle. Three
	 * requirements, all of them behavioral:
	 *
	 *   - Each named store, RE-OPENED afterwards under the same name via
	 *     `getStore`/`getIndexStore`, must read back EMPTY — no entry from a point `get`,
	 *     none from `iterate`. Handles are re-opened lazily by name, so a provider that
	 *     only closes its handle leaves the bytes in place and the next table created
	 *     under that name comes back holding the dropped table's rows.
	 *   - Deleting a store that was never created is a NO-OP, not an error. The engine
	 *     calls these speculatively on its reclaim paths (see
	 *     `StoreModuleBase.reclaimDetachedTable`), including with index names whose stores
	 *     never materialized.
	 *   - Every OTHER store must be untouched — sibling tables, the table's own index
	 *     stores that were not named, and the reserved `__stats__` / `__catalog__` stores.
	 *
	 * Reclaiming bytes on disk is a separate, per-provider concern: a provider may leave an
	 * emptied database directory or an unshrunk file behind and still be correct here.
	 *
	 * Pinned behaviorally by the shared `runStoreReclaimConformance` battery
	 * (`@quereus/store/testing`), which every plugin's `test/conformance.spec.ts`
	 * registers — the way `runStoreNameDistinctness` pins the naming property.
	 *
	 * `indexNames` is the authoritative list of the table's secondary-index names
	 * (from `tableSchema.indexes`). Implementations MUST build exact index store
	 * names from it via `buildIndexStoreName` rather than prefix-scanning the live
	 * store list — `_idx_` is a legal substring of an ordinary identifier, so a
	 * prefix scan over `{table}_idx_` also matches a sibling table literally named
	 * `{table}_idx_<x>` and would destroy its data.
	 *
	 * @param schemaName - The schema name
	 * @param tableName - The table name
	 * @param indexNames - The table's secondary-index names (exact, from the schema)
	 */
	deleteTableStores?(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void>;

	/**
	 * Rename all stores for a table from `oldName` to `newName`. Implementations
	 * must close any open handles, move the underlying data + index storage,
	 * and drop all cached references to the old name so that subsequent
	 * `getStore`/`getIndexStore` calls open the renamed storage.
	 *
	 * `indexNames` is the authoritative list of the table's secondary-index names
	 * (from `tableSchema.indexes`). Implementations MUST relocate exactly those
	 * index stores (built via `buildIndexStoreName`) rather than prefix-scanning —
	 * a prefix scan over `{oldName}_idx_` also matches a sibling table literally
	 * named `{oldName}_idx_<x>` and would silently move its data under `newName`.
	 *
	 * Called by StoreModule.renameTable during ALTER TABLE ... RENAME TO.
	 *
	 * Optional: when a provider omits this hook, StoreModule falls back to a generic
	 * copy — read every entry via the required `getStore`/`getIndexStore` on the old
	 * name and `put` it under the new name, then reclaim the old stores via
	 * `deleteTableStores` if implemented. That fallback is correct on every provider
	 * but does not stream at the backend's native speed and is O(table size) for a
	 * single rename. Implement this hook for an efficient native move (e.g. a
	 * directory/file rename) instead.
	 * @param schemaName - The schema name
	 * @param oldName - The current table name
	 * @param newName - The desired table name
	 * @param indexNames - The table's secondary-index names (exact, from the schema)
	 */
	renameTableStores?(schemaName: string, oldName: string, newName: string, indexNames: readonly string[]): Promise<void>;

	/**
	 * Open an atomic batch across this provider's stores, or return undefined
	 * when the provider has no shared atomic commit domain (callers then fall
	 * back to per-store {@link KVStore.batch}).
	 *
	 * A provider implements this iff all of its stores commit into one durable,
	 * all-or-nothing physical domain (e.g. IndexedDB's single database with
	 * multiple object stores). The transaction coordinator uses it to commit a
	 * table's data + secondary-index stores in one batch, closing the crash
	 * window where a per-store loop could leave them divergent.
	 */
	beginAtomicBatch?(): AtomicBatch | undefined;
}
