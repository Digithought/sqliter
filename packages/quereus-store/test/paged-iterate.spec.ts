/**
 * Equivalence property for {@link pagedIterate}: paging a range in fixed-size batches
 * must return the byte-identical sequence a single-shot `iterate` returns — for every
 * batch size, direction, bound combination and limit.
 *
 * Batch size 1 is the cheapest way to expose an inclusive-instead-of-exclusive resume
 * edge (every entry would repeat); a range whose size is an exact multiple of the batch
 * size is the case that makes the final resume read land on an empty range, which must
 * read as "exhausted" rather than throw.
 *
 * The oracle is `InMemoryKVStore.iterate`, which the shared KVStore conformance battery
 * already pins against the byte-ordering contract.
 */

import assert from 'node:assert/strict';
import { InMemoryKVStore } from '../src/common/memory-store.js';
import { pagedIterate, type FetchBatch } from '../src/common/paged-iterate.js';
import type { IterateOptions, KVEntry, KVStore } from '../src/common/kv-store.js';

const COUNT = 512;

/** 2-byte big-endian key — byte order matches numeric order. */
const enc = (n: number): Uint8Array => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);

/** Batch sizes: degenerate, tiny, a size that divides nothing evenly, the IDB page, oversized. */
const BATCH_SIZES = [1, 2, 7, 256, COUNT + 64];

async function seeded(): Promise<InMemoryKVStore> {
	const store = new InMemoryKVStore();
	const batch = store.batch();
	for (let i = 0; i < COUNT; i++) batch.put(enc(i), new Uint8Array([(i >> 8) & 0xff, i & 0xff, 0xaa]));
	await batch.write();
	return store;
}

/** Drain an async iterable into plain-array form so `deepStrictEqual` compares bytes. */
async function collect(source: AsyncIterable<KVEntry>): Promise<Array<[number[], number[]]>> {
	const out: Array<[number[], number[]]> = [];
	for await (const entry of source) out.push([[...entry.key], [...entry.value]]);
	return out;
}

/**
 * A non-streaming backend built on `src`: each call runs one bounded read and hands
 * back the whole (capped) result — what a SQL `select ... limit ?` does.
 */
function fetchFrom(src: KVStore, batchSize: number): FetchBatch {
	return async (bounds, want) => {
		assert.ok(want >= 1 && want <= batchSize, `want ${want} outside 1..${batchSize}`);
		assert.strictEqual(bounds.limit, undefined, 'pagedIterate must size the read via `want`, not `limit`');
		const out: KVEntry[] = [];
		for await (const entry of src.iterate({ ...bounds, limit: want })) out.push(entry);
		return out;
	};
}

/** The scenario matrix for one batch size. */
function scenarios(batchSize: number): Array<{ name: string; options: IterateOptions }> {
	const cases: Array<{ name: string; options: IterateOptions }> = [
		{ name: 'whole range', options: {} },
		{ name: 'whole range, reverse', options: { reverse: true } },
		{ name: 'gte only', options: { gte: enc(10) } },
		{ name: 'gt only', options: { gt: enc(10) } },
		{ name: 'lte only', options: { lte: enc(100) } },
		{ name: 'lt only', options: { lt: enc(100) } },
		{ name: 'gte + lt', options: { gte: enc(5), lt: enc(400) } },
		{ name: 'gt + lte', options: { gt: enc(5), lte: enc(400) } },
		{ name: 'gte + lt, reverse', options: { gte: enc(5), lt: enc(400), reverse: true } },
		{ name: 'gt + lte, reverse', options: { gt: enc(5), lte: enc(400), reverse: true } },
		{ name: 'empty point range', options: { gte: enc(300), lt: enc(300) } },
		{ name: 'crossed range', options: { gte: enc(400), lt: enc(100) } },
		{ name: 'range above every key', options: { gte: enc(COUNT) } },
		{ name: 'limit 0', options: { limit: 0 } },
		{ name: 'limit below one batch', options: { limit: Math.max(1, batchSize - 1) } },
		{ name: 'limit equal to one batch', options: { limit: batchSize } },
		{ name: 'limit above one batch', options: { limit: batchSize + 1 } },
		{ name: 'limit above the whole range', options: { limit: COUNT + 10 } },
		{ name: 'limit + bounds, reverse', options: { gte: enc(5), lt: enc(400), reverse: true, limit: batchSize + 1 } },
	];

	// A range whose size is an EXACT multiple of the batch size: the last full batch
	// consumes the range, and the resume edge collapses to an empty range.
	const multiple = Math.floor(COUNT / batchSize) * batchSize;
	if (multiple >= batchSize) {
		cases.push({ name: 'exclusive upper on an exact batch multiple', options: { lt: enc(multiple) } });
		cases.push({ name: 'inclusive upper on an exact batch multiple', options: { lte: enc(multiple - 1) } });
		cases.push({ name: 'reverse, inclusive lower on an exact batch multiple', options: { gte: enc(COUNT - multiple), reverse: true } });
	}
	return cases;
}

describe('pagedIterate', () => {
	let store: InMemoryKVStore;

	beforeEach(async () => {
		store = await seeded();
	});

	for (const batchSize of BATCH_SIZES) {
		describe(`batch size ${batchSize}`, () => {
			for (const { name, options } of scenarios(batchSize)) {
				it(`matches a single-shot iterate: ${name}`, async () => {
					const expected = await collect(store.iterate(options));
					const actual = await collect(pagedIterate(options, fetchFrom(store, batchSize), batchSize));
					assert.deepStrictEqual(actual, expected);
				});
			}
		});
	}

	it('resumes correctly when the consumer mutates yielded keys', async () => {
		// The resume key is captured before yielding AND copied; a consumer scribbling on
		// a yielded key must not move where the next batch starts.
		const expected = await collect(store.iterate());
		const actual: Array<[number[], number[]]> = [];
		for await (const entry of pagedIterate(undefined, fetchFrom(store, 1), 1)) {
			actual.push([[...entry.key], [...entry.value]]);
			entry.key[0] = 0x99;
			entry.key[1] = 0x99;
		}
		assert.deepStrictEqual(actual, expected);
	});

	it('stops fetching once the limit is met', async () => {
		let calls = 0;
		const fetch = fetchFrom(store, 4);
		const counting: FetchBatch = (bounds, want) => {
			calls++;
			return fetch(bounds, want);
		};
		const got = await collect(pagedIterate({ limit: 6 }, counting, 4));
		assert.strictEqual(got.length, 6);
		assert.strictEqual(calls, 2, 'a 6-entry limit over batch size 4 needs exactly two reads');
	});

	it('rejects a non-positive or non-integer batch size', async () => {
		const fetch = fetchFrom(store, 1);
		await assert.rejects(() => collect(pagedIterate(undefined, fetch, 0)), /positive integer/);
		await assert.rejects(() => collect(pagedIterate(undefined, fetch, -1)), /positive integer/);
		await assert.rejects(() => collect(pagedIterate(undefined, fetch, 1.5)), /positive integer/);
	});

	it('rejects a fetchBatch that over-returns rather than mis-counting the limit', async () => {
		const overRunning: FetchBatch = async (bounds, want) => {
			const out: KVEntry[] = [];
			for await (const entry of store.iterate({ ...bounds, limit: want + 1 })) out.push(entry);
			return out;
		};
		await assert.rejects(() => collect(pagedIterate(undefined, overRunning, 4)), /returned 5 entries for want=4/);
	});
});
