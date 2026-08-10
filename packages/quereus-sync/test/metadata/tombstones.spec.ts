/**
 * Tests for TombstoneStore.
 */

import { expect } from 'chai';
import { TombstoneStore, serializeTombstone, deserializeTombstone, type Tombstone } from '../../src/metadata/tombstones.js';
import { RAW_PK_KEYING } from '../../src/metadata/keys.js';
import { type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { InMemoryKVStore } from '@quereus/store';

describe('Tombstone', () => {
  describe('serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const siteId = generateSiteId();
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(Date.now()), counter: 42, siteId, opSeq: 0 },
        pk: [1],
        createdAt: Date.now(),
      };

      const serialized = serializeTombstone(tombstone);
      const deserialized = deserializeTombstone(serialized);

      expect(deserialized.hlc.wallTime).to.equal(tombstone.hlc.wallTime);
      expect(deserialized.hlc.counter).to.equal(tombstone.hlc.counter);
      expect(deserialized.createdAt).to.equal(tombstone.createdAt);
    });

    it('always carries the pk payload past the 38-byte head; priorRow stays absent', () => {
      const siteId = generateSiteId();
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(1234567890), counter: 7, siteId, opSeq: 0 },
        pk: [1],
        createdAt: 1700000000000,
      };

      const serialized = serializeTombstone(tombstone);
      // The payload is unconditional now: the raw pk must always be recoverable
      // from the value (the key holds only the lossy identity).
      expect(serialized.byteLength).to.be.greaterThan(38);

      const deserialized = deserializeTombstone(serialized);
      expect(deserialized.pk).to.deep.equal([1]);
      expect(deserialized.priorRow).to.be.undefined;
      expect(deserialized.createdAt).to.equal(tombstone.createdAt);
    });

    it('round-trips a priorRow with text/number/null cells', () => {
      const siteId = generateSiteId();
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 },
        pk: [1],
        createdAt: 1700000000001,
        priorRow: [1, 'Alice', null],
      };

      const serialized = serializeTombstone(tombstone);
      expect(serialized.byteLength).to.be.greaterThan(38);
      expect(deserializeTombstone(serialized).priorRow).to.deep.equal([1, 'Alice', null]);
    });

    it('round-trips Uint8Array and bigint cells in priorRow', () => {
      const siteId = generateSiteId();
      const blob = new Uint8Array([1, 2, 3, 250]);
      const big = 9007199254740993n; // beyond Number.MAX_SAFE_INTEGER
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(3000), counter: 0, siteId, opSeq: 0 },
        pk: [1],
        createdAt: 1700000000002,
        priorRow: [big, blob, 'x'],
      };

      const deserialized = deserializeTombstone(serializeTombstone(tombstone));
      expect(deserialized.priorRow).to.not.be.undefined;
      expect(deserialized.priorRow![0]).to.equal(big);
      expect(deserialized.priorRow![1]).to.be.instanceOf(Uint8Array);
      expect(Array.from(deserialized.priorRow![1] as Uint8Array)).to.deep.equal([1, 2, 3, 250]);
      expect(deserialized.priorRow![2]).to.equal('x');
    });

    it('preserves an empty priorRow as present (distinct from absent)', () => {
      // An empty row image still serializes past the 38-byte head and round-trips
      // to [] — not undefined — so "deleted a zero-column row" is not confused with
      // "no before-image captured".
      const siteId = generateSiteId();
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(4000), counter: 0, siteId, opSeq: 0 },
        pk: [1],
        createdAt: 1700000000003,
        priorRow: [],
      };

      const serialized = serializeTombstone(tombstone);
      expect(serialized.byteLength).to.be.greaterThan(38);
      expect(deserializeTombstone(serialized).priorRow).to.deep.equal([]);
    });
  });

  describe('TombstoneStore', () => {
    let store: TombstoneStore;
    let kv: InMemoryKVStore;
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

    beforeEach(() => {
      kv = new InMemoryKVStore();
      store = new TombstoneStore(kv, TTL, () => RAW_PK_KEYING);
    });

    it('should store and retrieve tombstones', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], hlc);
      const retrieved = await store.getTombstone('main', 'users', [1]);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.hlc.counter).to.equal(1);
    });

    it('should return undefined for non-existent tombstones', async () => {
      const result = await store.getTombstone('main', 'users', [999]);
      expect(result).to.be.undefined;
    });

    it('should persist and retrieve priorRow on the tombstone', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], hlc, [1, 'Alice', null]);
      const retrieved = await store.getTombstone('main', 'users', [1]);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.priorRow).to.deep.equal([1, 'Alice', null]);
    });

    it('should omit priorRow when none is provided', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], hlc);
      const retrieved = await store.getTombstone('main', 'users', [1]);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.priorRow).to.be.undefined;
    });

    it('delete -> reinsert -> delete keeps the latest row image', async () => {
      const siteId = generateSiteId();
      const firstDelete: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };
      const secondDelete: HLC = { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 };

      // First delete records the original image; after a reinsert at the same pk a
      // later delete overwrites the (same-key) tombstone, so the survivor carries
      // the LATEST delete's row image — never a stale earlier one.
      await store.setTombstone('main', 'users', [1], firstDelete, [1, 'Alice']);
      await store.setTombstone('main', 'users', [1], secondDelete, [1, 'Alice v2']);

      const retrieved = await store.getTombstone('main', 'users', [1]);
      expect(retrieved!.hlc.wallTime).to.equal(2000n);
      expect(retrieved!.priorRow).to.deep.equal([1, 'Alice v2']);
    });

    it('should block writes when tombstone exists and resurrection not allowed', async () => {
      const siteId = generateSiteId();
      const deleteHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 };
      const writeHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], deleteHLC);

      // Write with older HLC should be blocked
      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, false);
      expect(isBlocked).to.be.true;
    });

    it('should allow resurrection when enabled', async () => {
      const siteId = generateSiteId();
      const deleteHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };
      const writeHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId, opSeq: 0 };

      await store.setTombstone('main', 'users', [1], deleteHLC);

      // Write with newer HLC should not be blocked when resurrection allowed
      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, true);
      expect(isBlocked).to.be.false;
    });

    it('should not block when no tombstone exists', async () => {
      const siteId = generateSiteId();
      const writeHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId, opSeq: 0 };

      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, false);
      expect(isBlocked).to.be.false;
    });
  });
});

