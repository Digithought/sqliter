/**
 * StoreManager - Multi-tenant LevelDB store management
 *
 * Manages lazy loading and cleanup of per-database LevelDB stores.
 * Each database gets its own isolated store, opened on-demand and
 * closed after idle timeout.
 *
 * This is a generic implementation. Applications provide custom database ID
 * parsing and path resolution via hooks in StoreManagerConfig.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { StoreEventEmitter } from '@quereus/store';
import { LevelDBStore } from '@quereus/plugin-leveldb';
import {
  createSyncModule,
  type SyncManager,
} from '@quereus/sync';
import { serviceLog } from '../common/logger.js';

export interface StoreEntry {
  databaseId: string;
  store: LevelDBStore;
  syncManager: SyncManager;
  storeEvents: StoreEventEmitter;
  refCount: number;
  lastAccess: number;
  /** True if no local data existed before this store was opened. */
  isNew?: boolean;
}

/**
 * Context passed to store hooks for auth-aware decisions.
 */
export interface StoreContext {
  /** The raw auth token (e.g., JWT) */
  token?: string;
  /** User ID from authentication */
  userId?: string;
  /** Additional metadata from authentication */
  metadata?: Record<string, unknown>;
}

/**
 * Hooks for customizing store manager behavior.
 * Apps can provide these to implement custom database ID handling.
 */
export interface StoreManagerHooks {
  /**
   * Resolve a database ID to a storage path relative to dataDir.
   * @param databaseId The database identifier (any string)
   * @param context Optional auth context for auth-aware path resolution
   * @returns The storage path relative to dataDir
   * @default Returns sanitized databaseId (replaces unsafe chars)
   */
  resolveStoragePath?: (databaseId: string, context?: StoreContext) => string;

  /**
   * Validate a database ID.
   * @param databaseId The database identifier to validate
   * @param context Optional auth context for auth-aware validation
   * @returns True if valid, false otherwise
   * @default Returns true for non-empty strings
   */
  isValidDatabaseId?: (databaseId: string, context?: StoreContext) => boolean;
}

export interface StoreManagerConfig {
  /** Base directory for all database stores */
  dataDir: string;
  /** Maximum number of stores to keep open (LRU eviction) */
  maxOpenStores: number;
  /** Idle timeout in ms before closing a store with refCount=0 */
  idleTimeoutMs: number;
  /** Interval for cleanup checks */
  cleanupIntervalMs: number;
  /** Sync config passed to createSyncModule */
  syncConfig?: {
    retentionHorizonMs?: number;
    batchSize?: number;
  };
  /** Hooks for customizing behavior */
  hooks?: StoreManagerHooks;
  /** Called when a new store is created (no pre-existing local data). Used for S3 restore. */
  onStoreCreated?: (entry: StoreEntry) => Promise<void>;
  /** Idle time (ms) before a closed store's local directory is eligible for disk eviction. 0 = disabled. */
  diskEvictionIdleMs?: number;
  /** Called to confirm a closed store can be safely evicted from disk. Return true to proceed with deletion. */
  onEvictStore?: (databaseId: string) => Promise<boolean>;
}

/**
 * Sanitize a string for use as a filesystem path component.
 * Replaces unsafe characters with underscores.
 */
