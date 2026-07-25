# Sync Coordinator - Standalone Backend for Quereus Sync

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

The **sync-coordinator** package provides a production-ready, standalone backend server for the Quereus Sync protocol. It serves as both a reference implementation and a deployable service for multi-master CRDT replication.

## Design Goals

- **Production Ready**: Built with Fastify for high performance; suitable for direct deployment
- **Transport Flexibility**: Supports both HTTP polling and WebSocket real-time push
- **Extensible Service Layer**: Hook-based architecture for validation, authentication, and custom logic
- **Configurable**: Data directory, CORS, auth mode, logging verbosity all configurable
- **Developer-Friendly**: Clear separation of concerns; easy to understand and extend

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         sync-coordinator                                     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        CLI Entry Point (bin/sync-coordinator.js)        │ │
│  │  • Parses command line args (Commander)                                 │ │
│  │  • Loads configuration from file/env/args                               │ │
│  │  • Bootstraps and starts the server                                     │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        Configuration Layer                              │ │
│  │  • Data directory path                                                  │ │
│  │  • CORS settings (origins, credentials)                                 │ │
│  │  • Auth mode (none, token-whitelist, custom hook)                       │ │
│  │  • Debug logging namespaces                                             │ │
│  │  • Sync settings (batch size, tombstone TTL)                            │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                    CoordinatorService (Service Layer)                   │ │
│  │                                                                          │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │ │
│  │  │ Validation Hooks                                                   │   │ │
│  │  │  • onAuthenticate(request) → Promise<AuthResult>                 │   │ │
│  │  │  • onAuthorize(client, operation) → Promise<boolean>             │   │ │
│  │  │  • onBeforeApplyChanges(client, changes) → Promise<ValidationResult> │ │
│  │  │  • onAfterApplyChanges(client, changes, result) → void           │   │ │
│  │  │  • onClientConnect(client) → Promise<boolean>                    │   │ │
│  │  │  • onClientDisconnect(client) → void                             │   │ │
│  │  └──────────────────────────────────────────────────────────────────┘   │ │
│  │                                                                          │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │ │
│  │  │ Core Operations                                                    │   │ │
│  │  │  • handleSync(client, sinceHLC) → ChangeSet[]                    │   │ │
│  │  │  • handleApplyChanges(client, changes) → ApplyResult             │   │ │
│  │  │  • handleSnapshot(client) → AsyncIterable<SnapshotChunk>         │   │ │
│  │  └──────────────────────────────────────────────────────────────────┘   │ │
│  │                                                                          │ │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │ │
│  │  │ Client Sessions (for WebSocket)                                    │   │ │
│  │  │  • Map<connectionId, ClientSession>                              │   │ │
│  │  │  • Tracks siteId, lastSyncHLC, auth state                        │   │ │
│  │  └──────────────────────────────────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│            ┌───────────────────────┴────────────────────────┐                │
│            ▼                                                ▼                │
│  ┌───────────────────────┐                    ┌───────────────────────────┐ │
│  │    HTTP Routes        │                    │    WebSocket Handler      │ │
│  │    (Fastify)          │                    │    (Fastify WebSocket)    │ │
│  │                       │                    │                           │ │
│  │ POST /sync/changes    │                    │ • Connection handshake    │ │
│  │ GET  /sync/changes    │                    │ • Bidirectional messages  │ │
│  │ GET  /sync/snapshot   │                    │ • Push notifications      │ │
│  │ GET  /sync/status     │                    │ • Automatic reconnect     │ │
│  │ POST /sync/apply      │                    │   (client-side)           │ │
│  └───────────────────────┘                    └───────────────────────────┘ │
│            │                                                │                │
│            └───────────────────────┬────────────────────────┘                │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          SyncManager                                    │ │
│  │              (from quereus-sync)                                       │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          LevelDB Store                                  │ │
│  │              (from quereus-store)                                       │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Service Layer Design

The **CoordinatorService** is the heart of the sync-coordinator. It wraps the `SyncManager` from quereus-sync and adds:

