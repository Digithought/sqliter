description: A brand-new device using the sync client can now download a full copy of the database, show progress while it lands, and resume an interrupted download after a disconnect or restart. Review the client wiring, the concurrency-sensitive chunk path, and the tests.
files:
  - packages/quereus-sync-client/src/snapshot-reader.ts         # NEW — push-to-pull chunk queue (SnapshotStreamReader)
  - packages/quereus-sync-client/src/sync-client.ts             # bootstrap triggers, transfer runner, watchdog, gating, public API
  - packages/quereus-sync-client/src/types.ts                   # 'bootstrapping' status; bootstrapOnEmpty / snapshotChunkTimeoutMs / onSnapshotProgress options
  - packages/quereus-sync-client/src/index.ts                   # re-exports SnapshotStreamReader
  - packages/quereus-sync-client/test/snapshot-reader.spec.ts   # NEW — reader unit spec (10 tests)
  - packages/quereus-sync-client/test/sync-client.spec.ts       # harness upgrade + 18-test bootstrap suite
  - packages/quereus-sync-client/README.md                      # options, methods, states, protocol table
  - packages/quoomb-web/src/worker/types.ts                     # SyncStatus union widened (the worker casts the client status into it)
  - packages/quoomb-web/src/components/SyncStatusIndicator.tsx  # bootstrapping display case
  - docs/sync.md                                                # "Client snapshot bootstrap" section + message-table rows
----

## What was built

The client half of snapshot sync, per the settled design in the implement ticket
(all four open questions were pre-decided there; none were re-opened):

- **`SnapshotStreamReader`** (new file): adapts push-style `snapshot_chunk`
  socket callbacks into the `AsyncIterable<SnapshotChunk>` that
  `applySnapshotStream` consumes. `push()` is synchronous (order preservation),
  deserialization is lazy (inside `chunks()`), consumption uses a head index
  with compaction (no quadratic `shift()`), and the iterator drains the queue
  before honoring `complete()`/`abort()`. Records `headerHLC` when the header
  chunk passes through.
- **Two bootstrap triggers**, decided at handshake before the incremental path:
  a pending checkpoint (resume — newest by `createdAt`, superseded ones
  cleared) or an empty replica with `bootstrapOnEmpty` (default true).
  "Empty" = no peer sync state for this server AND no local change facts;
  either alone is insufficient (divergence guard).
- **`runSnapshotTransfer`**: sends `get_snapshot`/`resume_snapshot`, streams
  through the reader into `applySnapshotStream`, and on success writes the
  header HLC via `updatePeerSyncState` so the follow-up `get_changes` starts
  after the snapshot point. The internal transfer promise resolves to
  `Error | null` and **never rejects** — the automatic path nobody awaits
  cannot produce an unhandled rejection.
- **Failure = close the socket, handlers attached**: `onclose` fires, status →
  disconnected, `scheduleReconnect` runs, and the next handshake finds the
  checkpoint and resumes. No new retry machinery, no lingering `error` status,
  no `stopReconnect`. A fatal server error additionally keeps the existing
  stop-reconnect behavior.
- **Stall watchdog** (`snapshotChunkTimeoutMs`, default 60 s): reset per chunk,
  cleared on complete/settle; firing aborts the reader, which lands in the
  failure path above.
- **Gating while bootstrapping**: incoming `changes`/`push_changes` are dropped
  with an info event (watermark untouched — the post-bootstrap catch-up
  re-fetches them), `request_changes` relay and `pushLocalChanges` early-return.
  The local-change subscription only starts after bootstrap completes on the
  handshake path.
- **Public surface**: `requestSnapshot()` (idempotent while in flight; rejects
  when not connected or on transfer failure), `isBootstrapping`,
  `hasPendingSnapshot()` (usable before connecting), `bootstrapping` status
  variant, `onSnapshotProgress` callback, sync events throttled to table
  boundaries.

## How to validate

