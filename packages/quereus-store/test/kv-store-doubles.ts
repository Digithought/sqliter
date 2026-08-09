/**
 * KVStore test doubles shared by the bounded-iteration specs.
 *
 * Not a `*.spec.ts`, so Mocha's glob does not pick it up as a suite.
 */

import type { IterateOptions, KVEntry, KVStore, WriteBatch, WriteOptions } from '../src/common/kv-store.js';

/**
 * Forwards every {@link KVStore} method to an inner store. Subclasses override only
 * the one method whose behavior they are modeling.
 */
export class DelegatingKVStore implements KVStore {
	constructor(protected readonly inner: KVStore) {}

	get(key: Uint8Array): Promise<Uint8Array | undefined> {
		return this.inner.get(key);
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

/**
 * Counts entries pulled from the inner store's `iterate()` — the read meter for any
 * store layered ON TOP of it. Pulls lazily (one entry per `next()`), so a well-behaved
 * consumer reads exactly what it consumes.
 */
export class CountingKVStore extends DelegatingKVStore {
	private reads = 0;

	/** Entries pulled from the inner store since construction. Monotonic. */
	entriesRead(): number {
		return this.reads;
	}

	async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		for await (const entry of this.inner.iterate(options)) {
			this.reads++;
			yield entry;
		}
	}
}

/**
 * DELIBERATELY QUADRATIC: pages in fixed-size batches — so peak memory and the FIRST
 * batch both look bounded — but resumes by re-reading from the start of the range and
 * discarding a growing prefix, the shape of `limit`/`offset` paging over a SQL backend.
 * Total reads are O(n²). The negative control for the full-drain case, which is the only
 * one that can see this: every prefix-and-stop assertion passes against it.
 */
export class RescanningKVStore extends DelegatingKVStore {
	constructor(inner: KVStore, private readonly batchSize = 64) {
		super(inner);
	}

	async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		const { limit, ...bounds } = options ?? {};
		for (let offset = 0; ; offset += this.batchSize) {
			if (limit !== undefined && offset >= limit) return;
			const want = limit === undefined ? this.batchSize : Math.min(this.batchSize, limit - offset);
			const page = await this.readFromStart(bounds, offset, want);
			for (const entry of page) yield entry;
			if (page.length < want) return;
		}
	}

	/** Read `offset + want` entries from the range start and keep only the last `want`. */
	private async readFromStart(bounds: IterateOptions, offset: number, want: number): Promise<KVEntry[]> {
		const page: KVEntry[] = [];
		let seen = 0;
		for await (const entry of this.inner.iterate({ ...bounds, limit: offset + want })) {
			if (seen++ >= offset) page.push(entry);
		}
		return page;
	}
}

/**
 * DELIBERATELY UNBOUNDED: reads the entire BOUNDS range into an array before yielding
 * the first entry, and only then applies `limit` — the exact shape of the two mobile
 * backends the bounded-iteration contract exists to rule out (one runs a `select` and
 * takes the whole result set, the other walks a native iterator to exhaustion). Used as
 * the negative control that proves the guard bites.
 */
export class BufferingKVStore extends DelegatingKVStore {
	async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		// Note the dropped `limit`: the read is sized by the range, not by the consumer.
		const { limit: _limit, ...bounds } = options ?? {};
		const all: KVEntry[] = [];
		for await (const entry of this.inner.iterate(bounds)) all.push(entry);
		const limit = options?.limit ?? all.length;
		for (let i = 0; i < Math.min(limit, all.length); i++) yield all[i];
	}
}
