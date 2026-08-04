# Sync Protocol

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

The wire-level contract of `quereus-sync`: the data structures a peer exchanges, the
`SyncManager` API a host drives, and the WebSocket message protocol with its versioning,
reconnection and debouncing rules. A satellite of [Sync Module](sync.md).

## Data Structures

```typescript
/** Identifies a specific replica in the network */
type SiteId = Uint8Array;  // 16-byte UUID

/** A transaction's worth of changes */
interface ChangeSet {
  siteId: SiteId;                    // Origin replica
  transactionId: string;             // Unique transaction ID
  hlc: HLC;                          // Transaction commit time
  changes: Change[];                 // Column-level changes
  schemaMigrations: SchemaMigration[]; // Schema changes in this tx
}

/** A single column modification */
interface ColumnChange {
  type: 'column';
  schema: string;
  table: string;
  pk: SqlValue[];                    // Primary key values
  column: string;
  value: SqlValue;
  hlc: HLC;
  priorValue?: SqlValue;             // before-image: the value this write overwrote
  priorHlc?: HLC;                    // HLC of the overwritten cell version
}
```

**Per-cell before-image (`priorValue` / `priorHlc`).** An optional, purely additive
before-image mirroring Lamina's `UpdateCellFact(new_value, prior_value?, prior_hlc?)`.
It carries the cell version this write replaced, so a receiver can see *what changed
from what* (audit trails, undo, conflict debugging) without a separate lookup.

- **Source = the prior tracked cell version**, not the engine's `oldRow[i]`, which has
  no HLC and can diverge from the CRDT cell lineage. The prior `ColumnVersion`
  (`{ hlc, value }`) pairs semantically with `value`/`hlc`.
- **Replica-local lineage.** Stored on each `ColumnVersion` as "what this write replaced
  *here*" (`oldVersion` on the local write path, `oldColumnVersion` on apply). In
  causal-order delivery that equals the origin's prior, so a relaying receiver re-emits
  the origin's chain (the prior's own origin HLC, never reset to the receiver's clock).
- **Best-effort.** Both fields are absent on a cell's first write and on
  snapshot-reconstructed cells. Producers may omit them; receivers ignore them when
  absent; the no-`conflictResolver` HLC fast path is unchanged. Repeated local overwrites
  before a pull keep one change-log entry per cell, whose prior is the *immediately*
  overwritten version — "what the winning write overwrote", not "the value at last sync"
  (intended Lamina semantics).
- **Not used to skip the receiver's re-read.** `localValue` still comes from the
  receiver's `getColumnVersion` read; the before-image is exposed only for the
  resolver/validator. Skipping the re-read is intentionally **not** done — it would risk
  regressing the fast path.
```typescript

/** A row deletion */
interface RowDeletion {
  type: 'delete';
  schema: string;
  table: string;
  pk: SqlValue[];
  hlc: HLC;
  priorRow?: Row;                    // last-known row image before deletion (audit/undo)
}

type Change = ColumnChange | RowDeletion;
```

**Row before-image (`priorRow`).** The row-level companion to the per-cell
before-image: an optional, purely additive last-known row image carried on a
deletion, so a receiver can show or undo *what was removed*.

- **Source = the engine's `oldRow`**, captured at delete time (already on the event, no
  extra read) — the column-ordered row the engine deleted, unlike the per-cell
  `priorValue`, which comes from the prior tracked cell version.
- **Persisted on the tombstone.** `getChangesSince` re-resolves deletions from the
  `TombstoneStore`, so the image is stored on the `Tombstone` (the row analog of
  storing the cell prior on the `ColumnVersion`) and survives re-emission/relay.
- **Best-effort.** Absent when the delete carried no `oldRow` (relayed/synthesized
  deletes) and on snapshot-reconstructed tombstones. Producers may omit it; receivers
  ignore it when absent. A tombstone with no `priorRow` serializes to its unchanged
  fixed-size form.
- **Storage cost.** Every tombstone may hold a full row image, retained until
  retention-horizon GC — bounded but non-trivial for wide rows.
