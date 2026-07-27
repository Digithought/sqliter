/**
 * Service layer exports.
 *
 * This package provides generic multi-tenant sync coordination.
 * App-specific database ID handling and cascade delete should be
 * implemented in the application layer via StoreManagerHooks.
 */

export {
  type ClientIdentity,
  type ClientSession,
  type AuthContext,
  type SyncOperation,
  type RejectedChange,
  type ValidationResult,
  type CoordinatorHooks,
} from './types.js';

export {
  CoordinatorService,
  type CoordinatorServiceOptions,
} from './coordinator-service.js';

export {
  StoreManager,
  type StoreEntry,
  type StoreManagerConfig,
  type StoreManagerHooks,
  type StoreContext,
} from './store-manager.js';

export {
  CoordinatorMaintenanceLoop,
  runCoordinatorMaintenancePass,
  COORDINATOR_MAINTENANCE_INTERVAL_MS,
  type MaintenanceStoreSource,
  type StoreMaintenanceLogger,
} from './maintenance.js';

export {
  type S3StorageConfig,
  type StoragePathResolver,
  createS3Client,
  buildBatchKey,
  buildSnapshotKey,
  defaultStoragePathResolver,
  parseS3ConfigFromEnv,
} from './s3-config.js';

export {
  S3BatchStore,
  createS3BatchStore,
  type SyncBatch,
} from './s3-batch-store.js';

export {
  S3SnapshotStore,
  createS3SnapshotStore,
  type SnapshotMetadata,
  type SnapshotScheduleConfig,
} from './s3-snapshot-store.js';
