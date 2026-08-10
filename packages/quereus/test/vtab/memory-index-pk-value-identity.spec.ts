import { expect } from 'chai';
import { MemoryIndex } from '../../src/vtab/memory/index.js';
import { createPrimaryKeyFunctions } from '../../src/vtab/memory/utils/primary-key.js';
import { testBuiltinCollationResolver } from '../util/builtin-collation-resolver.js';
import { encodeScalar, encodePrimaryKey } from '../../src/vtab/memory/utils/primary-key-encode.js';
import { createDefaultColumnSchema } from '../../src/schema/column.js';
import { INTEGER_TYPE } from '../../src/types/builtin-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { TableSchema, PrimaryKeyColumnDefinition } from '../../src/schema/table.js';

/**
 * Regression tests for the value-identity (vs JS reference identity) of a
 * MemoryIndex entry's `primaryKeys`. Pre-fix these used a JS `Set`, keyed by
 * SameValueZero/reference identity, which silently broke:
 *   - composite (array) PKs: a fresh equal-by-value array never matched on
 *     removeEntry and stored a duplicate on addEntry; and
 *   - scalar integer PKs across representations (`5n` vs `5`).
 * The container is now a `Map<string, BTreeKeyForPrimary>` keyed by a lossless,
 * type-aware PK encoding (see `utils/primary-key-encode.ts`): membership/dedup is
 * by *value* (O(1) Map set/delete/has) while PK-sorted scan output is reconstructed
 * by sort-on-read. The Map is pure structured-cloneable data, so the secondary-index
 * inheritree's node copy-on-write (which deep-clones stored entries via
 * `structuredClone`) is safe.
 */

/** N INTEGER columns named c0..c(n-1). */
function makeColumns(n: number): ColumnSchema[] {
	return Array.from({ length: n }, (_, i) => ({
		...createDefaultColumnSchema(`c${i}`),
		logicalType: INTEGER_TYPE,
	}));
}

/** Minimal TableSchema sufficient for createPrimaryKeyFunctions. */
function makeSchema(columns: ColumnSchema[], primaryKeyDefinition: PrimaryKeyColumnDefinition[]): TableSchema {
	return {
		name: 'test',
		schemaName: 'main',
		columns,
		columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
		primaryKeyDefinition,
		checkConstraints: [],
		vtabModuleName: 'memory',
		isView: false,
	};
}

/** A single-column secondary index (on column 0) whose entries hold PKs compared/encoded for `pkDefinition`. */
function makeIndex(columns: ColumnSchema[], pkDefinition: PrimaryKeyColumnDefinition[]): MemoryIndex {
	const pk = createPrimaryKeyFunctions(makeSchema(columns, pkDefinition), testBuiltinCollationResolver);
	return new MemoryIndex({ name: 'idx', columns: [{ index: 0 }] }, columns, testBuiltinCollationResolver, pk.compare, pk.encode, 'test');
}

/**
 * A child index whose BTree inherits from `base`'s tree (the same wiring a
 * TransactionLayer uses: `new MemoryIndex(..., parentSecondaryTree)`). Entries
 * reachable only through `base.data` are INHERITED for the child — the child's
 * per-instance `ownedEntries` WeakSet does not contain them — so add/remove must
 * copy-on-write (clone the Map via `new Map(existing)`) rather than mutate the
 * shared entry in place.
 */
function makeChildIndex(columns: ColumnSchema[], pkDefinition: PrimaryKeyColumnDefinition[], base: MemoryIndex): MemoryIndex {
	const pk = createPrimaryKeyFunctions(makeSchema(columns, pkDefinition), testBuiltinCollationResolver);
	return new MemoryIndex({ name: 'idx', columns: [{ index: 0 }] }, columns, testBuiltinCollationResolver, pk.compare, pk.encode, 'test', base.data);
}

