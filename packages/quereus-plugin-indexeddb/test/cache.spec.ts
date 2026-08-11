/**
 * Tests for CachedKVStore read-through cache.
 *
 * Uses InMemoryKVStore as the underlying store to test cache behavior
 * in isolation without IndexedDB dependencies.
 */

import { expect } from 'chai';
import { InMemoryKVStore, CachedKVStore, type KVStore } from '@quereus/store';

/** Helper to create a spy-wrapped InMemoryKVStore that counts underlying calls. */
function createSpyStore(): { store: KVStore; calls: Record<string, number> } {
	const inner = new InMemoryKVStore();
	const calls: Record<string, number> = { get: 0, getMany: 0, has: 0, put: 0, delete: 0, iterate: 0 };

	const store: KVStore = {
		async get(key: Uint8Array) {
			calls.get++;
			return inner.get(key);
		},
		// Counted as ONE underlying call however many keys it carries — that is the property
		// the cache's batch path exists to produce, so the spy has to be able to see it.
		async getMany(keys: readonly Uint8Array[]) {
			calls.getMany++;
			return inner.getMany(keys);
		},
		async has(key: Uint8Array) {
			calls.has++;
			return inner.has(key);
		},
		async put(key: Uint8Array, value: Uint8Array) {
			calls.put++;
			return inner.put(key, value);
		},
		async delete(key: Uint8Array) {
			calls.delete++;
			return inner.delete(key);
		},
		iterate(options?) {
			calls.iterate++;
			return inner.iterate(options);
		},
		batch() {
			return inner.batch();
		},
		async close() {
			return inner.close();
		},
		async approximateCount(options?) {
			return inner.approximateCount(options);
		},
	};

	return { store, calls };
}

const KEY_A = new Uint8Array([1, 2, 3]);
const KEY_B = new Uint8Array([4, 5, 6]);
const VAL_1 = new Uint8Array([10, 20, 30]);
const VAL_2 = new Uint8Array([40, 50, 60]);

