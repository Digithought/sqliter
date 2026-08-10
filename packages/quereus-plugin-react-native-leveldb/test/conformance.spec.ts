/**
 * Runs the shared KVStore conformance suite against the React Native LevelDB backend.
 *
 * The suite lives in `@quereus/store/testing` (built to dist — run the store build, or
 * `yarn build`, before this spec so the import resolves).
 *
 * The real rn-leveldb bindings are a native module that cannot load under Node, so the
 * backend under test is the store driving `MockLevelDB` (see `test/mock-leveldb.ts` for
 * why that mock is written to be a faithful LevelDB rather than a convenient map).
 *
 * The mock keeps nothing outside the process, so this adapter supplies no `reopen` and
 * the persistence tier is not registered for this backend — same as the in-memory store.
 * Real on-device persistence is LevelDB's own and is not exercised here.
 *
 * Also runs the shared store-name distinctness battery over `ReactNativeLevelDBProvider`.
 * That battery needs to observe whether two logical stores land on ONE on-device database,
 * so its `openFn` memoizes a MockLevelDB per database NAME: same name → same mock (the
 * stores genuinely share storage, exactly as they would on device), different name →
 * different mock.
 */

import type { KVStore, KVStoreProvider } from '@quereus/store';
import { runKVStoreConformance, runStoreNameDistinctness } from '@quereus/store/testing';
import { ReactNativeLevelDBStore } from '../src/store.js';
import { createReactNativeLevelDBProvider, type ReactNativeLevelDBProvider } from '../src/provider.js';
import { MockLevelDB, MockLevelDBWriteBatch } from './mock-leveldb.js';

runKVStoreConformance('ReactNativeLevelDBStore', () => {
	let store: ReactNativeLevelDBStore | undefined;
	let reads = 0;

	return {
		async open(): Promise<KVStore> {
			// The mock counts each distinct entry the store touches through an iterator —
			// the read meter the bounded-iteration tier needs, since a KVStore handle
			// cannot see its own reads.
			const db = new MockLevelDB({ onEntryRead: () => { reads++; } });
			store = ReactNativeLevelDBStore.create(db, MockLevelDBWriteBatch);
			return store;
		},
		async teardown(): Promise<void> {
			if (store) await store.close(); // also closes the mock db
			store = undefined;
		},
		readMeter: {
			entriesRead: () => reads,
			// The store walks the native cursor one entry per yield,
			// plus at most one probe read: an exclusive `gt` whose key exists is read,
			// skipped, and the next entry read, so one yield can cost two.
			// Measured: unbounded consumption of k entries reads exactly k, and
			// `{ gt: <a present key> }` stopped after one entry reads 2 (re-measure by
			// temporarily setting this to 0 and reading the failure message).
			maxReadAhead: 2,
		},
	};
});

runStoreNameDistinctness('ReactNativeLevelDBProvider store names', () => {
	// One mock per database name — the in-process stand-in for "one LevelDB file per name".
	const dbsByName = new Map<string, MockLevelDB>();
	let provider: ReactNativeLevelDBProvider | undefined;

	return {
		async open(): Promise<KVStoreProvider> {
			provider = createReactNativeLevelDBProvider({
				openFn: (name) => {
					let db = dbsByName.get(name);
					if (!db) {
						db = new MockLevelDB();
						dbsByName.set(name, db);
					}
					return db;
				},
				WriteBatch: MockLevelDBWriteBatch,
			});
			return provider;
		},
		async teardown(): Promise<void> {
			if (provider) await provider.closeAll();
			provider = undefined;
			dbsByName.clear();
		},
	};
});
