/**
 * Factory function to create a sync-enabled store module.
 *
 * This wraps an existing store module (LevelDB or IndexedDB) with
 * CRDT sync capabilities.
 */

import type { KVStore } from '@quereus/store';
import type { KeyNormalizerResolver, TableSchema, TransactionCommitBatch } from '@quereus/quereus';
import { SyncManagerImpl } from './sync/sync-manager-impl.js';
import { SyncEventEmitterImpl } from './sync/events.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type ApplyToStoreCallback, type DropLocalTableCallback } from './sync/protocol.js';
import type { SyncManager } from './sync/manager.js';

/**
 * Function to get table schema by name.
 * Used to map column indices to column names for sync.
 */
export type GetTableSchemaCallback = (schemaName: string, tableName: string) => TableSchema | undefined;

/**
 * The narrow slice of the engine's event surface the sync layer captures local
 * changes from: a subscription to grouped per-transaction commit batches. A
 * Quereus `Database` satisfies this structurally (via `db.onTransactionCommit`),
 * as does a bare `DatabaseEventEmitter`. This is the authoritative
 * "one logical transaction = one group" boundary — see `docs/sync.md`
 * § Transaction-Based Change Grouping — so the sync layer anchors one HLC per
 * delivered batch.
 */
export interface TransactionCommitSource {
  /** Subscribe to grouped per-transaction commit batches. Returns an unsubscribe. */
  onTransactionCommit(listener: (batch: TransactionCommitBatch) => void): () => void;
}

/**
 * Result of creating a sync module.
 */
export interface CreateSyncModuleResult {
  /** The sync manager for sync operations */
  syncManager: SyncManager;
  /** Event emitter for reactive UI integration */
  syncEvents: SyncEventEmitterImpl;
}

/**
 * Options for creating a sync module.
 */
export interface CreateSyncModuleOptions extends Partial<SyncConfig> {
  /**
   * Callback for applying remote changes to the store.
   *
   * When provided, the SyncManager will call this to apply data and schema
   * changes from remote replicas. The store should emit events with
   * `remote: true` when this is called.
   *
   * If not provided, the SyncManager will only update CRDT metadata
   * and emit sync events, but will not modify actual data. The application
   * is responsible for applying changes separately.
   */
  applyToStore?: ApplyToStoreCallback;

  /**
   * Callback for getting table schema by name.
   *
   * When provided, the SyncManager uses this to get actual column names
   * for sync. This is required for proper column-level CRDT tracking.
   *
   * If not provided, column names will be derived from row indices (col_0,
   * col_1, etc.), which may not match across replicas if table schemas differ.
   */
  getTableSchema?: GetTableSchemaCallback;

  /**
   * Callback to reclaim a detached basis table's local storage by name, used by
   * the host-driven eviction sweep (`SyncManager.evictExpiredBasisTables`,
   * `docs/migration.md` § 4 Contract). Typically wired to the store module's
   * `reclaimDetachedTable`. When omitted (e.g. a relay-only coordinator with no
   * store) the sweep is a no-op.
   */
  dropLocalTable?: DropLocalTableCallback;

  /**
   * Collation-name → key-normalizer resolver used to derive each row's pk
   * IDENTITY (what per-row sync metadata is filed under). Pass the engine's
   * `db.getKeyNormalizerResolver()` whenever a `getTableSchema` oracle is wired,
   * so sync keys rows exactly as the database does — including collations
   * registered with `db.registerCollation`. When omitted, a built-ins-only
   * resolver (BINARY/NOCASE/RTRIM) is used, which throws on any custom
   * collation name rather than mis-keying it.
   */
  keyNormalizerResolver?: KeyNormalizerResolver;

  /**
   * Engine transaction-commit source for capturing local changes.
   *
   * When provided (typically the Quereus `Database`), the SyncManager
   * subscribes to `onTransactionCommit` and records CRDT metadata for each
   * committed local transaction — ticking the HLC once per transaction and
   * assigning every fact of the transaction an incrementing `opSeq`.
   *
   * Omit for a relay-only deployment (e.g. a sync coordinator) that has no
   * local engine and never produces local DML — it only applies remote changes
   * and serves `getChangesSince`.
   */
  transactionSource?: TransactionCommitSource;
}

/**
 * Create a sync-enabled module.
 *
 * This function:
 * 1. Creates a SyncManager that tracks CRDT metadata
 * 2. Subscribes to store events to record changes
 * 3. Returns the sync manager and event emitter for UI integration
 *
 * @param kv - The KV store to use for metadata storage
 * @param options - Optional sync configuration, callbacks, and the engine
 *   `transactionSource` to capture local changes from
 *
 * @example
 * ```typescript
 * import { LevelDBStore } from '@quereus/store';
 * import { Database } from '@quereus/quereus';
 * import { createSyncModule } from '@quereus/sync';
 *
 * const db = new Database();
 * const kv = await LevelDBStore.open({ path: './data' });
 *
 * const { syncManager, syncEvents } = await createSyncModule(kv, {
 *   transactionSource: db,
 * });
 *
 * // Subscribe to sync events for UI
 * syncEvents.onRemoteChange((event) => {
 *   console.log('Remote changes:', event.changes.length);
 * });
 *
 * // Use syncManager for sync operations
 * const changes = await syncManager.getChangesSince(peerSiteId, lastHLC);
 * ```
 */
export async function createSyncModule(
  kv: KVStore,
  options: CreateSyncModuleOptions = {}
): Promise<CreateSyncModuleResult> {
  const { applyToStore, getTableSchema, dropLocalTable, keyNormalizerResolver, transactionSource, ...configOverrides } = options;

  const fullConfig: SyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    ...configOverrides,
  };

  const syncEvents = new SyncEventEmitterImpl();

  const syncManager = await SyncManagerImpl.create(
    kv,
    transactionSource,
    fullConfig,
    syncEvents,
    applyToStore,
    getTableSchema,
    dropLocalTable,
    keyNormalizerResolver
  );

  return {
    syncManager,
    syncEvents,
  };
}