```typescript

/** A schema modification */
interface SchemaMigration {
  type: 'create_table' | 'drop_table' | 'rename_table'
      | 'add_column' | 'drop_column' | 'alter_column'
      | 'add_index' | 'drop_index';
  schema: string;
  table: string;                     // The object's name AFTER the migration
  fromTable?: string;                // `rename_table` only: the name before the rename
  ddl: string;                       // The DDL statement
  hlc: HLC;
  schemaVersion: number;             // Monotonic per (object kind, object name)
}
```

## Sync API

```typescript
interface SyncManager {
  /** Get this replica's site ID */
  getSiteId(): SiteId;

  /** Get current HLC for state comparison */
  getCurrentHLC(): HLC;

  /** All changes since a peer's last known state; omit sinceHLC for initial sync. */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /** Apply changes received from a peer; returns statistics about what was applied. */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /** False if a snapshot is required instead — e.g. tombstone TTL expired for relevant data. */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /** A full snapshot, for initial sync or TTL-expiration recovery. */
  getSnapshot(): Promise<Snapshot>;

  /** Apply a full snapshot (replaces all local data). */
  applySnapshot(snapshot: Snapshot): Promise<void>;
}

interface ApplyResult {
  applied: number;      // Changes successfully applied
  skipped: number;      // Already present (LWW no-op)
  conflicts: number;    // Conflicts resolved (remote won or lost)
  transactions: number; // Transactions processed
  unknownTable?: number; // Diverted for out-of-basis tables (§ Unknown-Table Disposition)
}

interface Snapshot {
  siteId: SiteId;
  hlc: HLC;
  snapshotFormat: number;  // wire-format stamp; see § Snapshot wire-format version
  tables: TableSnapshot[];
  schemaMigrations: SchemaMigration[];
  // Global tombstone pass (table-independent) so a fully-deleted row — a
  // tombstone with no live column-versions — survives an applySnapshot bootstrap.
  tombstones: SnapshotTombstone[];
}

interface TableSnapshot {
  schema: string;
  table: string;
  // One flat record per live cell — the table's ONLY payload; only the raw pk
  // travels, and no pre-grouped row images do. The receiver groups cells into
  // rows under its own DERIVED identity. See § Row identity vs. address.
  columnVersions: ReadonlyArray<{ column: string; hlc: HLC; value: SqlValue; pk: SqlValue[] }>;
}

// ============================================================================
// Streaming Snapshot API (for large datasets)
// ============================================================================

interface SyncManager {
  // ... existing methods ...

  /** Stream a snapshot as chunks; use instead of getSnapshot() for large databases. */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot with progress tracking, resumable via checkpoint.
   *
   * A fresh apply replaces all local CRDT metadata: the up-front clear wipes
   * column versions, tombstones, and the change log before the chunks rewrite
   * them. Tombstones ARE carried in the stream (a global `tombstone`-chunk pass,
   * separate from the per-table column-version sections), so a deleted row stays
   * deleted after bootstrap. On a *resumed* apply the sender skips already-completed
   * tables and never re-emits their metadata, so the receiver consults the persisted
   * checkpoint (saved under `sc:{snapshotId}`) and preserves those completed tables
   * through the clear — otherwise their CRDT state would be wiped and never
   * rewritten, diverging from the row data still in the store. (Tombstones are
   * re-emitted wholesale on resume and re-written idempotently.)
   *
   * The header HLC is drift-validated before the clear (see docs/sync.md § Hybrid
   * Logical Clock (HLC)): a far-future snapshot is rejected before any local
   * metadata is touched.
   *
   * A checkpoint exists for the WHOLE duration of an apply: one is saved at header
   * time, immediately after the clear, and the footer clears it on success. So
   * "a checkpoint is present" is the durable answer to "is this replica's data
   * partial?" — see § Checkpoint presence means partial data below.
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /** A resumable checkpoint for an in-progress snapshot, by id. */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /**
   * Every saved checkpoint — the discovery path for a caller that does not hold a
   * snapshotId (it only ever arrived in the header chunk, so a restarted client
   * has forgotten it). Ordering is unspecified; pick by `createdAt` when more than
   * one is present. Returns `[]` on a replica that never applied a snapshot.
   */
  listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]>;

  /**
   * Discard a checkpoint without applying anything — for a transfer the caller
   * will not resume (e.g. superseded checkpoints when several are present).
   * A successful apply already clears its own. Not guarded against an in-flight
   * apply: that apply simply re-saves the record at its next flush.
   */
  clearSnapshotCheckpoint(snapshotId: string): Promise<void>;

  /** Resume a snapshot transfer from a checkpoint. */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/**
 * Snapshot chunk types for streaming.
 *
 * Emission ORDER is load-bearing — DDL precedes table data:
 *
 *   header → schema-migration* → [table-start, column-versions…, table-end]*
 *          → tombstone* → footer
 *
 * The receiver cannot buffer a whole snapshot: `applySnapshotStream` flushes rows to
 * the store every 100 pending changes, and the adapter applies DDL before DML only
 * WITHIN one flush. A `create table` emitted after its rows arrives too late for every
 * flush they already triggered, and on a receiver that lacks the table each of those
 * rows fails with "Table not found for external write". The receiver correspondingly
 * flushes its pending DDL — re-sorted causally — at the first `table-start`.
 */
type SnapshotChunk =
  | SnapshotHeaderChunk      // First; snapshotFormat gated + HLC drift-validated here
  | SnapshotSchemaMigrationChunk  // All DDL, before any table data
  | SnapshotTableStartChunk
  | SnapshotColumnVersionsChunk
  | SnapshotTableEndChunk
  | SnapshotTombstoneChunk   // Global pass; carries fully-deleted rows
  | SnapshotFooterChunk;     // Last; carries stats

/** Progress info during snapshot streaming */
interface SnapshotProgress {
  snapshotId: string;
  tablesProcessed: number;
  totalTables: number;
  entriesProcessed: number;
  totalEntries: number;
  currentTable?: string;
}

/**
 * Checkpoint for resumable snapshot transfers.
 *
 * NOT JSON-safe: `siteId` is raw bytes and `hlc.wallTime` is a bigint, which
 * `JSON.stringify` throws on. Cross the wire via `serializeSnapshotCheckpoint` /
 * `deserializeSnapshotCheckpoint` (`sync/wire.ts`), which encode both as base64
 * into `SerializedSnapshotCheckpoint` — the shape `resume_snapshot` carries.
 *
 * INVARIANT on `completedTables`: a table appears here only after every one of its
 * rows has returned from the store apply. A resumed sender SKIPS these tables and
 * the receiver PRESERVES their metadata through the resume's up-front clear, so a
 * table named prematurely would lose its trailing rows permanently — they are never
 * re-sent, never reconciled, never reported. `applySnapshotStream` upholds this by
 * staging a finished table and graduating it only inside its data flush; being late
 * is safe (the table is merely re-streamed), being early is not.
 */
interface SnapshotCheckpoint {
  snapshotId: string;
  siteId: SiteId;
  hlc: HLC;
  lastTableIndex: number;
  lastEntryIndex: number;
  completedTables: string[];
  entriesProcessed: number;
  createdAt: number;
}
```

