/**
 * Shared in-memory {@link KVStoreProvider} test double — test-support, ships in
 * `@quereus/store/testing`.
 *
 * Nearly every spec in this package's `test/` directory (and this package's benchmark
 * suite) opens with its own private copy of an all-`InMemoryKVStore` provider. This is the
 * one shared implementation, built to the same conventions as its sibling
 * {@link createCountingProvider}:
 *
 *   - Store names come from {@link buildDataStoreName} / {@link buildIndexStoreName} and the
 *     reserved {@link CATALOG_STORE_NAME} / {@link STATS_STORE_NAME} constants — never
 *     hand-composed template strings, which drop the builders' lowercasing.
 *   - {@link KVStoreProvider.getStatsStore} returns ONE unified `__stats__` store for every
 *     table, as the interface specifies (its schema/table arguments are documented as
 *     ignored) — not the per-table `schema.table.__stats__` spelling most local copies use.
 *   - `options.costProfile` is spread in only when present, so a provider built with no
 *     options (or `{}`) has no `costProfile` property at all, matching what a genuine
 *     pre-profile third-party provider looks like.
 *
 * Unlike {@link createCountingProvider} — which deliberately omits `deleteIndexStore` /
 * `deleteTableStores` — this provider implements both, and they ERASE rather than merely
 * drop the map entry: see {@link erase} for why a live handle still needs its bytes cleared.
 * `renameTableStores` is deliberately NOT implemented; `StoreModule` falls back to a generic
 * copy for a provider without it (`test/rename-store-copy-fallback.spec.ts`), and nothing
 * that needs this provider today renames.
 */

import type { KVStoreProvider } from '../common/kv-store.js';
import type { KVCostProfile } from '../common/cost-profile.js';
import { buildDataStoreName, buildIndexStoreName, CATALOG_STORE_NAME, STATS_STORE_NAME } from '../common/key-builder.js';
import { InMemoryKVStore } from '../common/memory-store.js';

/** Options accepted by {@link createInMemoryProvider}. */
export interface InMemoryProviderOptions {
	/**
	 * Forwarded verbatim as the provider's declared `costProfile`. Omitted (the default)
	 * means the returned provider has no `costProfile` property at all — see the class doc
	 * comment above for why that shape matters to `resolveCostProfile`'s parity path.
	 */
	readonly costProfile?: KVCostProfile;
}

/**
 * Build an all-`InMemoryKVStore` {@link KVStoreProvider}. Every distinct built store name
 * gets its own `InMemoryKVStore`, created lazily on first access.
 */
export function createInMemoryProvider(options?: InMemoryProviderOptions): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();

	const getOrCreate = (key: string): InMemoryKVStore => {
		let store = stores.get(key);
		if (!store) {
			store = new InMemoryKVStore();
			stores.set(key, store);
		}
		return store;
	};

	/**
	 * Erase the store named `key`: a caller re-opening this name afterwards must find it
	 * empty, and a caller still holding a LIVE handle to it must see the erase too (the
	 * reclaim battery's "handle the caller already closed" case is the other order — see
	 * below). Two cases, both ending in the map entry being dropped so the name re-opens
	 * fresh:
	 *
	 *   - Live store: `clear()` it first, so an existing handle observes the erase, THEN
	 *     drop the map entry.
	 *   - Already-closed store (the caller closed its handle before asking for the delete —
	 *     exactly what `StoreModuleIndex.tearDownIndexStore` does): `close()` already
	 *     cleared its entries and marked it closed, so `clear()` would just throw
	 *     (`checkOpen()`) for no benefit. Skip straight to dropping the map entry.
	 *
	 * A store that was never created (key absent from the map) is a no-op, matching the
	 * interface's speculative-delete contract.
	 */
	const erase = async (key: string): Promise<void> => {
		const store = stores.get(key);
		if (!store) return;
		if (!store.isClosed) {
			store.clear();
		}
		stores.delete(key);
	};

	return {
		...(options?.costProfile ? { costProfile: options.costProfile } : {}),

		async getStore(schemaName, tableName) {
			return getOrCreate(buildDataStoreName(schemaName, tableName));
		},
		async getIndexStore(schemaName, tableName, indexName) {
			return getOrCreate(buildIndexStoreName(schemaName, tableName, indexName));
		},
		async getStatsStore() {
			return getOrCreate(STATS_STORE_NAME);
		},
		async getCatalogStore() {
			return getOrCreate(CATALOG_STORE_NAME);
		},
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},

		async deleteIndexStore(schemaName, tableName, indexName) {
			await erase(buildIndexStoreName(schemaName, tableName, indexName));
		},
		async deleteTableStores(schemaName, tableName, indexNames) {
			await erase(buildDataStoreName(schemaName, tableName));
			for (const indexName of indexNames) {
				await erase(buildIndexStoreName(schemaName, tableName, indexName));
			}
			// The unified __stats__ store is deliberately untouched — a table's row count is
			// one ENTRY there, and removing it is the caller's business, not a store deletion.
		},
	};
}
