import { expect } from 'chai';
import type { Row } from '../../src/common/types.js';
import {
	createCacheState,
	streamWithCache,
	clearCache,
	getCacheMetrics,
	withSharedCache,
	createCacheFunction,
	type SharedCacheConfig,
} from '../../src/runtime/cache/shared-cache.js';

/** Helper: collect all rows from an async iterable */
async function collect(iter: AsyncIterable<Row>): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of iter) {
		rows.push(row);
	}
	return rows;
}

/** Helper: create an async iterable from an array of rows */
async function* fromRows(rows: Row[]): AsyncIterable<Row> {
	for (const row of rows) {
		yield row;
	}
}

/** Helper: async generator that throws after N rows */
async function* throwingSource(rows: Row[], throwAfter: number): AsyncIterable<Row> {
	let i = 0;
	for (const row of rows) {
		if (i >= throwAfter) {
			throw new Error('source error');
		}
		yield row;
		i++;
	}
}

const defaultConfig: SharedCacheConfig = { threshold: 100, strategy: 'memory', name: 'test' };

describe('Runtime Shared Cache', () => {
	describe('streamWithCache() core behavior', () => {
		it('first consumer populates cache', async () => {
			const sourceRows: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];
			const state = createCacheState();

			const result = await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));

			expect(result).to.deep.equal(sourceRows);
			expect(state.cachedResult).to.be.an('array').with.lengthOf(3);
		});

		it('cache hit returns identical data', async () => {
			const sourceRows: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];
			const state = createCacheState();

			const first = await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));
			// Second consumer should read from cache, not from source
			const second = await collect(streamWithCache(fromRows([]), defaultConfig, state));

			expect(second).to.deep.equal(first);
		});

		it('row deep-copy correctness — mutating yielded row does not affect cache (build pass)', async () => {
			const sourceRows: Row[] = [[1, 'original']];
			const state = createCacheState();

			// First pass: populate cache
			const rows = await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));
			// Mutate the yielded row
			rows[0][1] = 'mutated';

			// The cached copy should be unaffected (it was spread-copied)
			expect(state.cachedResult![0][1]).to.equal('original');
		});

		it('row deep-copy correctness — mutating yielded row does not affect cache (cache-hit pass)', async () => {
			const sourceRows: Row[] = [[1, 'original']];
			const state = createCacheState();

			// Build pass
			await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));

			// Cache-hit pass: mutate yielded row
			const cached = await collect(streamWithCache(fromRows([]), defaultConfig, state));
			cached[0][1] = 'mutated';

			// The cache should be unaffected
			expect(state.cachedResult![0][1]).to.equal('original');

			// Next cache-hit consumer should also get the original
			const cached2 = await collect(streamWithCache(fromRows([]), defaultConfig, state));
			expect(cached2[0][1]).to.equal('original');
		});

		it('threshold exceeded — cache abandoned', async () => {
			const config: SharedCacheConfig = { threshold: 2, strategy: 'memory', name: 'test' };
			const sourceRows: Row[] = [[1], [2], [3]];
			const state = createCacheState();

			const result = await collect(streamWithCache(fromRows(sourceRows), config, state));

			expect(result).to.deep.equal(sourceRows);
			expect(state.cacheAbandoned).to.be.true;
			expect(state.cachedResult).to.be.undefined;
		});

		it('threshold boundary — exactly threshold rows keeps cache', async () => {
			const config: SharedCacheConfig = { threshold: 3, strategy: 'memory', name: 'test' };
			const sourceRows: Row[] = [[1], [2], [3]];
			const state = createCacheState();

			await collect(streamWithCache(fromRows(sourceRows), config, state));

			expect(state.cacheAbandoned).to.be.false;
			expect(state.cachedResult).to.deep.equal(sourceRows);
		});

		it('zero rows — cache populated as empty array', async () => {
			const state = createCacheState();

			await collect(streamWithCache(fromRows([]), defaultConfig, state));

			expect(state.cachedResult).to.deep.equal([]);
			expect(state.cacheAbandoned).to.be.false;
		});

		it('single row — cache populated correctly', async () => {
			const sourceRows: Row[] = [[42, 'only']];
			const state = createCacheState();

			const result = await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));

			expect(result).to.deep.equal(sourceRows);
			expect(state.cachedResult).to.deep.equal(sourceRows);
		});
	});

	describe('cache state management', () => {
		it('clearCache resets state and next consumer re-streams', async () => {
			const state = createCacheState();
			const sourceRows: Row[] = [[1], [2]];

			await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));
			expect(state.cachedResult).to.have.lengthOf(2);

			clearCache(state);
			expect(state.cachedResult).to.be.undefined;
			expect(state.cacheAbandoned).to.be.false;
			expect(state.consumeCount).to.equal(0);

			// After clear, next consumer should rebuild the cache from source
			const newSource: Row[] = [[10], [20]];
			const result = await collect(streamWithCache(fromRows(newSource), defaultConfig, state));
			expect(result).to.deep.equal(newSource);
			expect(state.cachedResult).to.deep.equal(newSource);
		});

		it('consumeCount increments on each cached consumption', async () => {
			const state = createCacheState();
			await collect(streamWithCache(fromRows([[1]]), defaultConfig, state));

			// First consume doesn't increment (it's the build pass)
			expect(state.consumeCount).to.equal(0);

			// Subsequent consumes from cache increment
			await collect(streamWithCache(fromRows([]), defaultConfig, state));
			expect(state.consumeCount).to.equal(1);

			await collect(streamWithCache(fromRows([]), defaultConfig, state));
			expect(state.consumeCount).to.equal(2);

			await collect(streamWithCache(fromRows([]), defaultConfig, state));
			expect(state.consumeCount).to.equal(3);
		});

		it('multiple sequential consumers all get identical cached results', async () => {
			const sourceRows: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];
			const state = createCacheState();

			const first = await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));

			for (let i = 0; i < 5; i++) {
				const cached = await collect(streamWithCache(fromRows([]), defaultConfig, state));
				expect(cached).to.deep.equal(first);
			}
		});

		it('partial consumption — break mid-stream — cache still consistent for next consumer', async () => {
			const sourceRows: Row[] = [[1], [2], [3], [4], [5]];
			const state = createCacheState();

			// First consumer reads all rows, populating cache
			await collect(streamWithCache(fromRows(sourceRows), defaultConfig, state));

			// Second consumer partially consumes from cache
			let partialCount = 0;
			for await (const _row of streamWithCache(fromRows([]), defaultConfig, state)) {
				partialCount++;
				if (partialCount === 2) break;
			}
			expect(partialCount).to.equal(2);

			// Third consumer should still get full cached data
			const full = await collect(streamWithCache(fromRows([]), defaultConfig, state));
			expect(full).to.deep.equal(sourceRows);
		});
	});

	describe('cache abandoned path', () => {
		it('after threshold exceeded, subsequent consumers stream directly from source', async () => {
			const config: SharedCacheConfig = { threshold: 2, strategy: 'memory', name: 'test' };
			const state = createCacheState();

			// First consumer exceeds threshold
			await collect(streamWithCache(fromRows([[1], [2], [3]]), config, state));
			expect(state.cacheAbandoned).to.be.true;

			// Second consumer should stream directly (no caching)
			const newSource: Row[] = [[10], [20]];
			const result = await collect(streamWithCache(fromRows(newSource), config, state));
			expect(result).to.deep.equal(newSource);
			expect(state.cachedResult).to.be.undefined;
		});
	});

	describe('edge cases', () => {
		it('source throws mid-stream — cache not committed, next consumer gets clean error', async () => {
			const config: SharedCacheConfig = { threshold: 10, strategy: 'memory', name: 'test' };
			const state = createCacheState();
			const rows: Row[] = [[1], [2], [3], [4]];

			// First consumer: source throws after 2 rows
			try {
				await collect(streamWithCache(throwingSource(rows, 2), config, state));
				expect.fail('should have thrown');
			} catch (err: unknown) {
				expect((err as Error).message).to.equal('source error');
			}

			// Cache should not have been committed (iteration didn't finish)
			expect(state.cachedResult).to.be.undefined;
			// cacheAbandoned should still be false — it wasn't a threshold issue
			expect(state.cacheAbandoned).to.be.false;

			// Next consumer with a working source should be able to build cache fresh
			const goodSource: Row[] = [[10], [20]];
			const result = await collect(streamWithCache(fromRows(goodSource), config, state));
			expect(result).to.deep.equal(goodSource);
			expect(state.cachedResult).to.deep.equal(goodSource);
		});

		it('large rows — spread copy works correctly', async () => {
			const largeRow: Row = Array.from({ length: 100 }, (_, i) => `col${i}`);
			const state = createCacheState();

			await collect(streamWithCache(fromRows([largeRow]), defaultConfig, state));

			expect(state.cachedResult).to.have.lengthOf(1);
			expect(state.cachedResult![0]).to.deep.equal(largeRow);
			// Verify it's a separate copy
			expect(state.cachedResult![0]).to.not.equal(largeRow);
		});

		it('rows with diverse SqlValue types', async () => {
			const diverseRow: Row = [
				'text',
				42,
				BigInt(999),
				true,
				null,
				new Uint8Array([1, 2, 3]),
			];
			const state = createCacheState();

			const result = await collect(streamWithCache(fromRows([diverseRow]), defaultConfig, state));

			expect(result).to.have.lengthOf(1);
			expect(result[0]).to.deep.equal(diverseRow);
			// Cached copy exists
			expect(state.cachedResult![0]).to.deep.equal(diverseRow);
		});
	});

	describe('getCacheMetrics()', () => {
		it('reports initial state correctly', () => {
			const state = createCacheState();
			const metrics = getCacheMetrics(state);
			expect(metrics.isCached).to.be.false;
			expect(metrics.isAbandoned).to.be.false;
			expect(metrics.consumeCount).to.equal(0);
			expect(metrics.cachedRows).to.be.undefined;
		});

		it('reports cached state after population', async () => {
			const state = createCacheState();
			await collect(streamWithCache(fromRows([[1], [2]]), defaultConfig, state));

			const metrics = getCacheMetrics(state);
			expect(metrics.isCached).to.be.true;
			expect(metrics.isAbandoned).to.be.false;
			expect(metrics.cachedRows).to.equal(2);
		});

		it('reports abandoned state', async () => {
			const config: SharedCacheConfig = { threshold: 1, strategy: 'memory', name: 'test' };
			const state = createCacheState();
			await collect(streamWithCache(fromRows([[1], [2]]), config, state));

			const metrics = getCacheMetrics(state);
			expect(metrics.isCached).to.be.false;
			expect(metrics.isAbandoned).to.be.true;
		});
	});

	describe('withSharedCache()', () => {
		it('returns iterable and state, iterable populates on first use', async () => {
			const sourceRows: Row[] = [[1, 'a'], [2, 'b']];
			const { iterable, state } = withSharedCache(fromRows(sourceRows), defaultConfig);

			const result = await collect(iterable);
			expect(result).to.deep.equal(sourceRows);
			expect(state.cachedResult).to.deep.equal(sourceRows);
		});
	});

	describe('createCacheFunction()', () => {
		it('returned function caches across calls', async () => {
			const sourceRows: Row[] = [[1], [2], [3]];
			const cachedFn = createCacheFunction(defaultConfig);

			// First call — builds cache
			const first = await collect(cachedFn(fromRows(sourceRows)));
			expect(first).to.deep.equal(sourceRows);

			// Second call — should use internal cache regardless of source
			const second = await collect(cachedFn(fromRows([])));
			expect(second).to.deep.equal(sourceRows);
		});
	});

	describe('eager build mode', () => {
		const eagerConfig: SharedCacheConfig = { threshold: 100, strategy: 'memory', name: 'test-eager', eager: true };

		it('consumer that breaks after the first row still populates the cache', async () => {
			// This is the exact case that fails under the default streaming config:
			// a first-match short-circuit aborts the generator before the drain
			// completes, so cachedResult is never set. Eager mode drains + commits
			// BEFORE yielding, so the early break cannot defeat it.
			const sourceRows: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];
			let pulled = 0;
			async function* countingSource(): AsyncIterable<Row> {
				for (const row of sourceRows) { pulled++; yield row; }
			}
			const state = createCacheState();

			let seen = 0;
			for await (const _row of streamWithCache(countingSource(), eagerConfig, state)) {
				seen++;
				break; // short-circuit like IN's first-match early-exit
			}

			expect(seen).to.equal(1);
			// Despite the early break, the whole source was drained and committed.
			expect(pulled).to.equal(3);
			expect(state.cachedResult).to.deep.equal(sourceRows);
		});

		it('a later consumer replays the full committed buffer', async () => {
			const sourceRows: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];
			const state = createCacheState();

			// Build pass short-circuits, but eager mode still commits.
			for await (const _row of streamWithCache(fromRows(sourceRows), eagerConfig, state)) {
				void _row;
				break;
			}
			expect(state.cachedResult).to.deep.equal(sourceRows);

			// Replay pass: empty source proves the rows come from cache, not the source.
			const replay = await collect(streamWithCache(fromRows([]), eagerConfig, state));
			expect(replay).to.deep.equal(sourceRows);
		});

		it('empty eager source commits an empty buffer', async () => {
			const state = createCacheState();
			const result = await collect(streamWithCache(fromRows([]), eagerConfig, state));
			expect(result).to.deep.equal([]);
			expect(state.cachedResult).to.deep.equal([]);
			expect(state.cacheAbandoned).to.be.false;
		});

		it('over-threshold eager source abandons cache but still delivers all rows', async () => {
			const config: SharedCacheConfig = { threshold: 2, strategy: 'memory', name: 'test-eager', eager: true };
			const sourceRows: Row[] = [[1], [2], [3]];
			const state = createCacheState();

			const result = await collect(streamWithCache(fromRows(sourceRows), config, state));

			expect(result).to.deep.equal(sourceRows);
			expect(state.cacheAbandoned).to.be.true;
			expect(state.cachedResult).to.be.undefined;
		});

		it('deep-copy — mutating a yielded row does not corrupt the eager cache (build pass)', async () => {
			const sourceRows: Row[] = [[1, 'original']];
			const state = createCacheState();

			const rows = await collect(streamWithCache(fromRows(sourceRows), eagerConfig, state));
			rows[0][1] = 'mutated';

			expect(state.cachedResult![0][1]).to.equal('original');
		});

		it('deep-copy — mutating a yielded row does not corrupt the eager cache (replay pass)', async () => {
			const sourceRows: Row[] = [[1, 'original']];
			const state = createCacheState();

			await collect(streamWithCache(fromRows(sourceRows), eagerConfig, state));

			const cached = await collect(streamWithCache(fromRows([]), eagerConfig, state));
			cached[0][1] = 'mutated';

			expect(state.cachedResult![0][1]).to.equal('original');
			// A subsequent replay consumer still gets the original.
			const cached2 = await collect(streamWithCache(fromRows([]), eagerConfig, state));
			expect(cached2[0][1]).to.equal('original');
		});

		it('source throws mid eager-drain — nothing committed, next good source builds cleanly', async () => {
			const config: SharedCacheConfig = { threshold: 10, strategy: 'memory', name: 'test-eager', eager: true };
			const state = createCacheState();
			const rows: Row[] = [[1], [2], [3], [4]];

			try {
				await collect(streamWithCache(throwingSource(rows, 2), config, state));
				expect.fail('should have thrown');
			} catch (err: unknown) {
				expect((err as Error).message).to.equal('source error');
			}

			// Not committed, and not a threshold abandon — next eval must retry fresh.
			expect(state.cachedResult).to.be.undefined;
			expect(state.cacheAbandoned).to.be.false;

			const goodSource: Row[] = [[10], [20]];
			const result = await collect(streamWithCache(fromRows(goodSource), config, state));
			expect(result).to.deep.equal(goodSource);
			expect(state.cachedResult).to.deep.equal(goodSource);
		});
	});
});