1. **Validation Hooks**: Extensible callbacks for custom business logic
2. **Client Session Management**: Tracks connected clients and their state
3. **Broadcast Capabilities**: Notifies connected WebSocket clients of changes

### Validation Hooks

Hooks allow customization without modifying core code. All hooks are optional; defaults allow all operations.

```typescript
interface CoordinatorHooks {
  /**
   * Authenticate an incoming request/connection.
   * Called before any sync operation.
   * Return client identity or throw to reject.
   */
  onAuthenticate?(context: AuthContext): Promise<ClientIdentity>;

  /**
   * Authorize a specific operation for a client.
   * Called after authentication, before executing the operation.
   */
  onAuthorize?(client: ClientIdentity, operation: SyncOperation): Promise<boolean>;

  /**
   * Validate changes before applying them.
   * Can modify, filter, or reject changes.
   */
  onBeforeApplyChanges?(
    client: ClientIdentity,
    changes: ChangeSet[]
  ): Promise<{ approved: ChangeSet[]; rejected: RejectedChange[] }>;

  /**
   * Called after changes are successfully applied.
   * Useful for logging, metrics, or triggering side effects.
   */
  onAfterApplyChanges?(
    client: ClientIdentity,
    changes: ChangeSet[],
    result: ApplyResult
  ): void;

  /**
   * Called when a WebSocket client connects.
   * Return false to reject the connection.
   */
  onClientConnect?(client: ClientIdentity, socket: WebSocket): Promise<boolean>;

  /**
   * Called when a WebSocket client disconnects.
   */
  onClientDisconnect?(client: ClientIdentity): void;
}
```

### Client Sessions

For WebSocket connections, the coordinator maintains client sessions:

```typescript
interface ClientSession {
  connectionId: string;           // Unique connection identifier
  siteId: SiteId;                 // Client's replica site ID
  identity: ClientIdentity;       // Authenticated identity
  lastSyncHLC: HLC | undefined;   // Last HLC client synced to
  connectedAt: number;            // Timestamp
  socket: WebSocket;              // The WebSocket connection
}
```

Sessions are created on WebSocket handshake and destroyed on disconnect. HTTP requests are stateless but still go through authentication.

## HTTP API

All endpoints are prefixed with `/sync` (configurable).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Health check; returns coordinator status and stats |
| `GET` | `/changes` | Get changes since `?sinceHLC=...` for requesting client |
| `POST` | `/changes` | Apply changes from client; body is `ChangeSet[]` |
| `GET` | `/snapshot` | Stream full snapshot for initial sync |
| `POST` | `/snapshot` | Resume snapshot from checkpoint |

### Request Headers

| Header | Description |
|--------|-------------|
| `Authorization` | Auth token (when auth mode requires it) |
| `X-Site-Id` | Client's site ID (required for all sync operations) |
| `X-Since-HLC` | Alternative to query param for GET /changes |

### Response Format

All responses are JSON with consistent structure:

