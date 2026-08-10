/**
 * Direct unit coverage for `compareCodePoints` — the primitive the built-in collations,
 * `compareSameType`'s OBJECT branch and `deepCompareJson` all compare with — and for the
 * two JSON paths that route through it.
 *
 * The contract is a single equation, and most tests here restate it:
 *
 *     sign(compareCodePoints(a, b)) === sign(memcmp(utf8(a), utf8(b)))
 *
 * for every pair of WELL-FORMED strings. Unpaired surrogates are excluded on purpose: they
 * have no UTF-8 encoding (`TextEncoder` folds each to U+FFFD), so the right-hand side is not
 * even well defined for them. See `bug-store-lone-surrogate-key-collision`.
 *
 * `collation-normalizer.spec.ts` pins the same equation through the three built-in
 * comparators; this file pins it on the primitive itself, plus the total-order properties
 * any comparator handed to `Array.prototype.sort` must have.
 */
import { expect } from 'chai';
import { compareCodePoints, compareSqlValues, canonicalJsonString, JSON_TYPE } from '../src/index.js';
import type { JSONValue } from '../src/common/json-types.js';

/** U+1F600 GRINNING FACE — astral; UTF-8 `F0 9F 98 80`. */
const EMOJI = '\u{1F600}';
/** U+FF21 FULLWIDTH LATIN CAPITAL LETTER A — BMP above the surrogates; UTF-8 `EF BC A1`. */
const WIDE_A = '\uFF21';

/** memcmp of the UTF-8 encodings — the order the store's key bytes physically take. */
const encoder = new TextEncoder();
function utf8Compare(a: string, b: string): number {
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	const min = Math.min(x.length, y.length);
	for (let i = 0; i < min; i++) {
		if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	}
	return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/**
 * Well-formed strings straddling every boundary the two orders can disagree across: the UTF-8
 * encoding-length steps (U+07FF/U+0800), the last BMP code point below the surrogate block
 * (U+D7FF) and the first above it (U+E000), the Private Use Area and Halfwidth/Fullwidth Forms
 * that JS `<` wrongly ranks ABOVE astral text, the astral extremes (U+10000, U+10FFFF), and
 * prefix/length variations of each. No duplicates — one test asserts `0` iff identical.
 */
const CORPUS: readonly string[] = [
	'', 'a', 'ab', 'b', 'z', 'zz',
	'\u0080', '\u07FF', '\u0800',
	'\uD7FF', '\uE000', '\uF8FF', '\uF900', '\uFF21', '\uFF41', '\uFFFD', '\uFFFF',
	'\u{10000}', '\u{10400}', '\u{10428}', '\u{1F600}', '\u{1F601}', '\u{10FFFF}',
	'a\uFF21', 'a\u{1F600}', '\uFF21a', '\u{1F600}a',
	'\uFF21\uFF21', '\uFF21\u{1F600}', '\u{1F600}\uFF21', '\u{1F600}\u{1F600}',
	'\u{1F600} ', '\u{1F600}\uFFFF', '\u{10FFFF} ',
];

describe('compareCodePoints', () => {
	it('agrees with memcmp of the UTF-8 encodings on every ordered pair of the corpus', () => {
		for (const a of CORPUS) {
			for (const b of CORPUS) {
				expect(
					Math.sign(compareCodePoints(a, b)),
					`(${JSON.stringify(a)}, ${JSON.stringify(b)})`,
				).to.equal(Math.sign(utf8Compare(a, b)));
			}
		}
	});

	it('sorts the corpus into UTF-8 byte order', () => {
		expect([...CORPUS].sort(compareCodePoints)).to.deep.equal([...CORPUS].sort(utf8Compare));
	});

	it('returns exactly -1, 0 or 1, and is antisymmetric', () => {
		for (const a of CORPUS) {
			for (const b of CORPUS) {
				const cmp = compareCodePoints(a, b);
				expect(cmp, `(${JSON.stringify(a)}, ${JSON.stringify(b)})`).to.be.oneOf([-1, 0, 1]);
				expect(compareCodePoints(b, a)).to.equal(-cmp);
			}
		}
	});

	it('is transitive across the corpus', () => {
		const sorted = [...CORPUS].sort(compareCodePoints);
		for (let i = 0; i + 1 < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) {
				expect(
					compareCodePoints(sorted[i], sorted[j]),
					`${JSON.stringify(sorted[i])} must precede ${JSON.stringify(sorted[j])}`,
				).to.be.at.most(0);
			}
		}
	});

	it('reports 0 only for identical strings', () => {
		for (const a of CORPUS) {
			for (const b of CORPUS) {
				expect(compareCodePoints(a, b) === 0, `(${JSON.stringify(a)}, ${JSON.stringify(b)})`)
					.to.equal(a === b);
			}
		}
	});

	it('ranks an astral character above every BMP character — the case JS `<` gets wrong', () => {
		expect(compareCodePoints(WIDE_A, EMOJI)).to.equal(-1);
		expect(WIDE_A < EMOJI, 'the defect this replaces: code-unit order says the opposite').to.be.false;
		expect(compareCodePoints('\uE000', EMOJI)).to.equal(-1);
		expect(compareCodePoints('\uFFFF', EMOJI)).to.equal(-1);
		expect(compareCodePoints('\uD7FF', EMOJI)).to.equal(-1);
	});

	it('orders two astral characters by their code point', () => {
		expect(compareCodePoints('\u{1F600}', '\u{1F601}')).to.equal(-1);
		expect(compareCodePoints('\u{10000}', '\u{10FFFF}')).to.equal(-1);
		// These differ in the LOW surrogate only — the scan must not stop at the equal high one.
		expect(compareCodePoints('\u{1F600}', '\u{1F60F}')).to.equal(-1);
		// ...and these in the HIGH surrogate only.
		expect(compareCodePoints('\u{10000}', '\u{20000}')).to.equal(-1);
	});

	it('treats a proper prefix as less than the string extending it', () => {
		expect(compareCodePoints('a', 'ab')).to.equal(-1);
		expect(compareCodePoints(EMOJI, EMOJI + 'a')).to.equal(-1);
		expect(compareCodePoints('', EMOJI)).to.equal(-1);
	});
});

