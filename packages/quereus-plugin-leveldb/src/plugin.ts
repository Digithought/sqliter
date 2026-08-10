/**
 * LevelDB plugin for Quereus.
 *
 * Registers a StoreModule backed by LevelDB for Node.js environments.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { LevelDBProvider } from './provider.js';

/**
 * Plugin configuration options.
 */
export interface LevelDBPluginConfig {
	/**
	 * Base path for the single shared LevelDB database. Every table, index, the
	 * catalog, and stats live as sublevels inside this one physical store.
	 * @default './data'
	 */
	basePath?: string;

	/**
	 * Create the database if it doesn't exist.
	 * @default true
	 */
	createIfMissing?: boolean;

	/**
	 * fsync each transaction commit before resolving, so a committed transaction
	 * survives power loss. The cost is one fsync per commit; set false to trade
	 * durability for lower commit latency.
	 * @default true
	 */
	syncCommits?: boolean;

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
}

/**
 * Register the LevelDB plugin with a database.
 */
export default function register(
	_db: Database,
	config: Record<string, SqlValue> = {}
) {
	const basePath = (config.basePath as string) ?? './data';
	const createIfMissing = config.createIfMissing !== false;
	const moduleName = (config.moduleName as string) ?? 'store';
	const isolation = (config.isolation as boolean) ?? true;
	const syncCommits = config.syncCommits !== false;

	const provider = new LevelDBProvider({
		basePath,
		createIfMissing,
		syncCommits,
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


