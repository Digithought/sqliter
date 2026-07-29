/**
 * Tests for key encoding utilities.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type { KeyNormalizerResolver } from '@quereus/quereus';
import {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
  BUILTIN_KEY_NORMALIZER_RESOLVER,
  assertNoUnpairedSurrogate,
  findUnpairedSurrogate,
} from '../src/common/encoding.js';

describe('Key Encoding', () => {
  describe('encodeValue / decodeValue', () => {
    it('should encode and decode NULL', () => {
      const encoded = encodeValue(null);
      expect(encoded).to.deep.equal(new Uint8Array([0x00]));

      const { value, bytesRead } = decodeValue(encoded);
      expect(value).to.be.null;
      expect(bytesRead).to.equal(1);
    });

    it('should encode and decode positive integers', () => {
      const testCases = [0n, 1n, 127n, 128n, 255n, 256n, 65535n, 2147483647n, 9007199254740991n];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should encode and decode negative integers', () => {
      const testCases = [-1n, -127n, -128n, -255n, -256n, -65535n, -2147483648n];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should preserve integer sort order', () => {
      const values = [-1000n, -1n, 0n, 1n, 1000n];
      const encoded = values.map(v => encodeValue(v));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('should encode and decode floating point numbers', () => {
      // Note: Integer-valued floats like 0.0 are encoded as integers
      // Only test actual non-integer floats here
      const testCases = [0.5, 1.5, -1.5, 3.14159, -3.14159];

      for (const num of testCases) {
        const encoded = encodeValue(num);
        const { value } = decodeValue(encoded);
        expect(value).to.equal(num, `Failed for ${num}`);
      }
    });

    it('should preserve float sort order', () => {
      // Use non-integer floats to ensure they're encoded as REAL
      const values = [-1000.5, -1.5, -0.5, 0.5, 1.5, 1000.5];
      const encoded = values.map(v => encodeValue(v));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('should preserve mixed int/real sort order across the type boundary', () => {
      // Regression for store-numeric-key-mixed-int-real-sort-order: whole numbers
      // (bigint-shaped) must NOT all sort before fractional ones. The encoded bytes
      // must memcmp in the exact order compareNumbers gives. The old per-shape
      // TYPE_INTEGER(0x01) < TYPE_REAL(0x02) tag put every integer below every real,
      // so 3n would have sorted below 2.5 — the silent-under-fetch bug.
      const values: SqlValue[] = [-3.5, -3n, -2.5, 0n, 2.5, 3n, 3.5];
      const encoded = values.map(v => encodeValue(v));
      for (let i = 0; i < encoded.length - 1; i++) {
        expect(compareBytes(encoded[i], encoded[i + 1])).to.be.lessThan(
          0, `${values[i]} should sort before ${values[i + 1]}`);
      }
    });

    it('preserves full int64 precision where large integers share a nearest double', () => {
      // 2^53 and 2^53+1 both round to the double 2^53 (2^53+1 is not representable);
      // the tie-break tail must keep them DISTINCT (no key collision / data loss) and
      // ORDERED. 2^53+2 is exactly representable again.
      const values: bigint[] = [
        9007199254740992n, // 2^53
        9007199254740993n, // 2^53 + 1 (rounds to the 2^53 double)
        9007199254740994n, // 2^53 + 2 (exact)
      ];
      const encoded = values.map(v => encodeValue(v));
      // Distinct + ascending (a naive "encode as a double" scheme collides 0 and 1).
      expect(compareBytes(encoded[0], encoded[1])).to.be.lessThan(0);
      expect(compareBytes(encoded[1], encoded[2])).to.be.lessThan(0);
      // Exact roundtrip — no precision loss.
      for (const v of values) {
        expect(decodeValue(encodeValue(v)).value).to.equal(v, `roundtrip ${v}`);
      }
    });

    it('normalizes -0 so -0, +0 and 0n encode to the same key', () => {
      // compareNumbers(-0, 0) === 0, so all three must collide to one byte key.
      const negZero = encodeValue(-0);
      const posZero = encodeValue(0);
      const bigZero = encodeValue(0n);
      expect(compareBytes(negZero, posZero)).to.equal(0);
      expect(compareBytes(posZero, bigZero)).to.equal(0);
    });

    it('should encode and decode strings with NOCASE', () => {
      const testCases = ['', 'hello', 'Hello World', 'UPPERCASE', 'MixedCase'];

      for (const str of testCases) {
        const encoded = encodeValue(str, { collation: 'NOCASE' });
        const { value } = decodeValue(encoded, 0, { collation: 'NOCASE' });
        // NOCASE stores lowercase
        expect(value).to.equal(str.toLowerCase(), `Failed for "${str}"`);
      }
    });

    it('should encode and decode strings with BINARY', () => {
      const testCases = ['', 'hello', 'Hello World', 'UPPERCASE'];

      for (const str of testCases) {
        const encoded = encodeValue(str, { collation: 'BINARY' });
        const { value } = decodeValue(encoded, 0, { collation: 'BINARY' });
        expect(value).to.equal(str, `Failed for "${str}"`);
      }
    });

    it('should preserve NOCASE string sort order', () => {
      const values = ['apple', 'Banana', 'CHERRY', 'date'];

      // Sort by encoded bytes
      const sorted = [...values].sort((a, b) => {
        const ea = encodeValue(a, { collation: 'NOCASE' });
        const eb = encodeValue(b, { collation: 'NOCASE' });
        return compareBytes(ea, eb);
      });

      expect(sorted).to.deep.equal(['apple', 'Banana', 'CHERRY', 'date']);
    });

    it('should handle strings with null bytes', () => {
      const str = 'hello\x00world';
      const encoded = encodeValue(str, { collation: 'BINARY' });
      const { value } = decodeValue(encoded, 0, { collation: 'BINARY' });
      expect(value).to.equal(str);
    });

    it('should encode and decode blobs', () => {
      const testCases = [
        new Uint8Array([]),
        new Uint8Array([0, 1, 2, 3]),
        new Uint8Array([255, 254, 253]),
        new Uint8Array(1000).fill(42),
      ];

      for (const blob of testCases) {
        const encoded = encodeValue(blob);
        const { value } = decodeValue(encoded);
        expect(value).to.deep.equal(blob);
      }
    });

    it('should preserve blob sort order (element-wise, matching SQL)', () => {
      // Regression for store-blob-key-varint-not-memcmp-ordered: the encoded
      // bytes must memcmp in element-wise blob order, not by length. Covers the
      // exact bug (x'0102' < x'03' though shorter), prefix < extension, empty <
      // non-empty, and the escaped content bytes 0x00/0x01/0x02 in order.
      const blobs = [
        new Uint8Array([]),          // empty sorts first
        new Uint8Array([0x00]),      // escaped 0x00
        new Uint8Array([0x00, 0x00]),
        new Uint8Array([0x01]),      // escaped 0x01
        new Uint8Array([0x01, 0x02]),
        new Uint8Array([0x01, 0x02, 0xff]), // prefix < extension
        new Uint8Array([0x02]),      // raw byte
        new Uint8Array([0x03]),      // x'0102' (above) must sort before this
        new Uint8Array([0xff]),
      ];
      const encoded = blobs.map(b => encodeValue(b));
      for (let i = 0; i < encoded.length - 1; i++) {
        expect(compareBytes(encoded[i], encoded[i + 1])).to.be.lessThan(
          0, `blob ${i} should sort before blob ${i + 1}`);
      }
    });

    describe('unpaired surrogates', () => {
      // `TextEncoder` folds every unpaired surrogate to U+FFFD, so all 2048 of them would
      // encode to the same three bytes — two distinct text values sharing one key. The
      // encoder refuses them instead. See `encodeText` / `assertNoUnpairedSurrogate`.
      const LONE_HIGH = '\uD800';
      const LONE_HIGH_2 = '\uD801';
      const LONE_LOW = '\uDC00';
      /** U+10000 — a WELL-FORMED pair; the same two code-unit ranges, legally paired. */
      const ASTRAL = '\u{10000}';

      it('proves the collision the guard exists to prevent', () => {
        // Not a claim about encodeValue — a claim about TextEncoder, the reason for the
        // guard. If this ever stops holding, the guard can be reconsidered.
        const enc = new TextEncoder();
        expect(Array.from(enc.encode(LONE_HIGH))).to.deep.equal([0xef, 0xbf, 0xbd]);
        expect(Array.from(enc.encode(LONE_HIGH_2))).to.deep.equal([0xef, 0xbf, 0xbd]);
      });

      it('throws rather than encoding two distinct lone surrogates to equal bytes', () => {
        for (const s of [LONE_HIGH, LONE_HIGH_2, LONE_LOW]) {
          expect(() => encodeValue(s, { collation: 'BINARY' }), JSON.stringify(s))
            .to.throw(/unpaired surrogate/i);
        }
      });

      it('names the offending code unit and offset', () => {
        expect(() => encodeValue(`ab${LONE_LOW}`, { collation: 'BINARY' }))
          .to.throw(/U\+DC00 at offset 2/);
      });

      it('throws for a lone surrogate anywhere in the string', () => {
        const cases = [LONE_HIGH, `${LONE_HIGH}x`, `x${LONE_HIGH}`, `${ASTRAL}${LONE_HIGH}`,
          `${LONE_LOW}${ASTRAL}`, `${LONE_LOW}${LONE_HIGH}`]; // low-then-high is NOT a pair
        for (const s of cases) {
          expect(() => encodeValue(s, { collation: 'BINARY' }), JSON.stringify(s))
            .to.throw(/unpaired surrogate/i);
        }
      });

      it('throws under every built-in collation, not just BINARY', () => {
        for (const collation of ['BINARY', 'NOCASE', 'RTRIM']) {
          expect(() => encodeValue(LONE_HIGH, { collation }), collation)
            .to.throw(/unpaired surrogate/i);
        }
      });

      it('throws from a composite key when any component carries one', () => {
        expect(() => encodeCompositeKey([1n, LONE_HIGH], { collation: 'BINARY' }))
          .to.throw(/unpaired surrogate/i);
      });

      it('says persistent storage cannot hold the value, and memory tables can', () => {
        expect(() => encodeValue(LONE_HIGH, { collation: 'BINARY' }))
          .to.throw(/persistent storage/i);
        expect(() => encodeValue(LONE_HIGH, { collation: 'BINARY' }))
          .to.throw(/in-memory tables accept the value/i);
      });

      it('guards the NORMALIZED string, so a slicing custom normalizer cannot smuggle one in', () => {
        // The normalizer's output is what gets encoded. A normalizer that cuts through a
        // surrogate pair produces a lone half out of a perfectly well-formed input.
        const firstUnit: KeyNormalizerResolver = (name) =>
          name === 'FIRSTUNIT' ? (s) => s.slice(0, 1) : BUILTIN_KEY_NORMALIZER_RESOLVER(name);
        expect(() => encodeValue(ASTRAL, { collation: 'FIRSTUNIT', normalizers: firstUnit }))
          .to.throw(/unpaired surrogate/i);
      });

      it('round-trips a well-formed astral character untouched', () => {
        for (const s of [ASTRAL, '\u{10FFFF}', '\u{1F600}', `x${ASTRAL}y`]) {
          const encoded = encodeValue(s, { collation: 'BINARY' });
          expect(decodeValue(encoded, 0, { collation: 'BINARY' }).value).to.equal(s);
        }
      });

      it('keeps distinct astral characters at distinct, code-point-ordered keys', () => {
        // U+FFFD itself is a legal character; it must not be confusable with a rejected
        // lone surrogate, and it sorts BELOW every astral character (EF BF BD < F0 …).
        const values = ['�', '\u{10000}', '\u{1F600}', '\u{10FFFF}'];
        const encoded = values.map(v => encodeValue(v, { collation: 'BINARY' }));
        for (let i = 0; i < encoded.length - 1; i++) {
          expect(compareBytes(encoded[i], encoded[i + 1])).to.be.lessThan(
            0, `${JSON.stringify(values[i])} should sort before ${JSON.stringify(values[i + 1])}`);
        }
      });

      it('accepts a lone surrogate inside a JSON value — JSON.stringify escapes it', () => {
        // `encodeObject` encodes `JSON.stringify`'s output, which is well-formed (ES2019):
        // a lone surrogate becomes the seven ASCII characters `\ud800`. So the bytes stay
        // injective without a guard, and the value survives the round trip.
        const a = encodeValue([LONE_HIGH] as unknown as SqlValue);
        const b = encodeValue([LONE_HIGH_2] as unknown as SqlValue);
        expect(compareBytes(a, b)).to.not.equal(0);
        expect(decodeValue(a).value).to.deep.equal([LONE_HIGH]);
      });
    });

    describe('assertNoUnpairedSurrogate / findUnpairedSurrogate (shared, exported guard)', () => {
      // encodeText's own unpaired-surrogate coverage lives in the describe block above;
      // these tests exercise the exported guard directly — the same one `key-builder.ts`
      // and `store-module-catalog.ts` call for identifiers and persisted DDL text.
      const LONE_HIGH = '\uD800';
      const LONE_LOW = '\uDC00';
      const ASTRAL = '\u{10000}';

      it('findUnpairedSurrogate returns -1 for a clean string', () => {
        expect(findUnpairedSurrogate('')).to.equal(-1);
        expect(findUnpairedSurrogate('hello')).to.equal(-1);
        expect(findUnpairedSurrogate(ASTRAL)).to.equal(-1);
      });

      it('findUnpairedSurrogate returns the offset of the first unpaired surrogate', () => {
        expect(findUnpairedSurrogate(LONE_HIGH)).to.equal(0);
        expect(findUnpairedSurrogate(`ab${LONE_LOW}`)).to.equal(2);
        expect(findUnpairedSurrogate(`${ASTRAL}${LONE_HIGH}`)).to.equal(2);
      });

      it('assertNoUnpairedSurrogate accepts a clean string', () => {
        expect(() => assertNoUnpairedSurrogate('hello', 'a text value')).to.not.throw();
        expect(() => assertNoUnpairedSurrogate(ASTRAL, 'a text value')).to.not.throw();
      });

      it('assertNoUnpairedSurrogate raises on an unpaired surrogate', () => {
        expect(() => assertNoUnpairedSurrogate(LONE_HIGH, 'a text value')).to.throw(/unpaired surrogate/i);
      });

      it('names the offending code unit and offset', () => {
        expect(() => assertNoUnpairedSurrogate(`ab${LONE_LOW}`, 'a text value'))
          .to.throw(/U\+DC00 at offset 2/);
      });

      it('interpolates the caller-supplied description into the message', () => {
        expect(() => assertNoUnpairedSurrogate(LONE_HIGH, 'the identifier "x"'))
          .to.throw(/cannot store the identifier "x" containing an unpaired surrogate/);
      });
    });

    describe('JSON object canonical key encoding', () => {
      it('encodes reorder-equal objects to identical bytes', () => {
        // {a:1,b:2} and {b:2,a:1} compare equal (deepCompareJson sorts keys), so
        // their persisted byte keys MUST match — otherwise a JSON PK stores two rows.
        const a = encodeValue({ a: 1, b: 2 } as unknown as SqlValue);
        const b = encodeValue({ b: 2, a: 1 } as unknown as SqlValue);
        expect(compareBytes(a, b)).to.equal(0);
      });

      it('encodes reorder-equal nested objects to identical bytes', () => {
        const a = encodeValue({ outer: { z: 1, a: 2 }, list: [{ q: 1, p: 2 }] } as unknown as SqlValue);
        const b = encodeValue({ list: [{ p: 2, q: 1 }], outer: { a: 2, z: 1 } } as unknown as SqlValue);
        expect(compareBytes(a, b)).to.equal(0);
      });

      it('encodes structurally distinct objects to different bytes', () => {
        const a = encodeValue({ a: 1 } as unknown as SqlValue);
        const b = encodeValue({ a: 2 } as unknown as SqlValue);
        expect(compareBytes(a, b)).to.not.equal(0);
      });

      it('keeps array element order significant', () => {
        const a = encodeValue([1, 2] as unknown as SqlValue);
        const b = encodeValue([2, 1] as unknown as SqlValue);
        expect(compareBytes(a, b)).to.not.equal(0);
      });
    });
  });

  describe('encodeCompositeKey / decodeCompositeKey', () => {
    it('should encode and decode composite keys', () => {
      const values = [1n, 'hello', 3.14];
      const encoded = encodeCompositeKey(values, { collation: 'NOCASE' });
      const decoded = decodeCompositeKey(encoded, 3, { collation: 'NOCASE' });

      expect(decoded[0]).to.equal(1n);
      expect(decoded[1]).to.equal('hello'); // lowercase due to NOCASE
      expect(decoded[2]).to.equal(3.14);
    });

    it('should preserve composite key sort order', () => {
      const keys = [
        [1n, 'a'],
        [1n, 'b'],
        [2n, 'a'],
        [2n, 'b'],
      ];

      const encoded = keys.map(k => encodeCompositeKey(k, { collation: 'NOCASE' }));

      for (let i = 0; i < encoded.length - 1; i++) {
        const cmp = compareBytes(encoded[i], encoded[i + 1]);
        expect(cmp).to.be.lessThan(0, `Key ${i} should sort before key ${i + 1}`);
      }
    });

    describe('DESC direction (per-component bit inversion)', () => {
      it('single DESC INTEGER inverts byte order', () => {
        const values = [1n, 2n, 3n];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('single DESC TEXT inverts byte order', () => {
        const values = ['apple', 'banana', 'cherry'];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('single DESC REAL inverts byte order', () => {
        const values = [1.5, 2.1, 3.7];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('single DESC BLOB inverts variable-length order under bit inversion', () => {
        // The escape+terminator scheme must stay order-correct after ^0xff. Uses
        // a prefix pair (x'0102' < x'0102ff') and the length-vs-content pair
        // (x'0102' < x'03') to exercise the terminator under inversion.
        const values = [
          new Uint8Array([0x01, 0x02]),
          new Uint8Array([0x01, 0x02, 0xff]),
          new Uint8Array([0x03]),
        ];
        const encoded = values.map(v =>
          encodeCompositeKey([v], { collation: 'NOCASE' }, [true]),
        );
        // DESC: larger blobs sort first, so ASC index 2 > 1 > 0 reverses.
        expect(compareBytes(encoded[2], encoded[1])).to.be.lessThan(0);
        expect(compareBytes(encoded[1], encoded[0])).to.be.lessThan(0);
      });

      it('ASC then DESC: ASC preserved across groups, DESC within group', () => {
        const pairs: Array<[string, bigint]> = [
          ['a', 1n], ['a', 2n], ['a', 3n],
          ['b', 1n], ['b', 2n], ['b', 3n],
        ];
        const encoded = pairs.map(p =>
          encodeCompositeKey(p, { collation: 'NOCASE' }, [false, true]),
        );
        const sorted = pairs
          .map((p, i) => ({ p, bytes: encoded[i] }))
          .sort((a, b) => compareBytes(a.bytes, b.bytes))
          .map(x => x.p);
        expect(sorted).to.deep.equal([
          ['a', 3n], ['a', 2n], ['a', 1n],
          ['b', 3n], ['b', 2n], ['b', 1n],
        ]);
      });

      it('DESC then ASC: primary DESC group, secondary ASC within group', () => {
        const pairs: Array<[string, bigint]> = [
          ['a', 1n], ['a', 2n],
          ['b', 1n], ['b', 2n],
        ];
        const encoded = pairs.map(p =>
          encodeCompositeKey(p, { collation: 'NOCASE' }, [true, false]),
        );
        const sorted = pairs
          .map((p, i) => ({ p, bytes: encoded[i] }))
          .sort((a, b) => compareBytes(a.bytes, b.bytes))
          .map(x => x.p);
        expect(sorted).to.deep.equal([
          ['b', 1n], ['b', 2n],
          ['a', 1n], ['a', 2n],
        ]);
      });

      it('omitted directions is equivalent to all-false ASC', () => {
        const values: Array<bigint | string | number> = [1n, 'x', 2.5];
        const a = encodeCompositeKey(values, { collation: 'NOCASE' });
        const b = encodeCompositeKey(values, { collation: 'NOCASE' }, [false, false, false]);
        expect(a).to.deep.equal(b);
      });
    });
  });

  describe('key normalizer resolution', () => {
    it('resolves the built-in NOCASE normalizer', () => {
      expect(BUILTIN_KEY_NORMALIZER_RESOLVER('NOCASE')('HELLO')).to.equal('hello');
    });

    it('resolves the built-in BINARY normalizer', () => {
      expect(BUILTIN_KEY_NORMALIZER_RESOLVER('BINARY')('HELLO')).to.equal('HELLO');
    });

    it('resolves an undefined collation to BINARY (identity)', () => {
      expect(BUILTIN_KEY_NORMALIZER_RESOLVER(undefined)('HELLO')).to.equal('HELLO');
    });

    it('RTRIM strips trailing ASCII space (0x20) only, matching RTRIM_COLLATION', () => {
      const rtrim = BUILTIN_KEY_NORMALIZER_RESOLVER('RTRIM');
      expect(rtrim('hello   ')).to.equal('hello');
      // The retired store-local encoder stripped /\s+$/ — tab, NBSP, every Unicode
      // space — while the comparator strips only 0x20, so 'a\t' and 'a' shared one
      // key byte string despite comparing distinct. The engine normalizer does not.
      expect(rtrim('hello\t')).to.equal('hello\t');
      expect(rtrim('hello ')).to.equal('hello ');
      expect(rtrim('hello\t ')).to.equal('hello\t');
    });

    it('encodes RTRIM values ending in non-space whitespace to distinct keys', () => {
      const a = encodeValue('a', { collation: 'RTRIM' });
      const tab = encodeValue('a\t', { collation: 'RTRIM' });
      const spaces = encodeValue('a  ', { collation: 'RTRIM' });
      expect(compareBytes(a, spaces)).to.equal(0);   // trailing 0x20 stripped
      expect(compareBytes(a, tab)).to.not.equal(0);  // trailing tab preserved
    });

    it('is case-insensitive for collation names', () => {
      expect(BUILTIN_KEY_NORMALIZER_RESOLVER('nocase')('HELLO')).to.equal('hello');
      expect(BUILTIN_KEY_NORMALIZER_RESOLVER('NoCase')('HELLO')).to.equal('hello');
    });

    it('throws on an unknown collation rather than falling back to NOCASE', () => {
      expect(() => BUILTIN_KEY_NORMALIZER_RESOLVER('NOSPACE'))
        .to.throw(/no such collation sequence: NOSPACE/);
      expect(() => encodeValue('hello', { collation: 'NOSPACE' }))
        .to.throw(/no such collation sequence: NOSPACE/);
    });

    it('should preserve RTRIM sort order', () => {
      const values = ['a', 'a  ', 'a   ', 'b', 'b '];
      const sorted = [...values].sort((a, b) => {
        const ea = encodeValue(a, { collation: 'RTRIM' });
        const eb = encodeValue(b, { collation: 'RTRIM' });
        return compareBytes(ea, eb);
      });
      // With RTRIM, 'a', 'a  ', 'a   ' all sort the same, then 'b', 'b '
      expect(sorted[0]).to.match(/^a/);
      expect(sorted[1]).to.match(/^a/);
      expect(sorted[2]).to.match(/^a/);
      expect(sorted[3]).to.match(/^b/);
      expect(sorted[4]).to.match(/^b/);
    });

    it('uses the supplied resolver for TEXT key bytes', () => {
      const upper: KeyNormalizerResolver = (name) =>
        name === 'UPPER' ? (s) => s.toUpperCase() : BUILTIN_KEY_NORMALIZER_RESOLVER(name);

      const encoded = encodeValue('hello', { collation: 'UPPER', normalizers: upper });
      expect(decodeValue(encoded).value).to.equal('HELLO');
    });

    it('carries the resolver through per-column collation overrides in a composite key', () => {
      const upper: KeyNormalizerResolver = (name) =>
        name === 'UPPER' ? (s) => s.toUpperCase() : BUILTIN_KEY_NORMALIZER_RESOLVER(name);

      const key = encodeCompositeKey(
        ['hello', 'World'],
        { collation: 'NOCASE', normalizers: upper },
        undefined,
        ['UPPER', undefined],
      );
      expect(decodeCompositeKey(key, 2)).to.deep.equal(['HELLO', 'world']);
    });
  });
});

/**
 * Compare two byte arrays lexicographically.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

