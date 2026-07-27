/**
 * Tests for change-log key encoding.
 *
 * These assert the load-bearing invariant of the HLC-indexed change log:
 * the lexicographic byte order of the keys MUST equal `compareHLC`, so that a
 * range scan over the key space visits entries in HLC order. The opSeq bytes
 * sit after siteId (the last tiebreak), so they must round-trip and must order
 * facts of the same transaction.
 */

import { expect } from 'chai';
import { type HLC, compareHLC, createHLC } from '../../src/clock/hlc.js';
import {
  serializeHLCForKey,
  deserializeHLCFromKey,
  buildChangeLogKey,
  parseChangeLogKey,
  buildChangeLogScanBoundsAfter,
  buildColumnVersionKey,
  parseColumnVersionKey,
  encodeRawPkIdentity,
  encodePkIdentity,
  RAW_PK_KEYING,
} from '../../src/metadata/keys.js';

const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const siteB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Lexicographic comparison of two byte arrays (the KV store's key order). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('change-log key encoding', () => {
  describe('serializeHLCForKey / deserializeHLCFromKey', () => {
    it('should round-trip a 30-byte HLC component including opSeq', () => {
      const hlc = createHLC(1234567890123n, 42, siteA, 0xCAFEBABE);
      const bytes = serializeHLCForKey(hlc);
      expect(bytes.length).to.equal(30);

      const back = deserializeHLCFromKey(bytes);
      expect(back.wallTime).to.equal(hlc.wallTime);
      expect(back.counter).to.equal(hlc.counter);
      expect(back.opSeq).to.equal(0xCAFEBABE);
      expect(compareHLC(back, hlc)).to.equal(0);
    });

    it('should place opSeq after siteId so byte order == compareHLC', () => {
      // A representative set spanning every component, intentionally NOT sorted.
      const hlcs: HLC[] = [
        createHLC(2000n, 0, siteA, 0),     // wallTime dominates
        createHLC(1000n, 2, siteA, 0),     // counter beats siteId/opSeq
        createHLC(1000n, 1, siteB, 0),     // siteId beats opSeq
        createHLC(1000n, 1, siteA, 5),     // opSeq is the last tiebreak
        createHLC(1000n, 1, siteA, 0),
        createHLC(1000n, 0, siteA, 0xFFFFFFFF),
      ];

      for (const x of hlcs) {
        for (const y of hlcs) {
          const byCompare = sign(compareHLC(x, y));
          const byBytes = sign(compareBytes(serializeHLCForKey(x), serializeHLCForKey(y)));
          expect(byBytes).to.equal(byCompare,
            `byte order disagreed with compareHLC for ${x.opSeq} vs ${y.opSeq}`);
        }
      }
    });

    it('should keep a counter rollover ordered above an opSeq increment', () => {
      // (counter+1, opSeq 0) must outrank (same counter, large opSeq).
      const opBump = createHLC(1000n, 1, siteA, 0xFFFFFFFF);
      const counterBump = createHLC(1000n, 2, siteA, 0);
      expect(compareHLC(opBump, counterBump)).to.be.lessThan(0);
      expect(sign(compareBytes(serializeHLCForKey(opBump), serializeHLCForKey(counterBump))))
        .to.equal(-1);
    });
  });

  describe('buildChangeLogKey / parseChangeLogKey', () => {
    it('should round-trip a column entry at the new 30-byte offsets', () => {
      const hlc = createHLC(1000n, 7, siteA, 99);
      const identity = encodeRawPkIdentity([1, 'x']);
      const key = buildChangeLogKey(hlc, 'column', 'main', 'users', identity, 'name');
      // cl:(3) + hlc(30) + type(1) + suffix
      expect(key.length).to.be.greaterThan(34);

      const parsed = parseChangeLogKey(key);
      expect(parsed).to.not.be.null;
      expect(parsed!.entryType).to.equal('column');
      expect(parsed!.schema).to.equal('main');
      expect(parsed!.table).to.equal('users');
      expect(parsed!.column).to.equal('name');
      expect(parsed!.identity).to.equal(identity);
      expect(parsed!.hlc.opSeq).to.equal(99);
      expect(compareHLC(parsed!.hlc, hlc)).to.equal(0);
    });

    it('should round-trip a delete entry (no column)', () => {
      const hlc = createHLC(1000n, 1, siteB, 3);
      const identity = encodeRawPkIdentity([42]);
      const key = buildChangeLogKey(hlc, 'delete', 'main', 'orders', identity);
      const parsed = parseChangeLogKey(key);
      expect(parsed).to.not.be.null;
      expect(parsed!.entryType).to.equal('delete');
      expect(parsed!.column).to.be.undefined;
      expect(parsed!.identity).to.equal(identity);
      expect(parsed!.hlc.opSeq).to.equal(3);
    });

    it('should produce keys whose byte order matches compareHLC', () => {
      const hlcs: HLC[] = [
        createHLC(1000n, 1, siteA, 0),
        createHLC(1000n, 1, siteA, 1),
        createHLC(1000n, 1, siteA, 2),
        createHLC(1000n, 1, siteB, 0),
        createHLC(1000n, 2, siteA, 0),
        createHLC(2000n, 0, siteA, 0),
      ];
      const keyFor = (h: HLC): Uint8Array =>
        buildChangeLogKey(h, 'column', 'main', 't', encodeRawPkIdentity([1]), 'c');

      for (const x of hlcs) {
        for (const y of hlcs) {
          expect(sign(compareBytes(keyFor(x), keyFor(y))))
            .to.equal(sign(compareHLC(x, y)));
        }
      }
    });

    it('should reject buffers shorter than the minimum length', () => {
      expect(parseChangeLogKey(new Uint8Array(34))).to.be.null;
    });
  });

  describe('buildChangeLogScanBoundsAfter', () => {
    it('should exclude <= sinceHLC (incl. non-zero opSeq) and include the next', () => {
      // sinceHLC is the last fact of a transaction (opSeq 5).
      const since = createHLC(1000n, 1, siteA, 5);
      const next = createHLC(1000n, 1, siteA, 6); // next fact, strictly after
      const { gte, lt } = buildChangeLogScanBoundsAfter(since);

      const sinceKey = buildChangeLogKey(since, 'column', 'main', 't', encodeRawPkIdentity([1]), 'c');
      const nextKey = buildChangeLogKey(next, 'column', 'main', 't', encodeRawPkIdentity([1]), 'c');

      // The boundary entry itself is excluded (key < gte).
      expect(compareBytes(sinceKey, gte)).to.be.lessThan(0);
      // The next entry is included (gte <= key < lt).
      expect(compareBytes(nextKey, gte)).to.be.greaterThanOrEqual(0);
      expect(compareBytes(nextKey, lt)).to.be.lessThan(0);
    });

    it('should exclude an equal-(wallTime,counter,site) entry with smaller opSeq', () => {
      const since = createHLC(5000n, 3, siteB, 10);
      const { gte } = buildChangeLogScanBoundsAfter(since);
      const earlier = createHLC(5000n, 3, siteB, 0);
      const earlierKey = buildChangeLogKey(earlier, 'delete', 'main', 't', encodeRawPkIdentity([7]));
      expect(compareBytes(earlierKey, gte)).to.be.lessThan(0);
    });

    it('rejects a table name carrying an unpaired surrogate rather than folding it to U+FFFD', () => {
      // Mirrors @quereus/store's catalog-key guard (bug-store-catalog-key-lone-surrogate-
      // identifier-collision): `TextEncoder` folds an unpaired surrogate to U+FFFD, so two
      // distinct table names differing only in a lone surrogate would otherwise share one
      // change-log key prefix. `buildChangeLogKey` guards the schema/table/column identifier
      // arguments via `assertNoUnpairedSurrogate` (imported from `@quereus/store`) before
      // building the key.
      const hlc = createHLC(1000n, 1, siteA, 0);
      const identity = encodeRawPkIdentity([1]);
      expect(() => buildChangeLogKey(hlc, 'column', 'main', '\uD800', identity, 'c'))
        .to.throw(/unpaired surrogate/i);
      expect(() => buildChangeLogKey(hlc, 'column', 'main', 't', identity, '\uD800'))
        .to.throw(/unpaired surrogate/i);
    });

    it('should carry from opSeq into siteId when opSeq is at max (0xFFFFFFFF)', () => {
      // The generic last-byte increment must roll all four opSeq bytes to 0 and
      // carry into the low byte of siteId — there is no opSeq beyond max, so the
      // next possible key is (wallTime, counter, siteId+1, opSeq 0).
      const since = createHLC(1000n, 1, siteA, 0xFFFFFFFF);
      const { gte } = buildChangeLogScanBoundsAfter(since);

      // Decode the HLC component of gte (skip the 3-byte 'cl:' prefix).
      const carried = deserializeHLCFromKey(gte.slice(3, 33));
      expect(carried.wallTime).to.equal(1000n);
      expect(carried.counter).to.equal(1);
      expect(carried.opSeq).to.equal(0); // rolled over

      // siteA is [1, 0, …, 0]; the carry lands in the last siteId byte.
      const expectedSite = new Uint8Array(siteA);
      expectedSite[15] = 1;
      expect(Array.from(carried.siteId)).to.deep.equal(Array.from(expectedSite));

      // The boundary fact (max opSeq) is therefore excluded by the scan.
      const boundaryKey = buildChangeLogKey(since, 'column', 'main', 't', encodeRawPkIdentity([1]), 'c');
      expect(compareBytes(boundaryKey, gte)).to.be.lessThan(0);
    });
  });

  describe('encodePkIdentity / length-prefixed keys', () => {
    it('bigint and number pks of equal value share one identity (n: tag)', () => {
      expect(encodeRawPkIdentity([5n])).to.equal(encodeRawPkIdentity([5]));
      // The former JSON.stringify encoding threw outright on a bigint pk.
      expect(() => encodeRawPkIdentity([9007199254740993n])).to.not.throw();
    });

    it('normalizers and transforms shape the identity', () => {
      const nocase = { normalizers: [(v: string) => v.toLowerCase()], transforms: [undefined] };
      expect(encodePkIdentity(['APPLE'], nocase)).to.equal(encodePkIdentity(['apple'], nocase));
      const double = { normalizers: [], transforms: [(v: unknown) => (v as number) * 2] };
      expect(encodePkIdentity([2], double)).to.equal(encodePkIdentity([2], double));
      expect(encodePkIdentity([2], double)).to.not.equal(encodePkIdentity([2], RAW_PK_KEYING));
    });

    it('parses identity and column unambiguously even when both contain separators', () => {
      // A string pk containing ':' and a column name containing ':' — the length
      // prefix keeps the split exact where a last-colon split would misparse.
      const identity = encodeRawPkIdentity(['a:b']);
      const key = buildColumnVersionKey('main', 't', identity, 'col:on');
      const parsed = parseColumnVersionKey(key);
      expect(parsed).to.not.be.null;
      expect(parsed!.identity).to.equal(identity);
      expect(parsed!.column).to.equal('col:on');
    });

    it('null pk members produce a grouping identity, not a poisoned key', () => {
      expect(encodeRawPkIdentity([null])).to.equal(encodeRawPkIdentity([null]));
      expect(encodeRawPkIdentity([null])).to.not.equal(encodeRawPkIdentity(['']));
    });
  });

  describe('buildColumnVersionKey', () => {
    it('rejects a schema, table, or column name carrying an unpaired surrogate', () => {
      const identity = encodeRawPkIdentity([1]);
      expect(() => buildColumnVersionKey('\uD800', 't', identity, 'c')).to.throw(/unpaired surrogate/i);
      expect(() => buildColumnVersionKey('main', '\uD800', identity, 'c')).to.throw(/unpaired surrogate/i);
      expect(() => buildColumnVersionKey('main', 't', identity, '\uD800')).to.throw(/unpaired surrogate/i);
    });

    it('still builds a key for a clean identifier', () => {
      expect(() => buildColumnVersionKey('main', 't', encodeRawPkIdentity([1]), 'c')).to.not.throw();
    });
  });
});
