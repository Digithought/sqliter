/**
 * SQLite KVStore provider implementation for NativeScript.
 *
 * Manages SQLite-backed KV stores for the StoreModule.
 * Uses a single SQLite database with multiple tables (one per logical store).
 *
 * Storage naming convention. Every logical store name comes from the shared builders
 * (`buildDataStoreName` / `buildIndexStoreName`), then {@link encodeSqliteName} escapes it
 * into a legal bare SQLite identifier:
 *
 *   {prefix}{encoded {schema}.{table}}             - Data store (row data)
 *   {prefix}{encoded {schema}.{table}_idx_{name}}  - Index store (secondary indexes)
 *   {prefix}__stats__                              - Unified stats store (row counts)
 *   {prefix}__catalog__                            - Catalog store (DDL metadata)
 *
 * e.g. table `users` in schema `main` → `quereus_main_2Eusers`.
 *
 * The two reserved stores are NOT run through the encoder, and that is exactly what keeps
 * them in a namespace no table can reach — see {@link encodeSqliteName}.
 *
 * HARD CUTOVER: an earlier version derived its own table names (`{prefix}{schema}_{table}`,
 * with every character outside `[a-zA-Z0-9_]` folded to `_`). Those tables are NOT read
 * here and databases written by it must be re-created; there is no on-disk migration. The
 * old scheme was many-to-one, so two differently-named tables could share one SQLite table
 * and interleave their rows.
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { buildDataStoreName, buildIndexStoreName, CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';
import { SQLiteStore, type SQLiteDatabase } from './store.js';

const textEncoder = new TextEncoder();

/**
 * Escape a logical store name into a legal bare SQLite identifier.
 *
 * Bytes `0`-`9` and `a`-`z` pass through; every other byte becomes `_XX` (uppercase hex of
 * the UTF-8 byte). `_` is therefore ALWAYS an escape introducer and never a literal, which
 * is what makes the mapping injective: the output can be parsed back unambiguously, so two
 * different store names can never produce the same identifier. That matters because
 * `StoreModule.assertStoreNameFree` compares LOGICAL names and only stands in for a
 * physical collision check while this mapping is one-to-one.
 *
 * Percent-escaping (what `@quereus/plugin-leveldb` uses) is deliberately not reused here:
 * `%` is illegal in a bare SQLite identifier, and `SQLiteStore` interpolates the table name
 * straight into its SQL unquoted — so escaping into `[a-z0-9_]` keeps every produced name a
 * legal bare identifier and adds no quoting/injection surface.
 *
 * Two properties the callers rely on:
 *
 *   - Injective under SQLite's ASCII-case-insensitive identifier comparison too. The input
 *     is already lowercased by the shared builders, so no ASCII uppercase survives to be
 *     escaped and the escape hex is the only uppercase in the output; case-folding it back
 *     to `_2e` still decodes to the same byte.
 *   - Disjoint from the reserved store names. `{prefix}__stats__` and `{prefix}__catalog__`
 *     are used UNESCAPED; an encoded name can never contain a bare `_` followed by a
 *     non-hex character, so no table name can produce `__stats__` (its second `_` is not a
 *     hex digit) and no table can spoof a reserved store. Do not run the reserved names
 *     through this function.
 */
function encodeSqliteName(name: string): string {
	let out = '';
	for (const byte of textEncoder.encode(name)) {
		const isDigit = byte >= 0x30 && byte <= 0x39;
		const isLower = byte >= 0x61 && byte <= 0x7a;
		out += (isDigit || isLower)
			? String.fromCharCode(byte)
			: '_' + byte.toString(16).toUpperCase().padStart(2, '0');
	}
	return out;
}

/**
 * Options for creating a SQLite provider.
 */
export interface SQLiteProviderOptions {
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
}

/**
 * SQLite implementation of KVStoreProvider for NativeScript.
 *
 * Creates separate tables for each logical store within a single SQLite database.
 * This is more efficient than multiple database files on mobile.
 */
export class SQLiteProvider implements KVStoreProvider {
	private db: SQLiteDatabase;
	private tablePrefix: string;
	private stores = new Map<string, SQLiteStore>();
	private catalogStore: SQLiteStore | null = null;
	private statsStore: SQLiteStore | null = null;

