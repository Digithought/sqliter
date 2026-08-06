import { expect } from 'chai';
import { valueToText } from '../../src/util/value-text.js';
import { applyTextAffinity } from '../../src/util/affinity.js';
import { BLOB_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { castFallback, lenientCast } from '../../src/types/cast-semantics.js';
import type { SqlValue } from '../../src/common/types.js';

/** UTF-8 bytes of `s`, for building blob inputs readably. */
function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

describe('valueToText', () => {
	it('passes NULL through', () => {
		expect(valueToText(null)).to.equal(null);
	});

	it('returns a string unchanged, including temporal values (physically text)', () => {
		expect(valueToText('')).to.equal('');
		expect(valueToText('hello')).to.equal('hello');
		expect(valueToText('2024-01-15')).to.equal('2024-01-15');
		expect(valueToText('2024-01-15T10:30:00')).to.equal('2024-01-15T10:30:00');
		expect(valueToText('PT90M')).to.equal('PT90M');
	});

	it('spells a number with String(v)', () => {
		expect(valueToText(0)).to.equal('0');
		expect(valueToText(123)).to.equal('123');
		expect(valueToText(3.14)).to.equal('3.14');
		expect(valueToText(-2.5)).to.equal('-2.5');
		// Deliberate SQLite divergence, tracked separately: SQLite gives '1.0' / 'Inf'.
		expect(valueToText(1.0)).to.equal('1');
		expect(valueToText(Infinity)).to.equal('Infinity');
		expect(valueToText(NaN)).to.equal('NaN');
	});

	it('spells a bigint as exact decimal digits, with no Number() round-trip', () => {
		expect(valueToText(9007199254740993n)).to.equal('9007199254740993');
		expect(valueToText(-9007199254740993n)).to.equal('-9007199254740993');
		expect(valueToText(0n)).to.equal('0');
	});

	it('spells a boolean as true/false', () => {
		expect(valueToText(true)).to.equal('true');
		expect(valueToText(false)).to.equal('false');
	});

	it('decodes a blob as UTF-8, not as hex or as decimal bytes', () => {
		expect(valueToText(utf8('ab'))).to.equal('ab');
		expect(valueToText(new Uint8Array([0x61, 0x62]))).to.equal('ab');
	});

	it('decodes an empty blob to the empty string, not null', () => {
		expect(valueToText(new Uint8Array([]))).to.equal('');
	});

	it('keeps a leading BOM as one U+FEFF character (ignoreBOM)', () => {
		// The decoder default STRIPS EF BB BF, which would render x'efbbbf' as ''.
		const decoded = valueToText(new Uint8Array([0xef, 0xbb, 0xbf]));
		expect(decoded).to.equal('﻿');
		expect(decoded.length).to.equal(1);
	});

	it('decodes invalid UTF-8 to U+FFFD — lossy, and deliberately so', () => {
		expect(valueToText(new Uint8Array([0xff]))).to.equal('�');
		// Distinct invalid blobs collide onto the same text. Text derived from a blob
		// is therefore not a key for that blob. Do not "fix" this by throwing: the
		// conversion has to be total.
		expect(valueToText(new Uint8Array([0xff]))).to.equal(valueToText(new Uint8Array([0xfe])));
	});

	it('decodes multi-byte sequences', () => {
		expect(valueToText(new Uint8Array([0xe4, 0xb8, 0xad]))).to.equal('中');
		expect(valueToText(utf8('naïve 中文 🙂'))).to.equal('naïve 中文 🙂');
	});

	it('renders a JSON object as its own text', () => {
		expect(valueToText({ a: 1 })).to.equal('{"a":1}');
		expect(valueToText({})).to.equal('{}');
	});

	it('renders a JSON array as its own text', () => {
		expect(valueToText([1, 2, 3])).to.equal('[1,2,3]');
		expect(valueToText([])).to.equal('[]');
	});

	it('renders a nested JSON document', () => {
		expect(valueToText({ a: { x: 1 }, b: [1, { c: null }] })).to.equal('{"a":{"x":1},"b":[1,{"c":null}]}');
	});

	it('keeps the document\'s own key order, NOT canonical (sorted) order', () => {
		// canonicalJsonString (util/json-canonical.ts) exists for keys and fingerprints;
		// a user-visible conversion shows the document as it is.
		expect(valueToText({ b: 2, a: 1 })).to.equal('{"b":2,"a":1}');
		// The consequence, stated plainly: JSON_TYPE.compare is a structural
		// deep-compare, so these two documents are EQUAL yet render DIFFERENT text.
		expect(valueToText({ b: 2, a: 1 })).to.not.equal(valueToText({ a: 1, b: 2 }));
	});

	it('is total over SqlValue — no input in the type space throws', () => {
		const values: SqlValue[] = [
			null, '', 'x', 0, -0, 1.5, NaN, Infinity, -Infinity, 0n, -1n, true, false,
			new Uint8Array([]), new Uint8Array([0x00]), new Uint8Array([0xff, 0xfe, 0xfd]),
			{}, [], { a: [1, 2, { b: null }] },
		];
		for (const v of values) {
			expect(() => valueToText(v)).to.not.throw();
		}
	});
});

describe('value-to-text call sites agree with valueToText', () => {
	const samples: SqlValue[] = [
		'hello', '', 42, 3.14, 9007199254740993n, true, false,
		new Uint8Array([0x61, 0x62]), new Uint8Array([]), new Uint8Array([0xff]),
		{ a: 1 }, [1, 2, 3],
	];

	it('TEXT_TYPE.parse IS the conversion (no hex arm, no throw for objects)', () => {
		for (const v of samples) {
			expect(TEXT_TYPE.parse!(v)).to.equal(valueToText(v));
		}
		expect(TEXT_TYPE.parse!(null)).to.equal(null);
	});

	it('lenientCast to TEXT is the conversion for every storage class', () => {
		for (const v of samples) {
			expect(lenientCast(v, TEXT_TYPE)).to.equal(valueToText(v));
		}
		expect(lenientCast(null, TEXT_TYPE)).to.equal(null);
	});

	it('castFallback TEXT/BLOB arms both render through the conversion', () => {
		for (const v of samples) {
			expect(castFallback(v, TEXT_TYPE)).to.equal(valueToText(v));
		}
		// The BLOB arm is the UTF-8 bytes of that same text.
		expect(castFallback({ a: 1 }, BLOB_TYPE)).to.deep.equal(utf8('{"a":1}'));
		expect(castFallback(new Uint8Array([0x61]), BLOB_TYPE)).to.deep.equal(utf8('a'));
	});

	it('applyTextAffinity converts through the conversion but leaves a blob alone', () => {
		expect(applyTextAffinity(42)).to.equal('42');
		expect(applyTextAffinity(9007199254740993n)).to.equal('9007199254740993');
		expect(applyTextAffinity(true)).to.equal('true');
		expect(applyTextAffinity({ a: 1 })).to.equal('{"a":1}');
		expect(applyTextAffinity(null)).to.equal(null);
		expect(applyTextAffinity('x')).to.equal('x');
		// SQLite TEXT affinity does NOT convert a blob — a different question from
		// "render this as text". The blob must come back byte-identical.
		const blob = new Uint8Array([0x61, 0x62]);
		expect(applyTextAffinity(blob)).to.equal(blob);
	});
});