function sanitizePathComponent(value: string): string {
  // Allow alphanumeric, dash, underscore; replace others with underscore
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Default storage path resolver - simple sanitized passthrough.
 *
 * Applications can provide a custom resolveStoragePath hook for
 * org-based folder structures or other custom layouts.
 */
function defaultResolveStoragePath(databaseId: string, _context?: StoreContext): string {
  return sanitizePathComponent(databaseId);
}

/**
 * Default database ID validator - accepts any non-empty string with safe characters.
 *
 * Applications can provide a custom isValidDatabaseId hook for
 * stricter validation (e.g., org:type_id format).
 */
function defaultIsValidDatabaseId(databaseId: string, _context?: StoreContext): boolean {
  if (typeof databaseId !== 'string' || databaseId.length === 0) {
    return false;
  }
  // Accept alphanumeric with common separators
  return /^[a-zA-Z0-9_:.-]+$/.test(databaseId);
}

const DEFAULT_CONFIG: StoreManagerConfig = {
  dataDir: './data',
  maxOpenStores: 100,
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  cleanupIntervalMs: 30 * 1000, // 30 seconds
};

/**
 * Manages multiple LevelDB stores for multi-tenant sync.
 */
export class StoreManager {
  private readonly config: StoreManagerConfig;
  private readonly resolveStoragePath: (databaseId: string, context?: StoreContext) => string;
  private readonly isValidDatabaseId: (databaseId: string, context?: StoreContext) => boolean;
  private readonly stores = new Map<string, StoreEntry>();
  private readonly pendingOpens = new Map<string, Promise<StoreEntry>>();
  /** In-flight closes keyed by databaseId. An acquire awaits this before opening a fresh handle. */
  private readonly pendingCloses = new Map<string, Promise<void>>();
  private readonly onStoreCreated?: (entry: StoreEntry) => Promise<void>;
  /** Tracks closed stores eligible for disk eviction: databaseId → { storagePath, closedAt } */
  private readonly closedStores = new Map<string, { storagePath: string; closedAt: number }>();
  private readonly diskEvictionIdleMs: number;
  private readonly onEvictStore?: (databaseId: string) => Promise<boolean>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private _shuttingDown = false;

  constructor(config: Partial<StoreManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resolveStoragePath = config.hooks?.resolveStoragePath ?? defaultResolveStoragePath;
    this.isValidDatabaseId = config.hooks?.isValidDatabaseId ?? defaultIsValidDatabaseId;
    this.onStoreCreated = config.onStoreCreated;
    this.diskEvictionIdleMs = config.diskEvictionIdleMs ?? 0;
    this.onEvictStore = config.onEvictStore;
  }

  /**
   * Start the store manager (begins cleanup interval).
   */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);
    serviceLog('StoreManager started with dataDir: %s', this.config.dataDir);
  }

  /**
   * Get or open a store for a database. Increments refCount.
   * Uses pendingOpens to prevent concurrent open+restore for the same databaseId,
   * and awaits pendingCloses so an in-flight close of the same key fully finishes
   * before we vend or re-open a handle (see closeStore for the serialization invariant).
   * @param databaseId The database identifier
   * @param context Optional auth context for auth-aware path resolution
   */
  async acquire(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
    // Reject once shutdown has begun — the store map is being torn down and a
    // handle vended here would never be closed by shutdown().
    // NOTE: best-effort only — this checks _shuttingDown at entry, but the awaits
    // below (pendingCloses, evictLRU, openAndRestore) can yield to a shutdown() that
    // flips the flag mid-acquire, so a handle could still be opened after teardown
    // started. Harmless today: no caller acquires concurrently with shutdown. If that
    // ever changes, re-check _shuttingDown after each await and back out the open.
    if (this._shuttingDown) {
      throw new Error(`Cannot acquire store ${databaseId}: StoreManager is shutting down`);
    }

    // Remove from eviction candidates — store is being (re-)opened
    this.closedStores.delete(databaseId);

    // Serialize against an in-flight close of the SAME key: closeStore synchronously
    // removes the entry from this.stores and registers its close promise here before
    // awaiting close(). Waiting for it guarantees we never observe (and refCount++) a
    // handle mid-teardown; after it resolves we fall through and open a fresh handle.
    const closing = this.pendingCloses.get(databaseId);
    if (closing) {
      await closing;
    }

    // Check if already open
    let entry = this.stores.get(databaseId);
    if (entry) {
      entry.refCount++;
      entry.lastAccess = Date.now();
      serviceLog('Store acquired (cached): %s, refCount=%d', databaseId, entry.refCount);
      return entry;
    }

    // Check if open+restore is already in progress for this databaseId
    const pending = this.pendingOpens.get(databaseId);
    if (pending) {
      entry = await pending;
      entry.refCount++;
      entry.lastAccess = Date.now();
      serviceLog('Store acquired (waited for pending open): %s, refCount=%d', databaseId, entry.refCount);
      return entry;
    }

    // Check if we need to evict before opening new
    if (this.stores.size >= this.config.maxOpenStores) {
      await this.evictLRU();
    }

    // Open new store with dedup via pendingOpens
    const openPromise = this.openAndRestore(databaseId, context);
    this.pendingOpens.set(databaseId, openPromise);
    try {
      entry = await openPromise;
      this.stores.set(databaseId, entry);
      serviceLog('Store acquired (opened): %s', databaseId);
      return entry;
    } finally {
      this.pendingOpens.delete(databaseId);
    }
  }

  /**
   * Release a store reference. Decrements refCount.
   */
  release(databaseId: string): void {
    this.decRef(databaseId, true);
  }

  /**
   * Release a pin taken by {@link acquireIfOpen}, without refreshing
   * `lastAccess` — see the NOTE there for why background sweeps must not count
   * as access.
   */
  releasePin(databaseId: string): void {
    this.decRef(databaseId, false);
  }

  private decRef(databaseId: string, touch: boolean): void {
    const entry = this.stores.get(databaseId);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    if (touch) entry.lastAccess = Date.now();
    serviceLog('Store released: %s, refCount=%d', databaseId, entry.refCount);
  }

  /**
   * Check if a store is currently open.
   */
  isOpen(databaseId: string): boolean {
    return this.stores.has(databaseId);
  }

  /**
   * Get an open store without acquiring (for read-only checks).
   */
  get(databaseId: string): StoreEntry | undefined {
    return this.stores.get(databaseId);
  }

  /**
   * Snapshot of the database IDs currently open. A plain array copy, so the
   * caller can await between entries without tripping over concurrent
   * open/close mutating the live map.
   */
  openDatabaseIds(): string[] {
    return Array.from(this.stores.keys());
  }

  /**
   * Pin an already-open store, or return undefined if it is not open. Unlike
   * {@link acquire} this never opens (or re-opens) a store — it is for
   * background work that should touch only what is already resident, e.g. the
   * periodic sync-maintenance sweep.
   *
   * Synchronous by design: the refCount bump lands in the same synchronous
   * section as the `stores.get`, which makes it atomic with respect to
   * `closeStore`'s equally-synchronous "guard then delete" section (see the
   * serialization invariant on {@link closeStore}). So the store cannot be
   * closed out from under a caller that got an entry back, and a caller that
   * lost the race gets undefined rather than a half-torn-down handle.
   *
   * NOTE: deliberately does NOT touch `lastAccess`. A maintenance sweep is not
   * user access; refreshing the timestamp on every pass would keep otherwise-idle
   * stores permanently above the idle-close threshold.
   */
  acquireIfOpen(databaseId: string): StoreEntry | undefined {
    if (this._shuttingDown) return undefined;

    const entry = this.stores.get(databaseId);
    if (!entry) return undefined;

    entry.refCount++;
    return entry;
  }

  /**
   * Get count of open stores.
   */
  get openCount(): number {
    return this.stores.size;
  }

  /**
   * Get count of closed stores pending disk eviction.
   */
  get evictionCandidateCount(): number {
    return this.closedStores.size;
  }

  /**
   * Check if a database ID is valid.
   * @param databaseId The database identifier
   * @param context Optional auth context for auth-aware validation
   */
  validateDatabaseId(databaseId: string, context?: StoreContext): boolean {
    return this.isValidDatabaseId(databaseId, context);
  }

  /**
   * Shutdown all stores.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this._shuttingDown = true;
    this.shutdownPromise = (async () => {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      const closePromises = Array.from(this.stores.entries()).map(async ([id, entry]) => {
        try {
          await entry.store.close();
          serviceLog('Store closed: %s', id);
        } catch (err) {
          serviceLog('Error closing store %s: %O', id, err);
        }
      });

      await Promise.all(closePromises);
      this.stores.clear();
      this.closedStores.clear();
      serviceLog('StoreManager shutdown complete');
    })();

    return this.shutdownPromise;
  }

  /**
   * Open a store and run the onStoreCreated callback if the store is new.
   * On callback failure, closes the store and rethrows.
   */
  private async openAndRestore(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
    const entry = await this.openStore(databaseId, context);

    if (entry.isNew && this.onStoreCreated) {
      try {
        await this.onStoreCreated(entry);
      } catch (err) {
        await entry.store.close();
        throw err;
      }
    }

    return entry;
  }

  private async openStore(databaseId: string, context?: StoreContext): Promise<StoreEntry> {
    // Validate database ID
    if (!this.isValidDatabaseId(databaseId, context)) {
      throw new Error(`Invalid database ID: ${databaseId}`);
    }

    const storagePath = this.resolveStoragePath(databaseId, context);
    const fullPath = join(this.config.dataDir, storagePath);

    // Detect whether local data already exists before creating directories
    const isNew = !existsSync(fullPath);

    // Ensure parent directories exist (org folder for new org-based format)
    const parentPath = join(this.config.dataDir, storagePath.split('/')[0]);
    await mkdir(parentPath, { recursive: true });

    serviceLog('Opening store at: %s (isNew=%s)', fullPath, isNew);

    const store = await LevelDBStore.open({
      path: fullPath,
      createIfMissing: true,
    });

    const storeEvents = new StoreEventEmitter();
    // Relay-only: the coordinator has no local engine and produces no local DML,
    // so no transactionSource is wired — it only applies remote changes and serves
    // getChangesSince. (storeEvents is retained for the StoreEntry/adapter wiring.)
    const { syncManager } = await createSyncModule(store, this.config.syncConfig);

    return {
      databaseId,
      store,
      syncManager,
      storeEvents,
      refCount: 1,
      lastAccess: Date.now(),
      isNew,
    };
  }

  /**
   * Cleanup idle stores with refCount=0 past timeout.
   */
  private async cleanup(): Promise<void> {
    if (this._shuttingDown) return;
    const now = Date.now();
    const toClose: string[] = [];

    for (const [id, entry] of this.stores) {
      if (entry.refCount === 0 && now - entry.lastAccess > this.config.idleTimeoutMs) {
        toClose.push(id);
      }
    }

    for (const id of toClose) {
      await this.closeStore(id);
    }

    if (toClose.length > 0) {
      serviceLog('Cleanup: closed %d idle stores', toClose.length);
    }

    // Disk eviction: delete local directories for closed stores past the eviction threshold
    if (this.diskEvictionIdleMs > 0 && this.onEvictStore) {
      await this.evictFromDisk(now);
    }
  }

  /**
   * Evict closed stores from local disk if they've been idle long enough
   * and the eviction callback confirms safety (e.g. data is durable in S3).
   */
  private async evictFromDisk(now: number): Promise<void> {
    const toEvict: string[] = [];

    for (const [databaseId, info] of this.closedStores) {
      // Skip if store was re-opened since being closed
      if (this.stores.has(databaseId) || this.pendingOpens.has(databaseId)) {
        this.closedStores.delete(databaseId);
        continue;
      }

      if (now - info.closedAt >= this.diskEvictionIdleMs) {
        toEvict.push(databaseId);
      }
    }

    for (const databaseId of toEvict) {
      const info = this.closedStores.get(databaseId)!;
      try {
        const canEvict = await this.onEvictStore!(databaseId);
        if (!canEvict) continue;

        const fullPath = join(this.config.dataDir, info.storagePath);
        await rm(fullPath, { recursive: true, force: true });
        this.closedStores.delete(databaseId);
        serviceLog('Disk eviction: deleted local directory for %s', databaseId);
      } catch (err) {
        serviceLog('Disk eviction failed for %s (non-fatal): %O', databaseId, err);
      }
    }

    if (toEvict.length > 0) {
      serviceLog('Disk eviction: processed %d candidates', toEvict.length);
    }
  }

  /**
   * Evict least recently used store (with refCount=0).
   */
  private async evictLRU(): Promise<void> {
    let oldest: { id: string; lastAccess: number } | null = null;

    for (const [id, entry] of this.stores) {
      // Only evict stores with no active references
      if (entry.refCount === 0) {
        if (!oldest || entry.lastAccess < oldest.lastAccess) {
          oldest = { id, lastAccess: entry.lastAccess };
        }
      }
    }

    if (oldest) {
      await this.closeStore(oldest.id);
      serviceLog('Evicted LRU store: %s', oldest.id);
    } else {
      serviceLog('Warning: Cannot evict, all stores have active references');
    }
  }

  /**
   * Close a specific store.
   *
   * Serialization invariant: the close decision and the removal from this.stores
   * happen in ONE synchronous section (no await between the refCount guard and the
   * stores.delete). JS is single-threaded, so that section is atomic w.r.t. any
   * racing acquire:
   *   - acquire's sync section ran first → it bumped refCount, the guard here bails,
   *     the entry stays live.
   *   - this sync section runs first → the entry is gone from this.stores and the
   *     in-flight close is registered in pendingCloses BEFORE we await close(); a
   *     later acquire finds no entry, awaits pendingCloses, then opens a fresh handle
   *     (correct for LevelDB's single-open lock — old handle fully closed first).
   */
  private async closeStore(databaseId: string, context?: StoreContext): Promise<void> {
    const entry = this.stores.get(databaseId);
    if (!entry) return;

    // Guard against race: another async op may have acquired this store
    // between the caller's refCount check and now.
    if (entry.refCount > 0) return;

    // Synchronously retire the entry from the live map so no acquire can observe it
    // mid-teardown, and resolve the storage path (sync) before any await.
    this.stores.delete(databaseId);
    const storagePath = this.resolveStoragePath(databaseId, context);

    const closePromise = (async () => {
      try {
        await entry.store.close();
        serviceLog('Store closed: %s', databaseId);

        // Track for disk eviction if configured
        if (this.diskEvictionIdleMs > 0 && this.onEvictStore) {
          this.closedStores.set(databaseId, { storagePath, closedAt: Date.now() });
        }
      } catch (err) {
        serviceLog('Error closing store %s: %O', databaseId, err);
      }
    })();

    this.pendingCloses.set(databaseId, closePromise);
    try {
      await closePromise;
    } finally {
      this.pendingCloses.delete(databaseId);
    }
  }
}

