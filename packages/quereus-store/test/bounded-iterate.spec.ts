/**
 * Negative control for the bounded-iteration guard.
 *
 * `runKVStoreConformance`'s tier 7 asserts that a backend reads a bounded amount from
 * backing storage no matter how big the range is. A guard nobody has watched fail is
 * not a guard — so this spec drives {@link assertBoundedIterate} directly against store
 * doubles built to violate the contract and checks that it REJECTS, plus a well-behaved
 * double that must PASS. Two violations, because they fail different assertions:
 * draining the whole range before yielding (caught by prefix-and-stop) and `limit`/
 * `offset` re-paging (bounded first batch, quadratic total — caught only by a drain).
 */

import assert from 'node:assert/strict';
import { InMemoryKVStore } from '../src/common/memory-store.js';
import { assertBoundedIterate, type ReadMeter } from '../src/testing/kv-conformance.js';
import { BufferingKVStore, CountingKVStore, RescanningKVStore } from './kv-store-doubles.js';

const COUNT = 512;

/** 2-byte big-endian key — byte order matches numeric order. */
const enc = (n: number): Uint8Array => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);

async function seeded(): Promise<InMemoryKVStore> {
	const store = new InMemoryKVStore();
	const batch = store.batch();
	for (let i = 0; i < COUNT; i++) batch.put(enc(i), new Uint8Array([i & 0xff]));
	await batch.write();
	return store;
}

/** A meter over `counter`, declaring the one-entry-per-yield read-ahead it actually has. */
function meterOf(counter: CountingKVStore): ReadMeter {
	return { entriesRead: () => counter.entriesRead(), maxReadAhead: 1 };
}

describe('assertBoundedIterate (bounded-iteration guard)', () => {
	it('rejects a store that drains the whole range before yielding', async () => {
		const counter = new CountingKVStore(await seeded());
		const buffering = new BufferingKVStore(counter);
		await assert.rejects(
			() => assertBoundedIterate(buffering, meterOf(counter)),
			/bounded iteration: consuming 1 entry read 512 from backing storage/,
		);
	});

	it('rejects a buffering store in reverse too', async () => {
		const counter = new CountingKVStore(await seeded());
		const buffering = new BufferingKVStore(counter);
		await assert.rejects(
			() => assertBoundedIterate(buffering, meterOf(counter), { reverse: true }),
			/bounded iteration/,
		);
	});

	it('rejects a buffering store even when the consumer asked for a small limit', async () => {
		// The double honors `limit` only AFTER draining, which is exactly the bug:
		// `limit: 5` over 512 entries must not read 512.
		const counter = new CountingKVStore(await seeded());
		const buffering = new BufferingKVStore(counter);
		await assert.rejects(
			() => assertBoundedIterate(buffering, meterOf(counter), { limit: 5 }, 5),
			/bounded iteration/,
		);
	});

	it('accepts a store that yields lazily', async () => {
		const counter = new CountingKVStore(await seeded());
		await assertBoundedIterate(counter, meterOf(counter));
		await assertBoundedIterate(counter, meterOf(counter), { reverse: true });
		await assertBoundedIterate(counter, meterOf(counter), { limit: 5 }, 5);
		await assertBoundedIterate(counter, meterOf(counter), undefined, COUNT);
	});

	describe('offset-style re-paging (bounded first batch, quadratic total)', () => {
		const BATCH = 64;
		/** A meter over `counter` declaring the re-pager's batch as its read-ahead. */
		const pagedMeter = (counter: CountingKVStore): ReadMeter =>
			({ entriesRead: () => counter.entriesRead(), maxReadAhead: BATCH });

		it('slips past every prefix-and-stop assertion', async () => {
			// Documents WHY the full-drain case exists: stopping early cannot see this bug.
			const counter = new CountingKVStore(await seeded());
			const rescanning = new RescanningKVStore(counter, BATCH);
			await assertBoundedIterate(rescanning, pagedMeter(counter));
			await assertBoundedIterate(rescanning, pagedMeter(counter), { limit: 5 }, 5);
		});

		it('is caught by draining the whole range', async () => {
			const counter = new CountingKVStore(await seeded());
			const rescanning = new RescanningKVStore(counter, BATCH);
			await assert.rejects(
				() => assertBoundedIterate(rescanning, pagedMeter(counter), undefined, COUNT),
				/bounded iteration: consuming 512 entries read 2304 from backing storage/,
			);
		});
	});

	it('rejects a dead meter rather than reporting a bounded read', async () => {
		// An adapter that wires its meter to the wrong object reports 0 forever, which
		// would make every metered case pass no matter what the backend does.
		const counter = new CountingKVStore(await seeded());
		const dead: ReadMeter = { entriesRead: () => 0, maxReadAhead: 1 };
		await assert.rejects(
			() => assertBoundedIterate(counter, dead),
			/read meter counted nothing/,
		);
	});

	it('rejects rather than passing vacuously when the range is too small to measure', async () => {
		const counter = new CountingKVStore(new InMemoryKVStore());
		await assert.rejects(
			() => assertBoundedIterate(counter, meterOf(counter)),
			/range is too small to measure/,
		);
	});
});
