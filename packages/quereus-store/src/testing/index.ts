/**
 * Test-support entry point — `@quereus/store/testing`.
 *
 * Shared conformance batteries every backend runs, so behavior cannot drift between
 * the in-memory, LevelDB, and IndexedDB implementations:
 *   - {@link runKVStoreConformance} — the {@link KVStore} contract (all backends);
 *   - {@link runKVProviderConformance} — the provider-level atomic multi-store commit
 *     ({@link KVStoreProvider.beginAtomicBatch}), for the backends that have one;
 *   - {@link runStoreNameDistinctness} — that a provider never folds two distinct logical
 *     stores onto one physical store (all backends with a provider).
 *
 * {@link assertBoundedIterate} and {@link assertStoreNamesDistinct} are the core assertions
 * of two of those batteries, exported standalone so a spec can drive them directly
 * (including against a double built to fail them — a guard nobody has watched fail is not
 * a guard).
 */

export { runKVStoreConformance, assertBoundedIterate, type KVBackend, type ReadMeter, type PointReadMeter } from './kv-conformance.js';
export { runKVProviderConformance, type KVProviderBackend } from './kv-provider-conformance.js';
export { runStoreNameDistinctness, assertStoreNamesDistinct, type KVNamingBackend } from './kv-naming-conformance.js';
