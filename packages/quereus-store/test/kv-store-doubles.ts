/**
 * KVStore test doubles shared by the bounded-iteration and batch-point-read specs.
 *
 * Not a `*.spec.ts`, so Mocha's glob does not pick it up as a suite.
 *
 * `DelegatingKVStore` — the base every double here extends — lives in
 * `src/testing/kv-delegating-store.ts` (published as `@quereus/store/testing`) and is
 * re-exported from here so the doubles below keep a single import source.
 */

import { bytesToHex, compareBytes } from '../src/common/bytes.js';
import type { IterateOptions, KVEntry, KVStore } from '../src/common/kv-store.js';
import { DelegatingKVStore } from '../src/testing/kv-delegating-store.js';

export { DelegatingKVStore };

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

/**
 * DELIBERATELY SORTED: reads the keys in byte order and answers in THAT order — the shape
 * of a backend whose native multi-get sorts internally (or whose results are filled in
 * arrival order) and whose adapter forgets to map back to argument order. Every value it
 * returns is correct; only the positions are wrong.
 */
export class SortingGetManyKVStore extends DelegatingKVStore {
	getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		return this.inner.getMany([...keys].sort(compareBytes));
	}
}

/**
 * DELIBERATELY COMPACTING: drops absent keys instead of leaving `undefined` at their
 * position — the shape of a backend that returns "the rows it found". The result is
 * shorter than the key list and everything after a miss has slid down one index.
 */
export class CompactingGetManyKVStore extends DelegatingKVStore {
	async getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		return (await this.inner.getMany(keys)).filter(value => value !== undefined);
	}
}

/**
 * DELIBERATELY ALIASING: reads each DISTINCT key once and files the SAME buffer object at
 * every position that key occupies — the shape of a backend that dedups its key list to
 * save a read. Positions and values all look right; a caller that scribbles on one
 * position silently rewrites the other.
 */
export class AliasingGetManyKVStore extends DelegatingKVStore {
	async getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		const distinct = new Map<string, Uint8Array>();
		for (const key of keys) distinct.set(bytesToHex(key), key);
		const hexes = [...distinct.keys()];
		const values = await this.inner.getMany([...distinct.values()]);
		const byHex = new Map(hexes.map((hex, i) => [hex, values[i]]));
		return keys.map(key => byHex.get(bytesToHex(key)));
	}
}