### Checkpoint presence means partial data

Checkpoints live under `sc:{snapshotId}` (`SYNC_KEY_PREFIX.SNAPSHOT_CHECKPOINT`).
A checkpoint is present for the *entire* duration of a streaming apply:

- **Saved at the header**, immediately after `clearExistingMetadata`. Both header
  gates — wire format and clock drift — reject *before* that clear and touch no
  local state, so a refused snapshot leaves no checkpoint behind. Everything after
  the clear is covered, including the window before the first metadata-batch flush
  (every 1000 entries) that used to be the earliest save.
- **Re-saved at every metadata flush**, advancing `completedTables`.
- **Cleared by the footer**, after `bootstrapFinalize` — deliberately in that order,
  so a failed finalize leaves the checkpoint in place and the transfer retries.

Every *other* snapshot's checkpoint is deleted at that same header point. The clear
just removed the local metadata of every table this apply did not inherit, so another
transfer's `completedTables` no longer has state behind it — resuming from it would
tell the sender to skip exactly the tables that can no longer be rebuilt. Dropping
those records keeps at most one checkpoint alive at a time, so nothing accumulates
and a replica made whole by *any* completed apply reports itself whole.

So on a replica whose data may be mid-bootstrap, `listSnapshotCheckpoints()` is the
single durable answer to "is this data partial?" — no `snapshotId` needed, which
matters because the id only ever arrives in the header chunk and a restarted client
has forgotten it. Feed the discovered checkpoint back to a peer's
`resumeSnapshotStream(checkpoint)` to finish the transfer, or
`clearSnapshotCheckpoint(id)` to abandon it.

