/**
 * `IndexedDBProvider.beginAtomicBatch` — the shared-domain atomic multi-store
 * commit capability.
 *
 * All of a provider's object stores live in one IndexedDB database, so a single
 * `db.transaction(storeNames, 'readwrite')` (via `MultiStoreWriteBatch`) commits
 * them atomically. These tests wire the real provider over `fake-indexeddb/auto`
 * and assert: multi-store atomic commit, post-write read-cache coherence across
 * the `CachedKVStore` wrapper, and MISUSE on a foreign handle.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { QuereusError, StatusCode } from '@quereus/quereus';
import { CachedKVStore, InMemoryKVStore } from '@quereus/store';
import { createIndexedDBProvider, IndexedDBProvider } from '../src/provider.js';
import { IndexedDBManager } from '../src/manager.js';

describe('IndexedDB atomic batch', () => {
	const testDbName = 'test-atomic-batch-db';
	let provider: IndexedDBProvider;

	beforeEach(() => {
		provider = createIndexedDBProvider({ databaseName: testDbName });
	});

	afterEach(async () => {
		try {
			await provider.closeAll();
		} catch {
			/* may already be closed */
		}
		IndexedDBManager.resetInstance(testDbName);
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(testDbName);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	});

	const K1 = new Uint8Array([1]);
	const V1 = new Uint8Array([0x10]);
	const K2 = new Uint8Array([2]);
	const V2 = new Uint8Array([0x20]);

	it('commits data + index ops across object stores in one atomic batch', async () => {
		const dataStore = await provider.getStore('main', 't');
		const indexStore = await provider.getIndexStore('main', 't', 'ix');

		const batch = provider.beginAtomicBatch();
		batch.put(dataStore, K1, V1);
		batch.put(indexStore, K2, V2);
		await batch.write();

		expect(await dataStore.get(K1)).to.deep.equal(V1);
		expect(await indexStore.get(K2)).to.deep.equal(V2);
	});

	it('invalidates each touched store cache so a read after write sees post-write data (RYOW)', async () => {
		const dataStore = await provider.getStore('main', 't') as CachedKVStore;
		expect(dataStore, 'data store is cached by default').to.be.instanceOf(CachedKVStore);

		// Warm a negative cache entry: reading the absent key caches `undefined`.
		expect(await dataStore.get(K1)).to.be.undefined;

		// The atomic write bypasses the CachedKVStore wrapper entirely.
		const batch = provider.beginAtomicBatch();
		batch.put(dataStore, K1, V1);
		await batch.write();

		// Without post-write invalidation this would still serve the stale negative
		// entry (undefined) — RYOW across the cache would regress.
		expect(await dataStore.get(K1)).to.deep.equal(V1);
	});

	it('same-key ops in one batch resolve to the last one queued', async () => {
		// The coordinator replays a transaction's pending ops into one atomic batch
		// without collapsing duplicates, so a transaction that writes then deletes
		// the same row lands both ops here and depends on queue order.
		const dataStore = await provider.getStore('main', 't');
		await dataStore.put(K1, V1);

		const putThenDelete = provider.beginAtomicBatch();
		putThenDelete.put(dataStore, K1, V2);
		putThenDelete.delete(dataStore, K1);
		await putThenDelete.write();
		expect(await dataStore.get(K1)).to.be.undefined;

		const deleteThenPut = provider.beginAtomicBatch();
		deleteThenPut.delete(dataStore, K1);
		deleteThenPut.put(dataStore, K1, V2);
		await deleteThenPut.write();
		expect(await dataStore.get(K1)).to.deep.equal(V2);
	});

	it('clear() discards queued ops (nothing is committed)', async () => {
		const dataStore = await provider.getStore('main', 't');
		const batch = provider.beginAtomicBatch();
		batch.put(dataStore, K1, V1);
		batch.clear();
		await batch.write();
		expect(await dataStore.get(K1)).to.be.undefined;
	});

	it('throws MISUSE for a handle not produced by this provider (wrong type)', () => {
		const foreign = new InMemoryKVStore();
		const batch = provider.beginAtomicBatch();
		let err: unknown;
		try {
			batch.put(foreign, K1, V1);
		} catch (e) {
			err = e;
		}
		expect(err).to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
	});

	it('throws MISUSE for an IndexedDBStore bound to a different provider/manager', async () => {
		const otherDbName = 'test-atomic-batch-other-db';
		const otherProvider = createIndexedDBProvider({ databaseName: otherDbName });
		try {
			const foreign = await otherProvider.getStore('main', 't');
			const batch = provider.beginAtomicBatch();
			let err: unknown;
			try {
				batch.delete(foreign, K1);
			} catch (e) {
				err = e;
			}
			expect(err).to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
		} finally {
			await otherProvider.closeAll();
			IndexedDBManager.resetInstance(otherDbName);
			await new Promise<void>((resolve, reject) => {
				const req = indexedDB.deleteDatabase(otherDbName);
				req.onsuccess = () => resolve();
				req.onerror = () => reject(req.error);
			});
		}
	});
});
