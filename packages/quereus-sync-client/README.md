# @quereus/sync-client

> **Stability: Experimental** — a research track; the API and the wire protocol it speaks
> may change or disappear without notice, in any release including a patch. See
> [Stability Tiers](../../docs/stability.md#tiers).

WebSocket sync client for [Quereus](https://github.com/gotchoices/quereus). Handles connection management, reconnection, and bidirectional change synchronization.

## Features

- **Automatic reconnection**: Exponential backoff (1s → 60s max) on connection loss
- **Local change batching**: Debounces rapid changes into efficient batches
- **Delta sync**: Only sends changes since last successful sync
- **Snapshot bootstrap**: A new (empty) device downloads a full copy of the database, with progress reporting and automatic resume of an interrupted transfer
- **Framework agnostic**: Works in any JavaScript environment with WebSocket support
- **Type-safe**: Full TypeScript support

## Installation

```bash
npm install @quereus/sync-client
```

## Quick Start

```typescript
import { SyncClient } from '@quereus/sync-client';
import { createSyncModule } from '@quereus/sync';

// Assuming you have a SyncManager from sync
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents);

// Create the sync client
const client = new SyncClient({
  syncManager,
  syncEvents,
  onStatusChange: (status) => {
    console.log('Connection status:', status.status);
  },
  onRemoteChanges: (result, changeSets) => {
    console.log(`Applied ${result.applied} changes`);
  },
  onError: (error) => {
    console.error('Sync error:', error);
  },
});

// Connect to the sync server
await client.connect('wss://your-server.com/sync/ws', 'a1-s1', authToken);

// Changes are synced automatically via syncEvents listener
// When done:
await client.disconnect();
```

## API

### `SyncClient`

Main class for WebSocket-based synchronization.

#### Constructor Options

```typescript
interface SyncClientOptions {
  /** SyncManager from @quereus/sync */
  syncManager: SyncManager;

  /** SyncEventEmitter for local change notifications */
  syncEvents: SyncEventEmitter;

  /** Called when connection status changes */
  onStatusChange?: (status: SyncStatus) => void;

  /** Called when remote changes are applied */
  onRemoteChanges?: (result: ApplyResult, changeSets: ChangeSet[]) => void;

  /** Called on sync events (for logging/UI) */
  onSyncEvent?: (event: SyncEvent) => void;

  /** Called on errors */
  onError?: (error: Error) => void;

  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;

  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelayMs?: number;

  /** Maximum reconnect delay in ms (default: 60000) */
  maxReconnectDelayMs?: number;

  /** Debounce window for local changes in ms (default: 50) */
  localChangeDebounceMs?: number;

  /** Auto-download a full snapshot on first connect to an empty replica (default: true) */
  bootstrapOnEmpty?: boolean;

  /** Snapshot stall watchdog: abort if no chunk arrives within this window in ms (default: 60000) */
  snapshotChunkTimeoutMs?: number;

  /** Fine-grained snapshot transfer progress */
  onSnapshotProgress?: (progress: SnapshotProgress) => void;
}
```

#### Methods

- `connect(url: string, databaseId: string, token?: string): Promise<void>` - Connect to sync server
- `disconnect(): Promise<void>` - Disconnect and stop reconnection attempts
- `requestSnapshot(): Promise<void>` - Explicitly download a full snapshot. **Do not write to the database while it is landing** — a concurrent local write is overwritten by the snapshot and never pushed
- `hasPendingSnapshot(): Promise<boolean>` - Whether an interrupted snapshot left the local database partial (usable before connecting; the next connect resumes the transfer)
- `status: SyncStatus` - Current connection status (getter property)
- `isConnected: boolean` - Whether the WebSocket is open (getter property)
- `isSynced: boolean` - Whether the client is fully synced (getter property)
- `isBootstrapping: boolean` - Whether a snapshot transfer is in flight (getter property)

### Serialization Helpers

The package exports helpers for ChangeSet serialization:

```typescript
import {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from '@quereus/sync-client';
```

## Connection States

The client goes through these states:

```
DISCONNECTED → CONNECTING → SYNCING → SYNCED
                    ↑                    │
                    └────────────────────┘ (on connection loss)
```

- `disconnected`: Not connected
- `connecting`: WebSocket connecting, handshake in progress
- `bootstrapping`: A full snapshot is streaming in — the local database is partial; hold writes until it finishes
- `syncing`: Connected, exchanging initial changes
- `synced`: Fully synchronized, real-time updates active
- `error`: Connection error (will auto-reconnect if enabled)

## Protocol

The client implements the Quereus sync WebSocket protocol:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `handshake` | Client→Server | Authenticate with siteId and token |
| `handshake_ack` | Server→Client | Confirm connection |
| `get_changes` | Client→Server | Request changes since HLC |
| `changes` | Server→Client | Initial/requested changes |
| `apply_changes` | Client→Server | Send local changes |
| `apply_result` | Server→Client | Confirm changes applied |
| `push_changes` | Server→Client | Real-time changes from other clients |
| `get_snapshot` | Client→Server | Request a full snapshot stream |
| `resume_snapshot` | Client→Server | Resume an interrupted snapshot from a checkpoint |
| `snapshot_chunk` | Server→Client | One streamed snapshot chunk |
| `snapshot_complete` | Server→Client | Snapshot stream finished |
| `ping`/`pong` | Both | Keepalive |

## Related Packages

- [`@quereus/sync`](../quereus-sync/) - Sync module (provides SyncManager)
- [`@quereus/sync-coordinator`](../sync-coordinator/) - Server-side coordinator
- [`@quereus/store`](../quereus-store/) - Storage base layer

## License

MIT

