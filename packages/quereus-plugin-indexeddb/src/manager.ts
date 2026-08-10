/**
 * Unified IndexedDB Database Manager.
 *
 * Manages a single IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 *
 * Architecture:
 *   - Single IDB database per prefix (e.g., 'quereus')
 *   - One object store per table (e.g., 'main.users', 'main.orders')
 *   - One '__catalog__' object store for DDL metadata
 *   - Native cross-table transactions for atomicity
 */

import { CATALOG_STORE_NAME, STATS_STORE_NAME } from '@quereus/store';

/**
 * Singleton manager for a unified IndexedDB database.
 * All tables share this database with separate object stores.
 */
export class IndexedDBManager {
  private static instances: Map<string, IndexedDBManager> = new Map();

  private dbName: string;
  private db: IDBDatabase | null = null;
  private dbVersion: number = 1;
  private objectStores: Set<string> = new Set();
  private openPromise: Promise<void> | null = null;
  /** Tail of the serialized schema-mutation queue (create/delete/rename stores). */
  private schemaTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(dbName: string) {
    this.dbName = dbName;
  }

  /**
   * Run a schema mutation serialized against all other schema mutations. Version
   * upgrades close and reopen the database at a bumped version; two overlapping
   * upgrades would race their `onupgradeneeded` transitions and throw VersionError,
   * so every version-changing op is chained through this single queue.
   */
  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    // Chain regardless of prior outcome so one failure doesn't wedge the queue.
    const run = this.schemaTail.then(fn, fn);
    // Keep the tail alive but swallow the result so a rejection doesn't poison later ops.
    this.schemaTail = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Get or create the singleton manager instance for a database name.
   */
  static getInstance(dbName: string): IndexedDBManager {
    let instance = this.instances.get(dbName);
    if (!instance) {
      instance = new IndexedDBManager(dbName);
      this.instances.set(dbName, instance);
    }
    return instance;
  }

  /**
   * Reset a singleton instance (for testing purposes).
   */
  static resetInstance(dbName: string): void {
    this.instances.delete(dbName);
  }

  /**
   * Get the list of object store names in the database.
   */
  getObjectStoreNames(): string[] {
    return Array.from(this.objectStores);
  }

  /**
   * Ensure the database is open and has the required object stores.
   */
  async ensureOpen(): Promise<IDBDatabase> {
    if (this.closed) {
      throw new Error('IndexedDBManager is closed');
    }

    // Let any in-flight schema mutation finish first: doUpgrade/doDelete/doRename
    // null out this.db while reopening, so returning it mid-op would hand back a
    // stale/closed handle.
    // NOTE: this only waits for schema ops enqueued *before* this call. A schema
    // mutation enqueued in the microtask gap between this await resolving and the
    // caller building its transaction can still close the returned handle out from
    // under a data write. IDB close() defers to already-open transactions, so the
    // common concurrent case survives; if data-write-vs-DDL interleaving ever
    // surfaces InvalidStateError, make the write path retry on a closed handle.
    await this.schemaTail;

    if (this.db) {
      return this.db;
    }

    // Serialize opening to prevent race conditions
    if (this.openPromise) {
      await this.openPromise;
      return this.db!;
    }

    // Reset openPromise in finally so a failed open (timeout / onerror) doesn't
    // stay cached — a later call re-attempts instead of replaying the rejection.
    this.openPromise = this.doOpen();
    try {
      await this.openPromise;
    } finally {
      this.openPromise = null;
    }
    return this.db!;
  }

  private async doOpen(): Promise<void> {
    // First, try to open the existing database to get its version
    const existingInfo = await this.getExistingDatabaseInfo();

    if (existingInfo) {
      this.dbVersion = existingInfo.version;
      this.objectStores = existingInfo.objectStores;

      // Check if we need to upgrade to add missing system stores
      const needsCatalog = !existingInfo.objectStores.has(CATALOG_STORE_NAME);
      const needsStats = !existingInfo.objectStores.has(STATS_STORE_NAME);

      if (needsCatalog || needsStats) {
        // Eagerly upgrade to create system stores before any operations
        this.dbVersion++;
      }
    }

    // Open with the current version
    this.db = await this.openDatabase(this.dbVersion);
  }

