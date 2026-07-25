# @quereus/sync-coordinator

> **Stability: Experimental** — a research track; the API, the HTTP/WebSocket wire
> protocol, and the on-disk state may change or disappear without notice, in any release
> including a patch. See [Stability Tiers](../../docs/stability.md#tiers).

Standalone coordinator backend for [@quereus/sync](../quereus-sync) — a production-ready server for multi-master CRDT replication.

## Features

- **Production Ready**: Built with Fastify for high performance
- **Transport Flexibility**: HTTP polling and WebSocket real-time push
- **Extensible Hooks**: Custom authentication, authorization, and change validation
- **Zero Configuration**: Sensible defaults, configurable via CLI, env, or file

## Installation

```bash
npm install @quereus/sync-coordinator
```

## Quick Start

### CLI

```bash
# Start with defaults (port 3000, no auth)
npx sync-coordinator

# Custom port and debug logging
npx sync-coordinator --port 8080 --debug "sync-coordinator:*"

# With token authentication
npx sync-coordinator --auth-mode token-whitelist --auth-tokens "secret1,secret2"
```

### Programmatic

```typescript
import { createCoordinatorServer, loadConfig } from '@quereus/sync-coordinator';

const config = loadConfig({
  overrides: {
    port: 8080,
    dataDir: './data',
  }
});

const server = await createCoordinatorServer({ config });
await server.start();
```

## Configuration

Configuration sources (highest priority first):
1. CLI arguments
2. Environment variables
3. Config file (`sync-coordinator.json`)
4. Defaults

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_HOST` | Host to bind | `0.0.0.0` |
| `SYNC_PORT` | Port to listen | `3000` |
| `SYNC_BASE_PATH` | Base path for routes | `/sync` |
| `SYNC_DATA_DIR` | LevelDB data directory | `./.data` |
| `SYNC_CORS_ORIGIN` | CORS origins (`true`, `false`, or comma-separated) | `true` |
| `SYNC_AUTH_MODE` | Auth mode: `none`, `token-whitelist` | `none` |
| `SYNC_AUTH_TOKENS` | Comma-separated allowed tokens | — |

### S3 Durable Storage (Optional)

Enable S3 batch storage for durability and disaster recovery:

| Variable | Description | Default |
|----------|-------------|---------|
| `S3_BUCKET` | S3 bucket name (required to enable) | — |
| `S3_REGION` | AWS region | `us-east-1` |
| `S3_ENDPOINT` | Custom endpoint for MinIO/compatible | — |
| `S3_ACCESS_KEY_ID` | AWS access key | — |
| `S3_SECRET_ACCESS_KEY` | AWS secret key | — |
| `S3_FORCE_PATH_STYLE` | Use path-style URLs (for MinIO) | `false` |
| `S3_KEY_PREFIX` | Key prefix for all objects | — |
| `DISK_EVICTION_ENABLED` | Enable disk eviction for idle stores backed by S3 (auto-enabled with `S3_BUCKET`) | `true` if S3 set |
| `DISK_EVICTION_IDLE_MS` | Idle time (ms) before a closed store's local directory is deleted | `3600000` (1 hr) |

When S3 is configured, local LevelDB directories act as a write-back cache. After a store is closed (idle 5 min) and remains unused for `DISK_EVICTION_IDLE_MS`, its local directory is deleted — provided an S3 snapshot exists. On next access, the store is automatically restored from S3.

#### Local Testing with MinIO

```bash
# Start MinIO (Docker)
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"

# Create bucket via MinIO Console at http://localhost:9001

# Run coordinator with MinIO
S3_BUCKET=sync-batches \
S3_ENDPOINT=http://localhost:9000 \
S3_ACCESS_KEY_ID=minioadmin \
S3_SECRET_ACCESS_KEY=minioadmin \
S3_FORCE_PATH_STYLE=true \
npx sync-coordinator
```

### CLI Options

```bash
npx sync-coordinator --help
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync/status` | GET | Health check and stats |
| `/sync/metrics` | GET | Prometheus metrics |
| `/sync/:databaseId/changes` | GET | Get changes since HLC |
| `/sync/:databaseId/changes` | POST | Apply changes |
| `/sync/:databaseId/snapshot` | GET | Stream full snapshot (NDJSON) |
| `/sync/ws` | WS | WebSocket for real-time sync |

## Prometheus Metrics

The `/sync/metrics` endpoint exposes metrics in Prometheus format:

```
sync_websocket_connections_active    # Current WebSocket connections
sync_websocket_connections_total     # Total connections since startup
sync_http_requests_total             # HTTP requests by endpoint/status
sync_changes_applied_total           # Changes applied
sync_changes_received_total          # Changes received from clients
sync_changes_rejected_total          # Changes rejected during validation
sync_changes_broadcast_total         # Changes broadcast to clients
sync_broadcast_errors_total          # Broadcast send failures
sync_snapshot_requests_total         # Snapshot requests
sync_snapshot_chunks_total           # Snapshot chunks sent
sync_auth_attempts_total             # Authentication attempts
sync_auth_failures_total             # Authentication failures
sync_apply_changes_duration_seconds  # Apply operation duration histogram
sync_get_changes_duration_seconds    # Get changes duration histogram
sync_change_batch_size               # Change batch size histogram
```

## Custom Hooks

Extend the coordinator with custom logic:

```typescript
import { createCoordinatorServer, loadConfig, type CoordinatorHooks } from '@quereus/sync-coordinator';

const hooks: CoordinatorHooks = {
  async onAuthenticate(ctx) {
    const user = await verifyJWT(ctx.token);
    return { userId: user.id, siteId: ctx.siteId! };
  },
  
  async onAuthorize(client, operation) {
    return checkPermissions(client.userId, operation);
  },
  
  async onBeforeApplyChanges(client, changes) {
    // Filter or reject changes
    return { approved: changes, rejected: [] };
  }
};

const server = await createCoordinatorServer({ 
  config: loadConfig(), 
  hooks 
});
```

## Debug Logging

Uses the `debug` library:

```bash
# All coordinator logs
DEBUG=sync-coordinator:* npx sync-coordinator

# Specific namespaces
DEBUG=sync-coordinator:ws,sync-coordinator:auth npx sync-coordinator
```

Namespaces: `server`, `http`, `ws`, `service`, `auth`, `config`

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Build and run
npm test         # Run tests
```

## Related Packages

- [`@quereus/sync`](../quereus-sync/) - Client-side sync module
- [`@quereus/sync-client`](../quereus-sync-client/) - WebSocket sync client
- [`@quereus/store`](../quereus-store/) - Storage base layer

## License

MIT