`clearExistingMetadata` sweeps `cv:` / `tb:` / `cl:` only — it must never grow to
include `sc:`, or a resumed apply would delete the very resume position it is
running from.

## Sync Flow (Master to Many-Masters)

For the primary use case of a master server syncing to many frontend replicas:

1. Frontend connects, sending `{ mySiteId, lastSyncHLC }`
2. Master checks `canDeltaSync()` — if false a full snapshot, if true `getChangesSince()`
3. Master sends `ChangeSet[]`; frontend applies them with `applyChanges(changeSets)`
4. Frontend sends its own local changes (those made while offline)
5. Master applies them, resolving conflicts via LWW, and re-sends any winners

## WebSocket Sync Protocol

The WebSocket protocol gives real-time bidirectional synchronization — the recommended transport for interactive applications.

A session runs `handshake` → `handshake_ack` (both carrying `protocolVersion`), then
`get_changes` → `changes`; the client pushes its own work as `apply_changes` →
`apply_result` (correlated by `requestId`), the server pushes another peer's as
fire-and-forget `push_changes`, and `ping` / `pong` keep the socket alive.

### Message Types

**Client → Server:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake` | Authenticate and establish session | `{ siteId, token?, protocolVersion }` |
| `get_changes` | Request changes since an HLC | `{ sinceHLC? }` (base64) |
| `apply_changes` | Push local changes to server | `{ changes: ChangeSet[], requestId? }` |
| `get_snapshot` | Request full snapshot | (none) |
| `resume_snapshot` | Resume an interrupted snapshot from a saved checkpoint | `{ checkpoint }` (via `serializeSnapshotCheckpoint`) |
| `ping` | Heartbeat / keepalive | (none) |

**Server → Client:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake_ack` | Confirm authentication | `{ serverSiteId, connectionId, protocolVersion }` |
| `changes` | Ordered response to `get_changes` (gap-free; **advances** received watermark) | `{ changeSets: ChangeSet[] }` |
| `push_changes` | Fire-and-forget broadcast from another client (applied, but **never** advances the received watermark) | `{ changeSets: ChangeSet[] }` |
| `apply_result` | Confirm changes applied | `{ requestId?, applied, skipped, conflicts }` |
| `snapshot_chunk` | Streamed snapshot data | `{ chunk: SnapshotChunk }` |
| `snapshot_complete` | Snapshot stream finished | (none) |
| `error` | Error response | `{ code, message }` |
| `pong` | Heartbeat response | (none) |

**Push/ack correlation (`requestId`).** Each `apply_changes` that advances the client's
delta-sync watermark carries a monotonic `requestId` (`apply-1`, `apply-2`, …). The
server keeps no state — it reflects the id back verbatim on the resulting
`apply_result`. The client promotes `lastSentHLC` only for the ack whose `requestId`
matches the batch that produced it, and only ever forward, which makes a stale,
duplicate, or out-of-order ack (e.g. redelivered across a reconnect) inert rather than
crediting the wrong batch. Pushes with no watermark to promote (a peer-relay
`apply_changes`) omit the id; the server then echoes none and the client leaves its
watermark untouched.

### Protocol version

`handshake` and `handshake_ack` both carry `protocolVersion` — the integer
`PROTOCOL_VERSION` exported from `@quereus/sync` (`sync/wire.ts`), the single wire
definition client and coordinator share. The check is **strict integer equality**, at
connect time:

- The coordinator reads the client's `protocolVersion` **before authenticating**. If it
  is absent or `!== PROTOCOL_VERSION`, it replies
  `{ type: "error", code: "PROTOCOL_VERSION_MISMATCH", fatal: true }` and closes the
  socket (code `4003`) without touching the store.
- The coordinator echoes its own `protocolVersion` in `handshake_ack`. The client checks
  it in `handleHandshakeAck`; on mismatch (or absence — an old coordinator) it sets a
  lasting `error` status and stops reconnecting, the same fatal path a `fatal: true`
  server error takes.

A peer predating versioning sends no `protocolVersion`; that is a mismatch, not silently
accepted — silent drift is what this guards against. Because all sync packages are
lockstep-versioned in this monorepo, `PROTOCOL_VERSION` is bumped on any breaking change
to a message shape or the codec, with no min/max range negotiation; `PROTOCOL_VERSION`'s
doc comment in `wire.ts` describes the range-negotiation upgrade path should
mixed-version rolling upgrades ever be required.

### Connection Lifecycle

The client state machine:

- **DISCONNECTED** → `connectSync(url, token)` → **CONNECTING**
- **CONNECTING** → `onopen`, send handshake → **SYNCING**
- **SYNCING** → `handshake_ack` → `get_changes`; changes received → `applyChanges()` → **SYNCED**
- **SYNCED** stays put across `apply_result` / applied `push_changes`, and re-enters itself on a local change → `apply_changes`
- Any of CONNECTING / SYNCING / SYNCED, on a WebSocket error or unintentional close → **RECONNECTING** → exponential backoff (1s, 2s, 4s … 60s) → DISCONNECTED and retry

### Delta Sync Optimization

