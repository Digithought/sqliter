/**
 * Negative control for the batch point-read guard.
 *
 * `runKVStoreConformance`'s tier 8 asserts that `getMany` answers POSITIONALLY: one value
 * per key, in argument order, `undefined` left at an absent key's own index, and a
 * repeated key answered in independent buffers. Every backend passed it on the first run,
 * which is exactly when a vacuous assertion hides — so this spec drives
 * {@link assertBatchPointRead} directly against store doubles built to violate the
 * contract and checks that it REJECTS, plus well-behaved stores that must PASS.
 *
 * Three violations, because they fail different assertions: answering in sorted order
 * (right values, wrong positions), compacting away misses (short result, shifted tail),
 * and aliasing one buffer across a repeated key's positions (right values, shared buffer).
 */

import assert from 'node:assert/strict';
import { CachedKVStore } from '../src/common/cached-kv-store.js';
import { InMemoryKVStore } from '../src/common/memory-store.js';
import { assertBatchPointRead } from '../src/testing/kv-conformance.js';
import {
	AliasingGetManyKVStore,
	CompactingGetManyKVStore,
	DelegatingKVStore,
	SortingGetManyKVStore,
} from './kv-store-doubles.js';

describe('assertBatchPointRead (batch point-read guard)', () => {
	it('rejects a store that answers in sorted order instead of argument order', async () => {
		const sorting = new SortingGetManyKVStore(new InMemoryKVStore());
		await assert.rejects(
			() => assertBatchPointRead(sorting),
			/unsorted key list: position 0/,
		);
	});

	it('rejects a store that drops absent keys instead of leaving a hole', async () => {
		const compacting = new CompactingGetManyKVStore(new InMemoryKVStore());
		await assert.rejects(
			() => assertBatchPointRead(compacting),
			/a miss must not shorten the result/,
		);
	});

	it('rejects a store that files ONE buffer at a repeated key\'s two positions', async () => {
		// The values are all correct here — only the scribble tells them apart.
		const aliasing = new AliasingGetManyKVStore(new InMemoryKVStore());
		await assert.rejects(
			() => assertBatchPointRead(aliasing),
			/the duplicate position must be its own buffer/,
		);
	});

	it('accepts a conforming store, and one behind a pass-through wrapper', async () => {
		await assertBatchPointRead(new InMemoryKVStore());
		await assertBatchPointRead(new DelegatingKVStore(new InMemoryKVStore()));
	});

	it('accepts a cache in front of a conforming store, warm or cold', async () => {
		// The warm/cold interleave is the case `CachedKVStore`'s miss-position bookkeeping
		// has to get right; running it on a fresh cache and again on a warm one covers both.
		const cached = new CachedKVStore(new InMemoryKVStore());
		await assertBatchPointRead(cached);
		await assertBatchPointRead(cached);
	});
});
