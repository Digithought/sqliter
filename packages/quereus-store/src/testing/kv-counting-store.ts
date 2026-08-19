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

import type { IterateOptions, KVEntry, KVStore, KVStoreProvider, WriteBatch, WriteOptions } from '../common/kv-store.js';
import { defaultGetMany } from '../common/kv-store.js';
import { InMemoryKVStore } from '../common/memory-store.js';

/**
 * Forwards every {@link KVStore} method to an inner store. Subclasses override only
 * the one method whose behavior they are modeling.
 */
export class DelegatingKVStore implements KVStore {
	constructor(protected readonly inner: KVStore) {}

	get(key: Uint8Array): Promise<Uint8Array | undefined> {
		return this.inner.get(key);
	}

	getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		return this.inner.getMany(keys);
	}

	put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void> {
		return this.inner.put(key, value, options);
	}

	delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
		return this.inner.delete(key, options);
	}

	has(key: Uint8Array): Promise<boolean> {
		return this.inner.has(key);
	}

	iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		return this.inner.iterate(options);
	}

	batch(): WriteBatch {
		return this.inner.batch();
	}

	close(): Promise<void> {
		return this.inner.close();
	}

	approximateCount(options?: IterateOptions): Promise<number> {
		return this.inner.approximateCount(options);
	}
}

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
 * @param countedStores - Map the counted stores are recorded into, keyed `schema.table`
 * (every table's data store) and, when `scope` is `'all'`, also `schema.table_idx_index`
 * (secondary indexes), `schema.table.__stats__`, and `__catalog__`. The caller reads
 * counters back out of this map after driving a query.
 * @param scope - `'data'` (default): only each table's data store is counted; index,
 * stats, and catalog stores stay plain, uncounted `InMemoryKVStore`s the caller never
 * sees. `'all'`: every store the provider hands out is counted into `countedStores`.
 */
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
			return counted(`${schemaName}.${tableName}`);
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return maybeCounted(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return maybeCounted(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return maybeCounted('__catalog__');
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
