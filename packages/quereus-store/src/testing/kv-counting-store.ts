/**
 * Shared counting test doubles for KVStore-backed specs — test-support, ships in
 * `@quereus/store/testing`.
 *
 * Several specs in this package (and this package's future benchmark suite) each need a
 * `KVStore` that counts what passes through it: entries pulled from `iterate()`, `get()`
 * calls, `getMany()` round trips, and the keys those round trips carried. This file is
 * the one shared implementation — see {@link CountingKVStore}'s doc comment for the one
 * subtlety in how it has to be built.
 */

import type { IterateOptions, KVEntry, KVStore, KVStoreProvider } from '../common/kv-store.js';
import { defaultGetMany } from '../common/kv-store.js';
import { buildDataStoreName, buildIndexStoreName, CATALOG_STORE_NAME, STATS_STORE_NAME } from '../common/key-builder.js';
import { InMemoryKVStore } from '../common/memory-store.js';
import { DelegatingKVStore } from './kv-delegating-store.js';

/**
 * Counts what passes through a wrapped {@link KVStore}: entries pulled from `iterate()`,
 * `get()` calls, `getMany()` round trips, and the keys those round trips carried.
 *
 * `getMany` routes through `defaultGetMany(this, keys)` rather than forwarding straight to
 * `this.inner.getMany(keys)`. That is deliberate, not an oversight. `defaultGetMany` issues
 * one `get(key)` per key against whatever object it is handed; passing `this` (the wrapper)
 * means each of those `get` calls lands on THIS class's own overridden, counted `get()`
 * (which in turn calls `this.inner.get`) — so a single `getMany` of N keys also advances
 * `getCount` by N, matching how the specs built against this class assert. Forwarding to
 * `this.inner.getMany(keys)` would run `defaultGetMany` with `this = inner`, bypassing the
 * wrapper's `get()` entirely and leaving `getCount` unchanged after a batched read — a subtle
 * break because most of the affected assertions are upper bounds (`.at.most(...)`), not exact
 * equalities, so the bug would pass silently in most specs and only fail the one exact-equal
 * assertion that happens to pin it.
 *
 * The trade-off this creates: `getManyCalls` / `getManyKeyCount` measure batching AT THE CALL
 * BOUNDARY into this wrapper (did the caller invoke `getMany` once with N keys, vs. N calls to
 * `get`) — not the wrapped backend's own internal round-trip count. That is the right thing to
 * measure for the specs this class serves today, which are proving the ENGINE batches its
 * reads, not that the wrapped backend has a native multi-get. A future benchmark reaching for
 * this class to measure a REAL backend's own native batching needs to know that distinction.
 */
export class CountingKVStore extends DelegatingKVStore {
	/** Entries pulled from the inner store's `iterate()`. */
	iterateEntryCount = 0;
	/** `get()` calls. */
	getCount = 0;
	/** `getMany()` calls — round trips, as observed at this counting boundary. */
	getManyCalls = 0;
	/** Keys carried by those `getMany()` calls. */
	getManyKeyCount = 0;

	/** Zero all four counters. */
	reset(): void {
		this.iterateEntryCount = 0;
		this.getCount = 0;
		this.getManyCalls = 0;
		this.getManyKeyCount = 0;
	}

	override async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		this.getCount++;
		return this.inner.get(key);
	}

	override async getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		this.getManyCalls++;
		this.getManyKeyCount += keys.length;
		// Must route through the wrapper's own `get` — see the class doc comment above.
		return defaultGetMany(this, keys);
	}

	override async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		for await (const entry of this.inner.iterate(options)) {
			this.iterateEntryCount++;
			yield entry;
		}
	}
}

/** Which stores {@link createCountingProvider} wraps in a {@link CountingKVStore}. */
export type CountingProviderScope = 'data' | 'all';

/**
 * A {@link KVStoreProvider} whose stores are {@link CountingKVStore}s, so a spec can assert
 * on the `iterate`/`get`/`getMany` traffic StoreModule generates without reaching into a
 * real backend.
 *
 * Store names come from the shared builders (`buildDataStoreName` / `buildIndexStoreName`,
 * the reserved `__stats__` / `__catalog__` constants) — the same rule every real provider
 * is held to by `runStoreNameDistinctness`. Hand-composing them here would lose the
 * builders' lowercasing, so a mixed-case table name would land on a store no real backend
 * would have used.
 *
 * @param countedStores - Map the counted stores are recorded into, keyed by BUILT store
 * name: `schema.table` (every table's data store) and, when `scope` is `'all'`, also
 * `schema.table_idx_index` (secondary indexes), `__stats__`, and `__catalog__`. The caller
 * reads counters back out of this map after driving a query.
 * @param scope - `'data'` (default): only each table's data store is counted; index,
 * stats, and catalog stores stay plain, uncounted `InMemoryKVStore`s the caller never
 * sees. `'all'`: every store the provider hands out is counted into `countedStores`.
 */
// NOTE: implements no `deleteIndexStore` / `deleteTableStores` (both optional on the
// interface), so a spec that drops a table or index and recreates it under the same name
// reads the dropped store's entries back. Every spec using this provider today creates its
// tables once; if one starts exercising drop-then-recreate, implement them (erase, don't
// just drop the handle) rather than working around it in the spec.
export function createCountingProvider(
	countedStores: Map<string, CountingKVStore>,
	scope: CountingProviderScope = 'data',
): KVStoreProvider {
	const auxStores = new Map<string, InMemoryKVStore>();
	const aux = (key: string): InMemoryKVStore => {
		let s = auxStores.get(key);
		if (!s) { s = new InMemoryKVStore(); auxStores.set(key, s); }
		return s;
	};
	const counted = (key: string): CountingKVStore => {
		let s = countedStores.get(key);
		if (!s) { s = new CountingKVStore(new InMemoryKVStore()); countedStores.set(key, s); }
		return s;
	};
	const maybeCounted = (key: string): KVStore => (scope === 'all' ? counted(key) : aux(key));
	return {
		async getStore(schemaName: string, tableName: string) {
			return counted(buildDataStoreName(schemaName, tableName));
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return maybeCounted(buildIndexStoreName(schemaName, tableName, indexName));
		},
		// One unified stats store for every table, as the interface specifies — the
		// schema/table arguments are ignored.
		async getStatsStore() {
			return maybeCounted(STATS_STORE_NAME);
		},
		async getCatalogStore() {
			return maybeCounted(CATALOG_STORE_NAME);
		},
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const s of countedStores.values()) await s.close();
			for (const s of auxStores.values()) await s.close();
			countedStores.clear();
			auxStores.clear();
		},
	};
}
