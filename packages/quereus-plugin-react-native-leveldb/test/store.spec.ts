/**
 * Tests for React Native LevelDB store implementation.
 *
 * Uses the shared mock LevelDB (`test/mock-leveldb.ts`) to test the store without
 * requiring the actual rn-leveldb native module. The broader contract is covered by
 * `test/conformance.spec.ts`, which drives the same mock through the shared
 * `runKVStoreConformance` battery; these cases are the package's own targeted checks.
 */

import { expect } from 'chai';
import { ReactNativeLevelDBStore, type LevelDBWriteBatchConstructor } from '../src/store.js';
import { MockLevelDB, MockLevelDBWriteBatch } from './mock-leveldb.js';

describe('ReactNativeLevelDBStore', () => {
	let store: ReactNativeLevelDBStore;
	let mockDb: MockLevelDB;
	const MockWriteBatch: LevelDBWriteBatchConstructor = MockLevelDBWriteBatch;

	beforeEach(() => {
		mockDb = new MockLevelDB();
		store = ReactNativeLevelDBStore.create(mockDb, MockWriteBatch);
	});

	afterEach(async () => {
		await store.close();
	});

	describe('Basic operations', () => {
		it('should put and get a value', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const value = new Uint8Array([4, 5, 6]);

			await store.put(key, value);
			const result = await store.get(key);

			expect(result).to.deep.equal(value);
		});

		it('should return undefined for non-existent key', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const result = await store.get(key);

			expect(result).to.be.undefined;
		});

		it('should delete a key', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const value = new Uint8Array([4, 5, 6]);

			await store.put(key, value);
			await store.delete(key);
			const result = await store.get(key);

			expect(result).to.be.undefined;
		});

		it('should check if key exists with has()', async () => {
			const key = new Uint8Array([10, 20, 30]);
			const value = new Uint8Array([40, 50, 60]);

			expect(await store.has(key)).to.be.false;
			await store.put(key, value);
			expect(await store.has(key)).to.be.true;
		});

		it('should overwrite existing values', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const value1 = new Uint8Array([4, 5, 6]);
			const value2 = new Uint8Array([7, 8, 9]);

			await store.put(key, value1);
			await store.put(key, value2);
			const result = await store.get(key);

			expect(result).to.deep.equal(value2);
		});
	});

	describe('Iteration', () => {
		beforeEach(async () => {
			// Insert test data
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			await store.put(new Uint8Array([3]), new Uint8Array([30]));
			await store.put(new Uint8Array([4]), new Uint8Array([40]));
			await store.put(new Uint8Array([5]), new Uint8Array([50]));
		});

		it('should iterate all entries in order', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate()) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(5);
			expect(entries[0].key[0]).to.equal(1);
			expect(entries[4].key[0]).to.equal(5);
		});

		it('should iterate with gte bound', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ gte: new Uint8Array([3]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(3);
			expect(entries[0].key[0]).to.equal(3);
		});

		it('should iterate with lt bound', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ lt: new Uint8Array([3]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(2);
			expect(entries[1].key[0]).to.equal(2);
		});

		it('should iterate with gt bound (exclusive)', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ gt: new Uint8Array([2]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(3);
			expect(entries[0].key[0]).to.equal(3);
		});

		it('should iterate with lte bound (inclusive)', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ lte: new Uint8Array([3]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(3);
			expect(entries[2].key[0]).to.equal(3);
		});

		it('should iterate in reverse', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ reverse: true })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(5);
			expect(entries[0].key[0]).to.equal(5);
			expect(entries[4].key[0]).to.equal(1);
		});

		it('should respect limit', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ limit: 2 })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(2);
		});

		it('should combine gte and lt bounds', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ gte: new Uint8Array([2]), lt: new Uint8Array([4]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(2);
			expect(entries[0].key[0]).to.equal(2);
			expect(entries[1].key[0]).to.equal(3);
		});

		// The native iterator must be released however the walk ends. Conformance tier 7
		// checks the store stays usable after an abandoned scan, which a leaked MOCK
		// iterator would not disturb — only the mock's own live-iterator count can see it.
		it('should close the native iterator on exhaustion, break, and a consumer throw', async () => {
			for await (const _entry of store.iterate()) { /* drain */ }
			expect(mockDb.openIteratorCount()).to.equal(0, 'after exhaustion');

			for await (const _entry of store.iterate()) {
				break;
			}
			expect(mockDb.openIteratorCount()).to.equal(0, 'after break');

			try {
				for await (const _entry of store.iterate()) {
					throw new Error('consumer boom');
				}
				expect.fail('Should have thrown');
			} catch (e) {
				expect((e as Error).message).to.equal('consumer boom');
			}
			expect(mockDb.openIteratorCount()).to.equal(0, 'after a consumer throw');
		});
	});

	describe('Batch operations', () => {
		it('should execute batch put operations', async () => {
			const batch = store.batch();
			batch.put(new Uint8Array([1]), new Uint8Array([10]));
			batch.put(new Uint8Array([2]), new Uint8Array([20]));
			batch.put(new Uint8Array([3]), new Uint8Array([30]));
			await batch.write();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.deep.equal(new Uint8Array([30]));
		});

		it('should execute batch delete operations', async () => {
			await store.put(new Uint8Array([100]), new Uint8Array([10]));
			await store.put(new Uint8Array([101]), new Uint8Array([20]));

			const batch = store.batch();
			batch.delete(new Uint8Array([100]));
			batch.delete(new Uint8Array([101]));
			await batch.write();

			expect(await store.has(new Uint8Array([100]))).to.be.false;
			expect(await store.has(new Uint8Array([101]))).to.be.false;
		});

		it('should clear batch operations', async () => {
			const batch = store.batch();
			batch.put(new Uint8Array([1]), new Uint8Array([10]));
			batch.clear();
			await batch.write();

			expect(await store.has(new Uint8Array([1]))).to.be.false;
		});
	});

	describe('Approximate count', () => {
		it('should return count of all entries', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			await store.put(new Uint8Array([3]), new Uint8Array([30]));

			const count = await store.approximateCount();
			expect(count).to.equal(3);
		});

		it('should return count within range', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			await store.put(new Uint8Array([3]), new Uint8Array([30]));
			await store.put(new Uint8Array([4]), new Uint8Array([40]));

			const count = await store.approximateCount({ gte: new Uint8Array([2]), lt: new Uint8Array([4]) });
			expect(count).to.equal(2);
		});
	});

	describe('Error handling', () => {
		it('should throw when operating on closed store', async () => {
			await store.close();

			try {
				await store.get(new Uint8Array([1]));
				expect.fail('Should have thrown');
			} catch (e) {
				expect((e as Error).message).to.include('closed');
			}
		});
	});
});