	constructor(options: SQLiteProviderOptions) {
		this.db = options.db;
		this.tablePrefix = options.tablePrefix ?? 'quereus_';
	}

	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		return this.getOrCreateStore(buildDataStoreName(schemaName, tableName));
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		return this.getOrCreateStore(buildIndexStoreName(schemaName, tableName, indexName));
	}

	async getStatsStore(_schemaName: string, _tableName: string): Promise<KVStore> {
		// Use the unified __stats__ store for all tables
		if (!this.statsStore) {
			this.statsStore = SQLiteStore.create(this.db, `${this.tablePrefix}${STATS_STORE_NAME}`);
		}
		return this.statsStore;
	}

	async getCatalogStore(): Promise<KVStore> {
		if (!this.catalogStore) {
			this.catalogStore = SQLiteStore.create(this.db, `${this.tablePrefix}${CATALOG_STORE_NAME}`);
		}
		return this.catalogStore;
	}

	async closeStore(schemaName: string, tableName: string): Promise<void> {
		await this.closeStoreByName(buildDataStoreName(schemaName, tableName));
	}

	async closeIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		await this.closeStoreByName(buildIndexStoreName(schemaName, tableName, indexName));
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

		// Close the underlying database
		this.db.close();
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		await this.dropStoreByName(buildIndexStoreName(schemaName, tableName, indexName));
	}

	async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void> {
		// Drop the data store's backing table.
		await this.dropStoreByName(buildDataStoreName(schemaName, tableName));

		// Stats live in the unified __stats__ store, so there is no per-table stats store to
		// drop here. (The table's ENTRY in that store is not reclaimed by anyone today —
		// tracked as `bug-drop-table-leaves-stale-stats-entry`; it is a stale row-count
		// estimate, not stale rows.)

		// Drop exactly the table's index stores (by name), not every store matching
		// the `{table}_idx_` prefix — that prefix also matches a sibling table
		// literally named `{table}_idx_<x>`.
		for (const indexName of indexNames) {
			await this.dropStoreByName(buildIndexStoreName(schemaName, tableName, indexName));
		}
	}

	/**
	 * The SQLite table backing a logical store.
	 *
	 * The ONE derivation, shared by every caller: a second hand-derived spelling of this is
	 * precisely the defect class the naming work had to remove from this file once (a store
	 * opened under one name and reclaimed under another leaves the rows in place).
	 */
	private physicalTableName(storeName: string): string {
		return `${this.tablePrefix}${encodeSqliteName(storeName)}`;
	}

	/**
	 * Get or open the store for a logical store name, caching by that CANONICAL name —
	 * the same string the shared builders produce and `StoreModule` reasons about. Keying
	 * the cache by anything else (a separately-derived spelling) risks two cache entries
	 * for one physical table, or one entry shared by two.
	 */
	private getOrCreateStore(storeName: string): SQLiteStore {
		let store = this.stores.get(storeName);

		if (!store) {
			store = SQLiteStore.create(this.db, this.physicalTableName(storeName));
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

	/**
	 * Erase a store by dropping its backing table, after closing and evicting any cached
	 * handle — so a store re-opened later under the same name is EMPTY, which is the reclaim
	 * contract on {@link KVStoreProvider.deleteTableStores}. `if exists` makes deleting a
	 * store that was never created a no-op that creates nothing, as that contract also asks.
	 *
	 * The table name is interpolated rather than bound because SQLite cannot parameterize an
	 * identifier; {@link encodeSqliteName} restricts every produced name to `[0-9a-z_]` plus
	 * the uppercase hex of its escapes, so there is no quoting or injection surface — the
	 * same reason `SQLiteStore` interpolates it.
	 */
	private async dropStoreByName(storeName: string): Promise<void> {
		await this.closeStoreByName(storeName);
		// NOTE: dropping a table returns its pages to this SQLite file's freelist for reuse,
		// but does not shrink the file on disk — that needs a `vacuum`, which is not run here.
		// If a mobile app's database file growing and never shrinking becomes a complaint,
		// that is the thread to pull.
		this.db.execute(`drop table if exists ${this.physicalTableName(storeName)}`);
	}
}

/**
 * Create a SQLite provider with the given options.
 */
export function createSQLiteProvider(options: SQLiteProviderOptions): SQLiteProvider {
	return new SQLiteProvider(options);
}