To minimize data transfer, clients track sync progress with the server. Every
watermark is a **`ChangeSet.hlc`** — a transaction commit boundary (the max over
`changeSets[].hlc`, via the shared `maxHLC` helper), never a per-change max or a
batch-slice boundary — so advancing it can only land *between* whole transactions
([sync.md § Transaction-Based Change Grouping → Read side](sync.md#read-side-one-changeset-per-transaction)):

1. **Receiving changes**: Only the ordered `changes` reply (contiguous, gap-free) advances `peerSyncState[serverSiteId]` (the *received* watermark) to the max `ChangeSet.hlc` received. A `push_changes` **broadcast** is applied idempotently but must **not** advance it — broadcast delivery is fire-and-forget, so a dropped broadcast is invisible to the coordinator; leaving the watermark below it means the next `get_changes sinceHLC=<watermark>` redelivers (and harmlessly re-applies) it, closing the change-loss hole
2. **Sending changes**: The client tracks `lastSentHLC` (confirmed) and `pendingSentHLC` (awaiting ack), both `ChangeSet.hlc` values, persisting `lastSentHLC` per peer on each confirmed ack via `updatePeerSentState` (the *sent* watermark, `pt:` prefix — kept separate from the received `ps:` watermark)
3. **Reconnection / restart**: On reconnect the client sends `get_changes` with `sinceHLC` from the received watermark, and re-seeds `lastSentHLC` from the persisted sent watermark (`getPeerSentState`), so a fresh process resumes delta-push from the last confirmed HLC instead of replaying its entire local history. A manual `disconnect()` clears only the in-memory copy; the persisted watermark is intentionally retained
4. **Server tracking**: The server uses the client's `sinceHLC` to return only new transactions — whole ChangeSets after that boundary, bounded by `batchSize` at transaction granularity

The push loop, end to end: a local change triggers the debounced send (50 ms window);
the client calls `getChangesSince(serverSiteId, lastSentHLC)` for per-transaction
ChangeSets, sends `apply_changes { requestId: apply-N, changes }`, and records
`pendingSentHLCs[requestId] = max ChangeSet.hlc of sent txns`; the server replies
`apply_result { requestId, ... }` with the id echoed verbatim; on a matching id the
client sets `lastSentHLC` to that HLC (forward-only) and persists it per peer.

### Reconnection with Exponential Backoff

When the WebSocket connection drops unexpectedly, the client schedules a reconnect with
`delay = min(1s × 2^attempt, 60s)`, reusing the original connection's URL and token, and
resets the attempt counter to 0 on success. A manual `disconnectSync()` sets
`intentionalDisconnect = true`, preventing auto-reconnect.

### Server Errors: Fatal vs Transient

A server `error` message does **not** by itself stop the client. Reconnect is gated by two
independent flags: `intentionalDisconnect` (set **only** when the client calls
`disconnect()`) and `stopReconnect` (set only by a fatal server error). The coordinator
tags each `error` with a `fatal` boolean:

- **Fatal** (`fatal: true`) — the session is unrecoverable and the coordinator typically
  also closes the socket: `AUTH_FAILED`, `MISSING_DATABASE_ID`, `ALREADY_AUTHENTICATED`.
  The client sets `status: 'error'`, settles any pending `connect()`, and sets
  `stopReconnect` so auto-reconnect halts (a bare retry would just fail again).
- **Transient** (`fatal` absent or false) — one request failed but the session is fine:
  `APPLY_CHANGES_ERROR`, `GET_CHANGES_ERROR`, `SNAPSHOT_ERROR`, `NOT_AUTHENTICATED`,
  `UNKNOWN_MESSAGE`, `MESSAGE_ERROR`. The client surfaces it (`error` sync event +
  `onError`) but keeps the connection **and its auto-reconnect** intact and does not enter
  a lasting `error` status.

For coordinators predating the `fatal` flag, the client falls back to a built-in
known-fatal set (the three codes above); every other code is treated as transient.

### Local Change Debouncing

Rapid local changes are batched to reduce network overhead: each local change event
starts or resets a 50 ms debounce timer, and when it fires the client collects every
change since `lastSentHLC` and sends them in one `apply_changes` message — N messages
per edit become 1 per burst.

### Client snapshot bootstrap

A brand-new device cannot catch up incrementally — "changes since nothing" is not the
database. `SyncClient` downloads a full copy instead, on two triggers, both decided at
handshake and finished *before* the incremental path (`get_changes`, local-change
subscription, push) starts:

- `requestSnapshot()`, explicit. Idempotent while a transfer is in flight: a second call
  joins it, and exactly one `get_snapshot` goes on the wire.
- An empty replica on first connect (`bootstrapOnEmpty`, default `true`). "Empty"
  requires **both** no peer sync state for this server and no local change facts of our
  own — the first alone also matches a device holding real local data that merely never
  met this server, and bootstrapping that clears its sync metadata while leaving its
  rows (divergence). A locally pre-created schema still counts as empty; replicated DDL
  applies idempotently.

Chunks stream through a push-to-pull adapter (`SnapshotStreamReader`) into
`applySnapshotStream`. On success the client records the header's HLC as the received
watermark, so the follow-up `get_changes` starts *after* the snapshot point. Progress
reaches callers three ways: `onSnapshotProgress` (every tick), the `bootstrapping`
status, and a sync event throttled to table boundaries.

**Do not write locally while a snapshot lands.** The apply clears sync metadata and
rewrites cell records unconditionally, so a concurrent write is silently overwritten and
never pushed; the client cannot block application writes (engine-level barrier:
`backlog/feat-sync-bootstrap-write-gate`). It holds what it does control — local pushes
and the peer-relay `request_changes` wait — and *drops* incoming `changes` /
`push_changes` rather than interleaving them with the rewrite. Nothing is lost: the
watermark stays put, so the post-bootstrap catch-up re-fetches them.

An interrupted apply leaves a checkpoint (`sc:` record) marking the data partial.
`hasPendingSnapshot()` reports one before connecting (e.g. at app startup), and the next
handshake sends `resume_snapshot` with it — newest by `createdAt`, superseded ones
cleared. There is **no dedicated retry machinery**: a failed or stalled transfer (no
chunk within `snapshotChunkTimeoutMs`, default 60 s) closes the socket, and the existing
reconnect backoff paces the retry. A resumed stream's header carries the *original*
snapshot's HLC while its data is read live, so the final watermark is deliberately
conservative — the catch-up re-fetches a little, which is idempotent.
