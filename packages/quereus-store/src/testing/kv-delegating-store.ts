/**
 * The pass-through {@link KVStore} base every test double in this package extends —
 * test-support, ships in `@quereus/store/testing`.
 *
 * Lives on its own rather than beside any one double because it is not specific to what
 * any of them model: the counting store here, and the buffering / rescanning / getMany-
 * misbehaving doubles in `test/kv-store-doubles.ts`, all subclass it and override exactly
 * the one method whose behavior they are demonstrating.
 */

import type { IterateOptions, KVEntry, KVStore, WriteBatch, WriteOptions } from '../common/kv-store.js';

/**
 * Forwards every {@link KVStore} method to an inner store. Subclasses override only
 * the one method whose behavior they are modeling.
 */
export class DelegatingKVStore implements KVStore {
	constructor(protected readonly inner: KVStore) {}

	get(key: Uint8Array): Promise<Uint8Array | undefined> {
		return this.inner.get(key);
	}

	getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		return this.inner.getMany(keys);
	}

	put(key: Uint8Array, value: Uint8Array, options?: WriteOptions): Promise<void> {
		return this.inner.put(key, value, options);
	}

	delete(key: Uint8Array, options?: WriteOptions): Promise<void> {
		return this.inner.delete(key, options);
	}

	has(key: Uint8Array): Promise<boolean> {
		return this.inner.has(key);
	}

	iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		return this.inner.iterate(options);
	}

	batch(): WriteBatch {
		return this.inner.batch();
	}

	close(): Promise<void> {
		return this.inner.close();
	}

	approximateCount(options?: IterateOptions): Promise<number> {
		return this.inner.approximateCount(options);
	}
}
