/**
 * Sync Plugin for Quereus
 *
 * Provides multi-master CRDT replication with automatic conflict resolution.
 *
 * Features:
 * - Fully automatic: All tables are CRDT-enabled without opt-in
 * - Column-level LWW: Fine-grained conflict resolution
 * - Transport agnostic: Bring your own WebSocket/HTTP/WebRTC
 * - Reactive hooks: UI integration for real-time updates
 * - Offline-first: Works with local changes that sync later
 *
 * Usage:
 *   import { createSyncModule } from '@quereus/sync';
 *   import { LevelDBStore } from '@quereus/store';
 *
 *   const kv = await LevelDBStore.open({ path: './sync-metadata' });
 *   // `db` is the engine Database; it captures local changes at the
 *   // transaction boundary. Omit transactionSource for a relay-only deployment.
 *   const { syncManager, syncEvents } = await createSyncModule(kv, { transactionSource: db });
 */

// Clock module
export {
  // HLC types and functions
  type HLC,
  HLCManager,
  compareHLC,
  hlcEquals,
  maxHLC,
  createHLC,
  deterministicTxnId,
  MAX_OPSEQ,
  serializeHLC,
  deserializeHLC,
  // HLC JSON serialization (for schema seeds and transport)
  type SerializedHLC,
  hlcToJson,
  hlcFromJson,
  // Site ID types and functions
  type SiteId,
  generateSiteId,
  // Base64url encoding
  siteIdToBase64,
  siteIdFromBase64,
  toBase64Url,
  fromBase64Url,
  siteIdEquals,
  type SiteIdentity,
  serializeSiteIdentity,
  deserializeSiteIdentity,
  SITE_ID_KEY,
} from './clock/index.js';

// Sync protocol types
export {
  // Change types
  type ColumnChange,
  type RowDeletion,
  type Change,
  // Schema types
  type SchemaMigrationType,
  type SchemaMigration,
  // Transaction types
  type ChangeSet,
  // API types
  type ApplyRejection,
  type ApplyResult,
  type ColumnVersionEntry,
  type TableSnapshot,
  type Snapshot,
  type PeerSyncState,
  // Streaming snapshot types
  type SnapshotChunkType,
  type SnapshotHeaderChunk,
  type SnapshotTableStartChunk,
  type SnapshotColumnVersionsChunk,
  type SnapshotTableEndChunk,
  type SnapshotSchemaMigrationChunk,
  type SnapshotFooterChunk,
  type SnapshotChunk,
  type SnapshotProgress,
  // Apply-to-store callback types
  type ApplyToStoreOptions,
  type DataChangeToApply,
  type SchemaChangeToApply,
  type ApplyToStoreResult,
  type ApplyToStoreCallback,
  // Conflict resolution
  type ConflictContext,
  type ConflictResolution,
  type ConflictResolver,
  // Unknown-table disposition
  type UnknownTableDisposition,
  // Basis-table eviction
  type BasisEvictionConfig,
  type DropLocalTableCallback,
  // Configuration
  type SyncConfig,
  DEFAULT_SYNC_CONFIG,
} from './sync/protocol.js';

// Wire protocol - shared transport/JSON layer (base64 helpers, Serialized* types,
// codec fns, message envelopes, PROTOCOL_VERSION). Single source of truth for the
// format the sync client and coordinator exchange.
export {
  // Version
  PROTOCOL_VERSION,
  // Base64 + HLC transport helpers
  bytesToBase64,
  base64ToBytes,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
  // Serialized (JSON-shape) types
  type SerializedChangeSet,
  type SerializedChange,
  type SerializedSchemaMigration,
  type SerializedSnapshotChunk,
  type SerializedSnapshotHeaderChunk,
  type SerializedSnapshotTableStartChunk,
  type SerializedSnapshotColumnVersionsChunk,
  type SerializedSnapshotTombstoneChunk,
  type SerializedSnapshotTableEndChunk,
  type SerializedSnapshotSchemaMigrationChunk,
  type SerializedSnapshotFooterChunk,
  type SerializedSnapshotCheckpoint,
  // Codec functions
  serializeChangeSet,
  deserializeChangeSet,
  serializeSnapshotChunk,
  deserializeSnapshotChunk,
  serializeSnapshotCheckpoint,
  deserializeSnapshotCheckpoint,
  // Message unions + per-message interfaces
  type ClientMessage,
  type HandshakeMessage,
  type GetChangesMessage,
  type ApplyChangesMessage,
  type GetSnapshotMessage,
  type ResumeSnapshotMessage,
  type PingMessage,
  type ServerMessage,
  type HandshakeAckMessage,
  type ChangesMessage,
  type PushChangesMessage,
  type ApplyResultMessage,
  type SnapshotChunkMessage,
  type SnapshotCompleteMessage,
  type RequestChangesMessage,
  type ErrorMessage,
  type PongMessage,
} from './sync/wire.js';

