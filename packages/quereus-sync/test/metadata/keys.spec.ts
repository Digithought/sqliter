/**
 * Tests for sync metadata key encoding.
 *
 * Two load-bearing invariants:
 *  - the lexicographic byte order of `cl:` keys MUST equal `compareHLC`, so that a
 *    range scan over the key space visits entries in HLC order. The opSeq bytes sit
 *    after siteId (the last tiebreak), so they must round-trip and must order facts
 *    of the same transaction;
 *  - every variable-length component (schema, table, pk identity, column) is
 *    length-prefixed, so a name containing `:` or `.` can neither shift a parse nor
 *    let one table's scan bounds swallow another's keys.
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
  buildTombstoneKey,
  parseTombstoneKey,
  buildSchemaMigrationKey,
  parseSchemaMigrationKey,
  buildTableColumnVersionScanBounds,
  buildColumnVersionScanBounds,
  buildTombstoneScanBounds,
  buildSchemaMigrationScanBounds,
  buildQuarantineKey,
  buildQuarantineScanBounds,
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

  // Every metadata key component — schema, table, pk identity, column — is
  // arbitrary user text: `create table "a:b" (...)` and `create table "a.b" (...)`
  // are both legal SQL. Before every component was length-prefixed, the
  // `{schema}.{table}:` prefix split at the first `.` and first `:`, so a table
  // named `a:b` either failed to parse (cv/cl — the record was silently dropped
  // from every sync path and deleted on the next snapshot apply) or parsed back
  // CONFIDENTLY WRONG as table `a` (tb — a tombstone that could delete a row of a
  // DIFFERENT table on the receiver). See bug-sync-metadata-key-delimiters-ambiguous.
  describe('separator-bearing identifiers round-trip through every key family', () => {
    const NASTY = ['a:b', 'a.b', 'x:y.z:', '.:', 'a'];

    it('parseColumnVersionKey recovers every component verbatim', () => {
      for (const schema of NASTY) {
        for (const table of NASTY) {
          const identity = encodeRawPkIdentity([`pk:${table}.`]);
          for (const column of NASTY) {
            const parsed = parseColumnVersionKey(buildColumnVersionKey(schema, table, identity, column));
            expect(parsed, `cv ${schema}/${table}/${column}`).to.not.be.null;
            expect(parsed!).to.deep.equal({ schema, table, identity, column });
          }
        }
      }
    });

    it('parseTombstoneKey recovers every component verbatim (no cross-table misattribution)', () => {
      for (const schema of NASTY) {
        for (const table of NASTY) {
          const identity = encodeRawPkIdentity([1]);
          const parsed = parseTombstoneKey(buildTombstoneKey(schema, table, identity));
          expect(parsed, `tb ${schema}/${table}`).to.not.be.null;
          expect(parsed!).to.deep.equal({ schema, table, identity });
        }
      }
    });

    it('parseSchemaMigrationKey recovers schema, table and version', () => {
      for (const schema of NASTY) {
        for (const table of NASTY) {
          const parsed = parseSchemaMigrationKey(buildSchemaMigrationKey(schema, table, 7));
          expect(parsed, `sm ${schema}/${table}`).to.not.be.null;
          expect(parsed!).to.deep.equal({ schema, table, version: 7 });
        }
      }
    });

    it('parseChangeLogKey recovers every component verbatim, column and delete alike', () => {
      const hlc = createHLC(1000n, 1, siteA, 0);
      for (const schema of NASTY) {
        for (const table of NASTY) {
          const identity = encodeRawPkIdentity(['a:b.c']);
          for (const column of NASTY) {
            const parsed = parseChangeLogKey(
              buildChangeLogKey(hlc, 'column', schema, table, identity, column));
            expect(parsed, `cl column ${schema}/${table}/${column}`).to.not.be.null;
            expect(parsed!.schema).to.equal(schema);
            expect(parsed!.table).to.equal(table);
            expect(parsed!.identity).to.equal(identity);
            expect(parsed!.column).to.equal(column);
          }

          const del = parseChangeLogKey(buildChangeLogKey(hlc, 'delete', schema, table, identity));
          expect(del, `cl delete ${schema}/${table}`).to.not.be.null;
          expect(del!.schema).to.equal(schema);
          expect(del!.table).to.equal(table);
          expect(del!.identity).to.equal(identity);
          expect(del!.column).to.be.undefined;
        }
      }
    });
  });

  describe('empty components and malformed keys', () => {
    it('a zero-length column still round-trips as a present component', () => {
      // The builders test `column !== undefined`, not truthiness: an empty column
      // must still emit its (empty) component, or a `column` entry would carry 3
      // parts where the parser demands 4 and read back as unparseable.
      const identity = encodeRawPkIdentity([1]);
      const cv = parseColumnVersionKey(buildColumnVersionKey('main', 't', identity, ''));
      expect(cv!.column).to.equal('');

      const hlc = createHLC(1000n, 1, siteA, 0);
      const cl = parseChangeLogKey(buildChangeLogKey(hlc, 'column', 'main', 't', identity, ''));
      expect(cl, 'an empty column name is still a parseable column entry').to.not.be.null;
      expect(cl!.column).to.equal('');
      expect(cl!.identity).to.equal(identity);
    });

    it('empty schema, table and identity round-trip', () => {
      const cv = parseColumnVersionKey(buildColumnVersionKey('', '', '', ''));
      expect(cv!).to.deep.equal({ schema: '', table: '', identity: '', column: '' });
      expect(parseTombstoneKey(buildTombstoneKey('', '', ''))!)
        .to.deep.equal({ schema: '', table: '', identity: '' });
    });

    it('parsers reject a foreign prefix, a truncated key, and the old v2 layout', () => {
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
      // Wrong family.
      expect(parseColumnVersionKey(enc('tb:4:main1:t'))).to.be.null;
      // Length runs past the end of the key.
      expect(parseColumnVersionKey(enc('cv:99:main'))).to.be.null;
      // Non-numeric length, and a leading separator.
      expect(parseTombstoneKey(enc('tb:x:main'))).to.be.null;
      expect(parseTombstoneKey(enc('tb::main'))).to.be.null;
      // Trailing bytes beyond the declared components.
      expect(parseTombstoneKey(enc('tb:1:a1:b1:c!'))).to.be.null;
      // A version-2 key (bare `.`/`:` layout) must not read back as version 3.
      expect(parseColumnVersionKey(enc('cv:main.t:3:s:1:v'))).to.be.null;
      expect(parseTombstoneKey(enc('tb:main.t:s:1'))).to.be.null;
      expect(parseSchemaMigrationKey(enc('sm:main.t:0000000007'))).to.be.null;
    });
  });

  describe('scan bounds stay exact under separator-bearing names', () => {
    const within = (key: Uint8Array, bounds: { gte: Uint8Array; lt: Uint8Array }): boolean =>
      compareBytes(key, bounds.gte) >= 0 && compareBytes(key, bounds.lt) < 0;

    // Sibling names chosen so a bare-`.`/bare-`:` layout would overlap: `a`'s
    // prefix `…a:` is a prefix of `a:b`'s `…a:b:` under the old encoding.
    const identity = encodeRawPkIdentity([1]);

    it('a table named "a" and one named "a:b" do not share cv: bounds', () => {
      const keyA = buildColumnVersionKey('main', 'a', identity, 'v');
      const keyAB = buildColumnVersionKey('main', 'a:b', identity, 'v');

      const boundsA = buildTableColumnVersionScanBounds('main', 'a');
      const boundsAB = buildTableColumnVersionScanBounds('main', 'a:b');

      expect(within(keyA, boundsA), '"a" in its own bounds').to.be.true;
      expect(within(keyAB, boundsAB), '"a:b" in its own bounds').to.be.true;
      expect(within(keyAB, boundsA), '"a:b" must NOT scan under "a"').to.be.false;
      expect(within(keyA, boundsAB), '"a" must NOT scan under "a:b"').to.be.false;
    });

    it('tb: and sm: bounds are likewise disjoint for "a" vs "a:b"', () => {
      const tbA = buildTombstoneKey('main', 'a', identity);
      const tbAB = buildTombstoneKey('main', 'a:b', identity);
      expect(within(tbA, buildTombstoneScanBounds('main', 'a'))).to.be.true;
      expect(within(tbAB, buildTombstoneScanBounds('main', 'a'))).to.be.false;
      expect(within(tbA, buildTombstoneScanBounds('main', 'a:b'))).to.be.false;

      const smA = buildSchemaMigrationKey('main', 'a', 1);
      const smAB = buildSchemaMigrationKey('main', 'a:b', 1);
      expect(within(smA, buildSchemaMigrationScanBounds('main', 'a'))).to.be.true;
      expect(within(smAB, buildSchemaMigrationScanBounds('main', 'a'))).to.be.false;
      expect(within(smA, buildSchemaMigrationScanBounds('main', 'a:b'))).to.be.false;
    });

    it('a row scan does not pick up a different row whose identity extends it', () => {
      // encodeRawPkIdentity('a') vs 'ab': one identity is a prefix of the other.
      const idA = encodeRawPkIdentity(['a']);
      const idAB = encodeRawPkIdentity(['ab']);
      const keyA = buildColumnVersionKey('main', 't', idA, 'v');
      const keyAB = buildColumnVersionKey('main', 't', idAB, 'v');

      expect(within(keyA, buildColumnVersionScanBounds('main', 't', idA))).to.be.true;
      expect(within(keyAB, buildColumnVersionScanBounds('main', 't', idA))).to.be.false;
      expect(within(keyA, buildColumnVersionScanBounds('main', 't', idAB))).to.be.false;
    });

    it('the schema-only quarantine prefix cannot match a different schema', () => {
      const hlc = createHLC(1000n, 1, siteA, 0);
      const inS = buildQuarantineKey('s', 't', hlc, 'column', [1], 'v');
      const inSx = buildQuarantineKey('s:x', 't', hlc, 'column', [1], 'v');

      expect(within(inS, buildQuarantineScanBounds('s')), '"s" entry under schema "s"').to.be.true;
      expect(within(inSx, buildQuarantineScanBounds('s')), '"s:x" must NOT scan under "s"').to.be.false;
      expect(within(inSx, buildQuarantineScanBounds('s:x'))).to.be.true;

      // Per-table form: table "t" must not swallow table "t:u".
      const inTU = buildQuarantineKey('s', 't:u', hlc, 'column', [1], 'v');
      expect(within(inS, buildQuarantineScanBounds('s', 't'))).to.be.true;
      expect(within(inTU, buildQuarantineScanBounds('s', 't'))).to.be.false;

      // The no-argument (GC sweep) form still covers everything.
      const all = buildQuarantineScanBounds();
      expect(within(inS, all) && within(inSx, all) && within(inTU, all)).to.be.true;
    });
  });
});
