/**
 * Runs the shared KVStore conformance suite against the in-memory backend, and against
 * `CachedKVStore` layered over it.
 *
 * The suite itself lives in `src/testing/` (so both plugins can import the built
 * `@quereus/store/testing`); this package imports it by relative path. In-memory is
 * non-persistent by design, so the adapters omit `reopen` and the persistence tier
 * is not registered for them.
 *
 * `CachedKVStore` is registered because its `iterate` returns the inner iterable
 * directly (no drain) — a property nothing else pins. Metering the inner store makes
 * the bounded-iteration tier go red if a future edit ever buffers there.
 */

import { CachedKVStore } from '../src/common/cached-kv-store.js';
import { InMemoryKVStore } from '../src/common/memory-store.js';
import { runKVStoreConformance } from '../src/testing/kv-conformance.js';
import { CountingKVStore } from '../src/testing/kv-counting-store.js';

runKVStoreConformance('InMemoryKVStore', () => ({
	open: async () => new InMemoryKVStore(),
	teardown: async () => {},
}));

runKVStoreConformance('CachedKVStore over InMemoryKVStore', () => {
	// The meter sits BETWEEN the cache and the memory store, so it counts exactly what
	// the cache pulls through. The memory store yields one entry per `next()`.
	let counter: CountingKVStore | undefined;

	return {
		open: async () => {
			counter = new CountingKVStore(new InMemoryKVStore());
			return new CachedKVStore(counter);
		},
		readMeter: {
			entriesRead: () => counter?.iterateEntryCount ?? 0,
			maxReadAhead: 1,
		},
		teardown: async () => {
			counter = undefined;
		},
	};
});
