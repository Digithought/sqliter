/**
 * Tests for StoreManager - multi-tenant LevelDB store management.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { StoreManager } from '../src/service/store-manager.js';

const TEST_DATABASE_ID = 'test-db-1';
const TEST_DATABASE_ID_2 = 'test-db-2';

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses.
 *
 * Used by the disk-eviction tests instead of a fixed sleep. Store close is
 * async (awaits LevelDB `store.close()` before the store is registered as an
 * eviction candidate), so under CPU/IO load the close can land well after a
 * fixed wall-clock deadline — a fixed `setTimeout` then asserting the
 * intermediate candidate count races that latency and flakes. Polling waits
 * for the actual state to settle, with a generous timeout as the failure cap.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

describe('StoreManager', () => {
  let manager: StoreManager;
  let testDataDir: string;

  beforeEach(() => {
    testDataDir = join(tmpdir(), `sync-store-test-${randomUUID()}`);
    manager = new StoreManager({
      dataDir: testDataDir,
      maxOpenStores: 3,
      idleTimeoutMs: 100,
      cleanupIntervalMs: 50,
    });
    manager.start();
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('validateDatabaseId', () => {
    it('should accept alphanumeric IDs', () => {
      expect(manager.validateDatabaseId('my-database')).to.be.true;
      expect(manager.validateDatabaseId('org:type_id')).to.be.true;
      expect(manager.validateDatabaseId('a1.b2.c3')).to.be.true;
    });

    it('should reject empty string', () => {
      expect(manager.validateDatabaseId('')).to.be.false;
    });

    it('should reject IDs with unsafe characters', () => {
      expect(manager.validateDatabaseId('path/traversal')).to.be.false;
      expect(manager.validateDatabaseId('../escape')).to.be.false;
      expect(manager.validateDatabaseId('has spaces')).to.be.false;
    });

    it('should use custom isValidDatabaseId hook', () => {
      const customManager = new StoreManager({
        dataDir: testDataDir,
        hooks: {
          isValidDatabaseId: (id) => id.startsWith('org:'),
        },
      });
      expect(customManager.validateDatabaseId('org:db1')).to.be.true;
      expect(customManager.validateDatabaseId('db1')).to.be.false;
    });
  });

  describe('acquire and release', () => {
    it('should open a store on first acquire', async () => {
      expect(manager.openCount).to.equal(0);
      const entry = await manager.acquire(TEST_DATABASE_ID);
      expect(entry).to.have.property('store');
      expect(entry).to.have.property('syncManager');
      expect(entry.databaseId).to.equal(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(1);
      expect(manager.openCount).to.equal(1);
    });

    it('should return cached store on subsequent acquire', async () => {
      const entry1 = await manager.acquire(TEST_DATABASE_ID);
      const entry2 = await manager.acquire(TEST_DATABASE_ID);
      expect(entry1).to.equal(entry2);
      expect(entry2.refCount).to.equal(2);
      expect(manager.openCount).to.equal(1);
    });

    it('should decrement refCount on release', async () => {
      const entry = await manager.acquire(TEST_DATABASE_ID);
      await manager.acquire(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(2);

      manager.release(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(1);
    });

    it('should not go below zero refCount', () => {
      manager.release('non-existent-db');
      // Should not throw
    });

    it('should open separate stores for different databases', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      await manager.acquire(TEST_DATABASE_ID_2);
      expect(manager.openCount).to.equal(2);
    });
  });

  describe('isOpen and get', () => {
    it('should report open state correctly', async () => {
      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.false;
      await manager.acquire(TEST_DATABASE_ID);
      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.true;
    });

    it('should return entry for open store via get', async () => {
      expect(manager.get(TEST_DATABASE_ID)).to.be.undefined;
      await manager.acquire(TEST_DATABASE_ID);
      const entry = manager.get(TEST_DATABASE_ID);
      expect(entry).to.not.be.undefined;
      expect(entry!.databaseId).to.equal(TEST_DATABASE_ID);
    });
  });

  describe('LRU eviction', () => {
    let lruManager: StoreManager;
    let lruDataDir: string;

    beforeEach(() => {
      lruDataDir = join(tmpdir(), `sync-lru-test-${randomUUID()}`);
      lruManager = new StoreManager({
        dataDir: lruDataDir,
        maxOpenStores: 3,
        idleTimeoutMs: 60_000,
        cleanupIntervalMs: 60_000,
      });
      // Deliberately NOT started: no cleanup timer, so the ONLY close path is evictLRU.
      // The shared manager's short idleTimeoutMs lets idle cleanup close a released store
      // while later stores are still opening (LevelDB open + createSyncModule can exceed
      // the timeout under load), which races the eviction behaviour under test.
    });

    afterEach(async () => {
      await lruManager.shutdown();
      await rm(lruDataDir, { recursive: true, force: true }).catch(() => {});
    });

    it('should evict LRU store when maxOpenStores reached', async () => {
      // maxOpenStores is 3 - open 3 stores
      await lruManager.acquire('db-a');
      lruManager.release('db-a');
      await lruManager.acquire('db-b');
      lruManager.release('db-b');
      await lruManager.acquire('db-c');
      lruManager.release('db-c');

      expect(lruManager.openCount).to.equal(3);

      // Opening a 4th should evict the oldest (db-a)
      await lruManager.acquire('db-d');
      expect(lruManager.openCount).to.be.at.most(3);
      expect(lruManager.isOpen('db-d')).to.be.true;
    });

    it('should not evict a store that was re-acquired before close', async () => {
      // Fill to capacity and release all
      await lruManager.acquire('db-a');
      lruManager.release('db-a');
      await lruManager.acquire('db-b');
      lruManager.release('db-b');
      await lruManager.acquire('db-c');
      lruManager.release('db-c');

      // Re-acquire db-a (the LRU candidate) so refCount > 0
      await lruManager.acquire('db-a');

      // Acquiring a 4th triggers eviction — db-a should be skipped
      // because its refCount is now 1
      await lruManager.acquire('db-d');
      expect(lruManager.isOpen('db-a')).to.be.true;
      expect(lruManager.isOpen('db-d')).to.be.true;
    });
  });

  describe('cleanup', () => {
    it('should close idle stores past timeout', async () => {
      const entry = await manager.acquire(TEST_DATABASE_ID);
      manager.release(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(0);

      // Wait for idle timeout + cleanup interval to fire
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.false;
    });

    it('should not close stores with active references', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      // Don't release — refCount stays 1

      // Wait for cleanup to fire
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.true;
    });

    it('should not run cleanup after shutdown begins', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      manager.release(TEST_DATABASE_ID);

      // Shutdown closes all stores and prevents further cleanup from running
      await manager.shutdown();
      expect(manager.openCount).to.equal(0);

      // Even if the cleanup interval were still active (it's cleared),
      // _shuttingDown prevents cleanup from iterating the cleared map
    });
  });

  describe('shutdown', () => {
    it('should close all stores', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      await manager.acquire(TEST_DATABASE_ID_2);
      expect(manager.openCount).to.equal(2);

      await manager.shutdown();
      expect(manager.openCount).to.equal(0);
    });

    it('should be idempotent', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      await manager.shutdown();
      await manager.shutdown(); // Second call should not throw
      expect(manager.openCount).to.equal(0);
    });
  });

  describe('disk eviction', () => {
    let evictManager: StoreManager;
    let evictDataDir: string;
    let evictCallback: (databaseId: string) => Promise<boolean>;

    beforeEach(() => {
      evictDataDir = join(tmpdir(), `sync-evict-test-${randomUUID()}`);
      // Default: always approve eviction
      evictCallback = async () => true;
      evictManager = new StoreManager({
        dataDir: evictDataDir,
        maxOpenStores: 10,
        idleTimeoutMs: 50,       // Close after 50ms idle
        cleanupIntervalMs: 30,   // Cleanup every 30ms
        diskEvictionIdleMs: 100, // Evict from disk after 100ms closed
        onEvictStore: (id) => evictCallback(id),
      });
      evictManager.start();
    });

    afterEach(async () => {
      await evictManager.shutdown();
      await rm(evictDataDir, { recursive: true, force: true }).catch(() => {});
    });

    it('should track closed stores as eviction candidates', async () => {
      await evictManager.acquire(TEST_DATABASE_ID);
      evictManager.release(TEST_DATABASE_ID);
      expect(evictManager.evictionCandidateCount).to.equal(0);

      // Wait for idle close to register the store as an eviction candidate.
      await waitFor(() => evictManager.evictionCandidateCount === 1);
      expect(evictManager.isOpen(TEST_DATABASE_ID)).to.be.false;
      expect(evictManager.evictionCandidateCount).to.equal(1);
    });

    it('should delete local directory after eviction idle threshold', async () => {
      await evictManager.acquire(TEST_DATABASE_ID);
      evictManager.release(TEST_DATABASE_ID);

      // Verify local directory exists
      const storagePath = join(evictDataDir, TEST_DATABASE_ID);
      expect(existsSync(storagePath)).to.be.true;

      // Wait for idle close + eviction threshold + cleanup cycles
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(evictManager.isOpen(TEST_DATABASE_ID)).to.be.false;
      expect(existsSync(storagePath)).to.be.false;
      expect(evictManager.evictionCandidateCount).to.equal(0);
    });

    it('should NOT delete directory when onEvictStore returns false', async () => {
      evictCallback = async () => false;

      await evictManager.acquire(TEST_DATABASE_ID);
      evictManager.release(TEST_DATABASE_ID);

      const storagePath = join(evictDataDir, TEST_DATABASE_ID);
      expect(existsSync(storagePath)).to.be.true;

      // Wait for idle close + eviction threshold
      await new Promise(resolve => setTimeout(resolve, 300));

      // Directory should still exist — eviction was denied
      expect(existsSync(storagePath)).to.be.true;
      // Still tracked as a candidate (will retry next cycle)
      expect(evictManager.evictionCandidateCount).to.equal(1);
    });

    it('should cancel eviction when store is re-acquired', async () => {
      await evictManager.acquire(TEST_DATABASE_ID);
      evictManager.release(TEST_DATABASE_ID);

      // Wait for idle close (but not eviction threshold)
      await waitFor(() => evictManager.evictionCandidateCount === 1);
      expect(evictManager.isOpen(TEST_DATABASE_ID)).to.be.false;
      expect(evictManager.evictionCandidateCount).to.equal(1);

      // Re-acquire the store — should remove from eviction candidates
      await evictManager.acquire(TEST_DATABASE_ID);
      expect(evictManager.evictionCandidateCount).to.equal(0);

      const storagePath = join(evictDataDir, TEST_DATABASE_ID);
      expect(existsSync(storagePath)).to.be.true;
    });

    it('should not track eviction candidates when diskEvictionIdleMs is 0', async () => {
      // The default manager (from beforeEach) has no eviction configured
      await manager.acquire(TEST_DATABASE_ID);
      manager.release(TEST_DATABASE_ID);

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.false;
      expect(manager.evictionCandidateCount).to.equal(0);

      // Directory should still exist
      const storagePath = join(testDataDir, TEST_DATABASE_ID);
      expect(existsSync(storagePath)).to.be.true;
    });

    it('should clear eviction candidates on shutdown', async () => {
      await evictManager.acquire(TEST_DATABASE_ID);
      evictManager.release(TEST_DATABASE_ID);

      // Wait for idle close to register the eviction candidate.
      await waitFor(() => evictManager.evictionCandidateCount === 1);
      expect(evictManager.evictionCandidateCount).to.equal(1);

      await evictManager.shutdown();
      expect(evictManager.evictionCandidateCount).to.equal(0);
    });
  });

  describe('isNew detection', () => {
    it('should mark first-time stores as isNew', async () => {
      const entry = await manager.acquire(TEST_DATABASE_ID);
      expect(entry.isNew).to.be.true;
    });

    it('should not mark re-opened stores as isNew', async () => {
      // Open and close a store to create local data
      await manager.acquire(TEST_DATABASE_ID);
      manager.release(TEST_DATABASE_ID);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.false;

      // Re-acquire — local directory exists, so isNew should be false
      const entry = await manager.acquire(TEST_DATABASE_ID);
      expect(entry.isNew).to.be.false;
    });
  });

  describe('onStoreCreated callback', () => {
    let callbackManager: StoreManager;
    let callbackDataDir: string;

    afterEach(async () => {
      if (callbackManager) {
        await callbackManager.shutdown();
        await rm(callbackDataDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('should call onStoreCreated for new stores', async () => {
      const created: string[] = [];
      callbackDataDir = join(tmpdir(), `sync-callback-test-${randomUUID()}`);
      callbackManager = new StoreManager({
        dataDir: callbackDataDir,
        maxOpenStores: 10,
        idleTimeoutMs: 60_000,
        cleanupIntervalMs: 60_000,
        onStoreCreated: async (entry) => {
          created.push(entry.databaseId);
        },
      });
      callbackManager.start();

      await callbackManager.acquire(TEST_DATABASE_ID);
      expect(created).to.deep.equal([TEST_DATABASE_ID]);
    });

    it('should NOT call onStoreCreated for existing stores', async () => {
      const created: string[] = [];
      callbackDataDir = join(tmpdir(), `sync-callback-test-${randomUUID()}`);

      // First: open without callback to create local data
      const tempManager = new StoreManager({
        dataDir: callbackDataDir,
        maxOpenStores: 10,
        idleTimeoutMs: 60_000,
        cleanupIntervalMs: 60_000,
      });
      tempManager.start();
      await tempManager.acquire(TEST_DATABASE_ID);
      await tempManager.shutdown();

      // Second: open with callback — should NOT fire since data already exists
      callbackManager = new StoreManager({
        dataDir: callbackDataDir,
        maxOpenStores: 10,
        idleTimeoutMs: 60_000,
        cleanupIntervalMs: 60_000,
        onStoreCreated: async (entry) => {
          created.push(entry.databaseId);
        },
      });
      callbackManager.start();

      await callbackManager.acquire(TEST_DATABASE_ID);
      expect(created).to.deep.equal([]);
    });

    it('should close store and propagate error when onStoreCreated fails', async () => {
      callbackDataDir = join(tmpdir(), `sync-callback-test-${randomUUID()}`);
      callbackManager = new StoreManager({
        dataDir: callbackDataDir,
        maxOpenStores: 10,
        idleTimeoutMs: 60_000,
        cleanupIntervalMs: 60_000,
        onStoreCreated: async () => {
          throw new Error('S3 restore failed');
        },
      });
      callbackManager.start();

      try {
        await callbackManager.acquire(TEST_DATABASE_ID);
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).to.equal('S3 restore failed');
      }

      // Store should not remain open after failure
      expect(callbackManager.isOpen(TEST_DATABASE_ID)).to.be.false;
    });
  });

  describe('pendingOpens deduplication', () => {
    it('should deduplicate concurrent acquires for the same databaseId', async () => {
      // Launch two concurrent acquires
      const [entry1, entry2] = await Promise.all([
        manager.acquire(TEST_DATABASE_ID),
        manager.acquire(TEST_DATABASE_ID),
      ]);

      // Both should resolve to the same store entry
      expect(entry1.store).to.equal(entry2.store);
      expect(entry1.refCount).to.equal(2);
      expect(manager.openCount).to.equal(1);
    });

    it('should open separate stores for different databaseIds concurrently', async () => {
      const [entry1, entry2] = await Promise.all([
        manager.acquire(TEST_DATABASE_ID),
        manager.acquire(TEST_DATABASE_ID_2),
      ]);

      expect(entry1.databaseId).to.equal(TEST_DATABASE_ID);
      expect(entry2.databaseId).to.equal(TEST_DATABASE_ID_2);
      expect(entry1.store).to.not.equal(entry2.store);
      expect(manager.openCount).to.equal(2);
    });
  });

  describe('close/acquire race', () => {
    // Reproduces the bug where an acquire that lands while a store is mid-close
    // (idle cleanup) receives the handle being torn down instead of a live one.
    // Deterministic via a barrier that parks store.close() so the racing acquire
    // is guaranteed to run during the close window.
    it('acquire during an in-flight close returns a live handle, not the closing one', async () => {
      const raceDataDir = join(tmpdir(), `sync-race-test-${randomUUID()}`);
      const raceManager = new StoreManager({
        dataDir: raceDataDir,
        maxOpenStores: 10,
        idleTimeoutMs: 0,      // eligible for close the moment refCount hits 0
        cleanupIntervalMs: 20, // cleanup fires quickly
      });
      raceManager.start();

      try {
        const entry = await raceManager.acquire(TEST_DATABASE_ID);
        raceManager.release(TEST_DATABASE_ID); // refCount → 0; cleanup will close it
        // NOTE: no await between release and the close patch below — cleanup cannot
        // interpose, so the store is always patched before its close() is invoked.

        let releaseBarrier!: () => void;
        const closeBarrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
        let signalCloseStarted!: () => void;
        const closeStarted = new Promise<void>(resolve => { signalCloseStarted = resolve; });

        const originalClose = entry.store.close.bind(entry.store);
        entry.store.close = async () => {
          signalCloseStarted();
          await closeBarrier;   // park mid-close so an acquire can race
          await originalClose();
        };

        // Wait until cleanup has entered close() and is parked on the barrier.
        await closeStarted;

        // Race an acquire against the in-flight close, then let the close finish.
        const acquireP = raceManager.acquire(TEST_DATABASE_ID);
        releaseBarrier();
        const entry2 = await acquireP;

        // The acquired handle must be live — not the one that was being closed.
        expect(entry2.store.isClosed()).to.be.false;
        // And usable: a read must not throw "LevelDBStore is closed".
        await entry2.store.get(new Uint8Array([1]));

        raceManager.release(TEST_DATABASE_ID);
      } finally {
        await raceManager.shutdown();
        await rm(raceDataDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    // Sibling of the test above, but the close is driven by LRU eviction from INSIDE
    // acquire() (not the cleanup timer). Same closeStore serialization must hold, so an
    // acquire of the evicted key racing its eviction still gets a live handle.
    it('acquire of an LRU-evicted key racing its eviction returns a live handle', async () => {
      const raceDataDir = join(tmpdir(), `sync-race-evict-${randomUUID()}`);
      const raceManager = new StoreManager({
        dataDir: raceDataDir,
        maxOpenStores: 1,        // opening a second store forces eviction of the first
        idleTimeoutMs: 60_000,   // cleanup must never interpose — eviction is the only closer
        cleanupIntervalMs: 60_000,
      });
      // Deliberately NOT started: no cleanup timer, so the ONLY close path is evictLRU.

      try {
        const victim = await raceManager.acquire(TEST_DATABASE_ID);
        raceManager.release(TEST_DATABASE_ID); // refCount → 0; now LRU-evictable

        let releaseBarrier!: () => void;
        const closeBarrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
        let signalCloseStarted!: () => void;
        const closeStarted = new Promise<void>(resolve => { signalCloseStarted = resolve; });

        const originalClose = victim.store.close.bind(victim.store);
        victim.store.close = async () => {
          signalCloseStarted();
          await closeBarrier;   // park mid-close so an acquire of the same key can race
          await originalClose();
        };

        // Acquiring a second store trips maxOpenStores and evicts TEST_DATABASE_ID.
        // This acquire parks on the barrier (evictLRU → closeStore → close), so we hold
        // its promise rather than awaiting it here.
        const acquireBP = raceManager.acquire(TEST_DATABASE_ID_2);

        // Wait until eviction has entered close() and is parked on the barrier.
        await closeStarted;

        // Race an acquire of the evicted key against its in-flight eviction.
        const acquireVictimP = raceManager.acquire(TEST_DATABASE_ID);
        releaseBarrier();
        const [reopened] = await Promise.all([acquireVictimP, acquireBP]);

        // The re-acquired handle must be live — not the one eviction was tearing down.
        expect(reopened.store.isClosed()).to.be.false;
        await reopened.store.get(new Uint8Array([1]));

        raceManager.release(TEST_DATABASE_ID);
        raceManager.release(TEST_DATABASE_ID_2);
      } finally {
        await raceManager.shutdown();
        await rm(raceDataDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});