// Host-driven maintenance pass. The library still schedules nothing — this is
// only the shape of one pass (ordering, error isolation, single-flight); the
// host arms the timer around it.
export {
  SYNC_MAINTENANCE_INTERVAL_MS,
  type SyncMaintenanceTarget,
  type MaintenanceLogger,
  runSyncMaintenancePass,
  createSyncMaintenanceTicker,
} from './sync/maintenance.js';

// Built-in conflict resolvers
export {
  lwwResolver,
  localWinsResolver,
  remoteWinsResolver,
} from './sync/conflict-resolvers.js';

// Sync manager
export { type SyncManager, type SnapshotCheckpoint } from './sync/manager.js';
export { SyncManagerImpl } from './sync/sync-manager-impl.js';

// Store adapter for applying remote changes
export { createStoreAdapter, type SyncStoreAdapterOptions } from './sync/store-adapter.js';

// In-SQL introspection TVF (opt-in: host calls after createSyncModule)
export { registerBasisLifecycleTvf } from './sql/basis-lifecycle-tvf.js';

// Factory function
export {
  createSyncModule,
  type CreateSyncModuleResult,
  type CreateSyncModuleOptions,
  type GetTableSchemaCallback,
  type TransactionCommitSource,
} from './create-sync-module.js';

// Reactive events
export {
  type RemoteChangeEvent,
  type LocalChangeEvent,
  type ConflictEvent,
  type UnknownTableEvent,
  type AssertionViolationEvent,
  type BasisTableLifecycleEvent,
  type BasisTableEvictedEvent,
  type HeldChangesDrainedEvent,
  type SyncState,
  type Unsubscribe,
  type SyncEventEmitter,
  SyncEventEmitterImpl,
} from './sync/events.js';

// Metadata storage
export {
  // Key builders
  SYNC_KEY_PREFIX,
  buildColumnVersionKey,
  buildTombstoneKey,
  buildTransactionKey,
  buildPeerStateKey,
  buildPeerSentStateKey,
  buildSchemaMigrationKey,
  buildColumnVersionScanBounds,
  buildTableColumnVersionScanBounds,
  buildTombstoneScanBounds,
  buildSchemaMigrationScanBounds,
  encodePK,
  decodePK,
  // Column versions
  type ColumnVersion,
  ColumnVersionStore,
  serializeColumnVersion,
  deserializeColumnVersion,
  // SqlValue JSON encoding (for Uint8Array/bigint in JSON transport)
  encodeSqlValue,
  decodeSqlValue,
  // Tombstones
  type Tombstone,
  TombstoneStore,
  serializeTombstone,
  deserializeTombstone,
  // Quarantine (held out-of-basis straggler changes)
  type QuarantineEntry,
  QuarantineStore,
  serializeQuarantineEntry,
  deserializeQuarantineEntry,
  buildQuarantineKey,
  buildQuarantineScanBounds,
  // Basis-table lifecycle (legacy-table retirement bookkeeping)
  type BasisLifecycleState,
  type BasisTableLifecycleRecord,
  type EvictPolicy,
  BasisLifecycleStore,
  classifyBasisLifecycle,
  parseEvictPolicyTag,
  effectiveEvictHorizonMs,
  quietSince,
  isEvictable,
  serializeBasisLifecycleRecord,
  deserializeBasisLifecycleRecord,
  buildBasisLifecycleKey,
  buildAllBasisLifecycleScanBounds,
  // Peer state
  type PeerState,
  PeerStateStore,
  serializePeerState,
  deserializePeerState,
  // Schema versions (column-level)
  type SchemaVersion,
  type SchemaVersionType,
  type SchemaChangeOperation,
  SchemaVersionStore,
  buildSchemaVersionKey,
  buildSchemaVersionScanBounds,
  buildAllSchemaVersionsScanBounds,
  serializeSchemaVersion,
  deserializeSchemaVersion,
  parseSchemaVersionKey,
  // Most destructive wins
  getDestructiveness,
  getOperationDestructiveness,
  shouldApplySchemaChangeByOperation,
} from './metadata/index.js';

