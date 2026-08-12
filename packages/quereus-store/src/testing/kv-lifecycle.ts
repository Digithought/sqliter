/**
 * The per-backend lifecycle adapter shared by every PROVIDER-level battery.
 *
 * The batteries that assert a {@link KVStoreProvider} property (rather than a
 * {@link KVStore} one) all need exactly the same two things from a backend: how to open a
 * provider over an empty keyspace, and how to release whatever that created. Declaring the
 * pair once means a plugin's adapters stay interchangeable — one closure can be handed to
 * every such battery — and a battery added later inherits the shape instead of inventing a
 * third copy of it.
 */

import type { KVStoreProvider } from '../common/kv-store.js';

/**
 * Per-backend lifecycle adapter. Each battery drives its own per-test lifecycle and calls
 * the factory fresh for every test, so state never leaks between tests.
 */
export interface KVProviderLifecycle {
	/** Open a provider over a fresh, EMPTY physical keyspace. Called once per test. */
	open(): Promise<KVStoreProvider>;
	/** Release everything open() created (close the provider, rm dirs / delete dbs). */
	teardown(): Promise<void>;
}
