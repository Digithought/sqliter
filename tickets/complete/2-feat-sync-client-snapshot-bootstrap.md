description: A brand-new device using the sync client can now download a full copy of the database, show progress while it lands, and resume an interrupted download after a disconnect or restart. Reviewed; two ways the client could get permanently stuck were found and fixed.
files:
  - packages/quereus-sync-client/src/snapshot-reader.ts         # push-to-pull chunk queue (SnapshotStreamReader)
  - packages/quereus-sync-client/src/sync-client.ts             # bootstrap triggers, transfer runner, watchdog, gating, public API
  - packages/quereus-sync-client/src/types.ts                   # 'bootstrapping' status; bootstrapOnEmpty / snapshotChunkTimeoutMs / onSnapshotProgress
  - packages/quereus-sync-client/src/index.ts                   # re-exports SnapshotStreamReader
  - packages/quereus-sync-client/test/snapshot-reader.spec.ts   # reader unit spec (10 tests)
  - packages/quereus-sync-client/test/sync-client.spec.ts       # bootstrap suite (20 tests) + harness
  - packages/quereus-sync-client/README.md                      # options, methods, states, protocol table
  - packages/quoomb-web/src/worker/types.ts                     # SyncStatus union widened
  - packages/quoomb-web/src/components/SyncStatusIndicator.tsx  # bootstrapping display case
  - docs/sync.md                                                # "Client snapshot bootstrap" section + message-table rows
----

## What shipped

The client half of snapshot sync:

- **`SnapshotStreamReader`** adapts push-style `snapshot_chunk` socket callbacks into the
  `AsyncIterable<SnapshotChunk>` that `applySnapshotStream` consumes. `push()` is
  synchronous (order preservation), deserialization is lazy, consumption uses a head
  index with compaction, and the iterator drains the queue before honoring
  `complete()`/`abort()`.
- **Two bootstrap triggers**, decided at handshake before the incremental path: a pending
  checkpoint (resume — newest by `createdAt`, superseded ones cleared) or an empty
  replica with `bootstrapOnEmpty` (default true). "Empty" = no peer sync state for this
  server AND no local change facts; either alone is insufficient (divergence guard).
- **`runSnapshotTransfer`/`executeSnapshotTransfer`** send `get_snapshot`/`resume_snapshot`,
  stream through the reader into `applySnapshotStream`, and on success write the header
  HLC via `updatePeerSyncState` so the follow-up `get_changes` starts after the snapshot
  point. The internal transfer promise resolves to `Error | null` and never rejects.
- **Failure = close the socket, handlers attached**: `onclose` fires, status →
  disconnected, `scheduleReconnect` runs, and the next handshake finds the checkpoint and
  resumes. No new retry machinery. A fatal server error keeps the existing stop-reconnect
  behavior.
- **Stall watchdog** (`snapshotChunkTimeoutMs`, default 60 s), reset per chunk.
- **Gating while bootstrapping**: incoming `changes`/`push_changes` dropped with an info
  event (watermark untouched), `request_changes` relay and `pushLocalChanges`
  early-return. The local-change subscription starts only after bootstrap completes on
  the handshake path.
- **Public surface**: `requestSnapshot()`, `isBootstrapping`, `hasPendingSnapshot()`,
  `bootstrapping` status variant, `onSnapshotProgress`.

## Validation at completion

| Command | Result |
|---|---|
| `yarn build` | green |
| `yarn typecheck` | green |
| `yarn lint` | green |
| `yarn test` | green — 0 failing; quereus logic 8612, sync-client 85, sync-coordinator 134, rest as usual |
| `yarn docs:check` | **red, pre-existing** — see `backlog/debt-docs-size-ratchet-red-again` |

Focused run:

```
node --import ./packages/quereus-sync-client/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus-sync-client/test/**/*.spec.ts" --reporter min
```

## Review findings

### Defects found and fixed in this pass

- **The client could wedge permanently in `bootstrapping`** (`sync-client.ts`,
  `runSnapshotTransfer`). The transfer body cleared `snapshotTransferPromise` in its own
  `finally`; when the body settled *synchronously* — which it does whenever `send()`
  fails because the socket closed while `maybeBootstrap` was still probing the local
  store — that `finally` ran **before** the outer `this.snapshotTransferPromise =
  transfer()` assignment, leaving the field pointing at a settled promise nothing would
  ever clear. `isBootstrapping` then stayed true for the life of the client: every local
  push gated, every incoming change set dropped, and every later handshake joining the
  dead transfer, reading its stale error, and abandoning the handshake. Only a process
  restart recovered. Fixed by hanging cleanup off the returned promise's `.finally()`,
  which is guaranteed to run a microtask *after* the assignment; the body moved to
  `executeSnapshotTransfer`. Regression test `does not wedge isBootstrapping when the
  snapshot request cannot be sent`, verified failing against the original structure
  (`expected true to be false`).