describe('MemoryIndex primaryKeys value-identity', () => {
	it('composite-PK removeEntry drops the member by value (count -> 0, entry deleted)', () => {
		const columns = makeColumns(3);
		// Composite PK over columns 1 and 2.
		const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

		index.addEntry(1, [10, 20]);
		expect(index.getPrimaryKeys(1)).to.have.length(1);

		// Fresh array, equal by value to the stored PK — a Set would miss this.
		index.removeEntry(1, [10, 20]);
		expect(index.getPrimaryKeys(1)).to.have.length(0);
		// Emptied entry is removed from the tree, keeping distinct-key stats accurate.
		expect(index.size).to.equal(0);
	});

	it('composite-PK addEntry of an equal-by-value PK does not duplicate (count stays 1)', () => {
		const columns = makeColumns(3);
		const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

		index.addEntry(1, [10, 20]);
		index.addEntry(1, [10, 20]); // fresh equal-by-value array
		expect(index.getPrimaryKeys(1)).to.have.length(1);
	});

	it('composite-PK keeps genuinely distinct PKs under one index key', () => {
		const columns = makeColumns(3);
		const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

		index.addEntry(1, [10, 20]);
		index.addEntry(1, [10, 21]);
		index.addEntry(1, [11, 20]);
		expect(index.getPrimaryKeys(1)).to.have.length(3);

		index.removeEntry(1, [10, 21]); // remove the middle one by value
		const remaining = index.getPrimaryKeys(1) as number[][];
		expect(remaining).to.have.length(2);
		expect(remaining).to.deep.include.members([[10, 20], [11, 20]]);
		expect(remaining).to.not.deep.include([10, 21]);
	});

	it('single-column integer PK removes across 5n / 5 representations', () => {
		const columns = makeColumns(2);
		// Single-column PK over column 1.
		const index = makeIndex(columns, [{ index: 1 }]);

		index.addEntry(1, 5n);
		expect(index.getPrimaryKeys(1)).to.have.length(1);

		// Remove with a number where a bigint was stored — comparator treats 5n === 5.
		index.removeEntry(1, 5);
		expect(index.getPrimaryKeys(1)).to.have.length(0);
		expect(index.size).to.equal(0);
	});

	it('single-column integer PK dedups 5n vs 5 on add', () => {
		const columns = makeColumns(2);
		const index = makeIndex(columns, [{ index: 1 }]);

		index.addEntry(1, 5n);
		index.addEntry(1, 5); // value-equal under the integer comparator
		expect(index.getPrimaryKeys(1)).to.have.length(1);
	});

	// The copy-on-write discipline that keeps a layer's writes from corrupting the
	// committed base it inherits from. The container is now a Map cloned via
	// `new Map(existing)`, so these guard the Map clone path.
	describe('inherited copy-on-write (Map container) isolates the base', () => {
		it('inherited addEntry of a distinct composite PK does not mutate the base entry', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			base.addEntry(1, [10, 20]);

			const child = makeChildIndex(columns, pk, base);
			// Inherited entry (owned by `base`, not `child`): must clone before insert.
			child.addEntry(1, [10, 21]);

			// Child sees both PKs; base is untouched (no write-through to committed state).
			expect(child.getPrimaryKeys(1)).to.have.length(2);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});

		it('inherited removeEntry that empties the entry leaves the base entry intact', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			base.addEntry(1, [10, 20]);

			const child = makeChildIndex(columns, pk, base);
			// Fresh equal-by-value array removes by value through the inherited COW path.
			child.removeEntry(1, [10, 20]);

			// Masked in the child (a rolled-back delete must not strip the live base PK).
			expect(child.getPrimaryKeys(1)).to.have.length(0);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});

		it('inherited addEntry of an already-present PK does not duplicate or mutate the base', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			base.addEntry(1, [10, 20]);

			const child = makeChildIndex(columns, pk, base);
			child.addEntry(1, [10, 20]); // value-equal: COW no-op, still must not dup

			expect(child.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});
	});

	// The corruption class the single-entry COW tests above cannot catch: when an
	// inheritree LEAF holds ≥2 entries and one is copy-on-written, the node clone
	// (structuredClone of the leaf's entries) must preserve the SIBLING entries
	// intact and leave the base's view untouched. A class/BTree container would not
	// survive structuredClone here — this is the regression guard against
	// re-introducing one.
	describe('multi-entry-leaf copy-on-write', () => {
		it('a sibling entry is still served on the child AND base after COW of another entry', () => {
			const columns = makeColumns(3);
			const pk = [{ index: 1 }, { index: 2 }];
			const base = makeIndex(columns, pk);
			// Two distinct index keys → they share one inheritree leaf.
			base.addEntry(1, [10, 20]);
			base.addEntry(2, [30, 40]);

			const child = makeChildIndex(columns, pk, base);
			// COW the entry for index key 1 on the child (inherited → new Map + updateAt).
			child.addEntry(1, [11, 21]);

			// The sibling entry (index key 2) is served correctly through the child...
			expect(child.getPrimaryKeys(2)).to.deep.equal([[30, 40]]);
			// ...and through the base (the leaf clone must not have corrupted it).
			expect(base.getPrimaryKeys(2)).to.deep.equal([[30, 40]]);

			// And the COW'd entry: child sees both PKs, base only the original.
			expect(child.getPrimaryKeys(1)).to.have.length(2);
			expect(base.getPrimaryKeys(1)).to.deep.equal([[10, 20]]);
		});
	});

	// Numeric-storage-class normalization: the encoder collapses comparator-equal
	// numerics (NUMERIC class) to one Map key, but only element-wise — a single
	// JSON-array *value* is encoded whole, so structurally-distinct arrays stay
	// distinct.
	describe('numeric normalization & arity', () => {
		it('single-column PK: true / 1 / 1n collapse to one bucket member', () => {
			const columns = makeColumns(2);
			const index = makeIndex(columns, [{ index: 1 }]);

			index.addEntry(1, true);
			index.addEntry(1, 1);
			index.addEntry(1, 1n);
			expect(index.getPrimaryKeys(1)).to.have.length(1);
		});

		it('composite PK: [5n, 7] and [5, 7] collapse to one bucket member', () => {
			const columns = makeColumns(3);
			const index = makeIndex(columns, [{ index: 1 }, { index: 2 }]);

			index.addEntry(1, [5n, 7]);
			index.addEntry(1, [5, 7]); // value-equal element-wise under numeric normalization
			expect(index.getPrimaryKeys(1)).to.have.length(1);
		});

		it('single-column JSON PK: reorder-equal objects collapse to one bucket member and remove by value', () => {
			// A JSON PK column: the PK comparator (JSON_TYPE.compare -> deepCompareJson)
			// treats {a:1,b:2} and {b:2,a:1} as equal, so the encoder MUST too, or the
			// primaryKeys Map would hold two members for one logical PK.
			const columns = [
				{ ...createDefaultColumnSchema('c0'), logicalType: INTEGER_TYPE },
				{ ...createDefaultColumnSchema('c1'), logicalType: JSON_TYPE },
			];
			const index = makeIndex(columns, [{ index: 1 }]);

			index.addEntry(1, { a: 1, b: 2 });
			index.addEntry(1, { b: 2, a: 1 }); // reorder-equal — must dedup
			expect(index.getPrimaryKeys(1)).to.have.length(1);

			// Remove with a differently-ordered but equal object — must match by value.
			index.removeEntry(1, { b: 2, a: 1 });
			expect(index.getPrimaryKeys(1)).to.have.length(0);
			expect(index.size).to.equal(0);
		});
	});

	// An owned (in-place) mutation must invalidate the memoized sorted view so the
	// next scan reflects the new PK in its sorted position rather than a stale array.
	describe('sortedCache invalidation', () => {
		it('an in-place add after a sorted read re-sorts on the next read', () => {
			const columns = makeColumns(2);
			const index = makeIndex(columns, [{ index: 1 }]);

			index.addEntry(1, 30);
			index.addEntry(1, 10);
			// Prime the cache with a sorted read.
			expect(index.getPrimaryKeys(1)).to.deep.equal([10, 30]);

			// In-place add of a PK that sorts between the two — must invalidate the cache.
			index.addEntry(1, 20);
			expect(index.getPrimaryKeys(1)).to.deep.equal([10, 20, 30]);
		});
	});
});

