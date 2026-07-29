/**
 * Abstract key-value store interface.
 * Implemented by LevelDBStore (Node.js) and IndexedDBStore (browser).
 */

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
	/** Maximum number of entries to return. */
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
 */
export interface KVStore {
	/**
	 * Get a value by key.
	 * @returns The value, or undefined if not found.
	 */
	get(key: Uint8Array): Promise<Uint8Array | undefined>;

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
 * Implementations should manage store lifecycle and caching.
 */
export interface KVStoreProvider {
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
	 * @param schemaName - The schema name
	 * @param tableName - The table name
	 * @param indexName - The index name
	 */
	deleteIndexStore?(schemaName: string, tableName: string, indexName: string): Promise<void>;

	/**
	 * Delete all stores for a table (data, indexes, stats).
	 * Called when dropping a table.
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
