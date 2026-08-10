/**
 * Runs the shared KVStore conformance suite against the IndexedDB backend, under
 * `fake-indexeddb/auto` in Node/Mocha (same harness as every other IndexedDB spec).
 * Real-browser execution is a separate concern — see
 * tickets/blocked/feat-indexeddb-real-browser-smoke.md.
 *
 * The suite lives in `@quereus/store/testing` (built to dist — run the store build,
 * or `yarn build`, before this spec so the import resolves). The adapter opens one
 * object store within a per-test database; `reopen` drops the manager/handle WITHOUT
 * deleting the database and re-opens it, so persisted data survives — driving the
 * persistence tier.
 *
 * Also runs the shared store-name distinctness battery over `IndexedDBProvider`. This
 * provider is one of the two reference implementations of that property (it uses the
 * built store name verbatim as the object-store name), so a failure there means the
 * battery is wrong rather than the plugin.
 */

import 'fake-indexeddb/auto';
import type { KVStore, KVStoreProvider } from '@quereus/store';
import { runKVStoreConformance, runStoreNameDistinctness } from '@quereus/store/testing';
import { IndexedDBStore } from '../src/store.js';
import { IndexedDBManager } from '../src/manager.js';
import { createIndexedDBProvider, type IndexedDBProvider } from '../src/provider.js';

const STORE_NAME = 'conformance-store';

/** Max entries `IndexedDBStore.iterate` pages at once — mirrors `BATCH` in src/store.ts. */
const BATCH = 256;

/**
 * Entries read from IndexedDB across the whole process, counted below. Monotonic;
 * `assertBoundedIterate` baselines it, so reads from other specs do not interfere.
 */
let idbEntriesRead = 0;

/**
 * Count entries IndexedDB hands back, by patching the object-store prototype once.
 *
 * `IndexedDBStore` is built from an `IndexedDBManager` singleton, so unlike the LevelDB
 * adapter there is no handle to wrap — the read surface has to be instrumented globally.
 * Both read shapes are covered: each delivered (non-null) cursor position is one entry,
 * and `getAll`'s result length is however many that request returned. Counting is the
 * only effect, so the patch is harmless to every other IndexedDB spec in this process.
 *
 * NOTE: accepted tradeoff — a process-global prototype patch, kept because there is no
 * handle to wrap and the alternative is no IndexedDB metering at all. It relies on Mocha
 * running specs serially (a parallel runner would fold another spec's reads into the
 * measured delta) and on nothing else asserting IDB read counts; revisit if either changes.
 */
function installReadMeter(): void {
	const proto = IDBObjectStore.prototype as IDBObjectStore & { __quereusMetered?: boolean };
	if (proto.__quereusMetered) return;
	proto.__quereusMetered = true;

	const openCursor = proto.openCursor;
	proto.openCursor = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['openCursor']>) {
		const request = openCursor.apply(this, args);
		request.addEventListener('success', () => {
			if (request.result) idbEntriesRead++;
		});
		return request;
	};

	// The forward `iterate` path reads a whole page per `getAll`, so its result length is
	// that page's entry count.
	//
	// IMPORTANT: do NOT also meter `getAllKeys`. The batched read issues both over the
	// same range, so every entry would be counted twice and tier 7's
	// `take + maxReadAhead - 1` allowance would fail even though reads are bounded.
	const getAll = proto.getAll;
	if (typeof getAll === 'function') {
		proto.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
			const request = getAll.apply(this, args);
			request.addEventListener('success', () => {
				idbEntriesRead += Array.isArray(request.result) ? request.result.length : 0;
			});
			return request;
		};
	}
}

installReadMeter();

// Per-test unique database name. A counter (not Date.now/random) keeps names stable
// and collision-free across the suite's many tests within one process.
let seq = 0;

/** Delete a fake-indexeddb database by name and await completion. */
function deleteDatabase(dbName: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

runKVStoreConformance('IndexedDBStore', () => {
	const dbName = `quereus-kv-conf-idb-${seq++}`;
	let store: IndexedDBStore | undefined;

	async function dropHandles(): Promise<void> {
		if (store) await store.close();
		// Close + forget the singleton manager so a subsequent open re-reads the
		// persisted database from scratch (a genuine reopen), rather than reusing the
		// still-open in-memory handle.
		const manager = IndexedDBManager.getInstance(dbName);
		await manager.close();
		IndexedDBManager.resetInstance(dbName);
		store = undefined;
	}

	return {
		async open(): Promise<KVStore> {
			store = await IndexedDBStore.openForTable(dbName, STORE_NAME);
			return store;
		},
		async reopen(): Promise<KVStore> {
			await dropHandles(); // does NOT delete the database — data persists
			store = await IndexedDBStore.openForTable(dbName, STORE_NAME);
			return store;
		},
		async teardown(): Promise<void> {
			await dropHandles();
			await deleteDatabase(dbName);
		},
		readMeter: {
			entriesRead: () => idbEntriesRead,
			// Upper bound over BOTH read paths. Forward now reads exactly BATCH per page
			// (one `getAll`, no probe read past the end); reverse still steps a cursor and
			// reads one extra position to discover the page is full — so BATCH + 1 stays
			// correct, now slightly loose for forward.
			// NOTE: if `readBatch` changes again, re-measure by temporarily setting this to
			// 1 and reading the failure message, rather than reasoning about it.
			maxReadAhead: BATCH + 1,
		},
	};
});

runStoreNameDistinctness('IndexedDBProvider store names', () => {
	const dbName = `quereus-kv-naming-idb-${seq++}`;
	let provider: IndexedDBProvider | undefined;

	return {
		async open(): Promise<KVStoreProvider> {
			provider = createIndexedDBProvider({ databaseName: dbName });
			return provider;
		},
		async teardown(): Promise<void> {
			if (provider) {
				try {
					await provider.closeAll();
				} catch (e) {
					// An unopened (or already closed) provider is fine to skip; anything else
					// is worth seeing rather than swallowing.
					console.warn(`closeAll during teardown: ${String(e)}`);
				}
			}
			provider = undefined;
			IndexedDBManager.resetInstance(dbName);
			await deleteDatabase(dbName);
		},
	};
});
