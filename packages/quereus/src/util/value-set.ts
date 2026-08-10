import { BTree } from 'inheritree';
import type { SqlValue } from '../common/types.js';

/**
 * BTree used as a set whose entry IS the value: IN membership, DISTINCT
 * aggregates, primary-key membership in the backing 'replace-all' diff.
 *
 * Any BTree whose entry is a bare `SqlValue` (as opposed to a `Row` or a wrapper
 * object, where freezing is shallow and harmless) must be built here.
 *
 * `freeze: false` is required, not an optimization: inheritree freezes each
 * stored entry by default, and `Object.freeze` throws on a non-empty
 * `Uint8Array` — so a BLOB value could not be stored at all. Freezing would
 * also be wrong here regardless: the entry is a reference to a value owned by
 * the source row, not a copy.
 *
 * NOTE: consequently the set holds references to caller-owned BLOB buffers. If
 * a vtab ever recycles a `Uint8Array` across rows instead of handing out a
 * fresh one, membership/DISTINCT answers would silently change under it.
 */
export function createValueSet<T extends SqlValue | SqlValue[]>(
	compare: (a: T, b: T) => number,
): BTree<T, T> {
	return new BTree<T, T>(v => v, compare, { freeze: false });
}