/**
 * Direct unit tests for the lossless PK encoder. It must (1) never collide two
 * comparator-distinct PKs within a PK domain, and (2) collapse the NUMERIC
 * storage-class representation variants the comparator treats as equal. It is NOT a
 * collation transform.
 */
describe('primary-key-encode', () => {
	describe('encodeScalar', () => {
		it('collapses NUMERIC representation variants', () => {
			// 5, 5.0, 5n, and (for 1) true all normalize to the same key.
			expect(encodeScalar(5)).to.equal(encodeScalar(5n));
			expect(encodeScalar(5)).to.equal(encodeScalar(5.0));
			expect(encodeScalar(1)).to.equal(encodeScalar(1n));
			expect(encodeScalar(1)).to.equal(encodeScalar(true));
			expect(encodeScalar(0)).to.equal(encodeScalar(false));
			// -0 collapses to 0.
			expect(encodeScalar(-0)).to.equal(encodeScalar(0));
		});

		it('keeps a non-integer real distinct from any integer but under the NUMERIC tag', () => {
			expect(encodeScalar(5.5)).to.not.equal(encodeScalar(5));
			expect(encodeScalar(5.5)).to.not.equal(encodeScalar(6));
			// Same real always encodes the same.
			expect(encodeScalar(5.5)).to.equal(encodeScalar(5.5));
		});

		it('does not collide across storage classes (number / string / blob / json / null)', () => {
			const keys = [
				encodeScalar(5),
				encodeScalar('5'),
				encodeScalar(new Uint8Array([5])),
				encodeScalar({ a: 5 }),
				encodeScalar([5]),
				encodeScalar(null),
			];
			expect(new Set(keys).size).to.equal(keys.length);
		});

		it('encodes BLOBs losslessly: equal bytes collide, distinct bytes do not', () => {
			expect(encodeScalar(new Uint8Array([1, 2, 3]))).to.equal(encodeScalar(new Uint8Array([1, 2, 3])));
			expect(encodeScalar(new Uint8Array([1, 2, 3]))).to.not.equal(encodeScalar(new Uint8Array([1, 2, 4])));
			// Hex is zero-padded so [10] (0x0a) ≠ [1, 0] etc.
			expect(encodeScalar(new Uint8Array([10]))).to.not.equal(encodeScalar(new Uint8Array([1, 0])));
		});

		it('encodes JSON values by their canonical (object-key-sorted) form', () => {
			expect(encodeScalar({ a: 1, b: 2 })).to.equal(encodeScalar({ a: 1, b: 2 }));
			expect(encodeScalar([1, 2])).to.not.equal(encodeScalar([1, 3]));
			// Reorder-equal objects MUST encode alike — the PK comparator treats them
			// equal (canonical form), so a bare JSON.stringify would split one JSON PK
			// into two Map members and disagree with the comparator.
			expect(encodeScalar({ a: 1, b: 2 })).to.equal(encodeScalar({ b: 2, a: 1 }));
			// Recursively, through nested objects and inside arrays.
			expect(encodeScalar({ outer: { z: 1, a: 2 }, list: [{ q: 1, p: 2 }] }))
				.to.equal(encodeScalar({ list: [{ p: 2, q: 1 }], outer: { a: 2, z: 1 } }));
			// Array element order stays significant.
			expect(encodeScalar([1, 2])).to.not.equal(encodeScalar([2, 1]));
		});
	});

	describe('encodePrimaryKey', () => {
		it('arity 0 (singleton) is the constant key', () => {
			expect(encodePrimaryKey([], 0)).to.equal('S');
		});

		it('arity 1 collapses numeric variants but treats a JSON-array value as whole', () => {
			expect(encodePrimaryKey(5, 1)).to.equal(encodePrimaryKey(5n, 1));
			// [true] vs [1] as a SINGLE-column JSON value do NOT collide (encoded whole,
			// not element-wise) — distinct under JSON.stringify.
			expect(encodePrimaryKey([true], 1)).to.not.equal(encodePrimaryKey([1], 1));
		});

		it('arity N is injective via length-prefixed components', () => {
			// Numeric normalization still applies element-wise.
			expect(encodePrimaryKey([5n, 'a'], 2)).to.equal(encodePrimaryKey([5, 'a'], 2));
			// Length-prefixing prevents component-boundary aliasing.
			expect(encodePrimaryKey([1, 23], 2)).to.not.equal(encodePrimaryKey([12, 3], 2));
			// Distinct tuples encode distinctly.
			expect(encodePrimaryKey([5, 7], 2)).to.not.equal(encodePrimaryKey([5, 8], 2));
		});
	});
});
