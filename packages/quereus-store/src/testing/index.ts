/**
 * Test-support entry point — `@quereus/store/testing`.
 *
 * Shared conformance batteries every backend runs, so behavior cannot drift between
 * the in-memory, LevelDB, and IndexedDB implementations:
 *   - {@link runKVStoreConformance} — the {@link KVStore} contract (all backends);
 *   - {@link runKVProviderConformance} — the provider-level atomic multi-store commit
 *     ({@link KVStoreProvider.beginAtomicBatch}), for the backends that have one.
 *
 * {@link assertBoundedIterate} is the bounded-iteration tier's core assertion, exported
 * standalone so a spec can drive it directly (including against a store double built to
 * fail it — a guard nobody has watched fail is not a guard).
 */

export { runKVStoreConformance, assertBoundedIterate, type KVBackend, type ReadMeter } from './kv-conformance.js';
export { runKVProviderConformance, type KVProviderBackend } from './kv-provider-conformance.js';
