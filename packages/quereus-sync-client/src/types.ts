/**
 * Types for the WebSocket sync client.
 */

import type { ApplyResult, ChangeSet, SnapshotProgress, SyncManager, SyncEventEmitter } from '@quereus/sync';

// ============================================================================
// Connection Status
// ============================================================================

/**
 * Sync connection status.
 */
export type SyncStatus =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  /**
   * A snapshot bootstrap is streaming into the local store. The local database
   * is PARTIAL until this ends — do not write to it (a concurrent local write
   * is silently overwritten by the snapshot and never pushed).
   */
  | { status: 'bootstrapping'; tablesProcessed: number; totalTables: number;
      entriesProcessed: number; totalEntries: number; currentTable?: string }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncTime: number }
  | { status: 'error'; message: string };

/**
 * Sync event types for logging/UI notifications.
 */
export type SyncEventType = 'remote-change' | 'local-change' | 'conflict' | 'state-change' | 'error' | 'info' | 'rejected';

/**
 * Sync event for logging/UI display.
 */
export interface SyncEvent {
  type: SyncEventType;
  timestamp: number;
  message: string;
  details?: {
    table?: string;
    changeCount?: number;
    conflicts?: number;
    skipped?: number;
    rejections?: Array<{ reason: string; code?: string }>;
  };
}

// ============================================================================
// Client Options
// ============================================================================

/**
 * Options for configuring the SyncClient.
 */
export interface SyncClientOptions {
  /**
   * The SyncManager instance to use for sync operations.
   */
  syncManager: SyncManager;

  /**
   * The SyncEventEmitter to subscribe to local change events.
   * Required for automatic pushing of local changes to the server.
   */
  syncEvents: SyncEventEmitter;

  /**
   * Callback when connection status changes.
   */
  onStatusChange?: (status: SyncStatus) => void;

  /**
   * Callback when remote changes are applied.
   */
  onRemoteChanges?: (result: ApplyResult, changeSets: ChangeSet[]) => void;

  /**
   * Callback when a sync event occurs (for logging/UI).
   */
  onSyncEvent?: (event: SyncEvent) => void;

  /**
   * Callback when an error occurs.
   */
  onError?: (error: Error) => void;

  /**
   * Callback for messages the client doesn't handle (e.g., topology).
   * Receives the raw parsed JSON message object.
   */
  onUnhandledMessage?: (message: Record<string, unknown>) => void;

  /**
   * Whether to automatically reconnect on disconnect.
   * @default true
   */
  autoReconnect?: boolean;

  /**
   * Initial delay for reconnection (milliseconds).
   * @default 1000
   */
  reconnectDelayMs?: number;

  /**
   * Maximum delay for reconnection (milliseconds).
   * @default 60000
   */
  maxReconnectDelayMs?: number;

  /**
   * Debounce delay for batching local changes (milliseconds).
   * @default 50
   */
  localChangeDebounceMs?: number;

  /**
   * When true, the client operates in pull-only mode: it receives remote
   * changes but never pushes local changes to the server. Useful for
   * read-only / view-permission shared scenarios.
   * @default false
   */
  readOnly?: boolean;

  /**
   * Automatically request a full snapshot on the first connect to an EMPTY
   * replica — one that has never synced with this server and holds no local
   * change facts of its own. Disable to keep bootstrap purely explicit via
   * {@link SyncClient.requestSnapshot}.
   * @default true
   */
  bootstrapOnEmpty?: boolean;

  /**
   * Stall watchdog for a snapshot transfer: if no `snapshot_chunk` arrives
   * within this window, the transfer is aborted and the socket closed so the
   * normal reconnect path can resume from the saved checkpoint.
   * @default 60000
   */
  snapshotChunkTimeoutMs?: number;

  /**
   * Fine-grained snapshot transfer progress (fires once per applied chunk).
   * The coarser table-boundary progress also rides `onSyncEvent` and the
   * `bootstrapping` status.
   */
  onSnapshotProgress?: (progress: SnapshotProgress) => void;
}

// The WebSocket message unions (ClientMessage / ServerMessage and their
// per-message interfaces) and the Serialized* JSON-transport types formerly
// declared here now live in @quereus/sync (`sync/wire.ts`) — the single wire
// definition shared with the coordinator. Import them from '@quereus/sync';
// index.ts re-exports them so the client's public API is unchanged.

