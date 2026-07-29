/**
 * `IndexedDBProvider.beginAtomicBatch` — the shared-domain atomic multi-store commit.
 *
 * All of a provider's object stores live in one IndexedDB database, so a single
 * `db.transaction(storeNames, 'readwrite')` (via `MultiStoreWriteBatch`) commits them
 * atomically. Runs under `fake-indexeddb/auto` in Node/Mocha, like every other
 * IndexedDB spec.
 *
 * The contract itself (multi-store commit, same-key ordering, clear(), the empty
 * write, MISUSE on a foreign handle) is asserted by the SHARED provider conformance
 * suite in `@quereus/store/testing`, which LevelDB runs too — so the two backends
 * cannot drift. Built to dist: run the store build (or `yarn build`) before this spec
 * so the import resolves. Only genuinely IndexedDB-shaped behavior lives below —
 * notably read-cache coherence across the `CachedKVStore` wrapper, which LevelDB
 * has no equivalent of.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import type { KVStoreProvider } from '@quereus/store';
import { CachedKVStore } from '@quereus/store';
import { runKVProviderConformance } from '@quereus/store/testing';
import { createIndexedDBProvider, IndexedDBProvider } from '../src/provider.js';
import { IndexedDBManager } from '../src/manager.js';

// Per-test unique database name. A counter (not Date.now/random) keeps names stable and
// collision-free across the suite's many tests within one process.
let seq = 0;

/**
 * Delete a fake-indexeddb database by name and await completion.
 *
 * NOTE: no `onblocked` handler — per the IndexedDB spec a blocked delete still completes
 * (success fires) once the remaining connections close, so rejecting there would be wrong.
 * If teardown ever leaves a connection open for good, this settles never and the test
 * surfaces as a Mocha hook timeout; hook `onblocked` up to a diagnostic log then.
 */
function deleteDatabase(dbName: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

runKVProviderConformance('IndexedDBProvider atomic batch', () => {
	const dbNames: string[] = [];
	const providers: IndexedDBProvider[] = [];

	/** A provider over its own private database — its own manager, its own commit domain. */
	function makeProvider(): IndexedDBProvider {
		const databaseName = `quereus-atomic-idb-${seq++}`;
		dbNames.push(databaseName);
		const provider = createIndexedDBProvider({ databaseName });
		providers.push(provider);
		return provider;
	}

	return {
		async open(): Promise<KVStoreProvider> {
			return makeProvider();
		},
		async openForeign(): Promise<KVStoreProvider> {
			return makeProvider();
		},
		async teardown(): Promise<void> {
			for (const provider of providers) {
				try {
					await provider.closeAll();
				} catch (e) {
					// An unopened (or already closed) provider is fine to skip; anything else
					// is worth seeing rather than swallowing.
					console.warn(`closeAll during teardown: ${String(e)}`);
				}
			}
			for (const dbName of dbNames) {
				IndexedDBManager.resetInstance(dbName);
				await deleteDatabase(dbName);
			}
		},
	};
});

describe('IndexedDB atomic batch (backend specifics)', () => {
	const testDbName = 'test-atomic-batch-db';
	let provider: IndexedDBProvider;

	beforeEach(() => {
		provider = createIndexedDBProvider({ databaseName: testDbName });
	});

	afterEach(async () => {
		try {
			await provider.closeAll();
		} catch (e) {
			console.warn(`closeAll during teardown: ${String(e)}`);
		}
		IndexedDBManager.resetInstance(testDbName);
		await deleteDatabase(testDbName);
	});

	const K1 = new Uint8Array([1]);
	const V1 = new Uint8Array([0x10]);

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
});
