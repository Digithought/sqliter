description: A brand-new device using the sync client has no way to download an existing database — the client can only fetch incremental changes, so it can never catch up from empty. Teach it to download a full copy, show progress, and resume an interrupted download.
prereq: feat-sync-snapshot-checkpoint-discovery
files:
  - packages/quereus-sync-client/src/sync-client.ts            # only sends handshake / get_changes / apply_changes today
  - packages/quereus-sync-client/src/snapshot-reader.ts         # NEW — push-to-pull chunk queue
  - packages/quereus-sync-client/src/types.ts                   # SyncStatus, SyncClientOptions
  - packages/quereus-sync-client/src/index.ts                   # re-exports
  - packages/quereus-sync-client/test/sync-client.spec.ts       # MockWebSocket / MockSyncManager harness
  - packages/quereus-sync/src/sync/wire.ts                      # get_snapshot, resume_snapshot, snapshot_chunk, snapshot_complete shapes (already defined)
  - packages/sync-coordinator/src/server/websocket.ts           # server side already answers both requests
  - docs/sync.md                                                # client-facing sync docs
difficulty: hard
----

## Problem

`SyncClient` speaks only the incremental half of the sync protocol: it
handshakes, asks for changes after a stored point in time, and pushes local
changes back. It never asks for a full copy of the database.

That is fine for a device that already has the data. It is not fine for a new
one: an empty client asking for "changes since nothing" is not the same as
receiving the database, and there is no code path that gets it there.

Both ends of the missing middle already exist. The coordinator answers
`get_snapshot` by streaming the whole database as `snapshot_chunk` messages
followed by `snapshot_complete`, and answers `resume_snapshot` the same way
starting from a saved position. The engine's `applySnapshotStream` consumes such
a stream and writes it locally. Only the client wiring between them is missing.

## Decisions taken in the design pass

The plan ticket left four questions open. All four are settled here; the
implementer should not re-open them.

**1. When does the client ask for a snapshot?** Two triggers, no third.

- *Explicit*: a new public `requestSnapshot()` method. This is the entry point a
  later ticket (`bug-sync-delta-served-past-retention-horizon`) will call once
  the server can say "your starting point is too old".
- *Automatic on a first connect to an empty replica*, controlled by a new
  `bootstrapOnEmpty` option (default `true`).

The third option from the plan ticket — the **server** telling the client its
requested starting point is too old to serve incrementally — is deliberately
**not** in scope. It needs a coordinator change and a new wire message, and it
is already owned end-to-end by `bug-sync-delta-served-past-retention-horizon`,
which names this ticket as its prerequisite. Build the client so that ticket has
a method to call.

**2. What counts as "empty"?** Both of these must hold, checked against the
server's site id learned at handshake:

- `getPeerSyncState(serverSiteId)` is `undefined` — never synced with this
  server; and
- `getChangesSince(serverSiteId)` (no watermark) returns `[]` — no local change
  facts of our own.

Rationale: the first alone would also be true of a device that holds real local
data and is merely meeting this server for the first time — bootstrapping that
device would clear its sync metadata while leaving its rows in place, which is
divergence. The second alone would be true of a device whose entire contents
came from this server. Requiring both admits only the genuinely new device.

A device that pre-created its schema locally before connecting still counts as
empty: schema migration records (`sm:`) are not consulted, and replicated DDL is
applied idempotently (`decideSchemaChange` in
`packages/quereus-sync/src/sync/store-adapter.ts` returns `already-applied` for
a table that already exists with a matching definition, and throws loudly on a
same-name/different-shape collision). This is the common app-startup shape and
must keep working.

NOTE this tripwire at the probe site: the `getChangesSince` arm materializes
every local change set when it runs. It runs only when no peer sync state
exists — in practice once, on a device with nothing to materialize. If some
future caller runs the probe on a populated replica, replace it with a cheap
existence scan over the `cv:` prefix.

**3. What happens to local writes landing during a snapshot?** They are not
preserved, and the client does not pretend otherwise.

`applySnapshotStream` clears sync metadata at the header and then writes cell
records unconditionally — no last-writer-wins comparison against whatever the
application wrote in the meantime. So a concurrent local write is silently
overwritten by the snapshot and never pushed. The client cannot block
application writes; what it *can* do, and must:

- refuse to push local changes while a transfer is active, and not subscribe to
  local-change events until it finishes;
- expose the in-progress state (see 3 below) so callers can hold writes;
- document the contract on `requestSnapshot()` and on the `bootstrapping` status:
  **do not write to the database while a snapshot is landing.**

A real engine-level write barrier is out of scope — parked as
`backlog/feat-sync-bootstrap-write-gate`.

