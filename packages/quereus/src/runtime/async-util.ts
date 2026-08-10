/**
 * Async stream utilities for processing async iterables
 * Used by CacheNode emitter, NestedLoopJoin inner side, and other streaming operations
 */

import type { MaybePromise, Row } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { getAsyncIterator } from './utils.js';

const log = createLogger('runtime:async-util');

/**
 * Resolve a possibly-pending value and apply `fn`, WITHOUT a microtask hop on
 * the synchronous common case.
 *
 * Scalar sub-programs (a filter predicate, a projected column, a join
 * condition) run through a sub-scheduler that completes synchronously and
 * returns a concrete value whenever no instruction in the sub-program is itself
 * async — which is the overwhelmingly common case. But `await value` still
 * schedules a microtask even when `value` is not a thenable (per spec,
 * `await x` ≡ `await Promise.resolve(x)`), so a per-row/per-column
 * `await subprogram(rctx)` pays that tick N times for nothing. Branching on
 * `instanceof Promise` keeps the hot path fully synchronous and only defers
 * when the value is genuinely pending.
 *
 * The result is itself `MaybePromise<R>`: when the input is concrete, `fn` runs
 * inline and the mapped value is returned directly; only a genuinely pending
 * input chains through `.then`. Callers that need the plain value must still
 * branch at the extraction point (`r instanceof Promise ? await r : r`) — that
 * final `await` then runs only on the rare async path, never on the hot path.
 *
 * NOTE: pure-extraction sites (no mapping — e.g. collecting projected columns
 * into a row array) inline the same `instanceof Promise` branch directly rather
 * than wrapping an identity `fn` here; a value-returning helper cannot host the
 * caller's `await` without reintroducing the very hop this avoids.
 */
export function resolveMaybe<T, R>(value: MaybePromise<T>, fn: (v: T) => R): MaybePromise<R> {
	return value instanceof Promise ? value.then(fn) : fn(value);
}

/**
 * Transform rows using a mapping function
 */
export async function* mapRows<T extends Row, R>(
	src: AsyncIterable<T>,
	fn: (row: T) => R
): AsyncIterable<R> {
	for await (const row of src) {
		yield fn(row);
	}
}

/**
 * Filter rows using a predicate function
 */
export async function* filterRows<T>(
	src: AsyncIterable<T>,
	pred: (row: T) => MaybePromise<boolean>
): AsyncIterable<T> {
	for await (const row of src) {
		const include = await pred(row);
		if (include) {
			yield row;
		}
	}
}

/**
 * Duplicate an async iterable into two independent streams
 * This materializes chunks internally as needed
 */
export function tee<T>(src: AsyncIterable<T>): [AsyncIterable<T>, AsyncIterable<T>] {
	const buffer: T[] = [];
	let srcIterator: AsyncIterator<T> | null = null;
	let srcDone = false;
	let srcClosed = false;
	// Refcount of consumer generators that have actually been entered. Cleanup
	// keys off this (not off the two stream objects existing) so a stream that
	// is never iterated cannot wedge source release: the last entered generator
	// out closes the source.
	let liveConsumers = 0;
	const indices = [0, 0];

	// Release the source exactly once. If it already drained naturally, its
	// finally has run and there is nothing to return(); otherwise run its
	// finally via return() so row slots / vtab connections are freed.
	async function closeSource(): Promise<void> {
		if (srcClosed) {
			return;
		}
		srcClosed = true;
		if (srcDone) {
			return;
		}
		if (srcIterator?.return) {
			await srcIterator.return(undefined);
		}
	}

	async function fillBuffer(targetIndex: number): Promise<void> {
		if (srcDone || buffer.length > targetIndex) {
			return;
		}

		if (!srcIterator) {
			srcIterator = getAsyncIterator(src);
		}

		while (buffer.length <= targetIndex && !srcDone) {
			const result = await srcIterator.next();
			if (result.done) {
				srcDone = true;
				// Full drain: the source finally already ran. Mark closed so a
				// consumer's teardown below does not redundantly call return().
				await closeSource();
			} else {
				buffer.push(result.value);
			}
		}
	}

	function createStream(self: 0 | 1): AsyncIterable<T> {
		return {
			async *[Symbol.asyncIterator]() {
				liveConsumers++;
				try {
					while (true) {
						await fillBuffer(indices[self]);

						if (indices[self] >= buffer.length) {
							if (srcDone) break;
							continue;
						}

						yield buffer[indices[self]];
						indices[self]++;

						// Clean up buffer when both consumers have passed this point.
						// NOTE: trim keys off the slower consumer; if one consumer
						// is never iterated (its index stays 0) while the other
						// drains a large source, the buffer grows unbounded. Fine
						// for the intended both-sides-consumed use; revisit if a
						// caller tees then abandons one side over a big stream.
						const minIndex = Math.min(indices[0], indices[1]);
						if (minIndex > 100) { // Keep some buffer for efficiency
							buffer.splice(0, minIndex - 100);
							indices[0] -= (minIndex - 100);
							indices[1] -= (minIndex - 100);
						}
					}
				} finally {
					// Runs on normal completion, early break, or throw. Last
					// consumer out releases the source.
					liveConsumers--;
					if (liveConsumers === 0) {
						await closeSource();
					}
				}
			}
		};
	}

	return [createStream(0), createStream(1)];
}

