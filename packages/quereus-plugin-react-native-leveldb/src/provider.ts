/**
 * React Native LevelDB KVStore provider implementation.
 *
 * Manages LevelDB stores for the StoreModule in React Native environments.
 *
 * Storage naming convention:
 *   {prefix}.{schema}.{table}              - Data store (row data)
 *   {prefix}.{schema}.{table}_idx_{name}   - Index store (secondary indexes)
 *   {prefix}.__stats__                     - Unified stats store (row counts for all tables)
 *   {prefix}.__catalog__                   - Catalog store (DDL metadata)
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { STORE_SUFFIX, STATS_STORE_NAME } from '@quereus/store';
import { ReactNativeLevelDBStore, type LevelDBOpenFn, type LevelDBWriteBatchConstructor } from './store.js';

/**
 * Options for creating a React Native LevelDB provider.
 */
export interface ReactNativeLevelDBProviderOptions {
	/**
	 * The LevelDB open function from rn-leveldb.
	 * Obtain this from: import { LevelDB } from 'rn-leveldb';
	 * Then pass: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists)
	 */
	openFn: LevelDBOpenFn;

	/**
	 * The LevelDBWriteBatch constructor from rn-leveldb.
	 * Obtain this from: import { LevelDBWriteBatch } from 'rn-leveldb';
	 */
	WriteBatch: LevelDBWriteBatchConstructor;

	/**
	 * Base name prefix for all LevelDB databases.
	 * Each table gets a separate database with this prefix.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Create databases if they don't exist.
	 * @default true
	 */
	createIfMissing?: boolean;
}

/**
 * React Native LevelDB implementation of KVStoreProvider.
 *
 * Creates separate LevelDB databases for each table. On mobile platforms,
 * this provides efficient, persistent key-value storage with sorted keys.
 */
export class ReactNativeLevelDBProvider implements KVStoreProvider {
	private openFn: LevelDBOpenFn;
	private WriteBatch: LevelDBWriteBatchConstructor;
	private databaseName: string;
	private createIfMissing: boolean;
	private stores = new Map<string, ReactNativeLevelDBStore>();
	private catalogStore: ReactNativeLevelDBStore | null = null;
	private statsStore: ReactNativeLevelDBStore | null = null;

	constructor(options: ReactNativeLevelDBProviderOptions) {
		this.openFn = options.openFn;
		this.WriteBatch = options.WriteBatch;
		this.databaseName = options.databaseName ?? 'quereus';
		this.createIfMissing = options.createIfMissing ?? true;
	}

	/**
	 * Get the database name for a table.
	 * Uses dots as separators for a flat namespace.
	 */
	private getDatabaseName(schemaName: string, tableName: string): string {
		return `${this.databaseName}.${schemaName}.${tableName}`.toLowerCase();
	}

	/**
	 * Get the key for the store cache.
	 */
	private getStoreKey(schemaName: string, tableName: string): string {
		return `${schemaName}.${tableName}`.toLowerCase();
	}

	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		const key = this.getStoreKey(schemaName, tableName);
		return this.getOrCreateStore(key, this.getDatabaseName(schemaName, tableName));
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		const dbName = `${this.getDatabaseName(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		return this.getOrCreateStore(key, dbName);
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables
		if (!this.statsStore) {
			const statsDbName = `${this.databaseName}.${STATS_STORE_NAME}`;
			this.statsStore = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, statsDbName, {
				createIfMissing: this.createIfMissing,
			});
		}
		return this.statsStore;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			const catalogDbName = `${this.databaseName}.__catalog__`;
			this.catalogStore = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, catalogDbName, {
				createIfMissing: this.createIfMissing,
			});
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		const key = this.getStoreKey(schemaName, tableName);
		await this.closeStoreByKey(key);
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		await this.closeStoreByKey(key);
	}

	async closeAll(): Promise<void> {
		for (const store of this.stores.values()) {
			await store.close();
		}
		this.stores.clear();

		if (this.catalogStore) {
			await this.catalogStore.close();
			this.catalogStore = null;
		}

		if (this.statsStore) {
			await this.statsStore.close();
			this.statsStore = null;
		}
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		const key = `${this.getStoreKey(schemaName, tableName)}${STORE_SUFFIX.INDEX}${indexName}`;
		await this.closeStoreByKey(key);
		// Note: LevelDB doesn't have a built-in delete, would need filesystem ops
	}

	async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void> {
		// Close data store
		const dataKey = this.getStoreKey(schemaName, tableName);
		await this.closeStoreByKey(dataKey);

		// Stats are in the unified __stats__ store, so no need to close a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Close exactly the table's index stores (by name), not every store matching
		// the `{table}_idx_` prefix — that prefix also matches a sibling table
		// literally named `{table}_idx_<x>`.
		for (const indexName of indexNames) {
			await this.closeStoreByKey(`${dataKey}${STORE_SUFFIX.INDEX}${indexName}`);
		}
	}

	private getOrCreateStore(key: string, dbName: string): ReactNativeLevelDBStore {
		let store = this.stores.get(key);

		if (!store) {
			store = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, dbName, {
				createIfMissing: this.createIfMissing,
			});
			this.stores.set(key, store);
		}

		return store;
	}

	private async closeStoreByKey(key: string): Promise<void> {
		const store = this.stores.get(key);
		if (store) {
			await store.close();
			this.stores.delete(key);
		}
	}
}

/**
 * Create a React Native LevelDB provider with the given options.
 */
export function createReactNativeLevelDBProvider(options: ReactNativeLevelDBProviderOptions): ReactNativeLevelDBProvider {
	return new ReactNativeLevelDBProvider(options);
}
