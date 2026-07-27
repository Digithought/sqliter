/**
 * Regression tests: the change log must not accumulate entries for deleted rows.
 *
 * The `cl:` change log is an HLC-ordered INDEX over the live `cv:` column versions
 * and `tb:` tombstones — `getChangesSince` resolves each entry back to its record
 * and silently drops the entry when that record is gone. An entry whose target has
 * been deleted therefore cannot affect any output; it only costs storage and one
 * KV lookup per delta scan.
 *
 * Before the fix nothing removed those entries when their target died, so the log
 * grew with the replica's LIFETIME DELETE VOLUME instead of with the data it
 * actually holds. Each test below notes the pre-fix count it would have produced.
 */

import { expect } from 'chai';
import { SyncManagerImpl } from '../../src/sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from '../../src/sync/events.js';
import {
  DEFAULT_SYNC_CONFIG,
  type ApplyResult,
  type SyncConfig,
  type ChangeSet,
} from '../../src/sync/protocol.js';
import { InMemoryKVStore } from '@quereus/store';
import { generateSiteId } from '../../src/clock/site.js';
import { buildAllChangeLogScanBounds } from '../../src/metadata/keys.js';
import { compareHLC, type HLC } from '../../src/clock/hlc.js';
import type { SqlValue, TableSchema } from '@quereus/quereus';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';
import {
  COLUMNS_PER_FRESH_INSERT,
  closePeer,
  collect,
  flattenSets,
  localWrite,
  makePeer,
  relay,
} from './_peer-harness.js';

/** Local-change capture runs fire-and-forget after the commit; let it settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25));

/** Every tombstone is instantly past a negative horizon, so prunes are deterministic. */
const EXPIRE_IMMEDIATELY: Partial<SyncConfig> = { retentionHorizonMs: -1 };

/** Sorts before every real HLC, so a scan from it sees the whole log. */
const BEGINNING_OF_TIME: HLC = { wallTime: 0n, counter: 0, siteId: new Uint8Array(16), opSeq: 0 };

/**
 * Count `cl:` records as they sit in the KV store, NOT via
 * `changeLog.getAllChanges()`. This is a storage-growth test, so it has to see
 * every byte actually retained — and `getAllChanges` silently skips any entry
 * `parseChangeLogKey` cannot decode, which would hide exactly the leak under test.
 */
async function countChangeLog(manager: SyncManagerImpl): Promise<number> {
  let count = 0;
  for await (const _entry of manager.kv.iterate(buildAllChangeLogScanBounds())) count++;
  return count;
}

async function countTombstones(manager: SyncManagerImpl): Promise<number> {
  let count = 0;
  for await (const _t of manager.tombstones.getAllTombstones('main', 'users')) count++;
  return count;
}

/** Column-name oracle for a single `main.users` shape. */
function usersSchemaOracle(columns: string[]) {
  return (schema: string, table: string): TableSchema | undefined =>
    schema === 'main' && table === 'users'
      ? ({ columns: columns.map(name => ({ name })) } as unknown as TableSchema)
      : undefined;
}

