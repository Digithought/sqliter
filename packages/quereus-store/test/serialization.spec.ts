/**
 * Tests for row serialization utilities.
 */

import { expect } from 'chai';
import type { SqlValue, Row } from '@quereus/quereus';
import {
  serializeRow,
  deserializeRow,
  serializeValue,
  deserializeValue,
  serializeStats,
  deserializeStats,
} from '../src/common/serialization.js';

/** Deterministic PRNG (mulberry32) so the property run is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rand: () => number, max: number): number {
  return Math.floor(rand() * max);
}

const VALUE_KINDS = [
  'null',
  'number',
  'bigintSafe',
  'bigintUnsafe',
  'stringPlain',
  'stringSigilPrefix',
  'stringMarkerLookalike',
  'stringBareSigil',
  'boolean',
  'blob',
  'jsonPlain',
  'jsonMarkerCollision',
  'jsonArray',
  'jsonNestedMarker',
] as const;

/** Generates one random SqlValue, covering every kind the reviver gate must stay sound for. */
function generateValue(rand: () => number): SqlValue {
  const kind = VALUE_KINDS[randomInt(rand, VALUE_KINDS.length)];
  switch (kind) {
    case 'null':
      return null;
    case 'number':
      return Math.round((rand() - 0.5) * 20000) / 10;
    case 'bigintSafe':
      return BigInt(randomInt(rand, 1000));
    case 'bigintUnsafe':
      return BigInt('9007199254740993') + BigInt(randomInt(rand, 1000));
    case 'stringPlain':
      return `text-${randomInt(rand, 1000)}`;
    case 'stringSigilPrefix':
      return `$${(rand() * 1000).toFixed(2)} fee`;
    case 'stringMarkerLookalike':
      return '{"$bigint":"fake"}';
    case 'stringBareSigil':
      return 'contains a bare {"$ sigil in text';
    case 'boolean':
      return rand() < 0.5;
    case 'blob': {
      const len = randomInt(rand, 8) + 1;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = randomInt(rand, 256);
      }
      return bytes;
    }
    case 'jsonPlain':
      return { a: randomInt(rand, 100), b: 'value' };
    case 'jsonMarkerCollision':
      return { $bigint: 'not-a-bigint', extra: true };
    case 'jsonArray':
      return [randomInt(rand, 10), 'x', { $blob: 'fake' }];
    case 'jsonNestedMarker':
      return { outer: { inner: [{ $bigint: 'deep' }] } };
  }
}

function generateRow(rand: () => number, length: number): Row {
  return Array.from({ length }, () => generateValue(rand));
}

