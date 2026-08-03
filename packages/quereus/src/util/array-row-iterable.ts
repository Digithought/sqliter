import type { Row } from '../common/types.js';

/**
 * A reusable async iterable over an in-memory array of rows, iterable multiple times.
 * Used for runtime-generated row sets that are already fully materialized — e.g. the
 * working table of a recursive CTE iteration, or a statement's own eagerly-computed
 * report rows (`ANALYZE`).
 *
 * Note: This class intentionally does NOT manage row context. The consumer
 * (e.g. InternalRecursiveCTERef) is responsible for installing the appropriate
 * row context via its own createRowSlot. Doing it here would conflict with the
 * shared rowDescriptor used by the recursive CTE emitter's withRowContext calls.
 */
export class ArrayRowIterable implements AsyncIterable<Row> {
	constructor(private rows: Row[]) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Row> {
		for (const row of this.rows) {
			yield row;
		}
	}
}