```typescript
// Success
{ "ok": true, "data": <result> }

// Error
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

## WebSocket Protocol

WebSocket connections provide real-time bidirectional sync.

### Connection Handshake

1. Client connects to `/sync/ws`
2. Client sends `{ type: "handshake", siteId: "...", token?: "...", protocolVersion: <int> }`
3. Server checks `protocolVersion` **before authenticating**. If it is absent or
   not equal to the server's `PROTOCOL_VERSION`, the server replies
   `{ type: "error", code: "PROTOCOL_VERSION_MISMATCH", fatal: true }` and closes
   the socket with code `4003` — the store is never touched. Otherwise it
   authenticates and responds
   `{ type: "handshake_ack", serverSiteId: "...", protocolVersion: <int> }`.
4. Connection is established; client is added to session registry

The version check is **strict integer equality**: a peer that predates versioning
(sends no `protocolVersion`) is treated as incompatible, not silently accepted.
See [`sync.md` § Protocol version](sync.md) for the rationale.

### Message Types

**Client → Server:**
```typescript
| { type: "handshake"; siteId: string; token?: string; protocolVersion: number }
| { type: "get_changes"; sinceHLC?: HLC }
| { type: "apply_changes"; changes: ChangeSet[] }
| { type: "get_snapshot" }
| { type: "resume_snapshot"; checkpoint: SerializedSnapshotCheckpoint }
| { type: "ping" }
```

`SerializedSnapshotCheckpoint` is the JSON-safe form of `SnapshotCheckpoint`
(base64 `siteId` and `hlc`); the raw checkpoint holds a `Uint8Array` and a
`bigint`, which `JSON.stringify` cannot emit. Senders build it with
`serializeSnapshotCheckpoint`; the coordinator decodes it with
`deserializeSnapshotCheckpoint` before handing it to the service.

**Server → Client:**
```typescript
| { type: "handshake_ack"; serverSiteId: string; protocolVersion: number }
| { type: "changes"; changeSets: ChangeSet[] }
| { type: "apply_result"; result: ApplyResult }
| { type: "snapshot_chunk"; chunk: SnapshotChunk }
| { type: "snapshot_complete" }                        // Signals successful end of snapshot stream
| { type: "push_changes"; changeSets: ChangeSet[] }   // Server pushes new changes
| { type: "error"; code: string; message: string; fatal?: boolean }
| { type: "pong" }
```

### Push Notifications

When any client applies changes, the coordinator broadcasts to all other connected clients:
```typescript
{ type: "push_changes", changeSets: [...] }
```

Clients can immediately apply these or request a full sync.


## Configuration

Configuration is loaded from (in priority order):
1. Command-line arguments
2. Environment variables
3. Configuration file (`sync-coordinator.json` or `--config` path)
4. Defaults

### Configuration Schema

```typescript
interface CoordinatorConfig {
  // Server
  host: string;                    // Default: "0.0.0.0"
  port: number;                    // Default: 3000
  basePath: string;                // Default: "/sync"

  // Data storage
  dataDir: string;                 // Default: "./.data"

  // CORS
  cors: {
    origin: string | string[] | boolean;  // Default: true (all origins)
    credentials: boolean;                  // Default: true
  };

  // Authentication
  auth: {
    mode: "none" | "token-whitelist" | "custom";
    tokens?: string[];             // For token-whitelist mode
  };

  // Sync settings (passed to SyncManager)
  sync: {
    retentionHorizonMs: number;    // Default: 30 days (ms)
    batchSize: number;             // Default: 1000
  };

