/**
 * Tests for InMemoryKVStore-SPECIFIC surface.
 *
 * The shared KVStore contract (get/put/delete/has, iteration & ordering, batch,
 * approximateCount, close, copy semantics) is exercised against this backend by
 * `kv-conformance.spec.ts`. This file keeps only what is NOT on the `KVStore`
 * interface — the `clear()` method and `size` getter unique to InMemoryKVStore.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '../src/common/memory-store.js';

describe('InMemoryKVStore (backend-specific)', () => {
	let store: InMemoryKVStore;

	beforeEach(() => {
		store = new InMemoryKVStore();
	});

	afterEach(async () => {
		await store.close();
	});

	describe('clear / size', () => {
		it('clear removes all data', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			store.clear();
			expect(store.size).to.equal(0);
			expect(await store.has(new Uint8Array([1]))).to.be.false;
		});

		it('size reflects current entry count', async () => {
			expect(store.size).to.equal(0);
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			expect(store.size).to.equal(1);
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			expect(store.size).to.equal(2);
			await store.delete(new Uint8Array([1]));
			expect(store.size).to.equal(1);
		});
	});
});
