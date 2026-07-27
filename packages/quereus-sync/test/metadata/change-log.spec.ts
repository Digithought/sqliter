/**
 * Tests for ChangeLogStore.
 */

import { expect } from 'chai';
import { ChangeLogStore } from '../../src/metadata/change-log.js';
import { RAW_PK_KEYING } from '../../src/metadata/keys.js';
import { type HLC, compareHLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { InMemoryKVStore } from '@quereus/store';

describe('ChangeLogStore', () => {
  let kv: InMemoryKVStore;
  let store: ChangeLogStore;
  let siteId: Uint8Array;

  beforeEach(() => {
    kv = new InMemoryKVStore();
    store = new ChangeLogStore(kv, () => RAW_PK_KEYING);
    siteId = generateSiteId();
  });

  describe('recordColumnChange', () => {
    it('should record a column change', async () => {
      const hlc: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 0 };

      await store.recordColumnChange(hlc, 'main', 'users', [1], 'name');

      // Verify by getting changes since before
      const sinceHLC: HLC = { wallTime: BigInt(500), counter: 0, siteId, opSeq: 0 };
      const entries = [];
      for await (const entry of store.getChangesSince(sinceHLC)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(1);
      expect(entries[0].schema).to.equal('main');
      expect(entries[0].table).to.equal('users');
      expect(entries[0].column).to.equal('name');
      expect(entries[0].entryType).to.equal('column');
    });
  });

  describe('recordDeletion', () => {
    it('should record a deletion', async () => {
      const hlc: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 0 };

      await store.recordDeletion(hlc, 'main', 'users', [1]);

      const sinceHLC: HLC = { wallTime: BigInt(500), counter: 0, siteId, opSeq: 0 };
      const entries = [];
      for await (const entry of store.getChangesSince(sinceHLC)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(1);
      expect(entries[0].entryType).to.equal('delete');
    });
  });

  describe('getChangesSince', () => {
    it('should filter by HLC', async () => {
      const hlc1: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 0 };
      const hlc2: HLC = { wallTime: BigInt(2000), counter: 1, siteId, opSeq: 0 };
      const hlc3: HLC = { wallTime: BigInt(3000), counter: 1, siteId, opSeq: 0 };

      await store.recordColumnChange(hlc1, 'main', 'users', [1], 'name');
      await store.recordColumnChange(hlc2, 'main', 'users', [2], 'name');
      await store.recordColumnChange(hlc3, 'main', 'users', [3], 'name');

      // Get changes since hlc1
      const entries = [];
      for await (const entry of store.getChangesSince(hlc1)) {
        entries.push(entry);
      }

      // Should only get hlc2 and hlc3
      expect(entries).to.have.lengthOf(2);
    });

    it('should return entries in HLC order', async () => {
      // Insert in reverse order
      const hlc3: HLC = { wallTime: BigInt(3000), counter: 1, siteId, opSeq: 0 };
      const hlc1: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 0 };
      const hlc2: HLC = { wallTime: BigInt(2000), counter: 1, siteId, opSeq: 0 };

      await store.recordColumnChange(hlc3, 'main', 'users', [3], 'name');
      await store.recordColumnChange(hlc1, 'main', 'users', [1], 'name');
      await store.recordColumnChange(hlc2, 'main', 'users', [2], 'name');

      const sinceHLC: HLC = { wallTime: BigInt(0), counter: 0, siteId, opSeq: 0 };
      const entries = [];
      for await (const entry of store.getChangesSince(sinceHLC)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(3);
      // Entries should be in HLC order
      expect(compareHLC(entries[0].hlc, entries[1].hlc)).to.be.lessThan(0);
      expect(compareHLC(entries[1].hlc, entries[2].hlc)).to.be.lessThan(0);
    });

    it('should exclude an entry whose only difference is a smaller opSeq boundary', async () => {
      // Two facts of the same transaction (same wallTime/counter/siteId),
      // discriminated only by opSeq. getChangesSince(opSeq=0) must EXCLUDE
      // opSeq 0 itself and INCLUDE opSeq 1 — the scan starts strictly after.
      const op0: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 0 };
      const op1: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 1 };

      await store.recordColumnChange(op0, 'main', 'users', [1], 'a');
      await store.recordColumnChange(op1, 'main', 'users', [1], 'b');

      const entries = [];
      for await (const entry of store.getChangesSince(op0)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(1);
      expect(entries[0].hlc.opSeq).to.equal(1);
      expect(entries[0].column).to.equal('b');
    });
  });

  describe('pruneEntriesBefore', () => {
    it('should prune strictly before the boundary, respecting opSeq', async () => {
      // Three facts of one transaction (opSeq 0,1,2). Prune before opSeq 2:
      // opSeq 0 and 1 go, opSeq 2 stays (boundary is exclusive).
      const op0: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 0 };
      const op1: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 1 };
      const op2: HLC = { wallTime: BigInt(1000), counter: 1, siteId, opSeq: 2 };

      await store.recordColumnChange(op0, 'main', 'users', [1], 'a');
      await store.recordColumnChange(op1, 'main', 'users', [1], 'b');
      await store.recordColumnChange(op2, 'main', 'users', [1], 'c');

      const pruned = await store.pruneEntriesBefore(op2);
      expect(pruned).to.equal(2);

      const remaining = [];
      for await (const entry of store.getAllChanges()) {
        remaining.push(entry);
      }

      expect(remaining).to.have.lengthOf(1);
      expect(remaining[0].hlc.opSeq).to.equal(2);
    });
  });
});