- **A reconnect landing mid-unwind killed the fresh socket and stalled the handshake**
  (same file). The failure path closed `this.ws`, which by then can be the *new* socket a
  reconnect installed while the aborted apply was still unwinding; meanwhile the new
  handshake's `maybeBootstrap` joined the stale transfer promise, took its error as its
  own, and returned without sending anything or scheduling a retry. Fixed on both sides:
  the transfer captures and closes the socket it started on, and `maybeBootstrap` awaits
  a still-settling transfer before deciding. Regression test `resumes on the new socket
  when the dropped transfer is still unwinding`, verified failing before the fix
  (`expected [ 'handshake' ] to include 'resume_snapshot'`).
- **`WebSocket.OPEN` in the failure path could throw** `ReferenceError` when the global is
  gone by the time a transfer unwinds — observed as noise in the existing suite's
  teardown, and it breaks the documented "never rejects" contract by rejecting the
  transfer promise. Now reads `socket.OPEN` off the instance (spec-guaranteed).
- **`onError` fired for the client's own `disconnect()`.** A caller treating `onError` as
  "needs attention" got a `Snapshot transfer failed: Disconnected` for a teardown it
  requested. Suppressed when `intentionalDisconnect` is set; genuine failures still
  surface. (This was one of the implementer's own listed judgement calls.)
- **`docs/sync.md`**: the new "Client snapshot bootstrap" section was tightened ~25%
  (466 → ~350 words) without dropping any fact — restatement between its four paragraphs.
- **Mojibake in `sync-client.spec.ts:385`** (`Ã¢â‚¬â€` where an em dash belongs). Pre-existing,
  in a file this ticket rewrote; fixed.

### Tripwires recorded (not tickets)

- `sync-client.ts` `maybeBootstrap` — checkpoints carry no server identity (the apply
  stamps the *receiver's* site id), so a replica syncing one database to two coordinators
  would resume server A's checkpoint against server B and silently skip the tables A had
  finished. One coordinator per database today.
- `sync-client.ts` `executeSnapshotTransfer` — the apply returns only when the stream
  ends, and only `snapshot_complete` ends it, so a socket drop between the footer and
  that message fails a transfer whose data already landed and whose checkpoint the footer
  already cleared; the next connect re-bootstraps from scratch. Correct, just wasteful.
- `sync-client.ts` snapshot section header — the file measures 1,170 lines
  (`wc -l packages/quereus-sync-client/src/sync-client.ts`); the note names the
  extraction seam and the five members a `SnapshotBootstrap` collaborator would need.
- The implementer's three existing tripwires were re-read and are accurate: the unbounded
  reader queue, the `isReplicaEmpty` probe materializing local change sets, and the
  deliberately conservative resumed-transfer watermark.

### Ticket filed

- `backlog/debt-docs-size-ratchet-red-again` — `yarn docs:check` is red at HEAD because
  `docs/sync.md` and `docs/schema.md` exceed their recorded word budgets. Pre-existing
  (measured on the parent commit: sync.md 13,158 words vs. a 12,538 budget), *not* caused
  by this ticket, and no longer covered by `tickets/.pre-existing-known.md` — the ticket
  that entry names has since completed. The registry entry was repointed at the new slug.

### Checked and clean

- **`SnapshotStreamReader`**: order preservation, drain-then-abort, drain-then-complete,
  post-settle push drops, single-consumer guard, head-index compaction, `headerHLC`
  capture. Code re-read against its 10-test spec; no defect found.
- **Gating and watermarks**: the drop path for `changes`/`push_changes` correctly leaves
  the received watermark untouched, so the post-bootstrap `get_changes` re-fetches; the
  relay and push paths early-return; the header HLC is the right watermark on both a
  fresh and a resumed transfer (`resumeSnapshotStream` in
  `packages/quereus-sync/src/sync/snapshot-stream.ts` re-emits a header carrying the
  original snapshot's HLC, so `reader.headerHLC` is never undefined on resume).
- **Checkpoint wire round-trip**: `serializeSnapshotCheckpoint` at the client matches what
  `websocket.ts` decodes; covered by both sides' specs.
- **quoomb-web**: the widened union is required by exactly one site — the worker's
  `status as SyncStatus` cast (`quereus.worker.ts:888`). `convertSyncState` maps the
  engine's `SyncState`, not the client status, so it needs no `bootstrapping` case; the
  status indicator is the only renderer that switches on the union.
- **Docs**: `packages/quereus-sync-client/README.md` and `docs/sync.md` were read line by
  line against the code — option defaults, method list, status list and both protocol
  tables match what ships.

### Known gap left open (deliberately, no ticket)

There is still no end-to-end client ↔ coordinator ↔ real-engine snapshot test; the
client suite drives a hand-rolled `MockSyncManager.applySnapshotStream` that mirrors the
real checkpoint lifecycle (saved at header, cleared at footer, left behind on interrupt).
If the real apply's checkpoint timing ever changes, the client tests would not notice.
Building that harness is a larger piece of work than a review pass, the coordinator has
its own websocket specs over the same protocol, and the risk is drift rather than a known
defect — so it is recorded here rather than filed. The mock's doc comment states what it
mirrors, which is where a future change would have to be kept in step.

## Owned elsewhere

- Server-initiated bootstrap: `backlog/bug-sync-delta-served-past-retention-horizon`.
- Engine-level write barrier during a snapshot: `backlog/feat-sync-bootstrap-write-gate`.
- Sender-side backpressure (and the client queue's arm):
  `backlog/debt-sync-socket-backpressure`.
