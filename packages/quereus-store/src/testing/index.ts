/**
 * Test-support entry point — `@quereus/store/testing`.
 *
 * Shared conformance batteries every backend runs, so behavior cannot drift between
 * the in-memory, LevelDB, and IndexedDB implementations:
 *   - {@link runKVStoreConformance} — the {@link KVStore} contract (all backends);
 *   - {@link runKVProviderConformance} — the provider-level atomic multi-store commit
 *     ({@link KVStoreProvider.beginAtomicBatch}), for the backends that have one.
 */

export { runKVStoreConformance, type KVBackend } from './kv-conformance.js';
export { runKVProviderConformance, type KVProviderBackend } from './kv-provider-conformance.js';
