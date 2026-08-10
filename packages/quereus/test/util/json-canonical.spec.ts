import { expect } from 'chai';
import { canonicalJsonString } from '../../src/util/json-canonical.js';
import { serializeKey, BUILTIN_NORMALIZERS } from '../../src/util/key-serializer.js';
import { compareSqlValues, sqlValueIdentical } from '../../src/util/comparison.js';
import type { SqlValue } from '../../src/common/types.js';
import type { JSONValue } from '../../src/common/json-types.js';

const BIN = BUILTIN_NORMALIZERS.BINARY;

/** Single-value hash key for a SqlValue, using the BINARY normalizer. */
function key(v: SqlValue): string | null {
	return serializeKey([v], [BIN]);
}

describe('canonicalJsonString', () => {
	it('sorts object keys so reorder-equal objects stringify identically', () => {
		expect(canonicalJsonString({ a: 1, b: 2 })).to.equal(canonicalJsonString({ b: 2, a: 1 }));
		expect(canonicalJsonString({ a: 1, b: 2 })).to.equal('{"a":1,"b":2}');
	});

	it('distinguishes structurally distinct objects', () => {
		expect(canonicalJsonString({ a: 1 })).to.not.equal(canonicalJsonString({ a: 2 }));
		expect(canonicalJsonString({ a: 1 })).to.not.equal(canonicalJsonString({ b: 1 }));
	});

	it('sorts nested object keys recursively', () => {
		const x: JSONValue = { outer: { z: 1, a: 2 }, arr: [{ q: 1, b: 2 }] };
		const y: JSONValue = { arr: [{ b: 2, q: 1 }], outer: { a: 2, z: 1 } };
		expect(canonicalJsonString(x)).to.equal(canonicalJsonString(y));
	});

	it('keeps array element order significant (positional)', () => {
		expect(canonicalJsonString([1, 2, 3])).to.not.equal(canonicalJsonString([3, 2, 1]));
		expect(canonicalJsonString([{ a: 1 }, { b: 2 }])).to.not.equal(canonicalJsonString([{ b: 2 }, { a: 1 }]));
	});

	it('passes scalars through JSON.stringify unchanged', () => {
		expect(canonicalJsonString(5)).to.equal('5');
		expect(canonicalJsonString('x')).to.equal('"x"');
		expect(canonicalJsonString(true)).to.equal('true');
		expect(canonicalJsonString(null)).to.equal('null');
	});

	it('keeps NaN/Infinity → null and -0 → 0 parity with JSON.stringify', () => {
		// These match JSON.stringify's own coercions, so no new round-trip mismatch.
		expect(canonicalJsonString({ x: NaN } as unknown as JSONValue)).to.equal('{"x":null}');
		expect(canonicalJsonString({ x: Infinity } as unknown as JSONValue)).to.equal('{"x":null}');
		expect(canonicalJsonString({ x: -0 })).to.equal('{"x":0}');
	});
});

describe('serializeKey equality invariant (appendValue)', () => {
	it('reorder-equal JSON objects produce the same key', () => {
		expect(key({ a: 1, b: 2 })).to.equal(key({ b: 2, a: 1 }));
	});

	it('distinct JSON objects produce different keys (no [object Object] collapse)', () => {
		const k1 = key({ a: 1 });
		const k2 = key({ a: 2 });
		const k3 = key({ b: 9 });
		expect(new Set([k1, k2, k3]).size).to.equal(3);
	});

	it('JSON array element order is significant', () => {
		expect(key([1, 2, 3])).to.not.equal(key([3, 2, 1]));
	});

	it('numeric classes that compare equal produce the same key (bigint vs number)', () => {
		expect(key(5n)).to.equal(key(5));
		expect(key(5n)).to.equal('n:5');
		expect(key(0n)).to.equal(key(0));
	});

	it('boolean keys alike to its 0/1 numeric equivalent', () => {
		expect(key(true)).to.equal(key(1));
		expect(key(false)).to.equal(key(0));
		expect(key(true)).to.equal('n:1');
	});

	it('non-integer numbers keep their distinct decimal key', () => {
		expect(key(1.5)).to.equal('n:1.5');
		expect(key(1.5)).to.not.equal(key(2));
	});

	it('agrees with compareSqlValues on OBJECT-class equality', () => {
		const pairs: Array<[JSONValue, JSONValue]> = [
			[{ a: 1, b: 2 }, { b: 2, a: 1 }],   // reorder-equal
			[{ a: 1 }, { a: 2 }],               // distinct
			[[1, 2], [2, 1]],                   // array order
			[{ a: [1, { x: 1, y: 2 }] }, { a: [1, { y: 2, x: 1 }] }], // nested reorder-equal
		];
		for (const [a, b] of pairs) {
			const keysEqual = key(a as SqlValue) === key(b as SqlValue);
			const cmpEqual = compareSqlValues(a as SqlValue, b as SqlValue) === 0;
			const valEqual = sqlValueIdentical(a as SqlValue, b as SqlValue);
			expect(keysEqual).to.equal(cmpEqual, `key/compare disagree for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
			expect(keysEqual).to.equal(valEqual, `key/sqlValueIdentical disagree for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
		}
	});
});
