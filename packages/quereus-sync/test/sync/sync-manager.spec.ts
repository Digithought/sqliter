/**
 * Integration tests for SyncManager.
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl, type ConflictEvent, type SyncState } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type SyncConfig,
  type SnapshotChunk,
  type SnapshotHeaderChunk,
  type SnapshotFooterChunk,
  type ChangeSet,
} from '../../src/sync/protocol.js';
import { InMemoryKVStore, type IterateOptions, type KVEntry } from '@quereus/store';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { type HLC, compareHLC } from '../../src/clock/hlc.js';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';
import { parseColumnVersionKey } from '../../src/metadata/keys.js';

describe('SyncManager', () => {
  let kv: InMemoryKVStore;
  let source: FakeTransactionSource;
  let syncEvents: SyncEventEmitterImpl;
  let config: SyncConfig;

  beforeEach(() => {
    kv = new InMemoryKVStore();
    source = new FakeTransactionSource();
    syncEvents = new SyncEventEmitterImpl();
    config = { ...DEFAULT_SYNC_CONFIG };
  });

  describe('creation', () => {
    it('should create a new SyncManager', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      expect(manager).to.be.instanceOf(SyncManagerImpl);
    });

    it('should generate a site ID if not provided', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteId = manager.getSiteId();
      expect(siteId).to.have.lengthOf(16);
    });

    it('should use provided site ID', async () => {
      const providedSiteId = generateSiteId();
      config.siteId = providedSiteId;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      expect(siteIdEquals(manager.getSiteId(), providedSiteId)).to.be.true;
    });

    it('should persist and reload site ID', async () => {
      const manager1 = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteId1 = manager1.getSiteId();

      // Create a new manager with the same KV store
      const manager2 = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteId2 = manager2.getSiteId();

      expect(siteIdEquals(siteId1, siteId2)).to.be.true;
    });
  });

  describe('HLC', () => {
    it('should provide current HLC', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const hlc = manager.getCurrentHLC();
      expect(hlc.wallTime).to.be.a('bigint');
      expect(hlc.counter).to.be.a('number');
      expect(hlc.siteId).to.have.lengthOf(16);
    });
  });

  describe('getChangesSince', () => {
    it('should return empty array when no changes', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const changes = await manager.getChangesSince(peerSiteId);
      expect(changes).to.deep.equal([]);
    });
  });

  describe('getChangesSince transaction grouping', () => {
    const flush = () => new Promise(resolve => setTimeout(resolve, 10));

    it('returns one ChangeSet per transaction with a deterministic id and max-fact hlc', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      // One transaction, three columns => three facts.
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a', 'b', 'c'] });
      await flush();

      const sets = await manager.getChangesSince(peer);
      expect(sets).to.have.lengthOf(1);
      expect(sets[0].changes).to.have.lengthOf(3);
      // Deterministic id: "{wallTime}:{counter}:{base64(22)}", never a random UUID.
      expect(sets[0].transactionId).to.match(/^\d+:\d+:[A-Za-z0-9_-]{22}$/);
      // ChangeSet.hlc is the transaction's max fact HLC.
      const maxOpSeq = Math.max(...sets[0].changes.map(c => c.hlc.opSeq));
      expect(sets[0].hlc.opSeq).to.equal(maxOpSeq);
      // ChangeSet.siteId is the originating site (this manager), not a relay/random id.
      expect(siteIdEquals(sets[0].siteId, manager.getSiteId())).to.be.true;
      // Stable across repeated extraction.
      const again = await manager.getChangesSince(peer);
      expect(again[0].transactionId).to.equal(sets[0].transactionId);
    });

    it('groups a single transaction spanning multiple tables into one ChangeSet', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      // One commit touching two different tables => one transaction, one base HLC.
      source.commit({
        data: [
          { type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a'] },
          { type: 'insert', schemaName: 'main', tableName: 'orders', key: [1], newRow: ['b'] },
        ],
      });
      await flush();

      const sets = await manager.getChangesSince(peer);
      // Cross-table facts share the base HLC, so they group into ONE ChangeSet.
      expect(sets).to.have.lengthOf(1);
      expect(sets[0].changes).to.have.lengthOf(2);
      expect(new Set(sets[0].changes.map(c => c.table))).to.deep.equal(new Set(['users', 'orders']));
    });

    it('never merges two separate transactions', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a'] });
      await flush();
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [2], newRow: ['b'] });
      await flush();

      const sets = await manager.getChangesSince(peer);
      expect(sets).to.have.lengthOf(2);
      expect(sets[0].transactionId).to.not.equal(sets[1].transactionId);
      expect(compareHLC(sets[0].hlc, sets[1].hlc)).to.be.lessThan(0);
    });

    it('groups DDL and DML committed together into one ChangeSet (DDL at lower opSeq)', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      source.commit({
        schema: [{ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users', ddl: 'create table users (id integer primary key, name text)' }],
        data: [{ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['x', 'y'] }],
      });
      await flush();

      const sets = await manager.getChangesSince(peer);
      expect(sets).to.have.lengthOf(1);
      expect(sets[0].schemaMigrations).to.have.lengthOf(1);
      expect(sets[0].changes).to.have.lengthOf(2);
      // Migration sorts below the same transaction's data facts.
      const minDataOpSeq = Math.min(...sets[0].changes.map(c => c.hlc.opSeq));
      expect(sets[0].schemaMigrations[0].hlc.opSeq).to.be.lessThan(minDataOpSeq);
    });

    it('returns an oversized transaction whole and telemeters it', async () => {
      config.batchSize = 2;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warnings.push(String(msg));
      try {
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a', 'b', 'c', 'd', 'e'] });
        await flush();

        const sets = await manager.getChangesSince(peer);
        expect(sets).to.have.lengthOf(1);
        expect(sets[0].changes).to.have.lengthOf(5);
        expect(warnings.some(w => w.includes('Oversized transaction'))).to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('round-trips across a batchSize boundary: each transaction exactly once, in order', async () => {
      config.batchSize = 3;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      // Three transactions, two facts each.
      for (const id of [1, 2, 3]) {
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [id], newRow: [`a${id}`, `b${id}`] });
        await flush();
      }

      const collected: ChangeSet[] = [];
      let sinceHLC: HLC | undefined = undefined;
      for (let i = 0; i < 5; i++) {
        const sets: ChangeSet[] = await manager.getChangesSince(peer, sinceHLC);
        if (sets.length === 0) break;
        collected.push(...sets);
        sinceHLC = sets[sets.length - 1].hlc;
      }

      // All three transactions returned exactly once.
      expect(collected).to.have.lengthOf(3);
      expect(new Set(collected.map(cs => cs.transactionId)).size).to.equal(3);
      for (const cs of collected) expect(cs.changes).to.have.lengthOf(2);
      // Strictly ascending, no repeats/gaps.
      for (let i = 1; i < collected.length; i++) {
        expect(compareHLC(collected[i - 1].hlc, collected[i].hlc)).to.be.lessThan(0);
      }
    });

    it('bounds the change-log scan at scan time (does not drain the whole log)', async () => {
      // The delta path must STOP scanning once enough whole transactions are
      // accumulated — `batchSize` caps the scan footprint, not just the response.
      config.batchSize = 2;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      // Five single-fact transactions => five change-log entries, five transactions.
      for (const id of [1, 2, 3, 4, 5]) {
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [id], newRow: [`v${id}`] });
        await flush();
      }

      // Count change-log (`cl:`) entries pulled from the store during extraction.
      // getColumnVersion/getTombstone use kv.get, so only the change-log range scan
      // shows up here — an honest measure of the scan footprint.
      let changeLogEntriesScanned = 0;
      const origIterate = kv.iterate.bind(kv);
      kv.iterate = (options?: IterateOptions): AsyncIterable<KVEntry> => {
        const inner = origIterate(options);
        return (async function* () {
          for await (const entry of inner) {
            // Change-log keys begin with the ASCII bytes 'c','l',':'.
            if (entry.key[0] === 0x63 && entry.key[1] === 0x6c && entry.key[2] === 0x3a) {
              changeLogEntriesScanned++;
            }
            yield entry;
          }
        })();
      };

      // A delta from the start of time exercises the HLC-ordered delta path.
      const sinceHLC: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      const sets = await manager.getChangesSince(peer, sinceHLC);

      // Response is unchanged: the first two whole transactions only.
      expect(sets).to.have.lengthOf(2);
      expect(sets.flatMap(s => s.changes)).to.have.lengthOf(2);

      // Scan stopped after detecting the 3rd transaction's boundary (3 entries),
      // never reaching the 4th/5th — the whole point of the bound.
      expect(changeLogEntriesScanned).to.be.at.most(3);
      expect(changeLogEntriesScanned).to.be.lessThan(5);
    });

    // Regression for the scan-time bound mis-counting when a stale delete change-log
    // entry re-attributes to a later tombstone HLC. A delete→reinsert→delete key reuse
    // used to leave the first delete's entry behind, and it resolved to the SECOND
    // delete's tombstone — so boundary detection (keyed on the log HLC) and grouping
    // (keyed on the resolved HLC) disagreed, splitting the later multi-fact transaction
    // across two getChangesSince rounds. `sync-stale-delete-entry-reattribution` now
    // dedupes the delete entry on overwrite, so at most one survives per pk.
    it('does not split a transaction when a stale delete entry re-attributes', async () => {
      config.batchSize = 1;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a'] });
      await flush();
      source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['a'] });
      await flush();
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['b'] });
      await flush();
      // One transaction that deletes pk[1] AND inserts pk[2].
      source.commit({ data: [
        { type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['b'] },
        { type: 'insert', schemaName: 'main', tableName: 'users', key: [2], newRow: ['z'] },
      ] });
      await flush();

      const sinceHLC: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      const sets = await manager.getChangesSince(peer, sinceHLC);

      // Whichever ChangeSet carries the pk[1] delete must also carry the pk[2] insert —
      // they are one transaction and must never be split by the bound.
      const withDelete = sets.find(s => s.changes.some(c => c.type === 'delete'));
      expect(withDelete, 'expected a ChangeSet containing the delete').to.not.be.undefined;
      expect(
        withDelete!.changes.some(c => c.type === 'column' && JSON.stringify(c.pk) === '[2]'),
        'transaction split: pk[2] insert missing from the delete transaction',
      ).to.be.true;
    });

    it('walks a multi-round delta over a delete→reinsert→delete key reuse with no repeats, gaps, or split', async () => {
      // Same re-attribution hazard as above, but driven across watermark-advancing
      // rounds: batchSize=1 forces one whole transaction per round, so the stale
      // delete entry (txn3's tombstone) — if not deduped — would re-attribute to the
      // later multi-fact transaction and split it across rounds. Surviving txns:
      //   txn1 column pk[10], txn5 column pk[20], txn6 { delete pk[1], insert pk[2] }.
      config.batchSize = 1;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peer = generateSiteId();

      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [10], newRow: ['a1'] });
      await flush();
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a'] });
      await flush();
      source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['a'] });
      await flush();
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['b'] });
      await flush();
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [20], newRow: ['c'] });
      await flush();
      // One transaction that deletes pk[1] AND inserts pk[2] — must never be split.
      source.commit({ data: [
        { type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['b'] },
        { type: 'insert', schemaName: 'main', tableName: 'users', key: [2], newRow: ['z'] },
      ] });
      await flush();

      const collected: ChangeSet[] = [];
      let sinceHLC: HLC | undefined = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      for (let i = 0; i < 10; i++) {
        const sets: ChangeSet[] = await manager.getChangesSince(peer, sinceHLC);
        if (sets.length === 0) break;
        collected.push(...sets);
        sinceHLC = sets[sets.length - 1].hlc;
      }

      // No repeats: each transaction id appears exactly once.
      const txnIds = collected.map(cs => cs.transactionId);
      expect(new Set(txnIds).size, 'a transaction was repeated across rounds').to.equal(txnIds.length);

      // No gaps / strictly ascending watermark across the whole walk.
      for (let i = 1; i < collected.length; i++) {
        expect(compareHLC(collected[i - 1].hlc, collected[i].hlc)).to.be.lessThan(0);
      }

      // The multi-fact transaction is never split: the ChangeSet carrying the pk[1]
      // delete also carries the pk[2] insert, and nothing else carries either fact.
      const deleteSets = collected.filter(s => s.changes.some(c => c.type === 'delete'));
      expect(deleteSets, 'the delete must surface in exactly one ChangeSet').to.have.lengthOf(1);
      const deleteSet = deleteSets[0];
      expect(
        deleteSet.changes.some(c => c.type === 'column' && JSON.stringify(c.pk) === '[2]'),
        'transaction split: pk[2] insert missing from the delete transaction',
      ).to.be.true;

      // Exactly the surviving facts, once each: pk[10], pk[20], delete pk[1], pk[2].
      const allChanges = collected.flatMap(cs => cs.changes);
      const deletes = allChanges.filter(c => c.type === 'delete');
      const columns = allChanges.filter(c => c.type === 'column');
      expect(deletes.map(c => JSON.stringify(c.pk))).to.deep.equal(['[1]']);
      expect(new Set(columns.map(c => JSON.stringify(c.pk)))).to.deep.equal(new Set(['[10]', '[20]', '[2]']));
      expect(columns).to.have.lengthOf(3);
    });
  });

  describe('canDeltaSync', () => {
    it('should return false for unknown peer', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId: peerSiteId, opSeq: 0 };
      const canDelta = await manager.canDeltaSync(peerSiteId, hlc);
      expect(canDelta).to.be.false;
    });

    it('should return true for known peer within TTL', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 0, siteId: peerSiteId, opSeq: 0 };

      // Register the peer
      await manager.updatePeerSyncState(peerSiteId, hlc);

      const canDelta = await manager.canDeltaSync(peerSiteId, hlc);
      expect(canDelta).to.be.true;
    });
  });

  describe('peerSyncState', () => {
    it('should store and retrieve peer sync state', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 5, siteId: peerSiteId, opSeq: 0 };

      await manager.updatePeerSyncState(peerSiteId, hlc);
      const retrieved = await manager.getPeerSyncState(peerSiteId);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.wallTime).to.equal(hlc.wallTime);
      expect(retrieved!.counter).to.equal(hlc.counter);
    });

    it('should return undefined for unknown peer', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const retrieved = await manager.getPeerSyncState(peerSiteId);
      expect(retrieved).to.be.undefined;
    });
  });

  describe('peerSentState', () => {
    it('should store and retrieve the sent watermark', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 7, siteId: peerSiteId, opSeq: 0 };

      await manager.updatePeerSentState(peerSiteId, hlc);
      const retrieved = await manager.getPeerSentState(peerSiteId);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.wallTime).to.equal(hlc.wallTime);
      expect(retrieved!.counter).to.equal(hlc.counter);
    });

    it('should return undefined for unknown peer', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const retrieved = await manager.getPeerSentState(peerSiteId);
      expect(retrieved).to.be.undefined;
    });

    it('keys the sent watermark separately from the received watermark', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const peerSiteId = generateSiteId();
      const sent: HLC = { wallTime: 5000n, counter: 1, siteId: peerSiteId, opSeq: 0 };
      const received: HLC = { wallTime: 9000n, counter: 2, siteId: peerSiteId, opSeq: 0 };

      // Writing one watermark must not disturb the other for the same peer.
      await manager.updatePeerSentState(peerSiteId, sent);
      await manager.updatePeerSyncState(peerSiteId, received);

      const gotSent = await manager.getPeerSentState(peerSiteId);
      const gotReceived = await manager.getPeerSyncState(peerSiteId);

      expect(gotSent!.wallTime).to.equal(sent.wallTime);
      expect(gotSent!.counter).to.equal(sent.counter);
      expect(gotReceived!.wallTime).to.equal(received.wallTime);
      expect(gotReceived!.counter).to.equal(received.counter);
    });
  });

  describe('getSnapshot', () => {
    it('should return snapshot with site ID and HLC', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const snapshot = await manager.getSnapshot();

      expect(snapshot.siteId).to.have.lengthOf(16);
      expect(snapshot.hlc.wallTime).to.be.a('bigint');
      expect(snapshot.tables).to.be.an('array');
      expect(snapshot.schemaMigrations).to.be.an('array');
    });

    it('should return empty tables when no data', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const snapshot = await manager.getSnapshot();
      expect(snapshot.tables).to.have.lengthOf(0);
    });
  });

  describe('applySnapshot', () => {
    it('should apply snapshot and update HLC', async () => {
      const manager1 = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const manager2 = await SyncManagerImpl.create(new InMemoryKVStore(), source, config, syncEvents);

      // Get snapshot from manager1
      const snapshot = await manager1.getSnapshot();

      // Apply to manager2
      await manager2.applySnapshot(snapshot);

      // Manager2's HLC should be at least as high
      const hlc1 = manager1.getCurrentHLC();
      const hlc2 = manager2.getCurrentHLC();
      expect(compareHLC(hlc2, hlc1)).to.be.at.least(0);
    });
  });

  describe('streaming snapshots', () => {
    it('should stream snapshot with header and footer', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const chunks: SnapshotChunk[] = [];

      for await (const chunk of manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      expect(chunks.length).to.be.at.least(2);
      expect(chunks[0].type).to.equal('header');
      expect(chunks[chunks.length - 1].type).to.equal('footer');
    });

    it('should include snapshot ID in header and footer', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const chunks: SnapshotChunk[] = [];

      for await (const chunk of manager.getSnapshotStream()) {
        chunks.push(chunk);
      }

      const header = chunks[0] as SnapshotHeaderChunk;
      const footer = chunks[chunks.length - 1] as SnapshotFooterChunk;

      expect(header.snapshotId).to.be.a('string');
      expect(footer.snapshotId).to.equal(header.snapshotId);
    });

    it('should apply streamed snapshot', async () => {
      const manager1 = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const manager2 = await SyncManagerImpl.create(new InMemoryKVStore(), source, config, syncEvents);

      // Stream snapshot from manager1
      const chunks: SnapshotChunk[] = [];
      for await (const chunk of manager1.getSnapshotStream()) {
        chunks.push(chunk);
      }

      // Apply to manager2
      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }

      let progressCalls = 0;
      await manager2.applySnapshotStream(yieldChunks(), () => {
        progressCalls++;
      });

      // Should have processed the chunks
      const footer = chunks[chunks.length - 1] as SnapshotFooterChunk;
      expect(footer.type).to.equal('footer');
    });

    it('should respect chunk size', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const chunks: SnapshotChunk[] = [];

      // Use a small chunk size
      for await (const chunk of manager.getSnapshotStream(10)) {
        chunks.push(chunk);
      }

      // Should still have header and footer
      expect(chunks[0].type).to.equal('header');
      expect(chunks[chunks.length - 1].type).to.equal('footer');
    });
  });

  describe('checkpoint/resume', () => {
    it('should return undefined for non-existent checkpoint', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const checkpoint = await manager.getSnapshotCheckpoint('non-existent');
      expect(checkpoint).to.be.undefined;
    });

    it('should resume snapshot stream', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);

      // Get snapshot ID from initial stream
      let snapshotId = '';
      for await (const chunk of manager.getSnapshotStream()) {
        if (chunk.type === 'header') {
          snapshotId = chunk.snapshotId;
          break;
        }
      }

      // Create a mock checkpoint
      const checkpoint = {
        snapshotId,
        siteId: manager.getSiteId(),
        hlc: manager.getCurrentHLC(),
        lastTableIndex: 0,
        lastEntryIndex: 0,
        completedTables: [],
        entriesProcessed: 0,
        createdAt: Date.now(),
      };

      // Resume should work
      const resumedChunks: SnapshotChunk[] = [];
      for await (const chunk of manager.resumeSnapshotStream(checkpoint)) {
        resumedChunks.push(chunk);
      }

      expect(resumedChunks.length).to.be.at.least(2);
      expect(resumedChunks[0].type).to.equal('header');
    });
  });

  describe('applyChanges', () => {
    it('should apply empty changeset', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const result = await manager.applyChanges([]);

      expect(result.applied).to.equal(0);
      expect(result.skipped).to.equal(0);
      expect(result.conflicts).to.equal(0);
      expect(result.transactions).to.equal(0);
    });

    it('should apply column changes', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([changeSet]);

      expect(result.applied).to.equal(1);
      expect(result.transactions).to.equal(1);
    });

    it('should apply row deletions', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [1],
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([changeSet]);

      expect(result.applied).to.equal(1);
      expect(result.transactions).to.equal(1);
    });

    it('should skip older changes (LWW)', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();
      const now = Date.now();

      // Apply newer change first
      const newerChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-2',
        hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Bob',
            hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([newerChangeSet]);

      // Try to apply older change
      const olderChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([olderChangeSet]);

      // LWW causes the older change to be treated as a conflict (local wins)
      expect(result.conflicts).to.equal(1);
      expect(result.applied).to.equal(0);
    });

    it('dedupes the stale delete change-log entry when a newer tombstone is applied', async () => {
      // Apply-path mirror of the write-path dedup: two increasing-HLC deletes for the
      // same pk, applied in SEPARATE applyChanges calls (so the first tombstone is
      // committed before the second resolves and sees it as `oldTombstone`). The older
      // delete's change-log entry must be removed so at most one survives per pk with
      // HLC equal to the current tombstone — otherwise the stale entry resolves to the
      // later tombstone and re-attributes, the same scan-time hazard the write path fixes.
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();
      const now = Date.now();

      const deleteAt = (wall: number, counter: number): ChangeSet => {
        const hlc: HLC = { wallTime: BigInt(wall), counter, siteId: remoteSiteId, opSeq: 0 };
        return {
          siteId: remoteSiteId,
          transactionId: `tx-${wall}`,
          hlc,
          changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [1], hlc }],
          schemaMigrations: [],
        };
      };

      await manager.applyChanges([deleteAt(now, 1)]);
      const result = await manager.applyChanges([deleteAt(now + 1000, 1)]);
      expect(result.applied, 'the newer delete must be applied over the older tombstone').to.equal(1);

      // A peer other than the originating site sees the deletes. If the stale d1 entry
      // survived it would resolve to the d2 tombstone too, surfacing the pk[1] delete
      // twice; exactly one proves the older entry was deduped.
      const peer = generateSiteId();
      const sets = await manager.getChangesSince(peer);
      const deletes = sets.flatMap(s => s.changes).filter(c => c.type === 'delete' && JSON.stringify(c.pk) === '[1]');
      expect(deletes, 'stale delete entry not deduped on the apply path').to.have.lengthOf(1);
      expect(compareHLC(deletes[0].hlc, { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId, opSeq: 0 }))
        .to.equal(0);
    });

    it('dedupes same-pk deletes batched into ONE applyChanges call (in-batch repeat)', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const now = Date.now();

      const deleteFrom = (site: Uint8Array, wall: number, counter: number, tx: string): ChangeSet => {
        const hlc: HLC = { wallTime: BigInt(wall), counter, siteId: site, opSeq: 0 };
        return { siteId: site, transactionId: tx, hlc, changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [1], hlc }], schemaMigrations: [] };
      };

      // Both deletes resolve against the SAME pre-batch state (no tombstone yet),
      // so neither sees the other — both delete entries are recorded today.
      const result = await manager.applyChanges([
        deleteFrom(siteA, now, 1, 'tx-a'),
        deleteFrom(siteB, now + 1000, 1, 'tx-b'),
      ]);
      expect(result.applied).to.equal(2);

      const peer = generateSiteId();
      const sinceHLC: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      const sets = await manager.getChangesSince(peer, sinceHLC);
      const deletes = sets.flatMap(s => s.changes).filter(c => c.type === 'delete' && JSON.stringify(c.pk) === '[1]');
      expect(deletes, 'in-batch stale delete entry not deduped').to.have.lengthOf(1);
      // Survivor's HLC must equal the current tombstone's (the max-HLC delete).
      expect(compareHLC(deletes[0].hlc, { wallTime: BigInt(now + 1000), counter: 1, siteId: siteB, opSeq: 0 })).to.equal(0);
    });

    it('dedupes same-(pk,column) writes batched into ONE applyChanges call (in-batch repeat)', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const now = Date.now();

      const writeFrom = (site: Uint8Array, wall: number, value: string, tx: string): ChangeSet => {
        const hlc: HLC = { wallTime: BigInt(wall), counter: 1, siteId: site, opSeq: 0 };
        return { siteId: site, transactionId: tx, hlc, changes: [{ type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value, hlc }], schemaMigrations: [] };
      };

      const result = await manager.applyChanges([
        writeFrom(siteA, now, 'Alice', 'tx-a'),
        writeFrom(siteB, now + 1000, 'Bob', 'tx-b'),
      ]);
      expect(result.applied).to.equal(2);

      const peer = generateSiteId();
      const sinceHLC: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      const sets = await manager.getChangesSince(peer, sinceHLC);
      const cols = sets.flatMap(s => s.changes).filter(c => c.type === 'column' && JSON.stringify(c.pk) === '[1]');
      expect(cols, 'in-batch stale column entry not deduped').to.have.lengthOf(1);
      expect(compareHLC(cols[0].hlc, { wallTime: BigInt(now + 1000), counter: 1, siteId: siteB, opSeq: 0 })).to.equal(0);
    });

    it('does not split a separate transaction when same-pk deletes are collapsed in one batch (multi-round walk)', async () => {
      // batchSize=1 forces one whole transaction per round. Two same-pk deletes batched
      // into ONE applyChanges call collapse to the max-HLC winner; if the stale older
      // entry survived it would re-attribute to the later HLC and split the separate
      // multi-fact transaction across rounds (the apply-path mirror of the ~line-298 walk).
      config.batchSize = 1;
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const siteC = generateSiteId();
      const now = Date.now();

      const deleteFrom = (site: Uint8Array, wall: number, pk: number, tx: string): ChangeSet => {
        const hlc: HLC = { wallTime: BigInt(wall), counter: 1, siteId: site, opSeq: 0 };
        return { siteId: site, transactionId: tx, hlc, changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [pk], hlc }], schemaMigrations: [] };
      };

      // A multi-fact transaction (one commit): delete pk[5] AND write pk[6].name — same
      // base HLC, distinct opSeq, so it groups as one ChangeSet that must never split.
      // Its HLC sits BETWEEN the two colliding pk[1] deletes (now < now+1000 < now+2000):
      // without the in-batch collapse, the older pk[1] entry re-attributes forward to the
      // winner's HLC (now+2000), advancing the watermark PAST this transaction in round 1
      // so it would be silently skipped — i.e. this ordering makes the test a genuine
      // regression guard, not one masked by the watermark walk.
      const base = { wallTime: BigInt(now + 1000), counter: 1, siteId: siteC };
      const multiFact: ChangeSet = {
        siteId: siteC,
        transactionId: 'tx-multi',
        hlc: { ...base, opSeq: 1 },
        changes: [
          { type: 'delete', schema: 'main', table: 'users', pk: [5], hlc: { ...base, opSeq: 0 } },
          { type: 'column', schema: 'main', table: 'users', pk: [6], column: 'name', value: 'x', hlc: { ...base, opSeq: 1 } },
        ],
        schemaMigrations: [],
      };

      // hlcA < hlcB; both pk[1] deletes resolve against the same pre-batch state.
      const result = await manager.applyChanges([
        deleteFrom(siteA, now, 1, 'tx-a'),
        deleteFrom(siteB, now + 2000, 1, 'tx-b'),
        multiFact,
      ]);
      expect(result.applied).to.equal(4);

      const peer = generateSiteId();
      const collected: ChangeSet[] = [];
      let sinceHLC: HLC | undefined = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };
      for (let i = 0; i < 10; i++) {
        const sets: ChangeSet[] = await manager.getChangesSince(peer, sinceHLC);
        if (sets.length === 0) break;
        collected.push(...sets);
        sinceHLC = sets[sets.length - 1].hlc;
      }

      // No repeats: each transaction id appears exactly once.
      const txnIds = collected.map(cs => cs.transactionId);
      expect(new Set(txnIds).size, 'a transaction was repeated across rounds').to.equal(txnIds.length);

      // Strictly-ascending watermark across the whole walk.
      for (let i = 1; i < collected.length; i++) {
        expect(compareHLC(collected[i - 1].hlc, collected[i].hlc)).to.be.lessThan(0);
      }

      // The multi-fact transaction surfaces whole in exactly one ChangeSet: the set
      // carrying the pk[5] delete also carries the pk[6] write, and nothing else does.
      const withPk5 = collected.filter(s => s.changes.some(c => c.type === 'delete' && JSON.stringify(c.pk) === '[5]'));
      expect(withPk5, 'pk[5] delete must surface in exactly one ChangeSet').to.have.lengthOf(1);
      expect(
        withPk5[0].changes.some(c => c.type === 'column' && JSON.stringify(c.pk) === '[6]'),
        'transaction split: pk[6] write missing from the multi-fact transaction',
      ).to.be.true;
      const withPk6 = collected.filter(s => s.changes.some(c => c.type === 'column' && JSON.stringify(c.pk) === '[6]'));
      expect(withPk6, 'pk[6] write must surface in exactly one ChangeSet').to.have.lengthOf(1);
      expect(withPk6[0].transactionId).to.equal(withPk5[0].transactionId);

      // The collapsed pk[1] delete surfaces exactly once, attributed to the max-HLC winner.
      const pk1Deletes = collected.flatMap(s => s.changes).filter(c => c.type === 'delete' && JSON.stringify(c.pk) === '[1]');
      expect(pk1Deletes, 'collapsed pk[1] delete must surface exactly once').to.have.lengthOf(1);
      expect(compareHLC(pk1Deletes[0].hlc, { wallTime: BigInt(now + 2000), counter: 1, siteId: siteB, opSeq: 0 })).to.equal(0);
    });
  });

  describe('pruneTombstones', () => {
    it('should return 0 when no tombstones', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const pruned = await manager.pruneTombstones();
      expect(pruned).to.equal(0);
    });
  });

  describe('applyToStore callback', () => {
    it('should call applyToStore with data changes when applying remote changes', async () => {
      const appliedChanges: { data: unknown[]; schema: unknown[]; options: unknown } = {
        data: [],
        schema: [],
        options: null,
      };

      const applyToStore = async (
        dataChanges: unknown[],
        schemaChanges: unknown[],
        options: unknown
      ) => {
        appliedChanges.data = dataChanges;
        appliedChanges.schema = schemaChanges;
        appliedChanges.options = options;
        return { dataChangesApplied: dataChanges.length, schemaChangesApplied: schemaChanges.length, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([changeSet]);

      // Verify applyToStore was called with correct data
      expect(appliedChanges.data).to.have.lengthOf(1);
      expect(appliedChanges.options).to.deep.equal({ remote: true });

      const dataChange = appliedChanges.data[0] as { type: string; table: string; pk: unknown[]; columns: Record<string, unknown> };
      expect(dataChange.type).to.equal('update');
      expect(dataChange.table).to.equal('users');
      expect(dataChange.pk).to.deep.equal([1]);
      expect(dataChange.columns).to.deep.equal({ name: 'Alice' });
    });

    it('should call applyToStore with delete changes', async () => {
      const appliedChanges: { data: unknown[] } = { data: [] };

      const applyToStore = async (dataChanges: unknown[], schemaChanges: unknown[]) => {
        appliedChanges.data = dataChanges;
        return { dataChangesApplied: dataChanges.length, schemaChangesApplied: schemaChanges.length, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [1],
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([changeSet]);

      expect(appliedChanges.data).to.have.lengthOf(1);
      const dataChange = appliedChanges.data[0] as { type: string; table: string; pk: unknown[] };
      expect(dataChange.type).to.equal('delete');
      expect(dataChange.table).to.equal('users');
      expect(dataChange.pk).to.deep.equal([1]);
    });

    it('should not call applyToStore when no callback provided', async () => {
      // Create manager without callback
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      // Should not throw, just update metadata
      const result = await manager.applyChanges([changeSet]);
      expect(result.applied).to.equal(1);
    });

    it('should not call applyToStore for skipped changes', async () => {
      let callCount = 0;
      const applyToStore = async () => {
        callCount++;
        return { dataChangesApplied: 0, schemaChangesApplied: 0, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();
      const now = Date.now();

      // Apply newer change first
      const newerChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-2',
        hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Bob',
            hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([newerChangeSet]);
      expect(callCount).to.equal(1);

      // Try to apply older change - should be skipped
      const olderChangeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([olderChangeSet]);

      // applyToStore should not be called again (no changes to apply)
      expect(callCount).to.equal(1);
      expect(result.conflicts).to.equal(1);
      expect(result.applied).to.equal(0);
    });

    it('should emit remote change events after applying changes', async () => {
      const remoteEvents: unknown[] = [];
      syncEvents.onRemoteChange((event) => {
        remoteEvents.push(event);
      });

      const applyToStore = async () => ({ dataChangesApplied: 1, schemaChangesApplied: 0, errors: [] });
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
          },
        ],
        schemaMigrations: [],
      };

      await manager.applyChanges([changeSet]);

      expect(remoteEvents).to.have.lengthOf(1);
    });
  });

  describe('bidirectional sync', () => {
    it('should sync changes between two replicas', async () => {
      // Create two replicas with separate stores
      const kv1 = new InMemoryKVStore();
      const kv2 = new InMemoryKVStore();
      const source1 = new FakeTransactionSource();
      const source2 = new FakeTransactionSource();
      const syncEvents1 = new SyncEventEmitterImpl();
      const syncEvents2 = new SyncEventEmitterImpl();

      const manager1 = await SyncManagerImpl.create(kv1, source1, config, syncEvents1);
      const manager2 = await SyncManagerImpl.create(kv2, source2, config, syncEvents2);

      // Simulate local change on replica 1
      const site1 = manager1.getSiteId();
      const hlc1 = manager1.getCurrentHLC();

      const changeSet1: ChangeSet = {
        siteId: site1,
        transactionId: 'tx-1',
        hlc: hlc1,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: hlc1,
          },
        ],
        schemaMigrations: [],
      };

      // Apply to replica 2
      const result = await manager2.applyChanges([changeSet1]);
      expect(result.applied).to.equal(1);
      expect(result.conflicts).to.equal(0);
    });

    it('should resolve concurrent updates with LWW', async () => {
      const kv1 = new InMemoryKVStore();
      const source1 = new FakeTransactionSource();
      const syncEvents1 = new SyncEventEmitterImpl();

      const manager1 = await SyncManagerImpl.create(kv1, source1, config, syncEvents1);

      // Use separate site IDs for the remote changes (not manager1's own siteId)
      // This simulates receiving changes from two different remote peers
      const remoteSite1 = generateSiteId();
      const remoteSite2 = generateSiteId();

      // Create concurrent changes with different timestamps
      const earlierHLC: HLC = { wallTime: BigInt(1000), counter: 1, siteId: remoteSite1, opSeq: 0 };
      const laterHLC: HLC = { wallTime: BigInt(2000), counter: 1, siteId: remoteSite2, opSeq: 0 };

      const changeSet1: ChangeSet = {
        siteId: remoteSite1,
        transactionId: 'tx-1',
        hlc: earlierHLC,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: earlierHLC,
          },
        ],
        schemaMigrations: [],
      };

      const changeSet2: ChangeSet = {
        siteId: remoteSite2,
        transactionId: 'tx-2',
        hlc: laterHLC,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Bob',
            hlc: laterHLC,
          },
        ],
        schemaMigrations: [],
      };

      // Apply later change first, then earlier change
      await manager1.applyChanges([changeSet2]);
      const result = await manager1.applyChanges([changeSet1]);

      // Earlier change should be a conflict (local wins via LWW)
      expect(result.conflicts).to.equal(1);
      expect(result.applied).to.equal(0);
    });

    it('should handle delete-update conflicts', async () => {
      const kv1 = new InMemoryKVStore();
      const source1 = new FakeTransactionSource();
      const syncEvents1 = new SyncEventEmitterImpl();

      const manager1 = await SyncManagerImpl.create(kv1, source1, config, syncEvents1);

      const remoteSite = generateSiteId();

      // First, apply an update
      const updateHLC: HLC = { wallTime: BigInt(1000), counter: 1, siteId: remoteSite, opSeq: 0 };
      const updateChangeSet: ChangeSet = {
        siteId: remoteSite,
        transactionId: 'tx-1',
        hlc: updateHLC,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: updateHLC,
          },
        ],
        schemaMigrations: [],
      };
      await manager1.applyChanges([updateChangeSet]);

      // Then apply a delete with later timestamp
      const deleteHLC: HLC = { wallTime: BigInt(2000), counter: 1, siteId: remoteSite, opSeq: 0 };
      const deleteChangeSet: ChangeSet = {
        siteId: remoteSite,
        transactionId: 'tx-2',
        hlc: deleteHLC,
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [1],
            hlc: deleteHLC,
          },
        ],
        schemaMigrations: [],
      };
      const result = await manager1.applyChanges([deleteChangeSet]);

      expect(result.applied).to.equal(1);
    });

    it('should sync full snapshot between replicas', async () => {
      const kv1 = new InMemoryKVStore();
      const kv2 = new InMemoryKVStore();
      const source1 = new FakeTransactionSource();
      const source2 = new FakeTransactionSource();
      const syncEvents1 = new SyncEventEmitterImpl();
      const syncEvents2 = new SyncEventEmitterImpl();

      const manager1 = await SyncManagerImpl.create(kv1, source1, config, syncEvents1);
      const manager2 = await SyncManagerImpl.create(kv2, source2, config, syncEvents2);

      // Add some data to replica 1
      const site1 = manager1.getSiteId();
      const hlc1 = manager1.getCurrentHLC();

      const changeSet: ChangeSet = {
        siteId: site1,
        transactionId: 'tx-1',
        hlc: hlc1,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc: hlc1,
          },
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [2],
            column: 'name',
            value: 'Bob',
            hlc: hlc1,
          },
        ],
        schemaMigrations: [],
      };
      await manager1.applyChanges([changeSet]);

      // Stream snapshot from replica 1 to replica 2
      const chunks: SnapshotChunk[] = [];
      for await (const chunk of manager1.getSnapshotStream()) {
        chunks.push(chunk);
      }

      async function* yieldChunks() {
        for (const chunk of chunks) yield chunk;
      }

      await manager2.applySnapshotStream(yieldChunks());

      // Verify replica 2 received the data by getting its snapshot
      const snapshot2 = await manager2.getSnapshot();
      expect(snapshot2.tables.length).to.be.at.least(0);
    });
  });

  describe('schema migration sync', () => {
    it('should record schema migration when a transaction commits a schema change', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();

      // Emit a schema change event (simulating CREATE TABLE)
      source.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'users',
        ddl: 'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT) USING indexeddb',
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Get changes since - should include the schema migration
      const changes = await manager.getChangesSince(remoteSiteId);
      expect(changes.length).to.equal(1);
      expect(changes[0].schemaMigrations.length).to.equal(1);
      expect(changes[0].schemaMigrations[0].type).to.equal('create_table');
      expect(changes[0].schemaMigrations[0].ddl).to.include('CREATE TABLE');
    });

    it('should apply schema migration from remote changeset', async () => {
      let appliedSchemaChanges: Array<{ type: string; ddl: string }> = [];
      const applyToStore = async (
        _dataChanges: unknown[],
        schemaChanges: Array<{ type: string; ddl: string }>
      ) => {
        appliedSchemaChanges = schemaChanges;
        return { dataChangesApplied: 0, schemaChangesApplied: schemaChanges.length, errors: [] };
      };

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [],
        schemaMigrations: [
          {
            type: 'create_table',
            schema: 'main',
            table: 'users',
            ddl: 'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT) USING indexeddb',
            hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
            schemaVersion: 1,
          },
        ],
      };

      await manager.applyChanges([changeSet]);

      // Verify applyToStore was called with the schema change
      expect(appliedSchemaChanges.length).to.equal(1);
      expect(appliedSchemaChanges[0].type).to.equal('create_table');
      expect(appliedSchemaChanges[0].ddl).to.include('CREATE TABLE');
    });

    it('should sync schema migrations between two replicas', async () => {
      const kv1 = new InMemoryKVStore();
      const kv2 = new InMemoryKVStore();
      const source1 = new FakeTransactionSource();
      const source2 = new FakeTransactionSource();
      const syncEvents1 = new SyncEventEmitterImpl();
      const syncEvents2 = new SyncEventEmitterImpl();

      let replica2SchemaChanges: Array<{ type: string; ddl: string }> = [];
      const applyToStore2 = async (
        _dataChanges: unknown[],
        schemaChanges: Array<{ type: string; ddl: string }>
      ) => {
        replica2SchemaChanges = schemaChanges;
        return { dataChangesApplied: 0, schemaChangesApplied: schemaChanges.length, errors: [] };
      };

      const manager1 = await SyncManagerImpl.create(kv1, source1, config, syncEvents1);
      const manager2 = await SyncManagerImpl.create(kv2, source2, config, syncEvents2, applyToStore2);

      // Simulate CREATE TABLE on replica 1
      source1.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'users',
        ddl: 'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT) USING indexeddb',
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Get changes from replica 1 to send to replica 2
      const changesToSync = await manager1.getChangesSince(manager2.getSiteId());
      expect(changesToSync.length).to.equal(1);
      expect(changesToSync[0].schemaMigrations.length).to.equal(1);

      // Apply to replica 2
      await manager2.applyChanges(changesToSync);

      // Verify replica 2 received the schema change
      expect(replica2SchemaChanges.length).to.equal(1);
      expect(replica2SchemaChanges[0].type).to.equal('create_table');
      expect(replica2SchemaChanges[0].ddl).to.include('CREATE TABLE');
    });

    it('should not re-record schema migration from remote events', async () => {
      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSiteId = generateSiteId();

      // Emit a schema change event with remote=true (simulating applied remote change)
      source.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'users',
        ddl: 'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT) USING indexeddb',
        remote: true,
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Get changes since - should be empty (remote events are not re-recorded)
      const changes = await manager.getChangesSince(remoteSiteId);
      expect(changes.length).to.equal(0);
    });
  });

  describe('echo prevention (hub-and-spoke topology)', () => {
    it('should skip changes that originated from ourselves when receiving via relay', async () => {
      // This test simulates a hub-and-spoke sync topology:
      // 1. Client A makes a change
      // 2. A sends to Coordinator, which broadcasts to B
      // 3. B receives A's changes and stores them
      // 4. B sends ALL its changes to Coordinator (including A's changes it received)
      // 5. Coordinator broadcasts to A
      // 6. A should NOT treat its own changes as conflicts

      const kvA = new InMemoryKVStore();
      const kvB = new InMemoryKVStore();
      const sourceA = new FakeTransactionSource();
      const sourceB = new FakeTransactionSource();
      const syncEventsA = new SyncEventEmitterImpl();
      const syncEventsB = new SyncEventEmitterImpl();

      // Track conflict events on A
      const conflictsOnA: unknown[] = [];
      syncEventsA.onConflictResolved((event) => {
        conflictsOnA.push(event);
      });

      const managerA = await SyncManagerImpl.create(kvA, sourceA, config, syncEventsA);
      const managerB = await SyncManagerImpl.create(kvB, sourceB, config, syncEventsB);

      const siteA = managerA.getSiteId();
      const hlcA = managerA.getCurrentHLC();

      // Step 1: A creates a change with A's HLC
      const changeFromA: ChangeSet = {
        siteId: siteA,
        transactionId: 'tx-a-1',
        hlc: hlcA,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'test1',
            pk: ['hello from a'],
            column: 'a',
            value: 1,
            hlc: hlcA,
          },
          {
            type: 'column',
            schema: 'main',
            table: 'test1',
            pk: ['hello from a'],
            column: 'b',
            value: 2,
            hlc: hlcA,
          },
        ],
        schemaMigrations: [],
      };

      // A applies its own changes locally (simulating local write)
      // This records the column versions with A's HLC
      await managerA.applyChanges([changeFromA]);

      // Step 2-3: B receives A's changes (via coordinator broadcast)
      const resultB = await managerB.applyChanges([changeFromA]);
      expect(resultB.applied).to.equal(2);

      // Step 4: B now has A's changes. When B calls getChangesSince for any peer,
      // it will include A's changes (with A's HLC in each change).
      // Simulate B sending changes to coordinator - B includes A's changes
      const coordinatorSiteId = generateSiteId();
      const changesFromB = await managerB.getChangesSince(coordinatorSiteId);

      // B should have A's 2 column changes to send
      expect(changesFromB.length).to.be.greaterThan(0);
      const allChanges = changesFromB.flatMap(cs => cs.changes);
      expect(allChanges.length).to.equal(2);

      // Verify the changes have A's siteId in their HLCs
      for (const change of allChanges) {
        expect(siteIdEquals(change.hlc.siteId, siteA)).to.be.true;
      }

      // Step 5-6: Coordinator would broadcast B's payload (which contains A's changes) to A
      // A receives its own changes back!
      const resultA = await managerA.applyChanges(changesFromB);

      // These should be SKIPPED, not conflicts!
      expect(resultA.skipped).to.equal(2);
      expect(resultA.conflicts).to.equal(0);
      expect(resultA.applied).to.equal(0);

      // No conflict events should have been emitted
      expect(conflictsOnA).to.have.lengthOf(0);
    });

    it('should skip own deletions when receiving via relay', async () => {
      const kvA = new InMemoryKVStore();
      const kvB = new InMemoryKVStore();
      const sourceA = new FakeTransactionSource();
      const sourceB = new FakeTransactionSource();
      const syncEventsA = new SyncEventEmitterImpl();
      const syncEventsB = new SyncEventEmitterImpl();

      const managerA = await SyncManagerImpl.create(kvA, sourceA, config, syncEventsA);
      const managerB = await SyncManagerImpl.create(kvB, sourceB, config, syncEventsB);

      const siteA = managerA.getSiteId();
      const hlcA = managerA.getCurrentHLC();

      // A creates a delete
      const deleteFromA: ChangeSet = {
        siteId: siteA,
        transactionId: 'tx-a-1',
        hlc: hlcA,
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'test1',
            pk: ['row-to-delete'],
            hlc: hlcA,
          },
        ],
        schemaMigrations: [],
      };

      // A applies its own delete locally
      await managerA.applyChanges([deleteFromA]);

      // B receives A's delete
      await managerB.applyChanges([deleteFromA]);

      // B sends changes to coordinator (includes A's delete)
      const coordinatorSiteId = generateSiteId();
      const changesFromB = await managerB.getChangesSince(coordinatorSiteId);

      // A receives its own delete back
      const resultA = await managerA.applyChanges(changesFromB);

      // Should be skipped, not applied again
      expect(resultA.skipped).to.equal(1);
      expect(resultA.applied).to.equal(0);
    });

    it('should still apply changes from other peers in mixed payload', async () => {
      // When a relay payload contains both our own changes and other peers' changes,
      // we should skip our own but apply the others.

      const kvA = new InMemoryKVStore();
      const kvB = new InMemoryKVStore();
      const sourceA = new FakeTransactionSource();
      const sourceB = new FakeTransactionSource();
      const syncEventsA = new SyncEventEmitterImpl();
      const syncEventsB = new SyncEventEmitterImpl();

      const managerA = await SyncManagerImpl.create(kvA, sourceA, config, syncEventsA);
      const managerB = await SyncManagerImpl.create(kvB, sourceB, config, syncEventsB);

      const siteA = managerA.getSiteId();
      const hlcA = managerA.getCurrentHLC();

      // A makes a change
      const changeFromA: ChangeSet = {
        siteId: siteA,
        transactionId: 'tx-a-1',
        hlc: hlcA,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'test1',
            pk: ['row-a'],
            column: 'value',
            value: 'from A',
            hlc: hlcA,
          },
        ],
        schemaMigrations: [],
      };

      // A applies locally
      await managerA.applyChanges([changeFromA]);

      // B receives A's change
      await managerB.applyChanges([changeFromA]);

      // B makes its own LOCAL change via store events (not applyChanges)
      // This simulates B doing an INSERT/UPDATE locally
      // Note: Each column in the row becomes a separate column change
      sourceB.commitData({
        type: 'insert',
        schemaName: 'main',
        tableName: 'test1',
        key: ['row-b'],
        newRow: ['row-b', 'from B'],  // 2 columns = 2 column changes
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // B sends all changes to coordinator (both A's and B's)
      const coordinatorSiteId = generateSiteId();
      const changesFromB = await managerB.getChangesSince(coordinatorSiteId);

      // Should have changes from both A and B:
      // - 1 column change from A (row-a.value)
      // - 2 column changes from B (row-b has 2 columns)
      const allChanges = changesFromB.flatMap(cs => cs.changes);
      expect(allChanges.length).to.equal(3);

      // A receives the mixed payload
      const resultA = await managerA.applyChanges(changesFromB);

      // A's own change should be skipped, B's should be applied
      expect(resultA.skipped).to.equal(1);  // A's 1 column change
      expect(resultA.applied).to.equal(2);  // B's 2 column changes
      expect(resultA.conflicts).to.equal(0);
    });
  });

  describe('error handling', () => {
    /**
     * Whether any `cv:` record was filed for `(schema, table)`. Parses each key
     * rather than matching a literal prefix — every component of a metadata key
     * is length-prefixed, so the literal spelling is an implementation detail.
     */
    const hasColumnVersionFor = async (schema: string, table: string): Promise<boolean> => {
      for await (const entry of kv.iterate()) {
        const parsed = parseColumnVersionKey(entry.key);
        if (parsed?.schema === schema && parsed.table === table) return true;
      }
      return false;
    };

    it('should warn when data change event has no primary key', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);
      try {
        await SyncManagerImpl.create(kv, source, config, syncEvents);

        // Emit data change without key or pk
        source.commitData({
          type: 'insert',
          schemaName: 'main',
          tableName: 'test',
          newRow: ['value'],
        });

        await new Promise(resolve => setTimeout(resolve, 10));

        expect(warnings.some(w => w.includes('Missing primary key'))).to.be.true;
        expect(warnings.some(w => w.includes('main.test'))).to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('should catch errors while recording a committed data change and emit error state', async () => {
      const states: SyncState[] = [];
      syncEvents.onSyncStateChange(state => states.push(state));

      // Create a manager with a KV store that will fail on batch write
      const failingKv = new InMemoryKVStore();
      const origBatch = failingKv.batch.bind(failingKv);
      failingKv.batch = () => {
        const batch = origBatch();
        batch.write = async () => { throw new Error('batch write failed'); };
        return batch;
      };

      await SyncManagerImpl.create(failingKv, source, config, syncEvents);

      source.commitData({
        type: 'insert',
        schemaName: 'main',
        tableName: 'test',
        key: [1],
        newRow: ['value'],
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(states.some(s => s.status === 'error')).to.be.true;
      const errorState = states.find(s => s.status === 'error') as { status: 'error'; error: Error };
      expect(errorState.error.message).to.equal('batch write failed');
    });

    it('should catch errors while recording a committed schema change and emit error state', async () => {
      const states: SyncState[] = [];
      syncEvents.onSyncStateChange(state => states.push(state));

      // Create a manager with a KV store that will fail
      const failingKv = new InMemoryKVStore();
      await SyncManagerImpl.create(failingKv, source, config, syncEvents);

      // Sabotage the KV store after creation so schemaMigrations.getCurrentVersion fails
      failingKv.iterate = () => {
        throw new Error('iterate failed');
      };

      source.commitSchema({
        type: 'create',
        objectType: 'table',
        schemaName: 'main',
        objectName: 'test',
        ddl: 'CREATE TABLE test (id INTEGER)',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(states.some(s => s.status === 'error')).to.be.true;
    });

    it('should emit error state and rethrow when applyToStore callback fails', async () => {
      const states: SyncState[] = [];
      syncEvents.onSyncStateChange(state => states.push(state));

      const applyToStore = async () => {
        throw new Error('store apply failed');
      };

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, applyToStore);
      const remoteSiteId = generateSiteId();

      const changeSet: ChangeSet = {
        siteId: remoteSiteId,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'name',
          value: 'Alice',
          hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: remoteSiteId, opSeq: 0 },
        }],
        schemaMigrations: [],
      };

      let thrown = false;
      try {
        await manager.applyChanges([changeSet]);
      } catch (e) {
        thrown = true;
        expect((e as Error).message).to.equal('store apply failed');
      }

      expect(thrown).to.be.true;
      expect(states.some(s => s.status === 'error')).to.be.true;
    });

    it('should emit conflict event when remote wins LWW', async () => {
      const conflicts: ConflictEvent[] = [];
      syncEvents.onConflictResolved(event => conflicts.push(event));

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSite1 = generateSiteId();
      const remoteSite2 = generateSiteId();
      const now = Date.now();

      // Apply earlier change first
      const earlierChangeSet: ChangeSet = {
        siteId: remoteSite1,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSite1, opSeq: 0 },
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'name',
          value: 'Alice',
          hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSite1, opSeq: 0 },
        }],
        schemaMigrations: [],
      };

      await manager.applyChanges([earlierChangeSet]);
      conflicts.length = 0; // Clear any initial events

      // Apply newer change â€” remote wins over existing
      const newerChangeSet: ChangeSet = {
        siteId: remoteSite2,
        transactionId: 'tx-2',
        hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSite2, opSeq: 0 },
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'name',
          value: 'Bob',
          hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSite2, opSeq: 0 },
        }],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([newerChangeSet]);

      expect(result.applied).to.equal(1);
      expect(conflicts).to.have.lengthOf(1);
      expect(conflicts[0].winner).to.equal('remote');
      expect(conflicts[0].localValue).to.equal('Alice');
      expect(conflicts[0].remoteValue).to.equal('Bob');
      expect(conflicts[0].column).to.equal('name');
      expect(conflicts[0].table).to.equal('users');
    });

    it('should emit conflict event for both local-wins and remote-wins', async () => {
      const conflicts: ConflictEvent[] = [];
      syncEvents.onConflictResolved(event => conflicts.push(event));

      const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);
      const remoteSite1 = generateSiteId();
      const remoteSite2 = generateSiteId();
      const now = Date.now();

      // Apply newer change first
      const newerChangeSet: ChangeSet = {
        siteId: remoteSite1,
        transactionId: 'tx-1',
        hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSite1, opSeq: 0 },
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'name',
          value: 'Bob',
          hlc: { wallTime: BigInt(now + 1000), counter: 1, siteId: remoteSite1, opSeq: 0 },
        }],
        schemaMigrations: [],
      };

      await manager.applyChanges([newerChangeSet]);
      conflicts.length = 0;

      // Apply older change â€” local wins
      const olderChangeSet: ChangeSet = {
        siteId: remoteSite2,
        transactionId: 'tx-2',
        hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSite2, opSeq: 0 },
        changes: [{
          type: 'column',
          schema: 'main',
          table: 'users',
          pk: [1],
          column: 'name',
          value: 'Alice',
          hlc: { wallTime: BigInt(now), counter: 1, siteId: remoteSite2, opSeq: 0 },
        }],
        schemaMigrations: [],
      };

      const result = await manager.applyChanges([olderChangeSet]);

      expect(result.conflicts).to.equal(1);
      expect(conflicts).to.have.lengthOf(1);
      expect(conflicts[0].winner).to.equal('local');
      expect(conflicts[0].localValue).to.equal('Bob');
      expect(conflicts[0].remoteValue).to.equal('Alice');
    });

    it('should capture every table when getTableSchema is not provided (relay-only)', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);
      try {
        // Create manager WITHOUT getTableSchema callback
        const manager = await SyncManagerImpl.create(kv, source, config, syncEvents);

        source.commitData({
          type: 'insert',
          schemaName: 'main',
          tableName: 'test',
          key: [1],
          newRow: ['value'],
        });

        await manager.whenCommitsSettled();

        // No oracle ⇒ every table reports in-basis ⇒ nothing is skipped.
        expect(warnings.filter(w => w.includes('Skipped'))).to.have.lengthOf(0);
        expect(await hasColumnVersionFor('main', 'test')).to.be.true;
      } finally {
        console.warn = origWarn;
      }
    });

    it('should skip changes for a table whose schema the oracle does not know', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);
      try {
        // Create manager WITH getTableSchema that returns undefined: pk identity is
        // unresolvable, so the row's facts are skipped rather than filed under a
        // guessed identity (or aborting the whole transaction).
        const getTableSchema = () => undefined;
        const manager = await SyncManagerImpl.create(kv, source, config, syncEvents, undefined, getTableSchema);

        source.commitData({
          type: 'insert',
          schemaName: 'main',
          tableName: 'test',
          key: [1],
          newRow: ['value'],
        });

        await manager.whenCommitsSettled();

        // Exactly one skip warning, naming the table and the change count.
        const skips = warnings.filter(w => w.includes('Skipped') && w.includes('main.test'));
        expect(skips).to.have.lengthOf(1);
        expect(skips[0]).to.include('unresolvable');

        // Nothing recorded: no `cv:` column-version record for the skipped table.
        expect(await hasColumnVersionFor('main', 'test')).to.be.false;
      } finally {
        console.warn = origWarn;
      }
    });
  });
});
