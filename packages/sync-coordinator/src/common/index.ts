/**
 * Common utilities for sync-coordinator.
 */

export {
  createLogger,
  serverLog,
  httpLog,
  wsLog,
  serviceLog,
  authLog,
  configLog,
} from './logger.js';

// Wire codec now lives in @quereus/sync (single source of truth shared with the
// client). Re-exported here so callers keep importing it via ../common/index.js.
export {
  serializeChangeSet,
  deserializeChangeSet,
  serializeSnapshotChunk,
  deserializeSnapshotChunk,
  serializeSnapshotCheckpoint,
  deserializeSnapshotCheckpoint,
} from '@quereus/sync';