describe('OBJECT-class comparison orders by code point', () => {
	// `compareSqlValues` routes JSON arrays/objects through `compareSameType`'s OBJECT branch,
	// which compares `canonicalJsonString` output — the very string the store's `encodeObject`
	// writes as UTF-8 key bytes. So the branch must reproduce memcmp of those bytes.
	const VALUES: readonly JSONValue[] = [
		[WIDE_A], [EMOJI], ['a'], ['z'],
		{ [WIDE_A]: 1 }, { [EMOJI]: 1 },
		{ a: WIDE_A }, { a: EMOJI },
	];

	it('matches memcmp of the canonical JSON string bytes', () => {
		for (const a of VALUES) {
			for (const b of VALUES) {
				const expected = Math.sign(utf8Compare(canonicalJsonString(a), canonicalJsonString(b)));
				expect(
					Math.sign(compareSqlValues(a, b)),
					`${canonicalJsonString(a)} vs ${canonicalJsonString(b)}`,
				).to.equal(expected);
			}
		}
	});

	it('places a fullwidth-A array before an emoji array', () => {
		expect(compareSqlValues([WIDE_A], [EMOJI])).to.equal(-1);
	});
});

describe('JSON_TYPE.compare (deepCompareJson) orders by code point', () => {
	const compare = (a: JSONValue, b: JSONValue): number => Math.sign(JSON_TYPE.compare!(a, b));

	it('orders string leaves by code point, not code unit', () => {
		expect(compare([WIDE_A], [EMOJI])).to.equal(-1);
		expect(compare({ k: WIDE_A }, { k: EMOJI })).to.equal(-1);
	});

	it('orders object keys by code point, not code unit', () => {
		expect(compare({ [WIDE_A]: 1 }, { [EMOJI]: 1 })).to.equal(-1);
	});

	// Why `deepCompareJson` had to switch its key SORT along with its key COMPARISON: sorting
	// each key list by code unit and then comparing the lists by code point is not a total
	// order, and objects whose key sets mix astral and BMP keys are where it shows.
	it('stays a total order over objects whose key sets mix astral and BMP keys', () => {
		const objects: readonly JSONValue[] = [
			{ [WIDE_A]: 1, [EMOJI]: 2 },
			{ [EMOJI]: 1 },
			{ [WIDE_A]: 1 },
			{ [WIDE_A]: 1, m: 2 },
			{ m: 1 },
		];
		for (const a of objects) {
			for (const b of objects) {
				expect(compare(a, b)).to.equal(-compare(b, a));
			}
		}
		const sorted = [...objects].sort(compare);
		for (let i = 0; i + 1 < sorted.length; i++) {
			for (let j = i + 1; j < sorted.length; j++) {
				expect(compare(sorted[i], sorted[j])).to.be.at.most(0);
			}
		}
	});

	it('still calls reorder-equal objects equal, whatever the key sort', () => {
		expect(compare({ [EMOJI]: 1, [WIDE_A]: 2 }, { [WIDE_A]: 2, [EMOJI]: 1 })).to.equal(0);
		expect(compare({ a: 1, b: 2 }, { b: 2, a: 1 })).to.equal(0);
	});
});