**4. How is a partially-applied database surfaced?** Two ways, one live and one
durable:

- Live: a new `SyncStatus` variant `{ status: 'bootstrapping', … }` plus an
  `isBootstrapping` getter.
- Durable across process restart: a pending checkpoint. The prerequisite ticket
  guarantees a checkpoint exists for the whole duration of an apply, so
  "`listSnapshotCheckpoints()` is non-empty" is an accurate "this database is
  partial". Expose it as `hasPendingSnapshot(): Promise<boolean>` so a caller
  can check before reading, at startup, before ever connecting.

**5. Retry policy.** No new retry machinery. A failed or stalled transfer
**closes the socket**; the existing `onclose → scheduleReconnect` path takes it
from there, and the next `handshake_ack` finds the pending checkpoint and sends
`resume_snapshot`. Do not detach the socket handlers before closing — `onclose`
firing is the mechanism.

## Design

### A push-to-pull chunk reader (new file)

`applySnapshotStream` wants an `AsyncIterable<SnapshotChunk>`; the WebSocket
delivers `snapshot_chunk` messages as callbacks. Put the adapter in its own file,
`packages/quereus-sync-client/src/snapshot-reader.ts`, rather than growing
`sync-client.ts` (already ~770 lines) — it is independently testable.

```ts
export class SnapshotStreamReader {
  /** Enqueue one chunk. MUST be safe to call from the socket callback with no await. */
  push(chunk: SerializedSnapshotChunk): void;
  /** No more chunks: the iterator ends after draining the queue. */
  complete(): void;
  /** Fail the transfer: the iterator throws `error` after draining what it has. */
  abort(error: Error): void;
  /** The header chunk's HLC, once seen. */
  get headerHLC(): HLC | undefined;
  /** Number of chunks enqueued but not yet consumed. */
  get queueDepth(): number;
  chunks(): AsyncIterable<SnapshotChunk>;
}
```

Load-bearing details:

- **`push` must be synchronous.** `SyncClient.handleMessage` is `async` and is
  invoked from `ws.onmessage` without serialization — two messages can be
  in-flight through it at once, and anything after an `await` may interleave.
  The `snapshot_chunk` case must therefore reach `push` with no intervening
  `await`, which is what preserves chunk order. Say so in a comment; the whole
  transfer's correctness rests on it.
- **Deserialize lazily**, inside `chunks()`, not inside `push`. Keeps the socket
  callback cheap; the queue holds `SerializedSnapshotChunk`. Record `headerHLC`
  when the deserialized `header` chunk passes through.
- **Consume with a head index, not `Array.prototype.shift()`** — a snapshot can
  queue thousands of chunks and repeated `shift` is quadratic. Compact or reset
  the backing array when the head catches up.
- The iterator drains the queue first, then checks `abort`, then `complete`,
  then parks on a promise the next `push`/`complete`/`abort` resolves. Re-check
  abort after every wake.

NOTE this tripwire on the queue: nothing paces the sender, so a client slower
than the server buffers the whole snapshot in `queueDepth`. Mirror of the
server-side concern already filed as `backlog/debt-sync-socket-backpressure`
(an arm has been added there for this side). Log a warning above a high-water
mark; do not build flow control here.

### SyncClient changes

New state: the active `SnapshotStreamReader`, the in-flight transfer promise, and
a stall-watchdog timer.

**Message handling** — two new cases in `handleMessage`:

- `snapshot_chunk` → push to the active reader. With no active transfer, warn
  and drop; a late chunk from an aborted stream must never leak into the next one.
- `snapshot_complete` → `complete()` the active reader (no-op when none).

**Triggering** — restructure `handleHandshakeAck` so bootstrap is decided and
finished *before* the incremental path starts:

```
settleConnect()
await maybeBootstrap()          // resume | fresh snapshot | nothing
await requestChangesFromServer()
await seedSentWatermark()
if (!readOnly) { subscribeToLocalChanges(); await pushLocalChanges(); }
```

`maybeBootstrap()`:

- `const pending = await syncManager.listSnapshotCheckpoints()`
- If non-empty: take the newest by `createdAt`, `clearSnapshotCheckpoint` the
  rest (they are unreachable — the client tracks one transfer — and would
  otherwise accumulate), and run a transfer with
  `{ type: 'resume_snapshot', checkpoint: serializeSnapshotCheckpoint(newest) }`.
- Else if `bootstrapOnEmpty !== false` and the emptiness probe passes: run a
  transfer with `{ type: 'get_snapshot' }`.
- Else: nothing.

`runSnapshotTransfer(msg)`:

