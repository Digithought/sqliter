/**
 * IndexedDB plugin for Quereus.
 *
 * Registers a StoreModule backed by IndexedDB for browser environments.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule, type CacheOptions } from '@quereus/store';
import { IndexedDBProvider } from './provider.js';

/**
 * Plugin configuration options.
 */
export interface IndexedDBPluginConfig {
	/**
	 * Name for the unified IndexedDB database.
	 * All tables share this single database with separate object stores.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Module name to register. Tables are created with `USING <moduleName>`.
	 * @default 'store'
	 */
	moduleName?: string;

	/**
	 * Enable transaction isolation (read-committed + read-your-own-writes, no
	 * write-write conflict detection — NOT snapshot isolation).
	 * When true, wraps the store module with an isolation layer.
	 * @default true
	 */
	isolation?: boolean;

	/**
	 * Read cache configuration for data and index stores.
	 * Wraps each store with an in-memory LRU cache to reduce IDB round-trips.
	 */
	cache?: CacheOptions;
}

/**
 * Register the IndexedDB plugin with a database.
 */
export default function register(
	_db: Database,
	config: Record<string, SqlValue> = {}
) {
	const databaseName = (config.databaseName as string) ?? 'quereus';
	const moduleName = (config.moduleName as string) ?? 'store';
	const isolation = (config.isolation as boolean) ?? true;

	const cache = config.cache as IndexedDBPluginConfig['cache'];

	const provider = new IndexedDBProvider({
		databaseName,
		cache,
	});

	const storeModule = isolation
		? createIsolatedStoreModule({ provider })
		: new StoreModule(provider);

	return {
		vtables: [
			{
				name: moduleName,
				module: storeModule,
			},
		],
	};
}


