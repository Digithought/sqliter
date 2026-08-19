/**
 * Test-support entry point — `@quereus/store/testing`.
 *
 * Shared conformance batteries every backend runs, so behavior cannot drift between
 * the in-memory, LevelDB, and IndexedDB implementations:
 *   - {@link runKVStoreConformance} — the {@link KVStore} contract (all backends);
 *   - {@link runKVProviderConformance} — the provider-level atomic multi-store commit
 *     ({@link KVStoreProvider.beginAtomicBatch}), for the backends that have one;
 *   - {@link runStoreNameDistinctness} — that a provider never folds two distinct logical
 *     stores onto one physical store (all backends with a provider);
 *   - {@link runStoreReclaimConformance} — that a provider's delete hooks actually ERASE a
 *     dropped table's stores, leaving every other store intact (all backends with a
 *     provider).
 *
 * The last two take the same {@link KVProviderLifecycle} adapter, so a plugin's spec builds
 * one closure and hands it to both.
 *
 * {@link assertBoundedIterate} and {@link assertStoreNamesDistinct} are the core assertions
 * of two of those batteries, exported standalone so a spec can drive them directly
 * (including against a double built to fail them — a guard nobody has watched fail is not
 * a guard).
 *
 * {@link CountingKVStore} / {@link createCountingProvider} are not a conformance battery —
 * they are the shared counting test double several specs in this package (and its
 * benchmark suite) use to assert on `iterate`/`get`/`getMany` traffic.
 *
 * {@link createInMemoryProvider} is the shared all-`InMemoryKVStore` {@link KVStoreProvider}
 * most specs in this package (and its benchmark suite) need as a plain backend, with no
 * counting attached.
 */

export {
	runKVStoreConformance,
	assertBoundedIterate,
	assertBatchPointRead,
	type KVBackend,
	type ReadMeter,
	type PointReadMeter,
} from './kv-conformance.js';
export { runKVProviderConformance, type KVProviderBackend } from './kv-provider-conformance.js';
export { runStoreNameDistinctness, assertStoreNamesDistinct, type KVNamingBackend } from './kv-naming-conformance.js';
export { runStoreReclaimConformance, type KVReclaimBackend } from './kv-reclaim-conformance.js';
export type { KVProviderLifecycle } from './kv-lifecycle.js';
export { DelegatingKVStore } from './kv-delegating-store.js';
export {
	CountingKVStore,
	createCountingProvider,
	type CountingProviderScope,
} from './kv-counting-store.js';
export {
	createInMemoryProvider,
	type InMemoryProviderOptions,
} from './memory-provider.js';
