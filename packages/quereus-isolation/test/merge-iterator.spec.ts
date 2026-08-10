import { describe, it } from 'mocha';
import { expect } from 'chai';
import { mergeStreams, createMergeEntry, createTombstone } from '../src/index.js';
import type { MergeEntry, MergeConfig } from '../src/index.js';
import type { Row } from '@quereus/quereus';

// Helper to collect async iterable to array
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of iter) {
		result.push(item);
	}
	return result;
}

// Helper to create async iterable from array
async function* fromArray<T>(arr: T[]): AsyncGenerator<T> {
	for (const item of arr) {
		yield item;
	}
}

// Simple integer PK config
const intPKConfig: MergeConfig = {
	comparePK: (a, b) => (a[0] as number) - (b[0] as number),
	extractPK: (row) => [row[0]],
};

describe('MergeIterator', () => {
	describe('basic merging', () => {
		it('merges two empty streams', async () => {
			const result = await collect(mergeStreams(
				fromArray([]),
				fromArray([]),
				intPKConfig
			));
			expect(result).to.deep.equal([]);
		});

		it('passes through underlying when overlay empty', async () => {
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];
			const result = await collect(mergeStreams(
				fromArray([]),
				fromArray(underlying),
				intPKConfig
			));
			expect(result).to.deep.equal(underlying);
		});

		it('passes through overlay inserts when underlying empty', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([1, 'x'], [1]),
				createMergeEntry([2, 'y'], [2]),
			];
			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray([]),
				intPKConfig
			));
			expect(result).to.deep.equal([[1, 'x'], [2, 'y']]);
		});
	});

	describe('overlay precedence', () => {
		it('overlay update replaces underlying row', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([2, 'UPDATED'], [2]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'a'],
				[2, 'UPDATED'],
				[3, 'c'],
			]);
		});

		it('tombstone removes underlying row', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([2]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'a'],
				[3, 'c'],
			]);
		});

		it('overlay insert interleaves correctly', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([2, 'NEW'], [2]),
			];
			const underlying: Row[] = [[1, 'a'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'a'],
				[2, 'NEW'],
				[3, 'c'],
			]);
		});
	});

	describe('complex scenarios', () => {
		it('handles multiple operations', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([1, 'UPDATED'], [1]),  // Update first
				createTombstone([3]),                    // Delete middle
				createMergeEntry([5, 'NEW'], [5]),      // Insert at end
			];
			const underlying: Row[] = [
				[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']
			];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'UPDATED'],
				[2, 'b'],
				[4, 'd'],
				[5, 'NEW'],
			]);
		});

		it('handles composite primary keys', async () => {
			const compositePKConfig: MergeConfig = {
				comparePK: (a, b) => {
					const cmp1 = (a[0] as number) - (b[0] as number);
					if (cmp1 !== 0) return cmp1;
					return (a[1] as string).localeCompare(b[1] as string);
				},
				extractPK: (row) => [row[0], row[1]],
			};

			const overlay: MergeEntry[] = [
				createMergeEntry([1, 'b', 'UPDATED'], [1, 'b']),
			];
			const underlying: Row[] = [
				[1, 'a', 'x'],
				[1, 'b', 'y'],
				[1, 'c', 'z'],
			];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				compositePKConfig
			));

			expect(result).to.deep.equal([
				[1, 'a', 'x'],
				[1, 'b', 'UPDATED'],
				[1, 'c', 'z'],
			]);
		});

		it('handles all underlying rows being updated', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([1, 'X'], [1]),
				createMergeEntry([2, 'Y'], [2]),
				createMergeEntry([3, 'Z'], [3]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'X'],
				[2, 'Y'],
				[3, 'Z'],
			]);
		});

		it('handles interleaved inserts and updates', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([1, 'UPDATED'], [1]),   // Update
				createMergeEntry([2, 'INSERT'], [2]),    // Insert (no underlying)
				createMergeEntry([4, 'INSERT2'], [4]),   // Insert (no underlying)
			];
			const underlying: Row[] = [[1, 'a'], [3, 'c'], [5, 'e']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'UPDATED'],
				[2, 'INSERT'],
				[3, 'c'],
				[4, 'INSERT2'],
				[5, 'e'],
			]);
		});
	});

	describe('ordering invariants', () => {
		it('output is sorted when inputs are sorted', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([2, 'x'], [2]),
				createMergeEntry([4, 'y'], [4]),
				createMergeEntry([6, 'z'], [6]),
			];
			const underlying: Row[] = [[1, 'a'], [3, 'b'], [5, 'c'], [7, 'd']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			// Verify sorted order
			for (let i = 1; i < result.length; i++) {
				expect(result[i][0]).to.be.greaterThan(result[i - 1][0] as number);
			}
		});

		it('maintains order with dense overlay', async () => {
			const overlay: MergeEntry[] = [
				createMergeEntry([1, 'a1'], [1]),
				createMergeEntry([2, 'a2'], [2]),
				createMergeEntry([3, 'a3'], [3]),
				createMergeEntry([4, 'a4'], [4]),
				createMergeEntry([5, 'a5'], [5]),
			];
			const underlying: Row[] = [[2, 'b'], [4, 'd']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([
				[1, 'a1'],
				[2, 'a2'],
				[3, 'a3'],
				[4, 'a4'],
				[5, 'a5'],
			]);

			// Verify sorted
			for (let i = 1; i < result.length; i++) {
				expect(result[i][0]).to.be.greaterThan(result[i - 1][0] as number);
			}
		});
	});

	describe('tombstone edge cases', () => {
		it('tombstone for non-existent row is no-op', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([99]),  // Row doesn't exist in underlying
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([[1, 'a'], [2, 'b']]);
		});

		it('all rows tombstoned produces empty result', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([1]),
				createTombstone([2]),
				createTombstone([3]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([]);
		});

		it('tombstone at beginning', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([1]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([[2, 'b'], [3, 'c']]);
		});

		it('tombstone at end', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([3]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([[1, 'a'], [2, 'b']]);
		});

		it('multiple non-existent tombstones', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([0]),
				createTombstone([5]),
				createTombstone([10]),
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c']]);
		});

		it('mixed tombstones - some exist, some do not', async () => {
			const overlay: MergeEntry[] = [
				createTombstone([0]),   // doesn't exist
				createTombstone([2]),   // exists
				createTombstone([10]),  // doesn't exist
			];
			const underlying: Row[] = [[1, 'a'], [2, 'b'], [3, 'c']];

			const result = await collect(mergeStreams(
				fromArray(overlay),
				fromArray(underlying),
				intPKConfig
			));

			expect(result).to.deep.equal([[1, 'a'], [3, 'c']]);
		});
	});

	describe('iterator cleanup', () => {
		it('calls return on iterators when consumer stops early', async () => {
			let overlayClosed = false;
			let underlyingClosed = false;

			const overlay: AsyncIterable<MergeEntry> = {
				[Symbol.asyncIterator]: () => ({
					next: async () => ({ done: false, value: createMergeEntry([1, 'a'], [1]) }),
					return: async () => {
						overlayClosed = true;
						return { done: true, value: undefined };
					}
				})
			};

			const underlying: AsyncIterable<Row> = {
				[Symbol.asyncIterator]: () => ({
					next: async () => ({ done: false, value: [2, 'b'] as Row }),
					return: async () => {
						underlyingClosed = true;
						return { done: true, value: undefined };
					}
				})
			};

			const merged = mergeStreams(overlay, underlying, intPKConfig);
			const iter = merged[Symbol.asyncIterator]();

			// Get first item
			await iter.next();

			// Return early
			await iter.return?.(undefined);

			expect(overlayClosed).to.be.true;
			expect(underlyingClosed).to.be.true;
		});
	});

	describe('helper functions', () => {
		it('createMergeEntry creates correct structure', () => {
			const entry = createMergeEntry([1, 'test'], [1]);
			expect(entry).to.deep.equal({
				row: [1, 'test'],
				pk: [1],
				tombstone: false,
				sortKey: [1]  // Defaults to pk when not specified
			});
		});

		it('createMergeEntry accepts custom sortKey', () => {
			const entry = createMergeEntry([1, 'test'], [1], ['test', 1]);
			expect(entry).to.deep.equal({
				row: [1, 'test'],
				pk: [1],
				tombstone: false,
				sortKey: ['test', 1]  // Custom sort key for secondary index scans
			});
		});

		it('createTombstone creates correct structure', () => {
			const entry = createTombstone([42]);
			expect(entry).to.deep.equal({
				row: [42],
				pk: [42],
				tombstone: true,
				sortKey: [42]  // Defaults to pk when not specified
			});
		});

		it('createTombstone accepts custom sortKey', () => {
			const entry = createTombstone([42], ['deleted_key', 42]);
			expect(entry).to.deep.equal({
				row: [42],
				pk: [42],
				tombstone: true,
				sortKey: ['deleted_key', 42]  // Custom sort key for secondary index scans
			});
		});
	});

	describe('iteration laziness (incremental, not full-materialization)', () => {
		// A counting async source: yields arr in order while recording how many times
		// its iterator was pulled. mergeStreams is expected to pull ONE element ahead of
		// what the consumer has taken — never to drain the whole source up front. A
		// regression to full-materialization (e.g. buffering the underlying into an array
		// before merging) would make `pulls` jump to arr.length after a single consume,
		// which is exactly the range-scan drift this guards against.
		function countingSource<T>(arr: readonly T[]): { iterable: AsyncIterable<T>; pulls: () => number } {
			let pulls = 0;
			const iterable: AsyncIterable<T> = {
				[Symbol.asyncIterator](): AsyncIterator<T> {
					let i = 0;
					return {
						next: async (): Promise<IteratorResult<T>> => {
							pulls++;
							if (i < arr.length) return { done: false, value: arr[i++] };
							return { done: true, value: undefined };
						},
					};
				},
			};
			return { iterable, pulls: () => pulls };
		}

		it('consuming one element from a large underlying pass-through pulls one row ahead, not the whole stream', async () => {
			const underlyingRows: Row[] = Array.from({ length: 100 }, (_, i) => [i, `r${i}`] as Row);
			const underlying = countingSource(underlyingRows);

			const merged = mergeStreams(fromArray<MergeEntry>([]), underlying.iterable, intPKConfig);
			const iter = merged[Symbol.asyncIterator]();

			const first = await iter.next();
			expect(first.done).to.be.false;
			expect(first.value).to.deep.equal([0, 'r0']);

			// The merge primes both heads once up front; consuming the first element must NOT
			// have pulled all 100 underlying rows. A materializing rewrite would read 100 here.
			expect(underlying.pulls()).to.be.at.most(2);

			await iter.return?.(undefined);
		});

		it('a bounded take pulls proportional to what was consumed across the overlay seam', async () => {
			// Underlying [0..99]; overlay stages an insert (id=50→'x') that must interleave in
			// order. Take only the first 3 merged rows and assert we did not run past the seam.
			const underlyingRows: Row[] = Array.from({ length: 100 }, (_, i) => [i, `r${i}`] as Row);
			const underlying = countingSource(underlyingRows);
			const overlay = countingSource<MergeEntry>([createMergeEntry([50, 'x'], [50])]);

			const merged = mergeStreams(overlay.iterable, underlying.iterable, intPKConfig);
			const iter = merged[Symbol.asyncIterator]();

			const taken: Row[] = [];
			for (let n = 0; n < 3; n++) {
				const step = await iter.next();
				expect(step.done).to.be.false;
				taken.push(step.value);
			}
			expect(taken).to.deep.equal([[0, 'r0'], [1, 'r1'], [2, 'r2']]);

			// Three rows consumed near the front of the base ⇒ only a few underlying rows pulled,
			// nowhere near the staged insert at id=50 and nowhere near draining all 100.
			expect(underlying.pulls()).to.be.at.most(4);

			await iter.return?.(undefined);
		});
	});
});