/**
 * Add buffering to an async iterable with back-pressure
 */
export async function* buffered<T>(
	src: AsyncIterable<T>,
	maxBuffer: number
): AsyncIterable<T> {
	const buffer: T[] = [];
	const srcIterator = getAsyncIterator(src);
	let srcDone = false;
	let fillPromise: Promise<void> | null = null;

	// Fill buffer in background
	async function fillBuffer(): Promise<void> {
		while (buffer.length < maxBuffer && !srcDone) {
			const result = await srcIterator.next();
			if (result.done) {
				srcDone = true;
			} else {
				buffer.push(result.value);
			}
		}
	}

	// Start initial fill
	fillPromise = fillBuffer();

	try {
		while (true) {
			// Wait for buffer to have items or source to be done
			await fillPromise;

			if (buffer.length === 0 && srcDone) {
				break;
			}

			if (buffer.length > 0) {
				const item = buffer.shift()!;
				yield item;

				// Start refilling buffer if below threshold
				if (buffer.length < maxBuffer / 2 && !srcDone) {
					fillPromise = fillBuffer();
				}
			}
		}
	} finally {
		// Clean up source iterator if consumer breaks early
		if (!srcDone && srcIterator.return) {
			await srcIterator.return(undefined);
		}
	}
}

/**
 * Take only the first N items from an async iterable
 */
export async function* take<T>(src: AsyncIterable<T>, count: number): AsyncIterable<T> {
	let taken = 0;
	for await (const item of src) {
		if (taken >= count) break;
		yield item;
		taken++;
	}
}

/**
 * Skip the first N items from an async iterable
 */
export async function* skip<T>(src: AsyncIterable<T>, count: number): AsyncIterable<T> {
	let skipped = 0;
	for await (const item of src) {
		if (skipped < count) {
			skipped++;
			continue;
		}
		yield item;
	}
}

/**
 * Count the number of items in an async iterable (consumes the iterable)
 */
export async function count<T>(src: AsyncIterable<T>): Promise<number> {
	let total = 0;
	for await (const _ of src) {
		total++;
	}
	return total;
}

/**
 * Collect all items from an async iterable into an array
 * Use with caution on large iterables
 */
export async function collect<T>(src: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of src) {
		result.push(item);
	}
	return result;
}

/**
 * Merge multiple async iterables into a single stream
 * Items are yielded as soon as they become available from any source
 */
export async function* merge<T>(...sources: AsyncIterable<T>[]): AsyncIterable<T> {
	const iterators = sources.map(src => getAsyncIterator(src));
	// Each pending promise is tagged with its source index ONCE, at creation, so
	// Promise.race over pending.values() can identify the winner without
	// re-wrapping every other pending promise on each loop iteration (which was
	// O(sources) wrapper allocations per emitted row and grew handler chains on
	// slow sources).
	const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>();
	// Indices of sources not yet fully drained. `pending` tracks in-flight reads
	// for the race; `live` tracks what still needs closing. They diverge exactly
	// when the consumer breaks right after we yield a value: that source is out
	// of `pending` (deleted, not yet re-pulled) but its generator is suspended at
	// a yield and MUST still be released.
	const live = new Set<number>();

	const pull = (index: number): void => {
		pending.set(index, iterators[index].next().then(result => ({ index, result })));
	};

	// Start initial reads
	for (let i = 0; i < iterators.length; i++) {
		live.add(i);
		pull(i);
	}

	try {
		while (pending.size > 0) {
			// Wait for the first source to produce a result. Only the settled
			// source is re-pulled; the others keep their existing tagged promise.
			const { index, result } = await Promise.race(pending.values());
			pending.delete(index);

			if (result.done) {
				live.delete(index);
			} else {
				yield result.value;
				pull(index);
			}
		}
	} finally {
		// Close every still-live source. Covers all non-drain exits: consumer
		// early break (generator return() unwinds through here) and a source
		// next() throwing (error propagates through here, leaving siblings live).
		// Fully-drained sources have already been removed from `live`.
		await Promise.all(Array.from(live).map(async index => {
			const iterator = iterators[index];
			if (iterator.return) {
				try {
					await iterator.return(undefined);
				} catch (e) {
					// Swallow-but-log per AGENTS.md: one failing close must not
					// mask the others or the original error.
					log('merge: error closing source %d: %s', index, e);
				}
			}
		}));
	}
}

/**
 * Convert an array to an async iterable
 */
export async function* fromArray<T>(items: readonly T[]): AsyncIterable<T> {
	for (const item of items) {
		yield item;
	}
}

/**
 * Add logging to an async iterable for debugging
 */
export async function* traced<T>(
	src: AsyncIterable<T>,
	name: string,
	itemLogger?: (item: T, index: number) => string
): AsyncIterable<T> {
	log('Starting trace for %s', name);
	let index = 0;

	try {
		for await (const item of src) {
			if (itemLogger) {
				log('%s[%d]: %s', name, index, itemLogger(item, index));
			} else {
				log('%s[%d]: %O', name, index, item);
			}
			yield item;
			index++;
		}
		log('Completed trace for %s (%d items)', name, index);
	} catch (error) {
		log('Error in trace for %s after %d items: %s', name, index, error);
		throw error;
	}
}
