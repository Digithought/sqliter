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
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type ChangeSet } from '../../src/sync/protocol.js';
import { InMemoryKVStore } from '@quereus/store';
import { generateSiteId } from '../../src/clock/site.js';
import { buildAllChangeLogScanBounds } from '../../src/metadata/keys.js';
import type { HLC } from '../../src/clock/hlc.js';
import type { SqlValue, TableSchema } from '@quereus/quereus';
import { FakeTransactionSource } from '../helpers/fake-transaction-source.js';

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
  });
});
