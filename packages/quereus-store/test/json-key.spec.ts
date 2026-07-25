/**
 * Unit tests for the structural JSON key encoding (src/common/json-key.ts).
 *
 * The contract under test: for any two in-engine JSON values, memcmp of their
 * structural key bytes must agree with the comparator the isolation layer merges
 * under — `createTypedComparator(JSON_TYPE, BINARY_COLLATION)` (storage-class rank
 * across kinds, `deepCompareJson` within, string pairs by code point). The corpus
 * sweep below checks every pair, so a regression in any node kind's body layout or
 * in the tag ordering fails loudly.
 *
 * Identity edges pinned separately: reorder-equal objects collide on one key,
 * `2` / `2.0` / `2n` / `-0`-vs-`0` collide, `Infinity` (JSON.parse of `1e400`) is
 * DISTINCT from JSON `null` (canonical text conflated them via `JSON.stringify`),
 * and an empty-string object key differs from an absent one.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createTypedComparator, JSON_TYPE, BINARY_COLLATION, type SqlValue } from '@quereus/quereus';
import { jsonStructuralKey } from '../src/common/json-key.js';
import { compareBytes } from '../src/common/bytes.js';

/** Encode and assert the transform's output shape. */
function key(value: SqlValue): Uint8Array {
	const encoded = jsonStructuralKey(value);
	expect(encoded).to.be.instanceOf(Uint8Array);
	return encoded as Uint8Array;
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('jsonStructuralKey', () => {
	describe('order agrees with the typed JSON comparator over a mixed corpus', () => {
		// Every non-null in-engine JSON kind, with same-kind neighbours chosen to
		// exercise each body layout: sortable-double magnitude vs text digits
		// ('9'/'10', 9.5/10), code-unit vs code-point ('�' vs an astral pair),
		// prefix/length tiebreaks, and nested recursion.
		const corpus: SqlValue[] = [
			false, true,
			-1e308, -2.5, -1, 0, 0.5, 1, 2, 3, 9.5, 10, 1e308, Infinity,
			'', '10', '9', 'Z', 'a', 'ab', 'abc', 'abd', '�', '\u{1F600}',
			[], [2], [2, 0], [2, 1], [3], [10], [[1]], [[1], 2], [[2]], ['a'], [null], [false],
			{}, { '': 0 }, { a: 1 }, { a: 2 }, { a: 10 }, { a: 1, b: 2 }, { b: 1 },
			{ a: { b: 2 } }, { a: { b: 10 } }, { '�': 1 }, { '\u{1F600}': 1 },
		];
		const comparator = createTypedComparator(JSON_TYPE, BINARY_COLLATION);

		it('memcmp of key bytes matches the comparator for every pair', () => {
			const keys = corpus.map(key);
			for (let i = 0; i < corpus.length; i++) {
				for (let j = 0; j < corpus.length; j++) {
					const byType = sign(comparator(corpus[i], corpus[j]));
					const byBytes = sign(compareBytes(keys[i], keys[j]));
					expect(byBytes, `${JSON.stringify(corpus[i])} vs ${JSON.stringify(corpus[j])}`)
						.to.equal(byType);
				}
			}
		});
	});

	describe('identity', () => {
		it('collides reorder-equal objects on one key', () => {
			// Literal member order IS the JS insertion order, so the two spellings
			// genuinely enumerate their keys differently.
			expect(key({ a: 1, b: 2 })).to.deep.equal(key({ b: 2, a: 1 }));
		});

		it('sorts object keys by code point, not code unit', () => {
			// '�' < '\u{1F600}' by code point but the reverse by code unit — a
			// default Array.sort would emit the key sections in the wrong order and the
			// two spellings would land on different bytes.
			expect(key({ '\u{1F600}': 1, '�': 2 })).to.deep.equal(key({ '�': 2, '\u{1F600}': 1 }));
		});

		it('collides numerically-equal numbers: 2, 2.0, 2n, and -0 with 0', () => {
			expect(key(2)).to.deep.equal(key(2.0));
			expect(key(2n)).to.deep.equal(key(2));
			expect(key(-0)).to.deep.equal(key(0));
		});

		it('keeps Infinity (JSON.parse of 1e400) distinct from JSON null', () => {
			// Canonical text conflated them: JSON.stringify(Infinity) === 'null'.
			expect(key([Infinity])).to.not.deep.equal(key([null]));
			expect(compareBytes(key([null]), key([Infinity])),
				'null ranks below every number').to.be.lessThan(0);
		});

		it('keeps an object with an empty-string key distinct from (and after) one with no keys', () => {
			expect(key({})).to.not.deep.equal(key({ '': 0 }));
			expect(compareBytes(key({}), key({ '': 0 }))).to.be.lessThan(0);
		});
	});

	describe('rejections', () => {
		it('raises on a string leaf holding an unpaired surrogate', () => {
			expect(() => jsonStructuralKey(['a\uD800b'])).to.throw(/unpaired surrogate/i);
			expect(() => jsonStructuralKey('\uDC00')).to.throw(/unpaired surrogate/i);
		});

		it('raises on an object key holding an unpaired surrogate', () => {
			expect(() => jsonStructuralKey({ '\uD800': 1 })).to.throw(/unpaired surrogate/i);
		});

		it('raises on a value that is not a JSON node', () => {
			expect(() => jsonStructuralKey(new Uint8Array([1, 2]))).to.throw(/JSON key member/i);
		});
	});
});