  private async getExistingDatabaseInfo(): Promise<{ version: number; objectStores: Set<string> } | null> {
    return new Promise((resolve) => {
      // Try to open without specifying version to get current state
      const request = indexedDB.open(this.dbName);

      request.onerror = () => resolve(null);

      request.onsuccess = () => {
        const db = request.result;
        const stores = new Set<string>();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          stores.add(db.objectStoreNames[i]);
        }
        const version = db.version;
        db.close();
        resolve({ version, objectStores: stores });
      };
    });
  }

  private async openDatabase(version: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IndexedDB open timed out after 10 seconds'));
      }, 10000);

      const request = indexedDB.open(this.dbName, version);

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
      };

      request.onblocked = () => {
        // Don't reject immediately - the onversionchange handler on the blocking
        // connection should close it, allowing the upgrade to proceed.
        console.warn('IndexedDB open is blocked, waiting for other connections to close...');
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        // Ensure catalog store exists
        if (!db.objectStoreNames.contains(CATALOG_STORE_NAME)) {
          db.createObjectStore(CATALOG_STORE_NAME);
          this.objectStores.add(CATALOG_STORE_NAME);
        }
        // Ensure unified stats store exists
        if (!db.objectStoreNames.contains(STATS_STORE_NAME)) {
          db.createObjectStore(STATS_STORE_NAME);
          this.objectStores.add(STATS_STORE_NAME);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;

        // Handle version change requests from other connections (or ourselves)
        // This is critical for allowing version upgrades when the same manager
        // needs to create new object stores while transactions are pending
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };

        // Update objectStores from actual database
        this.objectStores.clear();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          this.objectStores.add(db.objectStoreNames[i]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Ensure an object store exists for a table.
   * Creates the store via database version upgrade if needed.
   */
  async ensureObjectStore(storeName: string): Promise<void> {
    await this.ensureOpen();

    if (this.objectStores.has(storeName)) {
      return; // Already exists
    }

    await this.runSerialized(async () => {
      // Re-check inside the lock: a queued peer may have already created it,
      // which avoids a redundant version bump.
      if (this.objectStores.has(storeName)) return;
      await this.doUpgrade(storeName);
    });
  }

  private async doUpgrade(storeName: string): Promise<void> {
    // Close current connection and reopen with new version
    this.db?.close();
    this.db = null;
    this.dbVersion++;

    this.db = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IndexedDB upgrade timed out'));
      }, 10000);

      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Failed to upgrade IndexedDB: ${request.error?.message}`));
      };

      request.onblocked = () => {
        // Don't reject immediately - the onversionchange handler on the blocking
        // connection should close it, allowing the upgrade to proceed.
        // The timeout will catch cases where the upgrade truly can't proceed.
        console.warn(`IndexedDB upgrade to create '${storeName}' is blocked, waiting for other connections to close...`);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;

        // Handle version change requests
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };

        this.objectStores.clear();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          this.objectStores.add(db.objectStoreNames[i]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Delete an object store (table).
   */
  async deleteObjectStore(storeName: string): Promise<void> {
    await this.ensureOpen();

    if (!this.objectStores.has(storeName)) {
      return; // Doesn't exist
    }

    await this.runSerialized(async () => {
      // Re-check inside the lock: a queued peer may have already deleted it.
      if (!this.objectStores.has(storeName)) return;
      await this.doDeleteObjectStore(storeName);
    });
  }

  private async doDeleteObjectStore(storeName: string): Promise<void> {
    // Close current connection and reopen with new version
    this.db?.close();
    this.db = null;
    this.dbVersion++;

    this.db = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IndexedDB upgrade timed out'));
      }, 10000);

      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Failed to upgrade IndexedDB: ${request.error?.message}`));
      };

      request.onblocked = () => {
        console.warn(`IndexedDB upgrade to delete '${storeName}' is blocked, waiting for other connections to close...`);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (db.objectStoreNames.contains(storeName)) {
          db.deleteObjectStore(storeName);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;

        // Handle version change requests
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };

        this.objectStores.clear();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          this.objectStores.add(db.objectStoreNames[i]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Rename one or more object stores within a single versionchange transaction.
   *
   * Object stores cannot be renamed in place, so each `{from → to}` is relocated
   * by an atomic copy-then-delete: create `to`, cursor-copy every entry from
   * `from` into it, then delete `from`. Because schema ops and the cursor copy
   * all ride one versionchange transaction, the whole batch is all-or-nothing —
   * any error aborts the transaction and leaves the database exactly as before
   * (old stores intact, new stores never created).
   */
  async renameObjectStores(renames: Array<{ from: string; to: string }>): Promise<void> {
    await this.ensureOpen();

    await this.runSerialized(async () => {
      // Evaluate the filter and collision guard inside the lock so they see state
      // committed by any queued peer, not a stale snapshot from before we waited.

      // Only move sources that actually materialized as object stores. A table
      // that was declared but never connected has no backing store yet — mirrors
      // LevelDB's pathExists guard for a never-materialized directory.
      const filtered = renames.filter((r) => this.objectStores.has(r.from));
      if (filtered.length === 0) {
        return; // nothing physical to move
      }

      // Pre-bump collision guard: refuse before mutating anything if any target
      // already exists, so a failed rename never leaves a half-created store.
      for (const { from, to } of filtered) {
        if (this.objectStores.has(to)) {
          throw new Error(`Cannot rename object store '${from}' to '${to}': object store '${to}' already exists`);
        }
      }

      await this.doRenameObjectStores(filtered);
    });
  }

  private async doRenameObjectStores(renames: Array<{ from: string; to: string }>): Promise<void> {
    // Close current connection and reopen with new version
    this.db?.close();
    this.db = null;
    this.dbVersion++;

    this.db = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IndexedDB rename upgrade timed out'));
      }, 10000);

      const request = indexedDB.open(this.dbName, this.dbVersion);

      // Capture a meaningful copy/abort error so the caller sees a real message
      // rather than a bare AbortError surfaced by the failed open request.
      let copyError: Error | null = null;

      request.onerror = () => {
        clearTimeout(timeout);
        reject(copyError ?? new Error(`Failed to rename IndexedDB object stores: ${request.error?.message}`));
      };

      request.onblocked = () => {
        // Don't reject immediately - the onversionchange handler on the blocking
        // connection should close it, allowing the upgrade to proceed.
        console.warn('IndexedDB rename upgrade is blocked, waiting for other connections to close...');
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = (event.target as IDBOpenDBRequest).transaction!;

        tx.onabort = () => {
          if (!copyError) {
            copyError = tx.error ?? new Error('IndexedDB rename transaction aborted');
          }
        };

        // Drive the renames sequentially with a cursor-chained driver so a
        // request is always pending — that keeps the versionchange transaction
        // alive until the last copy completes, at which point it auto-commits.
        let i = 0;
        const processNext = () => {
          if (i >= renames.length) return; // no more requests → tx commits
          const { from, to } = renames[i];

          if (!db.objectStoreNames.contains(from)) {
            // Source vanished unexpectedly — skip rather than throw mid-tx.
            i++;
            processNext();
            return;
          }
          if (!db.objectStoreNames.contains(to)) {
            db.createObjectStore(to);
          }

          // NOTE: this copies one record per IDB request, so renaming a table costs about
          // one round trip per row (`IndexedDBStore.iterate` pages forward reads with
          // getAllKeys/getAll for exactly this reason). Kept per-row here because a rename
          // is a rare one-off DDL and the chained cursor is what keeps the versionchange
          // transaction alive; page it the same way if renaming a large table ever shows up
          // as slow.
          const cursorReq = tx.objectStore(from).openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              // Keys/values are ArrayBuffers; copy them verbatim with out-of-line keys.
              tx.objectStore(to).put(cursor.value, cursor.key);
              cursor.continue();
            } else {
              // Copy exhausted — drop the old store and advance.
              db.deleteObjectStore(from);
              i++;
              processNext();
            }
          };
          cursorReq.onerror = () => {
            copyError = cursorReq.error ?? new Error(`Failed to copy object store '${from}' to '${to}'`);
            try {
              tx.abort();
            } catch {
              /* transaction already aborting */
            }
          };
        };

        processNext();
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;

        // Handle version change requests
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };

        this.objectStores.clear();
        for (let j = 0; j < db.objectStoreNames.length; j++) {
          this.objectStores.add(db.objectStoreNames[j]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Check if an object store exists.
   */
  hasObjectStore(storeName: string): boolean {
    return this.objectStores.has(storeName);
  }

  /**
   * Get the underlying IDBDatabase for direct transaction creation.
   */
  getDatabase(): IDBDatabase | null {
    return this.db;
  }

  /**
   * Get the catalog store name.
   */
  getCatalogStoreName(): string {
    return CATALOG_STORE_NAME;
  }

  /**
   * Create a read-write transaction spanning multiple object stores.
   * This enables atomic cross-table operations.
   */
  createTransaction(storeNames: string[], mode: IDBTransactionMode = 'readwrite'): IDBTransaction {
    if (!this.db) {
      throw new Error('Database not open');
    }
    return this.db.transaction(storeNames, mode);
  }

  /**
   * Close the database and clean up.
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.closed = true;
    IndexedDBManager.instances.delete(this.dbName);
  }

  /**
   * Delete the entire database (for testing or reset).
   */
  static async deleteDatabase(dbName: string): Promise<void> {
    const instance = this.instances.get(dbName);
    if (instance) {
      await instance.close();
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onerror = () => reject(new Error('Failed to delete database'));
      request.onsuccess = () => resolve();
    });
  }
}