- If a transfer is already in flight, return its promise (idempotent; a second
  `requestSnapshot()` does not start a second stream).
- Create the reader, set status `bootstrapping`, send `msg`. A `send` returning
  `false` means the socket died — abandon without starting the apply and let
  reconnect retry.
- Start the stall watchdog; reset it on every chunk; clear it on
  complete/abort/finish.
- `await syncManager.applySnapshotStream(reader.chunks(), p => …progress…)`.
- On success: if `reader.headerHLC` and `serverSiteId` are known, call
  `updatePeerSyncState(serverSiteId, reader.headerHLC)` so the follow-up
  `get_changes` asks for changes *after* the snapshot point instead of replaying
  from nothing. (`applySnapshotStream` merges the HLC into the local clock and
  emits `synced`, but writes no peer state — the client owns that.) Then emit a
  completion event and let the caller's flow continue.
- On failure: emit an `error` sync event, call `options.onError`, and close the
  socket **without** detaching handlers, so `onclose` reports `disconnected` and
  schedules the reconnect that will resume. Do **not** set a lingering `error`
  status and do **not** set `stopReconnect` — a snapshot failure is transient by
  construction.

**Watchdog.** A server that stops sending mid-stream without closing the socket
would otherwise hang the bootstrap forever with no reconnect. Add
`snapshotChunkTimeoutMs` (default 60_000): no chunk within the window aborts the
reader with a stall error, which lands in the failure path above. Tests set it
small.

**Aborting.** The reader is aborted from three places: `ws.onclose` (transfer
active), `handleServerError` (code `SNAPSHOT_ERROR`, or any `fatal` error), and
`disconnect()`.

**Gating while a transfer is active** (`isBootstrapping`):

- `changes` and `push_changes` are **dropped**, with an info event. Applying them
  concurrently would interleave `applyChanges` writes with the snapshot's
  clear-and-rewrite of the same `cv:` / `tb:` / `cl:` records. Nothing is lost:
  `push_changes` never advances the watermark anyway, and the `get_changes`
  catch-up that runs immediately after bootstrap re-fetches everything after the
  snapshot HLC.
- `request_changes` is skipped (we do not push during bootstrap).
- `pushLocalChanges` early-returns.

### Public surface

`sync-client.ts`:

- `requestSnapshot(): Promise<void>` — explicit bootstrap. Rejects when not
  connected/handshaken. Returns the in-flight promise if one exists. Document
  the "no local writes during this" contract on it.
- `get isBootstrapping(): boolean`
- `hasPendingSnapshot(): Promise<boolean>` — delegates to
  `listSnapshotCheckpoints()`; usable before connecting.

`types.ts`:

```ts
export type SyncStatus =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'bootstrapping'; tablesProcessed: number; totalTables: number;
      entriesProcessed: number; totalEntries: number; currentTable?: string }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncTime: number }
  | { status: 'error'; message: string };
```

New `SyncClientOptions` fields: `bootstrapOnEmpty?: boolean` (default `true`),
`snapshotChunkTimeoutMs?: number` (default `60_000`),
`onSnapshotProgress?: (progress: SnapshotProgress) => void`.

Progress: forward every `SnapshotProgress` to `onSnapshotProgress` and mirror it
into `setStatus`, but emit a human-readable `SyncEvent` only when
`tablesProcessed` changes — progress fires once per column-versions chunk and
would otherwise flood an event log. "3 of 12 tables" is the shape a caller
should be able to render.

## Edge cases & interactions

- **Fresh empty device, happy path.** Connect → `get_snapshot` sent before any
  `get_changes` → chunks → `snapshot_complete` → apply resolves →
  `updatePeerSyncState(serverSiteId, headerHLC)` → `get_changes` carries that
  HLC as `sinceHLC`. Assert the *order* of sent messages, not just their
  presence.
- **Device with local data, never synced with this server.** Emptiness probe
  fails on the `getChangesSince` arm → no `get_snapshot`, straight to
  `get_changes`. This is the divergence guard; it needs a test.
- **Device with prior peer sync state.** No bootstrap even if it happens to hold
  no local changes of its own.
- **`bootstrapOnEmpty: false`.** Empty device connects, no `get_snapshot`,
  incremental path runs. `requestSnapshot()` still works.
- **Interrupted transfer resumes.** Socket closes mid-stream → reader aborts →
  socket closed → reconnect → `handshake_ack` → checkpoint found →
  `resume_snapshot` carrying the serialized checkpoint. Assert the sent message
  is `resume_snapshot` (not `get_snapshot`) and that its `checkpoint` round-trips
  through `serializeSnapshotCheckpoint`/`deserializeSnapshotCheckpoint`.
