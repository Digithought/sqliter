/**
 * NativeScript SQLite plugin for Quereus.
 *
 * Registers a StoreModule backed by SQLite for NativeScript mobile environments.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { SQLiteProvider } from './provider.js';
import type { SQLiteDatabase } from './store.js';

/**
 * Plugin configuration options.
 */
export interface SQLitePluginConfig {
	/**
	 * The SQLite database instance.
	 * Obtain this from @nativescript-community/sqlite's openOrCreate().
	 */
	db: SQLiteDatabase;

	/**
	 * Prefix for table names to avoid collisions.
	 * @default 'quereus_'
	 */
	tablePrefix?: string;

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
 * Register the NativeScript SQLite plugin with a database.
 *
 * @example
 * ```typescript
 * import { openOrCreate } from '@nativescript-community/sqlite';
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import sqlitePlugin from '@quereus/plugin-nativescript-sqlite/plugin';
 *
 * const sqliteDb = openOrCreate('quereus.db');
 * const db = new Database();
 * await registerPlugin(db, sqlitePlugin, { db: sqliteDb });
 *
 * await db.exec(`
 *   create table users (id integer primary key, name text)
 *   using store
 * `);
 * ```
 */
export default function register(
	_db: Database,
	config: Record<string, SqlValue> = {}
) {
	// The SQLite database must be provided
	const sqliteDb = config.db as unknown as SQLiteDatabase;
	if (!sqliteDb) {
		throw new Error(
			'@quereus/plugin-nativescript-sqlite requires a "db" option with an open SQLite database. ' +
			'Use openOrCreate() from @nativescript-community/sqlite to create one.'
		);
	}

	const tablePrefix = (config.tablePrefix as string) ?? 'quereus_';
	const moduleName = (config.moduleName as string) ?? 'store';
	const isolation = (config.isolation as boolean) ?? true;

	const provider = new SQLiteProvider({
		db: sqliteDb,
		tablePrefix,
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