  // Logging
  logging: {
    level: "debug" | "info" | "warn" | "error";
    namespaces: string;            // debug-style namespace filter
  };
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SYNC_HOST` | Server host |
| `SYNC_PORT` | Server port |
| `SYNC_DATA_DIR` | Data directory path |
| `SYNC_CORS_ORIGIN` | CORS origin(s), comma-separated |
| `SYNC_AUTH_MODE` | Authentication mode |
| `SYNC_AUTH_TOKENS` | Comma-separated token whitelist |
| `SYNC_RETENTION_HORIZON_MS` | Retention horizon in ms (changes older than this are not guaranteed deliverable; default 30 days) |
| `SYNC_BATCH_SIZE` | Maximum changes per sync batch |
| `DEBUG` | Debug logging namespaces |

### CLI Usage

```bash
# Start with defaults
npx sync-coordinator

# Start with custom config
npx sync-coordinator --config ./my-config.json

# Start with CLI overrides
npx sync-coordinator --port 8080 --data-dir ./data --auth-mode none

# Full options
npx sync-coordinator \
  --host 0.0.0.0 \
  --port 3000 \
  --data-dir ./data \
  --cors-origin "http://localhost:5173,https://myapp.com" \
  --auth-mode token-whitelist \
  --auth-tokens "token1,token2" \
  --log-level debug
```

## Logging

The coordinator uses the `debug` library (same as Quereus core) for configurable logging:

```bash
# Enable all coordinator logs
DEBUG=sync-coordinator:*

# Enable only WebSocket and error logs
DEBUG=sync-coordinator:ws,sync-coordinator:*:error

# Enable underlying sync manager logs too
DEBUG=sync-coordinator:*,quereus:sync:*
```

### Log Namespaces

| Namespace | Description |
|-----------|-------------|
| `sync-coordinator:server` | Server lifecycle events |
| `sync-coordinator:http` | HTTP request/response logging |
| `sync-coordinator:ws` | WebSocket connection events |
| `sync-coordinator:service` | Service layer operations |
| `sync-coordinator:auth` | Authentication events |

## Extending the Coordinator

For custom deployments, import and extend the service:

```typescript
import { createCoordinatorServer, loadConfig, type CoordinatorHooks } from 'sync-coordinator';

const hooks: CoordinatorHooks = {
  async onAuthenticate(ctx) {
    // Custom auth: verify JWT, check database, etc.
    const user = await verifyToken(ctx.token);
    return { userId: user.id, siteId: ctx.siteId! };
  },
  async onAuthorize(client, operation) {
    // Check permissions
    return hasPermission(client.userId, operation);
  },
  async onBeforeApplyChanges(client, changes) {
    // Validate business rules
    return validateChanges(changes);
  }
};

const config = loadConfig({
  overrides: {
    port: 3000,
    dataDir: './data',
    cors: { origin: ['https://myapp.com'] }
  }
});

const server = await createCoordinatorServer({ config, hooks });
await server.start();
```


## Package Structure

```
packages/sync-coordinator/
├── src/
│   ├── bin/
│   │   └── sync-coordinator.ts    # CLI entry point
│   ├── config/
│   │   ├── index.ts               # Config exports
│   │   ├── types.ts               # Config type definitions
│   │   └── loader.ts              # Config loading logic
│   ├── service/
│   │   ├── index.ts               # Service exports
│   │   ├── types.ts               # Hook and session types
│   │   └── coordinator-service.ts # Main service class
│   ├── server/
│   │   ├── index.ts               # Server exports
│   │   ├── routes.ts              # HTTP route definitions
│   │   ├── websocket.ts           # WebSocket handler
│   │   └── create-server.ts       # Fastify server factory
│   ├── common/
│   │   └── logger.ts              # Debug logger setup
│   └── index.ts                   # Public API exports
├── test/
│   ├── service.spec.ts            # Service layer tests
│   ├── routes.spec.ts             # HTTP route tests
│   └── websocket.spec.ts          # WebSocket tests
├── package.json
├── tsconfig.json
└── README.md
```

## Security Considerations

1. **Always enable authentication in production**: The default `auth: "none"` is for development only.

2. **Use HTTPS in production**: The coordinator doesn't handle TLS directly; deploy behind a reverse proxy (nginx, Caddy) or load balancer.

3. **Validate client siteIds**: The `onAuthenticate` hook should verify that the claimed siteId matches the authenticated user's registered devices.

4. **Rate limiting**: Implement rate limiting in the `onAuthorize` hook or at the reverse proxy level.

5. **Input validation**: The coordinator validates sync protocol messages but application-level validation should be done in `onBeforeApplyChanges`.

## Performance Characteristics

- **HTTP polling**: Suitable for low-frequency sync (minutes). Higher latency, simpler client implementation.
- **WebSocket**: Recommended for real-time applications. Sub-second sync latency, persistent connections.
- **Snapshot streaming**: Memory-efficient chunked transfer for large datasets.
- **LevelDB backend**: Fast local storage; suitable for single-node deployments. For multi-node, use a shared database backend (requires custom KVStore implementation).

## Status

### Completed

- [x] Package structure and build setup
- [x] Configuration system with CLI, env, and file support
- [x] CoordinatorService with hook infrastructure
- [x] HTTP routes (Fastify)
- [x] WebSocket handler with session management
- [x] CORS middleware
- [x] Token-whitelist authentication mode
- [x] CLI entry point with Commander
- [x] Unit tests for service and config
- [x] Integration tests for HTTP and WebSocket
- [x] Metrics endpoint (Prometheus format)

### Future Enhancements

- [ ] Admin API for runtime configuration
- [ ] Client SDK helpers for common patterns
- [ ] Docker image and Helm chart
