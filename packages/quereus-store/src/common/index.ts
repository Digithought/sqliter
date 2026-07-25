/**
 * Common utilities for the persistent store module.
 */

// KV Store interface
export type {
  KVStore,
  KVEntry,
  WriteBatch,
  WriteOptions,
  BatchOp,
  AtomicBatch,
  IterateOptions,
  KVStoreFactory,
  KVStoreOptions,
  KVStoreProvider,
} from './kv-store.js';

// Key encoding
export {
  encodeValue,
  encodeCompositeKey,
  decodeValue,
  decodeCompositeKey,
  BUILTIN_KEY_NORMALIZER_RESOLVER,
  assertNoUnpairedSurrogate,
  findUnpairedSurrogate,
  type EncodeOptions,
  type KeyValueTransform,
} from './encoding.js';

// Row serialization
export {
  serializeRow,
  deserializeRow,
  serializeValue,
  deserializeValue,
  serializeStats,
  deserializeStats,
  type TableStats,
} from './serialization.js';

// Key building - new API
export {
	STORE_SUFFIX,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
	buildDataStoreName,
	buildIndexStoreName,
	buildStatsStoreName,
	buildStatsKey,
	buildDataKey,
	buildIndexKey,
	buildCatalogKey,
	buildViewCatalogKey,
	buildMaterializedViewCatalogKey,
	parseMaterializedViewCatalogKey,
	buildMetaCatalogKey,
	CLEAN_SHUTDOWN_META_NAME,
	STALE_MVS_META_NAME,
	classifyCatalogKey,
	type CatalogEntryKind,
	buildFullScanBounds,
	buildIndexPrefixBounds,
	buildPkPrefixBounds,
	buildCatalogScanBounds,
	// Legacy exports (deprecated)
	KEY_PREFIX,
	buildTablePrefix,
	buildTableScanBounds,
	buildIndexScanBounds,
	buildMetaKey,
	buildMetaScanBounds,
} from './key-builder.js';

// Events
export {
  StoreEventEmitter,
  type SchemaChangeEvent,
  type DataChangeEvent,
  type SchemaChangeListener,
  type DataChangeListener,
} from './events.js';

// DDL generation (canonical implementation lives in @quereus/quereus)
export { generateTableDDL, generateIndexDDL, generateViewDDL, generateMaintainedTableDDL, generateIndexTagsDDL } from '@quereus/quereus';

// Transaction support
export {
  TransactionCoordinator,
  type TransactionCallbacks,
  type PendingStoreOps,
  type OrderedPendingOps,
} from './transaction.js';

// Byte helpers for encoded keys
export { bytesToHex, bytesEqual, compareBytes } from './bytes.js';

// In-memory KV store
export { InMemoryKVStore } from './memory-store.js';

// Cached KV store wrapper
export { CachedKVStore, type CacheOptions } from './cached-kv-store.js';

// Generic store table and connection
export {
  StoreTable,
  resolvePkKeyCollations,
  resolvePkKeyTransforms,
  resolveIndexKeyTransforms,
  type StoreTableConfig,
  type StoreTableModule,
  type ExternalRowOp,
} from './store-table.js';
export { StoreConnection } from './store-connection.js';

// Materialized-view backing host (engine backing-host capability over a store table)
export { StoreBackingHost } from './backing-host.js';

// Generic store module
export { StoreModule, type StoreModuleConfig, type RehydrationResult, type RehydrationError, type LensDeploymentListener } from './store-module.js';

// Isolation layer utilities
export {
	createIsolatedStoreModule,
	hasIsolation,
	type IsolatedStoreModuleConfig,
} from './isolated-store.js';