- **Resume watermark is conservative.** A resumed stream's header carries the
  *original* snapshot's HLC while the data it serves is read live, so the
  watermark written at the end is older than the data applied. The follow-up
  `get_changes` therefore re-fetches some already-applied changes. That is
  correct (re-application is idempotent) and cheaper than the alternative;
  record it as a comment at the `updatePeerSyncState` call so a future reader
  does not "fix" it.
- **Several pending checkpoints.** Newest by `createdAt` is resumed; the others
  are cleared. Assert both halves.
- **Chunk arrives with no active transfer.** Dropped with a warning; must not
  start a transfer, must not throw, must not be visible to the next one.
- **`snapshot_complete` with no active transfer.** Ignored.
- **Double `requestSnapshot()`.** Second call returns the first promise; exactly
  one `get_snapshot` on the wire.
- **Server sends `error` mid-stream.** `SNAPSHOT_ERROR` aborts the transfer;
  socket closes; reconnect resumes. A *fatal* error aborts the transfer **and**
  keeps the existing `stopReconnect` behaviour — no reconnect, no resume.
- **Stall.** No chunk within `snapshotChunkTimeoutMs` → abort → close → reconnect.
  Test with a small timeout.
- **`disconnect()` mid-transfer.** Reader aborted, watchdog cleared, transfer
  promise settles (rejected is fine — it must not surface as an unhandled
  rejection), no reconnect scheduled.
- **`readOnly: true` client.** Still bootstraps; still never pushes.
- **`push_changes` arriving mid-transfer** is dropped and the watermark is
  untouched, so the post-bootstrap `get_changes` re-delivers it.
- **Snapshot rejected by an engine gate** (wire-format mismatch, clock drift).
  `applySnapshotStream` throws before touching local state and — per the
  prerequisite ticket — leaves no checkpoint. The client must surface the error
  and must not spin: reconnect will find no checkpoint, and the emptiness probe
  will still pass, so it retries the fresh `get_snapshot` on the next connect.
  That retry loop is bounded only by the existing reconnect backoff; confirm the
  backoff is what paces it and note the behaviour rather than adding a counter.
- **Message ordering under concurrent `handleMessage`.** A test that interleaves
  a `snapshot_chunk` with another message type and asserts chunk order survives
  is worth having — it is the invariant most likely to be broken by a later edit
  that adds an `await` before the `push`.

## Tests

All in `packages/quereus-sync-client/test/sync-client.spec.ts` plus a new spec
for `SnapshotStreamReader`. The existing `MockWebSocket` / `MockSyncManager`
harness covers everything needed; the prerequisite ticket gives the mock a real
in-memory checkpoint map. Have `MockSyncManager.applySnapshotStream` actually
drain the iterable (recording the chunks it saw) so ordering and abort-behaviour
assertions are real rather than vacuous.

`SnapshotStreamReader` unit tests worth writing up front:

- push-then-consume preserves order; consume-then-push parks and wakes;
- `complete()` after a partial drain still yields the queued remainder, then ends;
- `abort()` after a partial drain yields the remainder, then throws;
- `headerHLC` is populated once the header chunk is consumed;
- a large push burst is drained in O(n) (guards the `shift()` regression).

## TODO

### Phase 1 — reader

- Add `packages/quereus-sync-client/src/snapshot-reader.ts` with
  `SnapshotStreamReader` as specified; export from `index.ts`.
- Add its unit spec.

### Phase 2 — client wiring

- `types.ts`: `bootstrapping` status variant; `bootstrapOnEmpty`,
  `snapshotChunkTimeoutMs`, `onSnapshotProgress` options.
- `sync-client.ts`: `snapshot_chunk` / `snapshot_complete` message cases
  (synchronous push — comment why); `maybeBootstrap`, `runSnapshotTransfer`,
  emptiness probe, stall watchdog, abort paths (`onclose`, `handleServerError`,
  `disconnect`), post-apply `updatePeerSyncState`.
- Gate `handleChanges`, `handleRequestChanges`, `pushLocalChanges`, and
  local-change subscription on `isBootstrapping`.
- Public `requestSnapshot()`, `isBootstrapping`, `hasPendingSnapshot()`.
- Progress → status + `onSnapshotProgress`; throttle the `SyncEvent` to table
  boundaries.

### Phase 3 — coverage & docs

- Client specs for every bullet under *Edge cases & interactions*.
- `docs/sync.md`: a client-bootstrap section — the two triggers, the "no local
  writes during a snapshot" contract, how a partial database is detected after a
  restart, and how resume rides the existing reconnect path.
- `yarn build && yarn test` green.
