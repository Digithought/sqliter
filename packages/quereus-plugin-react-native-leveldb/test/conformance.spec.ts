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
 */

import type { KVStore } from '@quereus/store';
import { runKVStoreConformance } from '@quereus/store/testing';
import { ReactNativeLevelDBStore } from '../src/store.js';
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
			// The store walks the native cursor one entry per yield — no read-ahead.
			// Measured: consuming k entries reads exactly k (re-measure by temporarily
			// setting this to 0 and reading the failure message).
			maxReadAhead: 1,
		},
	};
});
