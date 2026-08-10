/**
 * Tests for IndexedDBManager to verify system stores are created eagerly.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { IndexedDBManager } from '../src/manager.js';
import { CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';

describe('IndexedDBManager', () => {
	const testDbName = 'test-manager-db';

	afterEach(async () => {
		const manager = IndexedDBManager.getInstance(testDbName);
		await manager.close();
		IndexedDBManager.resetInstance(testDbName);

		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(testDbName);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	});

	describe('System store creation', () => {
		it('should create __catalog__ and __stats__ stores on first open', async () => {
			const manager = IndexedDBManager.getInstance(testDbName);
			await manager.ensureOpen();

			const storeNames = manager.getObjectStoreNames();

			expect(storeNames).to.include(CATALOG_STORE_NAME);
			expect(storeNames).to.include(STATS_STORE_NAME);
		});

		it('should not trigger upgrade when system stores already exist', async () => {
			// First, create a database with system stores
			const manager1 = IndexedDBManager.getInstance(testDbName);
			await manager1.ensureOpen();

			const db1 = manager1.getDatabase();
			const version1 = db1!.version;

			await manager1.close();
			IndexedDBManager.resetInstance(testDbName);

			// Reopen the database - should not trigger upgrade
			const manager2 = IndexedDBManager.getInstance(testDbName);
			await manager2.ensureOpen();

			const db2 = manager2.getDatabase();
			const version2 = db2!.version;

			// Version should remain the same since system stores already exist
			expect(version2).to.equal(version1);
		});

		it('should upgrade existing database to add missing __stats__ store', async () => {
			// First, create a database without the stats store (simulating old version)
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.open(testDbName, 1);

				request.onupgradeneeded = (event) => {
					const db = (event.target as IDBOpenDBRequest).result;
					// Only create catalog, not stats (simulating old database)
					if (!db.objectStoreNames.contains(CATALOG_STORE_NAME)) {
						db.createObjectStore(CATALOG_STORE_NAME);
					}
				};

				request.onsuccess = () => {
					const db = request.result;
					db.close();
					resolve();
				};

				request.onerror = () => reject(request.error);
			});

			// Now open with manager - should detect missing __stats__ and upgrade
			const manager = IndexedDBManager.getInstance(testDbName);
			await manager.ensureOpen();

			const storeNames = manager.getObjectStoreNames();

			// Both system stores should now exist
			expect(storeNames).to.include(CATALOG_STORE_NAME);
			expect(storeNames).to.include(STATS_STORE_NAME);

			const db = manager.getDatabase();
			// Version should be 2 after upgrade
			expect(db!.version).to.equal(2);
		});
	});

	describe('Object store management', () => {
		it('should create new object stores on demand', async () => {
			const manager = IndexedDBManager.getInstance(testDbName);
			await manager.ensureOpen();

			const tableName = 'main.users';
			await manager.ensureObjectStore(tableName);

			expect(manager.hasObjectStore(tableName)).to.be.true;
			expect(manager.getObjectStoreNames()).to.include(tableName);
		});

		it('should not upgrade if object store already exists', async () => {
			const manager = IndexedDBManager.getInstance(testDbName);
			await manager.ensureOpen();

			const tableName = 'main.users';
			await manager.ensureObjectStore(tableName);

			const db = manager.getDatabase();
			const version = db!.version;

			// Calling ensureObjectStore again should not trigger upgrade
			await manager.ensureObjectStore(tableName);

			const db2 = manager.getDatabase();
			expect(db2!.version).to.equal(version);
		});
	});

	describe('Failed open recovery', () => {
		it('clears a rejected open so a later call retries', async () => {
			const manager = IndexedDBManager.getInstance(testDbName);
			const originalOpen = indexedDB.open;

			let rejected = false;
			try {
				// Force every indexedDB.open in this window to fire onerror, so doOpen rejects.
				(indexedDB as unknown as { open: () => unknown }).open = () => {
					const req: { error: Error; onerror: (() => void) | null } = {
						error: new Error('forced open failure'),
						onerror: null,
					};
					setTimeout(() => req.onerror?.(), 0);
					return req;
				};

				try {
					await manager.ensureOpen();
				} catch {
					rejected = true;
				}
				expect(rejected, 'first ensureOpen should reject').to.be.true;
				// A rejected open must not stay cached (bug c): openPromise is reset in finally.
				expect((manager as unknown as { openPromise: unknown }).openPromise).to.equal(null);
			} finally {
				(indexedDB as unknown as { open: unknown }).open = originalOpen;
			}

			// After the transient cause clears, a fresh call must succeed.
			const db = await manager.ensureOpen();
			expect(db).to.not.be.undefined;
			expect(manager.getObjectStoreNames()).to.include(CATALOG_STORE_NAME);
		});
	});

	describe('Concurrent schema mutations', () => {
		it('serializes concurrent distinct ensureObjectStore calls without VersionError', async () => {
			const manager = IndexedDBManager.getInstance(testDbName);
			await manager.ensureOpen();

			const N = 5;
			await Promise.all(
				Array.from({ length: N }, (_, i) => manager.ensureObjectStore(`concurrent.t${i}`)),
			);

			for (let i = 0; i < N; i++) {
				expect(manager.hasObjectStore(`concurrent.t${i}`)).to.be.true;
			}
		});

		it('bumps the version exactly once for N concurrent same-name requests', async () => {
			const manager = IndexedDBManager.getInstance(testDbName);
			await manager.ensureOpen();

			const before = manager.getDatabase()!.version;
			const N = 5;
			await Promise.all(
				Array.from({ length: N }, () => manager.ensureObjectStore('concurrent.same')),
			);

			expect(manager.hasObjectStore('concurrent.same')).to.be.true;
			// The inside-lock re-check means only the first request creates the store.
			expect(manager.getDatabase()!.version).to.equal(before + 1);
		});
	});
});
