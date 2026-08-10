/**
 * React Native LevelDB KVStore provider implementation.
 *
 * Manages LevelDB stores for the StoreModule in React Native environments. Each logical
 * store is its own on-device LevelDB database, named after the store.
 *
 * Storage naming convention. Every logical store name comes from the shared builders
 * (`buildDataStoreName` / `buildIndexStoreName`), then {@link encodeDatabaseName} escapes
 * it into a filename-safe form:
 *
 *   {prefix}.{encoded {schema}.{table}}             - Data store (row data)
 *   {prefix}.{encoded {schema}.{table}_idx_{name}}  - Index store (secondary indexes)
 *   {prefix}.__stats__                              - Unified stats store (row counts)
 *   {prefix}.__catalog__                            - Catalog store (DDL metadata)
 *
 * e.g. table `users` in schema `main` → `quereus.main.users`; a table named `a/b` →
 * `quereus.main.a%2Fb`.
 *
 * The two reserved stores are NOT run through the encoder, and that is what keeps them in
 * a namespace no table can reach — see {@link encodeDatabaseName}.
 *
 * HARD CUTOVER: an earlier version derived its own names and lowercased only part of them
 * (an index store was `{prefix}.{schema}.{table}_idx_{indexName}` with the index name's
 * case preserved, so one logical index could occupy two on-device databases). Those
 * databases are NOT read here and must be re-created; there is no on-disk migration.
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { buildDataStoreName, buildIndexStoreName, CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';
import { ReactNativeLevelDBStore, type LevelDBOpenFn, type LevelDBWriteBatchConstructor } from './store.js';

const textEncoder = new TextEncoder();

/**
 * True when `byte` may appear literally in a database name.
 *
 * Printable ASCII only, minus the escape introducer `%` and every byte that is hostile in
 * a filesystem path — rn-leveldb resolves the name it is given as a path under the app's
 * documents directory, so the name has to be safe as a SINGLE path component.
 *
 * Excluded: `/` and `\` (path separators — excluding them is what stops a quoted table
 * name from reaching a directory boundary, so a name like `..` can only ever be a strange
 * filename, never a traversal), `:` (a separator on Apple platforms and in Windows paths),
 * and `* ? " < > |` (illegal on Windows). The last group is not needed on iOS/Android but
 * costs nothing: ordinary identifiers contain none of these, and excluding them keeps the
 * name usable if a host ever puts it on a Windows-like filesystem. Control bytes, NUL,
 * space and every non-ASCII byte fall outside the printable range and are escaped too.
 */
function isSafeNameByte(byte: number): boolean {
	if (byte < 0x21 || byte > 0x7e) return false;
	switch (byte) {
		case 0x25: // '%' — reserved as the escape introducer, so the mapping stays injective
		case 0x2f: // '/'
		case 0x5c: // '\'
		case 0x3a: // ':'
		case 0x2a: // '*'
		case 0x3f: // '?'
		case 0x22: // '"'
		case 0x3c: // '<'
		case 0x3e: // '>'
		case 0x7c: // '|'
			return false;
		default:
			return true;
	}
}

/**
 * Escape a logical store name into a filename-safe on-device database name.
 *
 * Percent-encoding of the UTF-8 bytes, same shape as `@quereus/plugin-leveldb`'s
 * `encodeSublevelName` (no SQL is involved here, so `%` is free to be the introducer) but
 * with a stricter safe set — see {@link isSafeNameByte}. Ordinary lowercase identifiers,
 * `.` and `_` pass through unchanged; the name is never decoded back.
 *
 * The mapping is injective over the names the shared builders can produce, which is what
 * `StoreModule.assertStoreNameFree` relies on: it compares LOGICAL names and only stands in
 * for a physical collision check while each provider's encoding is one-to-one. (It is NOT
 * injective over arbitrary JS strings — `TextEncoder` folds every unpaired surrogate to
 * U+FFFD — but those builders reject such an identifier, so no such name reaches here.)
 *
 * Disjoint from the reserved store names: `{databaseName}.__stats__` and
 * `{databaseName}.__catalog__` are used UNESCAPED, and every canonical store name contains
 * at least one `.` (it is built as `{schema}.{table}`) which survives escaping, while
 * neither reserved name contains one. Do not run the reserved names through this function.
 */
// NOTE: escaping is a 3x expansion per unsafe byte, and the result is one path component,
// which most filesystems cap at 255 bytes. A 90-character Cyrillic table name is 193 bytes
// as raw UTF-8 (which the previous unescaped naming handed to rn-leveldb) but 553 bytes
// escaped, so names of roughly 80+ non-ASCII characters that used to open will now fail on
// device with a filesystem error. Not reproducible off-device (the tests drive MockLevelDB,
// which has no path). If long non-ASCII table names ever need to work here, hash the tail of
// an over-long encoded name rather than widening the safe set — the escape must stay
// injective. The other three providers have no equivalent limit.
function encodeDatabaseName(name: string): string {
	let out = '';
	for (const byte of textEncoder.encode(name)) {
		out += isSafeNameByte(byte)
			? String.fromCharCode(byte)
			: '%' + byte.toString(16).toUpperCase().padStart(2, '0');
	}
	return out;
}

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

	async getStore(schemaName: string, tableName: string, _options?: Record<string, unknown>): Promise<KVStore> {
		return this.getOrCreateStore(buildDataStoreName(schemaName, tableName));
	}

	async getIndexStore(schemaName: string, tableName: string, indexName: string): Promise<KVStore> {
		return this.getOrCreateStore(buildIndexStoreName(schemaName, tableName, indexName));
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
			const catalogDbName = `${this.databaseName}.${CATALOG_STORE_NAME}`;
			this.catalogStore = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, catalogDbName, {
				createIfMissing: this.createIfMissing,
			});
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
	}

	async deleteIndexStore(schemaName: string, tableName: string, indexName: string): Promise<void> {
		await this.closeStoreByName(buildIndexStoreName(schemaName, tableName, indexName));
		// Note: LevelDB doesn't have a built-in delete, would need filesystem ops
	}

	async deleteTableStores(schemaName: string, tableName: string, indexNames: readonly string[]): Promise<void> {
		// Close data store
		await this.closeStoreByName(buildDataStoreName(schemaName, tableName));

		// Stats are in the unified __stats__ store, so no need to close a separate store
		// The individual stats entry will be removed by the calling code if needed

		// Close exactly the table's index stores (by name), not every store matching
		// the `{table}_idx_` prefix — that prefix also matches a sibling table
		// literally named `{table}_idx_<x>`.
		for (const indexName of indexNames) {
			await this.closeStoreByName(buildIndexStoreName(schemaName, tableName, indexName));
		}
	}

	/**
	 * Get or open the store for a logical store name, caching by that CANONICAL name —
	 * the same string the shared builders produce and `StoreModule` reasons about. Keying
	 * the cache by anything else (a separately-derived spelling) risks two cache entries
	 * for one on-device database, or one entry shared by two.
	 */
	private getOrCreateStore(storeName: string): ReactNativeLevelDBStore {
		let store = this.stores.get(storeName);

		if (!store) {
			const dbName = `${this.databaseName}.${encodeDatabaseName(storeName)}`;
			store = ReactNativeLevelDBStore.open(this.openFn, this.WriteBatch, dbName, {
				createIfMissing: this.createIfMissing,
			});
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
 * Create a React Native LevelDB provider with the given options.
 */
export function createReactNativeLevelDBProvider(options: ReactNativeLevelDBProviderOptions): ReactNativeLevelDBProvider {
	return new ReactNativeLevelDBProvider(options);
}
