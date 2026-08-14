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
  'jsonCollidingKeyLate',
  'jsonEscapedLookalike',
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
    case 'jsonCollidingKeyLate':
      return { lead: randomInt(rand, 100), $blob: 'fake' };
    case 'jsonEscapedLookalike':
      return { $$bigint: 'pre-escaped', $json: { $$blob: 'nested' } };
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

    it('reads a record written before column statistics existed as "no column statistics"', () => {
      // The exact on-disk shape a pre-column-statistics session wrote. It must reopen
      // cleanly and simply carry no snapshot — there is no version field and no migration.
      const legacy = new TextEncoder().encode(JSON.stringify({ rowCount: 42, updatedAt: 1700000000000 }));

      const deserialized = deserializeStats(legacy);

      expect(deserialized.rowCount).to.equal(42);
      expect(deserialized.columnStats).to.be.undefined;
      expect(deserialized.analyzedRowCount).to.be.undefined;
      expect(deserialized.lastAnalyzed).to.be.undefined;
    });

    /**
     * `minValue` / `maxValue` / `HistogramBucket.upperBound` are `SqlValue`s, so the stats
     * record has to go through the same extended-JSON codec rows do. Bare `JSON.stringify`
     * THROWS on a bigint and silently mangles a `Uint8Array` into `{"0":…}` — the kind of
     * defect that only shows up on the one column type nobody tried, so every shape is
     * covered here rather than sampled.
     */
    it('round-trips min/max and histogram bounds for every SqlValue shape', () => {
      const shapes: Array<{ label: string; value: SqlValue }> = [
        { label: 'null', value: null },
        { label: 'integer', value: 42 },
        { label: 'negative integer', value: -7 },
        { label: 'bigint past 2^53', value: 9007199254740993n },
        { label: 'negative bigint past 2^53', value: -9007199254740993n },
        { label: 'real', value: 3.5 },
        { label: 'text', value: 'hello' },
        { label: 'text shaped like a marker', value: '{"$bigint":"1"}' },
        { label: 'empty text', value: '' },
        { label: 'boolean', value: true },
        { label: 'blob', value: new Uint8Array([0, 1, 254, 255]) },
        { label: 'empty blob', value: new Uint8Array([]) },
        { label: 'json object', value: { a: 1, b: [2, 3] } },
        { label: 'json object with a colliding key', value: { $bigint: 'not a marker' } },
        { label: 'json array', value: [1, 'two', null] },
        // Temporal values reach the store as their canonical text spelling.
        { label: 'date', value: '2026-08-14' },
        { label: 'datetime', value: '2026-08-14T17:57:41.183Z' },
        { label: 'timespan', value: 'PT1H' },
      ];

      for (const { label, value } of shapes) {
        const stats = {
          rowCount: 10,
          updatedAt: 1,
          analyzedRowCount: 10,
          lastAnalyzed: 2,
          columnStats: {
            c: {
              distinctCount: 3,
              nullCount: 1,
              minValue: value,
              maxValue: value,
              histogram: {
                sampleSize: 10,
                buckets: [{ upperBound: value, cumulativeCount: 10, distinctCount: 3 }],
              },
            },
          },
        };

        const deserialized = deserializeStats(serializeStats(stats));

        expect(deserialized, `${label}: whole record`).to.deep.equal(stats);
        const column = deserialized.columnStats!.c;
        if (value instanceof Uint8Array) {
          // deep.equal already compares the bytes; assert the TYPE survived, since a
          // mangled blob deep-equals a plain object of the same shape under some matchers.
          expect(column.minValue, `${label}: minValue is still a blob`).to.be.instanceOf(Uint8Array);
          expect(column.histogram!.buckets[0].upperBound, `${label}: bound is still a blob`)
            .to.be.instanceOf(Uint8Array);
        } else if (typeof value === 'bigint') {
          expect(typeof column.maxValue, `${label}: maxValue is still a bigint`).to.equal('bigint');
          expect(typeof column.histogram!.buckets[0].upperBound, `${label}: bound is still a bigint`)
            .to.equal('bigint');
        }
      }
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

    it('round-trips a JSON column with a real $bigint key nested under a $json key', () => {
      // Both keys collide with a marker name, at two different depths — each is
      // escaped independently on write and unescaped on read.
      const row: Row = [{ $json: { $bigint: 'also-not-a-bigint' } }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a marker nested inside an array inside an object', () => {
      const row: Row = [{ outer: { list: [1, 2, { $bigint: 'deep-not-a-bigint' }] } }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a colliding key that is not the first key of its object', () => {
      // Escaping this key yields `{"a":1,"$$blob":"fake"}` — no `{"$` sigil
      // anywhere, so the gate must also recognize the `"$$` escape sigil.
      const row: Row = [{ a: 1, $blob: 'fake' }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a user key that already looks like an escaped marker key', () => {
      // `$$bigint` escapes to `$$$bigint`, so it cannot be confused on read-back
      // with a genuinely escaped `$bigint`.
      const row: Row = [{ $$bigint: 'x', $bigint: 'y' }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('leaves non-marker keys starting with $ untouched', () => {
      const row: Row = [{ $ref: 'a', $bigintish: 'b', $: 'c' }];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('round-trips a marker-shaped object nested inside a blob-free array column', () => {
      const row: Row = [[{ $blob: 'fake' }, { $json: { $blob: 'also-fake' } }]];
      expect(deserializeRow(serializeRow(row))).to.deep.equal(row);
    });

    it('preserves an own __proto__ key alongside a colliding key', () => {
      // Key rewriting must define own properties, not assign them — assigning
      // `__proto__` would invoke the prototype setter, dropping the key and
      // re-pointing the object's prototype.
      const row: Row = [JSON.parse('{"__proto__":{"polluted":true},"$bigint":"x"}') as SqlValue];
      const result = deserializeRow(serializeRow(row));
      const value = result[0] as Record<string, unknown>;

      expect(Object.keys(value)).to.deep.equal(['__proto__', '$bigint']);
      expect(Object.getPrototypeOf(value)).to.equal(Object.prototype);
      expect(value.$bigint).to.equal('x');
    });

    it('preserves an own __proto__ key alongside an escaped-lookalike key', () => {
      const row: Row = [JSON.parse('{"__proto__":{"polluted":true},"$$blob":"y"}') as SqlValue];
      const result = deserializeRow(serializeRow(row));
      const value = result[0] as Record<string, unknown>;

      expect(Object.keys(value)).to.deep.equal(['__proto__', '$$blob']);
      expect(Object.getPrototypeOf(value)).to.equal(Object.prototype);
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