describe('Row Serialization', () => {
  describe('serializeRow / deserializeRow', () => {
    it('should serialize and deserialize simple rows', () => {
      const row = [1, 'hello', 3.14, null];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal(row);
    });

    it('should handle bigint values', () => {
      const row = [BigInt('9007199254740993'), 'test'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized[0]).to.equal(BigInt('9007199254740993'));
      expect(deserialized[1]).to.equal('test');
    });

    it('should handle Uint8Array (blob) values', () => {
      const blob = new Uint8Array([1, 2, 3, 4, 5]);
      const row = ['prefix', blob, 'suffix'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized[0]).to.equal('prefix');
      expect(deserialized[1]).to.deep.equal(blob);
      expect(deserialized[2]).to.equal('suffix');
    });

    it('should handle empty rows', () => {
      const row: (string | number | null | bigint | Uint8Array | boolean)[] = [];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal([]);
    });

    it('should handle rows with all null values', () => {
      const row = [null, null, null];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal([null, null, null]);
    });

    it('should handle boolean values', () => {
      const row = [true, false, 'text'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal([true, false, 'text']);
    });

    it('should handle special float values', () => {
      // Note: JSON doesn't support Infinity/-Infinity (they become null)
      // and -0 becomes 0. This is expected behavior.
      const row = [0, 1.5, -1.5, 3.14159];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized[0]).to.equal(0);
      expect(deserialized[1]).to.equal(1.5);
      expect(deserialized[2]).to.equal(-1.5);
      expect(deserialized[3]).to.equal(3.14159);
    });

    it('should handle unicode strings', () => {
      const row = ['Hello 世界', '🎉 emoji', 'Ñoño'];
      const serialized = serializeRow(row);
      const deserialized = deserializeRow(serialized);

      expect(deserialized).to.deep.equal(row);
    });
  });

  describe('serializeValue / deserializeValue', () => {
    it('should serialize and deserialize individual values', () => {
      const testCases = [
        null,
        42,
        3.14,
        'hello',
        true,
        false,
        BigInt('12345678901234567890'),
        new Uint8Array([1, 2, 3]),
      ];

      for (const value of testCases) {
        const serialized = serializeValue(value);
        const deserialized = deserializeValue(serialized);

        if (value instanceof Uint8Array) {
          expect(deserialized).to.deep.equal(value);
        } else {
          expect(deserialized).to.equal(value);
        }
      }
    });
  });

  describe('serializeStats / deserializeStats', () => {
    it('should serialize and deserialize table stats', () => {
      const stats = {
        rowCount: 1000,
        updatedAt: Date.now(),
      };

      const serialized = serializeStats(stats);
      const deserialized = deserializeStats(serialized);

      expect(deserialized).to.deep.equal(stats);
    });

    it('should handle zero row count', () => {
      const stats = {
        rowCount: 0,
        updatedAt: 0,
      };

      const serialized = serializeStats(stats);
      const deserialized = deserializeStats(serialized);

      expect(deserialized).to.deep.equal(stats);
    });
  });

  describe('reviver fast-path gate (property)', () => {
    it('deserializeRow(serializeRow(row)) round-trips for many generated shapes', () => {
      const rand = mulberry32(0x5eed);
      for (let i = 0; i < 300; i++) {
        const length = randomInt(rand, 8);
        const row = generateRow(rand, length);
        const result = deserializeRow(serializeRow(row));
        expect(result).to.deep.equal(row);
      }
    });

    it('deserializeValue(serializeValue(value)) round-trips for many generated shapes', () => {
      const rand = mulberry32(0xbeef);
      for (let i = 0; i < 300; i++) {
        const value = generateValue(rand);
        const result = deserializeValue(serializeValue(value));
        expect(result).to.deep.equal(value);
      }
    });
  });

  describe('reviver fast-path gate (edge cases)', () => {
    it('handles an empty row', () => {
      const row: Row = [];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('handles an all-null row', () => {
      const row: Row = [null, null, null];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips TEXT starting with a dollar sign', () => {
      const row: Row = ['$125.00 consulting fee'];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips TEXT containing the literal marker object as text', () => {
      const row: Row = ['{"$bigint":"fake"}'];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips TEXT containing a bare {"$ substring', () => {
      const row: Row = ['prefix {"$ suffix'];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a JSON column with a real $bigint key, unwrapped form', () => {
      const row: Row = [{ $bigint: 'not-a-bigint' }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a JSON column with a real $bigint key inside a $json wrapper on read-back', () => {
      // serializeRow itself decides whether to wrap (wrapJsonIfNeeded) — this
      // asserts the wrapped-on-write shape still round-trips correctly.
      const row: Row = [{ $json: { $bigint: 'also-not-a-bigint' } }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a marker nested inside an array inside an object', () => {
      const row: Row = [{ outer: { list: [1, 2, { $bigint: 'deep-not-a-bigint' }] } }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips blob content whose base64 text happens to contain a sigil-like run', () => {
      // Base64 alphabet never contains '"' or '{', so the encoded string
      // itself can never form the literal `{"$` sigil — this just confirms
      // arbitrary/adversarial byte content still round-trips regardless.
      const bytes = new Uint8Array(64);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (i * 37 + 11) % 256;
      }
      const row: Row = ['prefix', bytes, 'suffix'];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });
  });

  describe('reviver fast-path gate (negative self-test)', () => {
    it('would fail the round-trip suite if the reviver were wrongly skipped', () => {
      // Mirrors deserializeRow but never passes a reviver — simulating a
      // regressed gate predicate that always returns false. This proves the
      // round-trip tests above are actually sensitive to the reviver being
      // skipped, rather than passing vacuously.
      function deserializeRowNeverReviver(buffer: Uint8Array): unknown {
        const json = new TextDecoder().decode(buffer);
        return JSON.parse(json);
      }

      const row: Row = [
        BigInt('9007199254740993'),
        new Uint8Array([1, 2, 3]),
        { $bigint: 'not-a-bigint' },
      ];
      const broken = deserializeRowNeverReviver(serializeRow(row));

      expect(broken).to.not.deep.equal(row);
    });
  });
});

