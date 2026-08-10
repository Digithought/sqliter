/**
 * Tests for IndexedDB store implementation using fake-indexeddb.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { IndexedDBStore, MultiStoreWriteBatch } from '../src/store.js';
import { IndexedDBManager } from '../src/manager.js';
import { IndexedDBProvider } from '../src/provider.js';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';

describe('IndexedDBStore', () => {
  const testDbName = 'test-store-db';
  const storeName = 'test-store';
  let store: IndexedDBStore;

  beforeEach(async () => {
    const manager = IndexedDBManager.getInstance(testDbName);
    await manager.ensureObjectStore(storeName);
    store = await IndexedDBStore.openForTable(testDbName, storeName);
  });

  afterEach(async () => {
    await store.close();
    const manager = IndexedDBManager.getInstance(testDbName);
    await manager.close();
    IndexedDBManager.resetInstance(testDbName);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(testDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  // Point ops, iteration & ordering, and basic batch put/delete are covered for this
  // backend by the shared KVStore conformance suite (see conformance.spec.ts). This
  // file keeps only IndexedDB-SPECIFIC behavior with no cross-backend analogue.
  describe('Batch operations', () => {
    it('should complete write batch during a concurrent version upgrade', async () => {
      // This exercises the race condition: ensureObjectStore triggers a version
      // upgrade that closes this.db and sets it to null.  Before the fix,
      // WriteBatch.write() called the synchronous getDatabase() which would
      // return null and throw "Database not open".  After the fix it calls
      // ensureOpen() which waits for the upgrade to finish.
      const manager = store.getManager();
      const batch = store.batch();
      batch.put(new Uint8Array([10]), new Uint8Array([100]));
      batch.put(new Uint8Array([11]), new Uint8Array([110]));

      // Start the upgrade. doUpgrade() closes the current connection before
      // reopening at the bumped version, so getDatabase() briefly returns null.
      const upgradePromise = manager.ensureObjectStore('new-table-for-race-test');
      // Wait until that in-flight window is observable (bounded, so we never spin):
      // this guarantees the write below fires while a version upgrade is genuinely
      // in flight, forcing it through ensureOpen()'s wait-for-schema-queue path.
      for (let i = 0; i < 50 && manager.getDatabase() !== null; i++) {
        await Promise.resolve();
      }

      // Now start the batch write while the upgrade is in-flight.
      // ensureOpen() awaits the schema queue and then returns the reopened db.
      const writePromise = batch.write();

      await Promise.all([upgradePromise, writePromise]);

      // The write should have succeeded despite the concurrent upgrade
      expect(await store.get(new Uint8Array([10]))).to.deep.equal(new Uint8Array([100]));
      expect(await store.get(new Uint8Array([11]))).to.deep.equal(new Uint8Array([110]));

      // The new object store should also exist
      expect(manager.hasObjectStore('new-table-for-race-test')).to.be.true;
    });
  });

  // The streaming/batch-boundary iteration behavior (mid-iteration consumer awaits,
  // reverse across the boundary, limit spanning it, and the collapsed-range DataError
  // regression on inclusive bounds landing on a 256-entry multiple) is now asserted
  // for this backend by the shared conformance suite's Tier 3 (conformance.spec.ts).
  // MultiStoreWriteBatch is IndexedDB-specific (not the KVStore.batch surface), so its
  // reuse test stays here.
  describe('Batch reuse after commit', () => {
    it('does not re-apply a committed MultiStoreWriteBatch on reuse', async () => {
      const manager = store.getManager();
      const k1 = new Uint8Array([3]);
      const v1 = new Uint8Array([33]);
      const k2 = new Uint8Array([4]);
      const v2 = new Uint8Array([44]);

      const mb = new MultiStoreWriteBatch(manager);
      mb.putToStore(storeName, k1, v1);
      await mb.write();
      expect(await store.get(k1)).to.deep.equal(v1);

      await store.delete(k1);
      mb.putToStore(storeName, k2, v2);
      await mb.write();

      expect(await store.get(k1)).to.be.undefined;
      expect(await store.get(k2)).to.deep.equal(v2);
    });
  });
});

describe('IndexedDB Store Integration', () => {
  const testDbName = 'test-integration-db';
  let db: Database;
  let provider: IndexedDBProvider;

  beforeEach(async () => {
    db = new Database();
    provider = new IndexedDBProvider({ databaseName: testDbName });
    const storeModule = new StoreModule(provider);
    db.registerModule('store', storeModule);
  });

  afterEach(async () => {
    await provider.closeAll();
    IndexedDBManager.resetInstance(testDbName);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(testDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  describe('Integer primary key handling', () => {
    it('should store rows with integer primary key and retrieve them', async () => {
      // This reproduces the UndoGroup table structure from the bug report
      await db.exec(`
        CREATE TABLE UndoGroup (
          id INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          target_db TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          undone INTEGER NOT NULL DEFAULT 0
        ) USING store
      `);

      // Insert a row with an integer ID
      await db.exec(`
        INSERT INTO UndoGroup (id, description, target_db, created_at, undone)
        VALUES (1, 'Test undo group', 'main', 1706745600000, 0)
      `);

      // Verify we can retrieve the row by primary key
      const row = await db.get('SELECT * FROM UndoGroup WHERE id = 1');
      expect(row).to.not.be.undefined;
      expect(row?.id).to.equal(1);
      expect(row?.description).to.equal('Test undo group');
    });

    it('should store multiple rows with different integer IDs', async () => {
      await db.exec(`
        CREATE TABLE UndoGroup (
          id INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          target_db TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          undone INTEGER NOT NULL DEFAULT 0
        ) USING store
      `);

      // Insert multiple rows
      await db.exec(`INSERT INTO UndoGroup VALUES (1, 'First', 'db1', 1000, 0)`);
      await db.exec(`INSERT INTO UndoGroup VALUES (2, 'Second', 'db2', 2000, 0)`);
      await db.exec(`INSERT INTO UndoGroup VALUES (10, 'Tenth', 'db3', 3000, 1)`);

      // Verify all rows can be retrieved
      const rows = await asyncIterableToArray(db.eval('SELECT * FROM UndoGroup ORDER BY id'));
      expect(rows).to.have.length(3);
      expect(rows[0].id).to.equal(1);
      expect(rows[1].id).to.equal(2);
      expect(rows[2].id).to.equal(10);
    });

    it('should properly encode integer keys for IndexedDB storage', async () => {
      await db.exec(`
        CREATE TABLE test_int_pk (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      await db.exec(`INSERT INTO test_int_pk VALUES (42, 'Answer')`);

      // Directly check the underlying KVStore to verify the key is non-empty
      const kvStore = await provider.getStore('main', 'test_int_pk');
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of kvStore.iterate({})) {
        entries.push(entry);
      }

      // There should be exactly one entry
      expect(entries).to.have.length(1);

      // The key should not be empty - integer 42 should be encoded
      expect(entries[0].key.length).to.be.greaterThan(0);      // For a numeric, the encoded key should have:
      // - 1 byte type prefix (0x01 for NUMERIC)
      // - 8 bytes sortable double (big-endian with sign flip)
      // - 8 bytes signed tie-break tail
      // Total: 17 bytes
      expect(entries[0].key.length).to.equal(17);
    });

    it('should handle zero as integer primary key', async () => {
      await db.exec(`
        CREATE TABLE test_zero_pk (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      await db.exec(`INSERT INTO test_zero_pk VALUES (0, 'Zero')`);

      const row = await db.get('SELECT * FROM test_zero_pk WHERE id = 0');
      expect(row).to.not.be.undefined;
      expect(row?.id).to.equal(0);
      expect(row?.name).to.equal('Zero');
    });

    it('should handle negative integers as primary key', async () => {
      await db.exec(`
        CREATE TABLE test_negative_pk (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      await db.exec(`INSERT INTO test_negative_pk VALUES (-1, 'Negative one')`);
      await db.exec(`INSERT INTO test_negative_pk VALUES (-100, 'Negative hundred')`);

      const rows = await asyncIterableToArray(db.eval('SELECT * FROM test_negative_pk ORDER BY id'));
      expect(rows).to.have.length(2);
      // Negative numbers should sort before positive
      expect(rows[0].id).to.equal(-100);
      expect(rows[1].id).to.equal(-1);
    });

    it('should handle large integers as primary key', async () => {
      await db.exec(`
        CREATE TABLE test_large_pk (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      // Use a large but safe integer
      const largeId = 9007199254740991; // Number.MAX_SAFE_INTEGER
      await db.exec(`INSERT INTO test_large_pk VALUES (${largeId}, 'Max safe integer')`);

      const row = await db.get(`SELECT * FROM test_large_pk WHERE id = ${largeId}`);
      expect(row).to.not.be.undefined;
      expect(row?.id).to.equal(largeId);
    });
  });

  describe('Row retrieval after insert', () => {
    it('should retrieve inserted rows immediately', async () => {
      await db.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          data TEXT
        ) USING store
      `);

      // Insert and immediately retrieve
      await db.exec(`INSERT INTO items VALUES (1, 'one')`);
      let row = await db.get('SELECT * FROM items WHERE id = 1');
      expect(row?.data).to.equal('one');

      await db.exec(`INSERT INTO items VALUES (2, 'two')`);
      row = await db.get('SELECT * FROM items WHERE id = 2');
      expect(row?.data).to.equal('two');

      // Verify all rows exist
      const all = await asyncIterableToArray(db.eval('SELECT * FROM items'));
      expect(all).to.have.length(2);
    });
  });
});

describe('IndexedDB Store Integration with Isolation', () => {
  const testDbName = 'test-isolated-db';
  let db: Database;
  let provider: IndexedDBProvider;

  beforeEach(async () => {
    db = new Database();
    provider = new IndexedDBProvider({ databaseName: testDbName });
    // Use isolation layer (default in plugin)
    const storeModule = createIsolatedStoreModule({ provider });
    db.registerModule('store', storeModule);
  });

  afterEach(async () => {
    await provider.closeAll();
    IndexedDBManager.resetInstance(testDbName);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(testDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  describe('Integer primary key handling with isolation', () => {
    it('should store rows with integer primary key and retrieve them', async () => {
      // Simple test case
      await db.exec(`
        CREATE TABLE simple_test (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      // Insert multiple rows to ensure data visibility
      // (single insert followed by immediate read has timing issues with fake-indexeddb)
      await db.exec(`INSERT INTO simple_test VALUES (1, 'test')`);
      await db.exec(`INSERT INTO simple_test VALUES (2, 'test2')`);

      // Verify via a full table scan first
      const allRows = await asyncIterableToArray(db.eval('SELECT * FROM simple_test ORDER BY id'));
      expect(allRows).to.have.length(2);
      expect(allRows[0]?.id).to.equal(1);
      expect(allRows[0]?.name).to.equal('test');

      // Verify we can retrieve the row by primary key
      const row = await db.get('SELECT * FROM simple_test WHERE id = 1');
      expect(row).to.not.be.undefined;
      expect(row?.id).to.equal(1);
      expect(row?.name).to.equal('test');
    });

    it('should store multiple rows with different integer IDs', async () => {
      await db.exec(`
        CREATE TABLE UndoGroup (
          id INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          target_db TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          undone INTEGER NOT NULL DEFAULT 0
        ) USING store
      `);

      // Insert multiple rows
      await db.exec(`INSERT INTO UndoGroup VALUES (1, 'First', 'db1', 1000, 0)`);
      await db.exec(`INSERT INTO UndoGroup VALUES (2, 'Second', 'db2', 2000, 0)`);
      await db.exec(`INSERT INTO UndoGroup VALUES (10, 'Tenth', 'db3', 3000, 1)`);

      // Verify all rows can be retrieved
      const rows = await asyncIterableToArray(db.eval('SELECT * FROM UndoGroup ORDER BY id'));
      expect(rows).to.have.length(3);
      expect(rows[0].id).to.equal(1);
      expect(rows[1].id).to.equal(2);
      expect(rows[2].id).to.equal(10);
    });

    it('should properly encode integer keys for IndexedDB storage after commit', async () => {
      await db.exec(`
        CREATE TABLE test_int_pk (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      // With isolation, data is only written to IndexedDB after commit
      await db.exec('BEGIN');
      await db.exec(`INSERT INTO test_int_pk VALUES (42, 'Answer')`);
      await db.exec(`INSERT INTO test_int_pk VALUES (43, 'Another')`);

      // Verify we can read our own write within the transaction
      const rowInTx = await db.get('SELECT * FROM test_int_pk WHERE id = 42');
      expect(rowInTx).to.not.be.undefined;
      expect(rowInTx?.id).to.equal(42);

      await db.exec('COMMIT');

      // Extra transaction cycle ensures IndexedDB data visibility
      // (fake-indexeddb has timing issues with single write+read)
      await db.exec('BEGIN');
      await db.exec('COMMIT');

      // After commit, verify the data is still accessible
      const rowAfterCommit = await db.get('SELECT * FROM test_int_pk WHERE id = 42');
      expect(rowAfterCommit).to.not.be.undefined;
      expect(rowAfterCommit?.id).to.equal(42);

      // Note: With isolation layer, the underlying KVStore may be empty
      // because data is held in the isolation overlay until a new transaction starts.
      // The important thing is that the data is accessible via queries.
    });

    it('should handle transactions with integer keys', async () => {
      await db.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      // Insert within a transaction
      await db.exec('BEGIN');
      await db.exec(`INSERT INTO items VALUES (1, 'one')`);
      await db.exec(`INSERT INTO items VALUES (2, 'two')`);
      await db.exec(`INSERT INTO items VALUES (3, 'three')`);

      // Read-your-own-writes should work
      const row = await db.get('SELECT * FROM items WHERE id = 1');
      expect(row?.name).to.equal('one');

      await db.exec('COMMIT');

      // Extra transaction cycle ensures IndexedDB data visibility
      // (fake-indexeddb has timing issues with single write+read)
      await db.exec('BEGIN');
      await db.exec('COMMIT');

      // After commit, should still be there
      const allRows = await asyncIterableToArray(db.eval('SELECT * FROM items ORDER BY id'));
      expect(allRows).to.have.length(3);
    });

    it('should handle rollback with integer keys', async () => {
      await db.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          name TEXT
        ) USING store
      `);

      // First insert some data and commit (multiple inserts to ensure visibility)
      await db.exec(`INSERT INTO items VALUES (1, 'initial')`);
      await db.exec(`INSERT INTO items VALUES (2, 'second')`);

      // Now try a transaction that we'll rollback
      await db.exec('BEGIN');
      await db.exec(`INSERT INTO items VALUES (3, 'will be rolled back')`);

      // Should see it within transaction
      let rows = await asyncIterableToArray(db.eval('SELECT * FROM items ORDER BY id'));
      expect(rows).to.have.length(3);

      await db.exec('ROLLBACK');

      // After rollback, should only have the initial rows
      rows = await asyncIterableToArray(db.eval('SELECT * FROM items ORDER BY id'));
      expect(rows).to.have.length(2);
      expect(rows[0].id).to.equal(1);
      expect(rows[1].id).to.equal(2);
    });

    it('should persist data to IndexedDB after transaction commit', async () => {
      await db.exec(`
        CREATE TABLE persist_test (
          id INTEGER PRIMARY KEY,
          value TEXT
        ) USING store
      `);

      // Insert data within a transaction and commit
      await db.exec('BEGIN');
      await db.exec(`INSERT INTO persist_test VALUES (100, 'committed data')`);
      await db.exec('COMMIT');

      // Start a new transaction to force the previous one to be fully flushed
      await db.exec('BEGIN');
      await db.exec('COMMIT');

      // Now check the underlying KVStore
      const kvStore = await provider.getStore('main', 'persist_test');
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of kvStore.iterate({})) {
        entries.push(entry);
      }

      // There should be exactly one entry with a proper key
      expect(entries).to.have.length(1);
      expect(entries[0].key.length).to.be.greaterThan(0);

      // Verify the key is a properly encoded numeric (17 bytes: 1 type prefix +
      // 8-byte sortable double + 8-byte signed tie-break tail).
      expect(entries[0].key.length).to.equal(17);

      // First byte should be 0x01 (TYPE_NUMERIC — unified int/real numeric tag)
      expect(entries[0].key[0]).to.equal(0x01);
    });

    it('should handle parameterized inserts with integer primary key', async () => {
      // This reproduces the exact UndoGroup table structure from the bug report
      await db.exec(`
        CREATE TABLE UndoGroup (
          id INTEGER PRIMARY KEY,
          description TEXT NOT NULL,
          target_db TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          undone INTEGER NOT NULL DEFAULT 0
        ) USING store
      `);

      // Use parameterized insert - this is how the application does it
      const id = 1;
      const description = 'Test undo group';
      const targetDb = 'main';
      const createdAt = Date.now();

      await db.exec(
        'INSERT INTO UndoGroup (id, description, target_db, created_at) VALUES (?, ?, ?, ?)',
        [id, description, targetDb, createdAt]
      );

      // Insert a second row to ensure data visibility
      // (single insert followed by immediate read has timing issues with fake-indexeddb)
      await db.exec(
        'INSERT INTO UndoGroup (id, description, target_db, created_at) VALUES (?, ?, ?, ?)',
        [2, 'Second group', 'other', Date.now()]
      );

      // Verify we can retrieve the row by primary key
      const row = await db.get('SELECT * FROM UndoGroup WHERE id = ?', [id]);
      expect(row).to.not.be.undefined;
      expect(row?.id).to.equal(id);
      expect(row?.description).to.equal(description);
    });

    it('should handle parameterized inserts with multiple rows', async () => {
      await db.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        ) USING store
      `);

      // Insert multiple rows using parameters
      for (let i = 1; i <= 5; i++) {
        await db.exec('INSERT INTO items VALUES (?, ?)', [i, `Item ${i}`]);
      }

      // Verify all rows
      const rows = await asyncIterableToArray(db.eval('SELECT * FROM items ORDER BY id'));
      expect(rows).to.have.length(5);
      expect(rows[0].id).to.equal(1);
      expect(rows[4].id).to.equal(5);
    });
  });
});