`yarn build && yarn test` — both green at handoff (sync-client: 83 mocha tests;
full workspace suite passes, quereus logic 8612).

Focused run:

```
node --import ./packages/quereus-sync-client/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus-sync-client/test/**/*.spec.ts" --reporter min
```

Every bullet in the implement ticket's *Edge cases & interactions* list has a
test: happy path (asserts message ORDER and the `sinceHLC` on the follow-up
`get_changes`), divergence guard, prior-peer-state, `bootstrapOnEmpty: false` +
explicit request, interrupted-transfer resume across a real reconnect
(round-trips the checkpoint through the wire codec), several checkpoints,
late/orphan chunk and complete, double `requestSnapshot`, `SNAPSHOT_ERROR` vs
fatal error, stall, mid-transfer `disconnect()`, readOnly, mid-transfer
`changes`/`push_changes` drop, engine-gate rejection (no checkpoint left, no
spin), interleaved-message chunk ordering, and progress reporting.

## Known gaps and judgment calls (reviewer: treat tests as a floor)

- **The mock is a mirror, not the engine.** `MockSyncManager.applySnapshotStream`
  now really drains the iterable and mirrors the real checkpoint lifecycle
  (saved at header, cleared at footer, left behind on an interrupt) — but it is
  a hand-rolled mirror. There is no end-to-end client ↔ coordinator ↔ real
  engine snapshot test; the coordinator side has its own websocket specs. If
  the real `applySnapshotStream` ever diverges (e.g. checkpoint timing), client
  tests would not notice.
- **The chunk-path ordering invariant is comment-guarded.** The `snapshot_chunk`
  case in `handleMessage` must reach `reader.push()` with no intervening
  `await`; a later edit adding one reintroduces reordering. The interleaving
  test would likely catch a gross break but cannot catch every schedule.
- **`requestSnapshot()` mid-session keeps the local-change subscription
  attached** (only the handshake path defers subscription). Pushes are gated by
  `isBootstrapping`, so nothing is sent, but a change event during the transfer
  increments the pending counter and the post-transfer debounce is only armed by
  the NEXT local change. Under the documented "no writes during snapshot"
  contract this is moot; noted in case the reviewer disagrees.
- **`onError` fires for auto-resumable failures too** (e.g. a mid-stream socket
  drop that the reconnect will resume). Consistent with existing error
  surfacing, but a caller treating `onError` as "needs attention" sees noise.
- **Status after a successful bootstrap** is set to `{ syncing, progress: 0 }`;
  `synced` arrives with the catch-up `changes` reply, matching the existing
  lifecycle.
- **quoomb-web touch-up** was outside the ticket's files list: the worker casts
  the client's status into its own `SyncStatus` union (`status as SyncStatus`),
  which would have silently lied once the new variant appeared — union widened
  and an indicator display case added. No functional quoomb-web bootstrap UI
  beyond the status line.

## Tripwires placed (index for the review findings)

- `snapshot-reader.ts` (top of file): unbounded chunk queue — no client-side
  flow control; warns once past 5 000 queued chunks. Client arm already
  recorded on `backlog/debt-sync-socket-backpressure`.
- `sync-client.ts` `isReplicaEmpty`: the `getChangesSince` probe arm
  materializes every local change set; fine because it only runs when no peer
  sync state exists (in practice once, on an empty device).
- `sync-client.ts` post-apply `updatePeerSyncState`: resumed-transfer watermark
  is deliberately conservative (header HLC older than live-read data);
  re-fetching is idempotent — comment warns against "fixing" it.

## Deliberately out of scope (already owned elsewhere)

- Server-initiated bootstrap ("your starting point is too old"):
  `backlog/bug-sync-delta-served-past-retention-horizon`, which names this
  ticket as its prerequisite and now has `requestSnapshot()` to call.
- Engine-level write barrier during a snapshot:
  `backlog/feat-sync-bootstrap-write-gate`.
- Sender-side backpressure: `backlog/debt-sync-socket-backpressure`.
