/**
 * @quereus/sync-client - WebSocket sync client for Quereus
 *
 * This package provides a WebSocket-based sync client that connects to a
 * sync server and handles bidirectional synchronization of changes.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Local change batching with debouncing
 * - Delta sync tracking (only send/receive changes since last sync)
 * - Event callbacks for status changes, remote changes, and errors
 *
 * @example
 * ```typescript
 * import { SyncClient } from '@quereus/sync-client';
 *
 * const client = new SyncClient({
 *   syncManager,
 *   onStatusChange: (status) => console.log('Status:', status),
 *   onRemoteChanges: (result) => console.log('Applied:', result.applied),
 * });
 *
 * await client.connect('ws://localhost:8080/sync', 'a1-s1');
 * ```
 *
 * @packageDocumentation
 */

export { SyncClient } from './sync-client.js';
export { SnapshotStreamReader } from './snapshot-reader.js';

// The wire codec and message/Serialized types now live in @quereus/sync (the
// single source of truth shared with the coordinator). Re-export them here so the
// client's public API is unchanged for existing consumers.
export {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from '@quereus/sync';
export type {
  SerializedChangeSet,
  SerializedChange,
  SerializedSchemaMigration,
  // Protocol message types (for server implementations)
  ClientMessage,
  ServerMessage,
  HandshakeMessage,
  HandshakeAckMessage,
  GetChangesMessage,
  ChangesMessage,
  PushChangesMessage,
  ApplyChangesMessage,
  ApplyResultMessage,
  GetSnapshotMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
} from '@quereus/sync';

// Client-only types (not part of the wire) stay local.
export type {
  SyncStatus,
  SyncEvent,
  SyncEventType,
  SyncClientOptions,
} from './types.js';

