/**
 * Tests for ColumnVersionStore.
 */

import { expect } from 'chai';
import { ColumnVersionStore, serializeColumnVersion, deserializeColumnVersion, encodeSqlValue, decodeSqlValue, type ColumnVersion } from '../../src/metadata/column-version.js';
import type { HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { InMemoryKVStore } from '@quereus/store';

describe('ColumnVersion', () => {
  describe('serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(Date.now()), counter: 42, siteId, opSeq: 0 },
        value: 'test value',
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.hlc.wallTime).to.equal(version.hlc.wallTime);
      expect(deserialized.hlc.counter).to.equal(version.hlc.counter);
      expect(deserialized.value).to.equal(version.value);
    });

    it('should handle null values', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId, opSeq: 0 },
        value: null,
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.value).to.be.null;
    });

    it('should handle numeric values', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId, opSeq: 0 },
        value: 42.5,
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.value).to.equal(42.5);
    });

    it('should round-trip Uint8Array (blob) values', () => {
      const siteId = generateSiteId();
      const blob = new Uint8Array([0, 1, 127, 255, 65, 66, 67]);
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId, opSeq: 0 },
        value: blob,
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.value).to.be.instanceOf(Uint8Array);
      const result = deserialized.value as Uint8Array;
      expect(result.length).to.equal(blob.length);
      expect(Array.from(result)).to.deep.equal(Array.from(blob));
    });

    it('should omit the before-image when no prior version exists', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 },
        value: 'v2',
      };

      const deserialized = deserializeColumnVersion(serializeColumnVersion(version));

      expect(deserialized.value).to.equal('v2');
      // Absent, not undefined-valued: a prior-less version round-trips with no
      // before-image fields at all.
      expect(deserialized).to.not.have.property('priorHlc');
      expect(deserialized).to.not.have.property('priorValue');
    });

    it('should round-trip the before-image (prior value + prior hlc)', () => {
      const siteId = generateSiteId();
      const priorHlc: HLC = { wallTime: BigInt(1000), counter: 3, siteId, opSeq: 7 };
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 },
        value: 'v2',
        priorHlc,
        priorValue: 'v1',
      };

      const deserialized = deserializeColumnVersion(serializeColumnVersion(version));

      expect(deserialized.value).to.equal('v2');
      expect(deserialized.priorValue).to.equal('v1');
      expect(deserialized.priorHlc).to.not.be.undefined;
      expect(deserialized.priorHlc!.wallTime).to.equal(priorHlc.wallTime);
      expect(deserialized.priorHlc!.counter).to.equal(priorHlc.counter);
      expect(deserialized.priorHlc!.opSeq).to.equal(priorHlc.opSeq);
      expect(Array.from(deserialized.priorHlc!.siteId)).to.deep.equal(Array.from(siteId));
    });

    it('should round-trip a null before-image value', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 },
        value: 'v2',
        priorHlc: { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 },
        priorValue: null,
      };

      const deserialized = deserializeColumnVersion(serializeColumnVersion(version));

      // Prior present (so priorHlc survives) with a genuine null prior value.
      expect(deserialized.priorValue).to.be.null;
      expect(deserialized.priorHlc).to.not.be.undefined;
    });

    it('should round-trip a Uint8Array before-image value', () => {
      const siteId = generateSiteId();
      const priorBlob = new Uint8Array([0, 1, 127, 255, 7, 8]);
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 },
        value: 'v2',
        priorHlc: { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 },
        priorValue: priorBlob,
      };

      const deserialized = deserializeColumnVersion(serializeColumnVersion(version));

      expect(deserialized.priorValue).to.be.instanceOf(Uint8Array);
      expect(Array.from(deserialized.priorValue as Uint8Array)).to.deep.equal(Array.from(priorBlob));
    });

    it('should round-trip a bigint before-image value', () => {
      const siteId = generateSiteId();
      const priorBig = 9007199254740993n; // beyond Number.MAX_SAFE_INTEGER
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 },
        value: 'v2',
        priorHlc: { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 },
        priorValue: priorBig,
      };

      const deserialized = deserializeColumnVersion(serializeColumnVersion(version));

      expect(deserialized.priorValue).to.equal(priorBig);
    });

    it('should recover legacy corrupted Uint8Array format', () => {
      // Simulate old corrupted format: JSON.stringify(Uint8Array) â†’ {"0":65,"1":66,"2":67}
      const corrupted = { '0': 65, '1': 66, '2': 67 };
      const recovered = decodeSqlValue(corrupted);

      expect(recovered).to.be.instanceOf(Uint8Array);
      expect(Array.from(recovered as Uint8Array)).to.deep.equal([65, 66, 67]);
    });

    it('should not misidentify normal objects as corrupted Uint8Array', () => {
      // Object with non-consecutive keys
      expect(decodeSqlValue({ '0': 65, '2': 67 })).to.deep.equal({ '0': 65, '2': 67 });
      // Object with non-byte values
      expect(decodeSqlValue({ '0': 300 })).to.deep.equal({ '0': 300 });
      // Object with string values
      expect(decodeSqlValue({ '0': 'a' })).to.deep.equal({ '0': 'a' });
      // Normal string/number values pass through
      expect(decodeSqlValue('hello')).to.equal('hello');
      expect(decodeSqlValue(42)).to.equal(42);
      expect(decodeSqlValue(null)).to.equal(null);
    });
  });

  describe('ColumnVersionStore', () => {
    let store: ColumnVersionStore;
    let kv: InMemoryKVStore;

    beforeEach(() => {
      kv = new InMemoryKVStore();
      store = new ColumnVersionStore(kv);
    });

    it('should store and retrieve column versions', async () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId, opSeq: 0 },
        value: 'hello',
      };

      await store.setColumnVersion('main', 'users', [1], 'name', version);
      const retrieved = await store.getColumnVersion('main', 'users', [1], 'name');

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.value).to.equal('hello');
    });

    it('should return undefined for non-existent versions', async () => {
      const result = await store.getColumnVersion('main', 'users', [999], 'name');
      expect(result).to.be.undefined;
    });

    it('should correctly determine if write should apply (LWW)', async () => {
      const siteId1 = generateSiteId();
      const siteId2 = generateSiteId();

      const olderHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId: siteId1, opSeq: 0 };
      const newerHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId: siteId2, opSeq: 0 };

      // Store older version
      await store.setColumnVersion('main', 'users', [1], 'name', { hlc: olderHLC, value: 'old' });

      // Newer HLC should apply
      const shouldApplyNewer = await store.shouldApplyWrite('main', 'users', [1], 'name', newerHLC);
      expect(shouldApplyNewer).to.be.true;

      // Older HLC should not apply
      const shouldApplyOlder = await store.shouldApplyWrite('main', 'users', [1], 'name', olderHLC);
      expect(shouldApplyOlder).to.be.false;
    });

    // Load-bearing for change-log cleanup: on delete, each column name recovered
    // by getRowVersions is fed straight back to buildChangeLogKey to locate that
    // column's log entry. A name that does not round-trip leaves a permanent orphan.
    it('recovers every column name exactly, including one containing the key separator', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };
      // ':' is legal in an identifier — key building rejects only unpaired surrogates.
      const columns = ['id', 'a:b', 'plain'];

      for (const column of columns) {
        await store.setColumnVersion('main', 'users', [1], column, { hlc, value: column });
      }

      const versions = await store.getRowVersions('main', 'users', [1]);

      expect([...versions.keys()].sort()).to.deep.equal([...columns].sort());
      for (const column of columns) {
        expect(versions.get(column)!.value).to.equal(column);
      }
    });

    it('recovers column names when the primary key value contains a colon', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };

      await store.setColumnVersion('main', 'users', ['x:y'], 'name', { hlc, value: 'v' });

      const versions = await store.getRowVersions('main', 'users', ['x:y']);
      expect([...versions.keys()]).to.deep.equal(['name']);
    });
  });
});