describe('change log orphan cleanup', () => {
  describe('local deletes', () => {
    let source: FakeTransactionSource;
    let manager: SyncManagerImpl;

    beforeEach(async () => {
      source = new FakeTransactionSource();
      manager = await SyncManagerImpl.create(
        new InMemoryKVStore(),
        source,
        { ...DEFAULT_SYNC_CONFIG, ...EXPIRE_IMMEDIATELY },
        new SyncEventEmitterImpl(),
      );
    });

    const insert = async (pk: number, row: SqlValue[]) => {
      source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [pk], newRow: row });
      await settle();
    };
    const remove = async (pk: number, row: SqlValue[]) => {
      source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [pk], oldRow: row });
      await settle();
    };

    // Pre-fix: 4, 7, 10, 13, 16 — +3 per cycle on ONE row, growing without bound.
    it('does not grow across repeated insert→delete cycles on one row', async () => {
      for (let i = 0; i < 5; i++) {
        await insert(1, [`a${i}`, `b${i}`, `c${i}`]);
        await remove(1, [`a${i}`, `b${i}`, `c${i}`]);

        // One surviving entry: the current tombstone's delete entry. The three
        // column entries died with the column versions they indexed.
        expect(await countChangeLog(manager)).to.equal(1);
      }

      expect(await manager.pruneTombstones()).to.equal(1);
      expect(await countChangeLog(manager)).to.equal(0);
    });

    // Pre-fix: 80 entries (20 x (3 columns + 1 delete)), and still 80 after pruning.
    it('returns to empty after N distinct rows are inserted, deleted and pruned', async () => {
      const rows = 20;
      for (let pk = 1; pk <= rows; pk++) {
        await insert(pk, ['x', 'y', 'z']);
        await remove(pk, ['x', 'y', 'z']);
      }

      expect(await countChangeLog(manager)).to.equal(rows);   // one delete entry per row
      expect(await countTombstones(manager)).to.equal(rows);

      expect(await manager.pruneTombstones()).to.equal(rows);
      expect(await countChangeLog(manager)).to.equal(0);
    });

    it('leaves live rows fully indexed while unrelated rows are deleted and pruned', async () => {
      await insert(1, ['x', 'y', 'z']);
      await insert(3, ['x', 'y', 'z']);
      const peer = generateSiteId();
      const before = await manager.getChangesSince(peer, BEGINNING_OF_TIME);

      // Churn an unrelated row through its whole lifecycle.
      await insert(2, ['p', 'q', 'r']);
      await remove(2, ['p', 'q', 'r']);
      await manager.pruneTombstones();

      // 2 live rows x 3 columns; row 2 left no residue at all.
      expect(await countChangeLog(manager)).to.equal(6);

      const after = await manager.getChangesSince(peer, BEGINNING_OF_TIME);
      expect(after).to.deep.equal(before);
    });

    // Guards the ordering `recordDataEvent` relies on: cleanup runs against
    // COMMITTED state in its own batch, before the transaction's outer batch lands.
    // A delete followed by a reinsert of the same pk in ONE transaction must
    // therefore keep the reinsert — the cleanup ran before those versions existed.
    // (The reverse order does NOT hold; see
    // `sync-delete-cleanup-misses-same-batch-writes`.)
    it('keeps a reinsert that follows a delete of the same row in one transaction', async () => {
      await insert(1, ['x', 'y', 'z']);

      source.commit({
        data: [
          { type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y', 'z'] },
          { type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a', 'b', 'c'] },
        ],
      });
      await settle();

      const versions = await manager.columnVersions.getRowVersions('main', 'users', [1]);
      expect([...versions.keys()].sort()).to.deep.equal(['col_0', 'col_1', 'col_2']);
      // 3 live column entries + the tombstone's delete entry (the row is
      // tombstoned AND rewritten; LWW resolves by HLC, both stay indexed).
      expect(await countChangeLog(manager)).to.equal(4);
    });

    it('cleans up a column whose name contains the key separator', async () => {
      // A quoted identifier may contain ':' — the change-log key must still be
      // rebuilt from the exact stored column name, not a truncated one.
      // (Separately, such an entry is currently invisible to parseChangeLogKey /
      // parseColumnVersionKey, which split at the LAST ':' — that is why this
      // counts raw KV records. Tracked as `bug-sync-colon-in-column-name-drops-cell`.)
      const colonSource = new FakeTransactionSource();
      const withColonColumn = await SyncManagerImpl.create(
        new InMemoryKVStore(),
        colonSource,
        { ...DEFAULT_SYNC_CONFIG, ...EXPIRE_IMMEDIATELY },
        new SyncEventEmitterImpl(),
        undefined,
        usersSchemaOracle(['id', 'a:b']),
      );

      colonSource.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: [1, 'v'] });
      await settle();
      expect(await countChangeLog(withColonColumn)).to.equal(2);

      colonSource.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: [1, 'v'] });
      await settle();

      expect(await countChangeLog(withColonColumn)).to.equal(1);   // the delete entry only
      await withColonColumn.pruneTombstones();
      expect(await countChangeLog(withColonColumn)).to.equal(0);
    });
  });

  describe('applied (inbound) deletes', () => {
    // The path a relay runs almost exclusively: no local DML at all, every write
    // arrives through applyChanges.
    it('returns to empty after relaying upstream inserts then deletes', async () => {
      const source = new FakeTransactionSource();
      const origin = await SyncManagerImpl.create(
        new InMemoryKVStore(), source, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
      );
      const relay = await SyncManagerImpl.create(
        new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG, ...EXPIRE_IMMEDIATELY }, new SyncEventEmitterImpl(),
      );

      const rows = 10;
      for (let pk = 1; pk <= rows; pk++) {
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [pk], newRow: ['x', 'y', 'z'] });
      }
      await settle();

      const inserts: ChangeSet[] = await origin.getChangesSince(relay.getSiteId());
      await relay.applyChanges(inserts);
      expect(await countChangeLog(relay)).to.equal(rows * 3);

      for (let pk = 1; pk <= rows; pk++) {
        source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [pk], oldRow: ['x', 'y', 'z'] });
      }
      await settle();

      const deletes: ChangeSet[] = await origin.getChangesSince(relay.getSiteId());
      await relay.applyChanges(deletes);

      // Pre-fix the relay kept all 30 column entries alongside the 10 delete
      // entries, and pruning removed none of them.
      expect(await countChangeLog(relay)).to.equal(rows);

      expect(await relay.pruneTombstones()).to.equal(rows);
      expect(await countChangeLog(relay)).to.equal(0);
    });

    // A delete and a re-creation of ONE row arriving in a single applyChanges
    // batch must resolve exactly as they would arriving in separate batches —
    // Phase 1 resolves only against pre-batch state, so the in-batch delete has
    // to be reconciled against the in-batch column writes explicitly
    // (change-applicator's reconcileInBatchDeletes).
    describe('in-batch delete + re-creation', () => {
      const RESURRECT: Partial<SyncConfig> = { allowResurrection: true };

      /**
       * Origin does three separate local transactions on `main.users` row 1:
       * insert x,y,z; delete; re-insert a,b,c. The origin's own delete cleanup
       * removes the first insert's entries, so a fresh receiver pulls exactly
       * two transactions: the delete, then the re-creation.
       */
      async function makeOriginWithRecreatedRow(): Promise<SyncManagerImpl> {
        const source = new FakeTransactionSource();
        const origin = await SyncManagerImpl.create(
          new InMemoryKVStore(), source, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
        );
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['x', 'y', 'z'] });
        await settle();
        source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y', 'z'] });
        await settle();
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a', 'b', 'c'] });
        await settle();
        return origin;
      }

      const makeRelay = (config: Partial<SyncConfig> = {}): Promise<SyncManagerImpl> =>
        SyncManagerImpl.create(
          new InMemoryKVStore(), undefined, { ...DEFAULT_SYNC_CONFIG, ...config }, new SyncEventEmitterImpl(),
        );

      /** Everything the parity assertion compares between two relays. */
      async function relayState(manager: SyncManagerImpl): Promise<unknown> {
        const versions = await manager.columnVersions.getRowVersions('main', 'users', [1]);
        return {
          cells: [...versions.entries()].sort(([a], [b]) => a.localeCompare(b)),
          logCount: await countChangeLog(manager),
          tombstones: await countTombstones(manager),
        };
      }

      /** Apply the same origin's changesets to `batched` in ONE call and to `separate` one per call. */
      async function applyBothWays(
        origin: SyncManagerImpl,
        batched: SyncManagerImpl,
        separate: SyncManagerImpl,
      ): Promise<{ batchedResult: ApplyResult; separateResults: ApplyResult[] }> {
        const batchedResult = await batched.applyChanges(await origin.getChangesSince(batched.getSiteId()));

        const sets = await origin.getChangesSince(separate.getSiteId());
        // The delete and the re-creation really are distinct transactions — the
        // separate-applies leg genuinely splits them.
        expect(sets.length).to.be.greaterThan(1);
        const separateResults: ApplyResult[] = [];
        for (const changeSet of sets) separateResults.push(await separate.applyChanges([changeSet]));

        return { batchedResult, separateResults };
      }

      const sumResults = (results: ApplyResult[]): { applied: number; skipped: number; conflicts: number } =>
        results.reduce(
          (acc, r) => ({ applied: acc.applied + r.applied, skipped: acc.skipped + r.skipped, conflicts: acc.conflicts + r.conflicts }),
          { applied: 0, skipped: 0, conflicts: 0 },
        );

      // Pre-fix: the batched relay ended with 0 cell records — Phase 3's delete
      // cleanup wiped the re-created row's versions right after writing them.
      it('allowResurrection: true — one batch keeps the re-created row and matches separate applies', async () => {
        const origin = await makeOriginWithRecreatedRow();
        const batched = await makeRelay(RESURRECT);
        const separate = await makeRelay(RESURRECT);

        const { batchedResult, separateResults } = await applyBothWays(origin, batched, separate);

        // The re-creation won conflict resolution and survives: 3 cell records,
        // their 3 column change-log entries plus the tombstone's delete entry.
        const versions = await batched.columnVersions.getRowVersions('main', 'users', [1]);
        expect([...versions.keys()].sort()).to.deep.equal(['col_0', 'col_1', 'col_2']);
        expect([...versions.values()].map(v => v.value)).to.have.members(['a', 'b', 'c']);
        expect(await countChangeLog(batched)).to.equal(4);

        // Parity: state, counters, and what a third peer would receive.
        expect(await relayState(batched)).to.deep.equal(await relayState(separate));
        expect({ applied: batchedResult.applied, skipped: batchedResult.skipped, conflicts: batchedResult.conflicts })
          .to.deep.equal(sumResults(separateResults));

        const third = generateSiteId();
        const fromBatched = flattenSets(await batched.getChangesSince(third));
        expect(fromBatched).to.deep.equal(flattenSets(await separate.getChangesSince(third)));
        const reEmittedValues = fromBatched.filter(c => c.type === 'column').map(c => c.value).sort();
        expect(reEmittedValues).to.deep.equal(['a', 'b', 'c']);
      });

      // The receivers above were empty, so Phase 1 found no prior cell version to
      // record as the resurrecting write's before-image. A receiver that already
      // HOLDS the row does find one — the pre-delete value — even though the
      // same-batch delete erases that lineage. The origin (past its own delete) and
      // a separate-applies twin both record no prior, so keeping it would persist a
      // deleted value as the before-image and put it on the wire for a third peer.
      it('allowResurrection: true — a receiver that already holds the row records no stale before-image', async () => {
        const source = new FakeTransactionSource();
        const origin = await SyncManagerImpl.create(
          new InMemoryKVStore(), source, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
        );
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['x', 'y', 'z'] });
        await settle();

        const batched = await makeRelay(RESURRECT);
        const separate = await makeRelay(RESURRECT);
        await batched.applyChanges(await origin.getChangesSince(batched.getSiteId()));
        await separate.applyChanges(await origin.getChangesSince(separate.getSiteId()));

        source.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y', 'z'] });
        await settle();
        source.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['a', 'b', 'c'] });
        await settle();

        const { batchedResult, separateResults } = await applyBothWays(origin, batched, separate);

        // The re-created cells carry the new values and NO before-image — matching
        // the origin's own records for the same three facts.
        const versions = await batched.columnVersions.getRowVersions('main', 'users', [1]);
        expect([...versions.values()].map(v => v.value).sort()).to.deep.equal(['a', 'b', 'c']);
        expect([...versions.values()].map(v => v.priorHlc)).to.deep.equal([undefined, undefined, undefined]);
        expect([...versions.entries()].sort(([a], [b]) => a.localeCompare(b)))
          .to.deep.equal([...(await origin.columnVersions.getRowVersions('main', 'users', [1])).entries()]
            .sort(([a], [b]) => a.localeCompare(b)));

        expect(await relayState(batched)).to.deep.equal(await relayState(separate));
        expect({ applied: batchedResult.applied, skipped: batchedResult.skipped, conflicts: batchedResult.conflicts })
          .to.deep.equal(sumResults(separateResults));

        const third = generateSiteId();
        expect(flattenSets(await batched.getChangesSince(third)))
          .to.deep.equal(flattenSets(await separate.getChangesSince(third)));
      });

      // Pre-fix: the batched relay reported applied:4 / skipped:0 and emitted the
      // blocked column changes as applied, even though their metadata was wiped.
      it('allowResurrection: false (default) — one batch blocks the re-creation and matches separate applies', async () => {
        const origin = await makeOriginWithRecreatedRow();
        const batched = await makeRelay();
        const separate = await makeRelay();

        const { batchedResult, separateResults } = await applyBothWays(origin, batched, separate);

        // The in-batch delete blocks every column change for the row: only the
        // delete lands, and `skipped` counts the blocked column changes.
        expect(batchedResult.applied).to.equal(1);
        expect(batchedResult.skipped).to.equal(3);
        expect((await batched.columnVersions.getRowVersions('main', 'users', [1])).size).to.equal(0);
        expect(await countChangeLog(batched)).to.equal(1);

        expect(await relayState(batched)).to.deep.equal(await relayState(separate));
        expect({ applied: batchedResult.applied, skipped: batchedResult.skipped, conflicts: batchedResult.conflicts })
          .to.deep.equal(sumResults(separateResults));
      });

      // Reverse order — the column writes are OLDER than the same-batch delete.
      // Already the pre-fix behavior; pinned so the reconciliation can't regress it.
      it('keeps the row deleted when the same-batch column writes are older than the delete (both settings)', async () => {
        for (const config of [{}, RESURRECT]) {
          const insertSource = new FakeTransactionSource();
          const inserter = await SyncManagerImpl.create(
            new InMemoryKVStore(), insertSource, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
          );
          const deleteSource = new FakeTransactionSource();
          const deleter = await SyncManagerImpl.create(
            new InMemoryKVStore(), deleteSource, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(),
          );

          insertSource.commitData({ type: 'insert', schemaName: 'main', tableName: 'users', key: [1], newRow: ['x', 'y', 'z'] });
          await settle();
          deleteSource.commitData({ type: 'delete', schemaName: 'main', tableName: 'users', key: [1], oldRow: ['x', 'y', 'z'] });
          await settle();

          const receiver = await makeRelay(config);
          const batch = [
            ...await inserter.getChangesSince(receiver.getSiteId()),
            ...await deleter.getChangesSince(receiver.getSiteId()),
          ];
          // Guard the premise: the delete's HLC really is the row's max.
          const changes = flattenSets(batch);
          const deleteHlc = changes.find(c => c.type === 'delete')!.hlc;
          for (const c of changes.filter(c => c.type === 'column')) {
            expect(compareHLC(deleteHlc, c.hlc)).to.be.greaterThan(0);
          }

          await receiver.applyChanges(batch);
          expect((await receiver.columnVersions.getRowVersions('main', 'users', [1])).size).to.equal(0);
          expect(await countChangeLog(receiver)).to.equal(1);   // the delete entry only
        }
      });

      // Store-backed: the row's DATA outcome must match the metadata outcome.
      // Pre-fix the store adapter collapsed each row group with delete-wins, so a
      // re-creation that won resolution still vanished from the actual table.
      it('store-backed: one batch re-creates the table row like separate applies (allowResurrection: true)', async () => {
        const origin = await makePeer('origin', { createOrders: true });
        const batched = await makePeer('batched', { createOrders: true, config: RESURRECT });
        const separate = await makePeer('separate', { createOrders: true, config: RESURRECT });
        try {
          await localWrite(origin, "insert into orders (id, note) values (1, 'x')");
          await localWrite(origin, 'delete from orders where id = 1');
          await localWrite(origin, "insert into orders (id, note) values (1, 'a')");

          await relay(origin, batched);
          const sets = await origin.manager.getChangesSince(separate.manager.getSiteId());
          for (const changeSet of sets) {
            await separate.manager.applyChanges([{ ...changeSet, schemaMigrations: [] }]);
          }

          const batchedRows = await collect(batched.db, 'select id, note from orders');
          expect(batchedRows).to.deep.equal([{ id: 1, note: 'a' }]);
          expect(batchedRows).to.deep.equal(await collect(separate.db, 'select id, note from orders'));

          const cells = await batched.manager.columnVersions.getRowVersions('main', 'orders', [1]);
          expect(cells.size).to.equal(COLUMNS_PER_FRESH_INSERT);
          expect(await countChangeLog(batched.manager)).to.equal(COLUMNS_PER_FRESH_INSERT + 1);
          expect(await countChangeLog(separate.manager)).to.equal(COLUMNS_PER_FRESH_INSERT + 1);
        } finally {
          await closePeer(origin);
          await closePeer(batched);
          await closePeer(separate);
        }
      });

      it('store-backed: one batch leaves the table row deleted like separate applies (default)', async () => {
        const origin = await makePeer('origin', { createOrders: true });
        const batched = await makePeer('batched', { createOrders: true });
        const separate = await makePeer('separate', { createOrders: true });
        try {
          await localWrite(origin, "insert into orders (id, note) values (1, 'x')");
          await localWrite(origin, 'delete from orders where id = 1');
          await localWrite(origin, "insert into orders (id, note) values (1, 'a')");

          const batchedResult = await relay(origin, batched);
          const sets = await origin.manager.getChangesSince(separate.manager.getSiteId());
          for (const changeSet of sets) {
            await separate.manager.applyChanges([{ ...changeSet, schemaMigrations: [] }]);
          }

          expect(batchedResult.applied).to.equal(1);
          expect(batchedResult.skipped).to.equal(COLUMNS_PER_FRESH_INSERT);
          expect(await collect(batched.db, 'select id, note from orders')).to.deep.equal([]);
          expect(await collect(separate.db, 'select id, note from orders')).to.deep.equal([]);
          expect((await batched.manager.columnVersions.getRowVersions('main', 'orders', [1])).size).to.equal(0);
          expect(await countChangeLog(batched.manager)).to.equal(1);
          expect(await countChangeLog(separate.manager)).to.equal(1);
        } finally {
          await closePeer(origin);
          await closePeer(batched);
          await closePeer(separate);
        }
      });
    });
  });
});