describe('CachedKVStore', () => {
	describe('get() caching', () => {
		it('should return cached value on second call without hitting underlying', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			// Seed the underlying store
			await store.put(KEY_A, VAL_1);
			calls.get = 0; // reset after put

			// First get — cache miss
			const v1 = await cached.get(KEY_A);
			expect(v1).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(1);

			// Second get — cache hit
			const v2 = await cached.get(KEY_A);
			expect(v2).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(1); // no additional call
		});

		it('should return undefined for non-existent key', async () => {
			const { store } = createSpyStore();
			const cached = new CachedKVStore(store);

			const result = await cached.get(KEY_A);
			expect(result).to.be.undefined;
		});
	});

	describe('Negative cache entries', () => {
		it('should cache negative result and not hit underlying on second get()', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			// First get — miss, stores negative entry
			const v1 = await cached.get(KEY_A);
			expect(v1).to.be.undefined;
			expect(calls.get).to.equal(1);

			// Second get — should serve from cache (negative entry)
			const v2 = await cached.get(KEY_A);
			expect(v2).to.be.undefined;
			expect(calls.get).to.equal(1); // no additional call
		});

		it('should return false for has() on negative cache entry', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			// Populate negative entry
			await cached.get(KEY_A);
			calls.get = 0;

			const result = await cached.has(KEY_A);
			expect(result).to.be.false;
			expect(calls.get).to.equal(0); // served from cache
		});
	});

	describe('put() write-through', () => {
		it('should update cache so subsequent get() sees new value', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await cached.put(KEY_A, VAL_1);
			calls.get = 0;

			const result = await cached.get(KEY_A);
			expect(result).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(0); // served from cache
		});

		it('should overwrite existing cache entry', async () => {
			const { store } = createSpyStore();
			const cached = new CachedKVStore(store);

			await cached.put(KEY_A, VAL_1);
			await cached.put(KEY_A, VAL_2);

			const result = await cached.get(KEY_A);
			expect(result).to.deep.equal(VAL_2);
		});

		it('should replace negative cache entry with real value', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			// Create negative entry
			await cached.get(KEY_A);
			expect(calls.get).to.equal(1);

			// Put overwrites the negative entry
			await cached.put(KEY_A, VAL_1);
			calls.get = 0;

			const result = await cached.get(KEY_A);
			expect(result).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(0); // served from cache
		});
	});

	describe('delete() negative caching', () => {
		it('should result in cache returning undefined on get()', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await cached.put(KEY_A, VAL_1);
			await cached.delete(KEY_A);
			calls.get = 0;

			const result = await cached.get(KEY_A);
			expect(result).to.be.undefined;
			expect(calls.get).to.equal(0); // negative entry in cache
		});

		it('should result in has() returning false from cache', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await cached.put(KEY_A, VAL_1);
			await cached.delete(KEY_A);
			calls.get = 0;

			const result = await cached.has(KEY_A);
			expect(result).to.be.false;
			expect(calls.get).to.equal(0);
		});
	});

	describe('has() caching', () => {
		it('should return true from cache for known-present key', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await cached.put(KEY_A, VAL_1);
			calls.get = 0;

			const result = await cached.has(KEY_A);
			expect(result).to.be.true;
			expect(calls.get).to.equal(0);
		});

		it('should populate cache on miss', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await store.put(KEY_A, VAL_1);
			calls.get = 0;

			// has() populates cache via get() on underlying
			const result = await cached.has(KEY_A);
			expect(result).to.be.true;
			expect(calls.get).to.equal(1);

			// Second call served from cache
			const result2 = await cached.has(KEY_A);
			expect(result2).to.be.true;
			expect(calls.get).to.equal(1);
		});
	});

	describe('iterate() delegation', () => {
		it('should always delegate to underlying', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await store.put(KEY_A, VAL_1);
			await store.put(KEY_B, VAL_2);
			calls.iterate = 0;

			const entries = [];
			for await (const entry of cached.iterate()) {
				entries.push(entry);
			}

			expect(entries).to.have.length(2);
			expect(calls.iterate).to.equal(1);
		});
	});

	describe('LRU eviction', () => {
		it('should evict oldest entries when maxEntries is exceeded', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store, { maxEntries: 2 });

			// Fill underlying
			const k1 = new Uint8Array([1]);
			const k2 = new Uint8Array([2]);
			const k3 = new Uint8Array([3]);
			await store.put(k1, VAL_1);
			await store.put(k2, VAL_1);
			await store.put(k3, VAL_1);

			// Populate cache with k1 and k2
			await cached.get(k1);
			await cached.get(k2);
			calls.get = 0;

			// Access k3 — should evict k1 (oldest)
			await cached.get(k3);
			expect(calls.get).to.equal(1); // miss

			// k2 should still be cached (was accessed more recently than k1)
			calls.get = 0;
			await cached.get(k2);
			expect(calls.get).to.equal(0);

			// k1 should have been evicted
			calls.get = 0;
			await cached.get(k1);
			expect(calls.get).to.equal(1); // miss — was evicted
		});

		it('should evict entries when maxBytes is exceeded', async () => {
			const { store, calls } = createSpyStore();
			// Each entry: 1 byte key + 3 bytes value = 4 bytes
			// Allow only 8 bytes = 2 entries
			const cached = new CachedKVStore(store, { maxEntries: 100, maxBytes: 8 });

			const k1 = new Uint8Array([1]);
			const k2 = new Uint8Array([2]);
			const k3 = new Uint8Array([3]);
			const val = new Uint8Array([10, 20, 30]);
			await store.put(k1, val);
			await store.put(k2, val);
			await store.put(k3, val);

			await cached.get(k1);
			await cached.get(k2);
			calls.get = 0;

			// Adding k3 should evict k1
			await cached.get(k3);
			expect(calls.get).to.equal(1);

			// k1 evicted
			calls.get = 0;
			await cached.get(k1);
			expect(calls.get).to.equal(1);
		});

		it('should refresh LRU position on access', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store, { maxEntries: 2 });

			const k1 = new Uint8Array([1]);
			const k2 = new Uint8Array([2]);
			const k3 = new Uint8Array([3]);
			await store.put(k1, VAL_1);
			await store.put(k2, VAL_1);
			await store.put(k3, VAL_1);

			// Load k1 then k2
			await cached.get(k1);
			await cached.get(k2);

			// Access k1 again to refresh it
			await cached.get(k1);
			calls.get = 0;

			// Now add k3 — should evict k2 (now oldest), not k1
			await cached.get(k3);
			expect(calls.get).to.equal(1);

			// k1 should still be cached
			calls.get = 0;
			await cached.get(k1);
			expect(calls.get).to.equal(0);

			// k2 should be evicted
			calls.get = 0;
			await cached.get(k2);
			expect(calls.get).to.equal(1);
		});
	});

	describe('Batch invalidation', () => {
		it('should invalidate affected keys after batch write', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			// Seed and cache
			await cached.put(KEY_A, VAL_1);
			await cached.put(KEY_B, VAL_2);
			await cached.get(KEY_A);
			await cached.get(KEY_B);
			calls.get = 0;

			// Batch write invalidates
			const batch = cached.batch();
			batch.put(KEY_A, new Uint8Array([99]));
			await batch.write();

			// KEY_A should miss (invalidated)
			await cached.get(KEY_A);
			expect(calls.get).to.equal(1);

			// KEY_B should still be cached
			calls.get = 0;
			await cached.get(KEY_B);
			expect(calls.get).to.equal(0);
		});
	});

	describe('Cache disabled', () => {
		it('should pass through all operations when disabled', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store, { enabled: false });

			await store.put(KEY_A, VAL_1);
			calls.get = 0;

			await cached.get(KEY_A);
			expect(calls.get).to.equal(1);

			// Second get should still hit underlying
			await cached.get(KEY_A);
			expect(calls.get).to.equal(2);
		});
	});

	describe('invalidate() and invalidateAll()', () => {
		it('should invalidate a single key', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await store.put(KEY_A, VAL_1);
			await store.put(KEY_B, VAL_2);

			// Populate cache
			await cached.get(KEY_A);
			await cached.get(KEY_B);
			calls.get = 0;

			cached.invalidate(KEY_A);

			// KEY_A should miss
			await cached.get(KEY_A);
			expect(calls.get).to.equal(1);

			// KEY_B should still be cached
			calls.get = 0;
			await cached.get(KEY_B);
			expect(calls.get).to.equal(0);
		});

		it('should invalidate all entries', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store);

			await store.put(KEY_A, VAL_1);
			await store.put(KEY_B, VAL_2);

			await cached.get(KEY_A);
			await cached.get(KEY_B);
			calls.get = 0;

			cached.invalidateAll();

			await cached.get(KEY_A);
			await cached.get(KEY_B);
			expect(calls.get).to.equal(2);
		});
	});

	describe('getUnderlying()', () => {
		it('should return the wrapped store', () => {
			const { store } = createSpyStore();
			const cached = new CachedKVStore(store);
			expect(cached.getUnderlying()).to.equal(store);
		});
	});

	describe('Concurrent access', () => {
		it('should not leak linked-list nodes on concurrent get() for same key', async () => {
			const { store, calls } = createSpyStore();
			const cached = new CachedKVStore(store, { maxEntries: 10 });

			await store.put(KEY_A, VAL_1);
			calls.get = 0;

			// Fire two concurrent get() calls — both will miss and race to addEntry
			const [r1, r2] = await Promise.all([cached.get(KEY_A), cached.get(KEY_A)]);
			expect(r1).to.deep.equal(VAL_1);
			expect(r2).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(2); // both hit underlying

			// After the race, the cache should still serve correctly
			calls.get = 0;
			const r3 = await cached.get(KEY_A);
			expect(r3).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(0); // served from cache

			// Invalidate and verify we can still refetch cleanly
			cached.invalidateAll();
			calls.get = 0;
			const r4 = await cached.get(KEY_A);
			expect(r4).to.deep.equal(VAL_1);
			expect(calls.get).to.equal(1);
		});
	});
});
