description: The sync server writes messages to a client's socket as fast as it can generate them without checking whether the client is keeping up, so a slow client can make the server buffer an unbounded amount of data in memory.
files:
  - packages/sync-coordinator/src/server/websocket.ts   # sendMessage / snapshot + change broadcast loops
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/quereus-sync-client/src/snapshot-reader.ts # receiving half — unbounded chunk queue (added by feat-sync-client-snapshot-bootstrap)
tradeoffs: Requires an adversarial or very slow client to matter, and the ticket still has to decide the policy for a client that never drains: unbounded wait versus closing the session.
----

## Problem

The coordinator's socket writes (e.g. the `snapshot_chunk` streaming loops in
`handleGetSnapshot`/`handleResumeSnapshot`, and change broadcasts) call `socket.send(...)`
without respecting the socket's drain/backpressure signal. A slow or stalled consumer causes
the server-side send buffer to grow without bound — a memory-exhaustion risk driven by a
single slow client.

Surfaced by the same review as the shared-protocol work.

## Direction / open questions (for the fix pass)

- Introduce backpressure on the streaming send paths: await the socket's drain (or check
  `bufferedAmount` / the `ws` write callback) before yielding the next chunk, so the producer
  paces to the consumer.
- Decide a policy for a client that never drains: a buffered-bytes ceiling after which the
  session is closed, vs. unbounded wait.
- Applies most acutely to snapshot streaming (many large chunks); confirm the change broadcast
  path needs the same treatment.

Hardening under adverse client behavior; backlog rather than an active bug.

## Second arm — the receiving side has the same shape

Added while planning `feat-sync-client-snapshot-bootstrap`, which builds the client half of
snapshot download. The sync client turns incoming `snapshot_chunk` messages into a queue that
`applySnapshotStream` drains at its own pace (`SnapshotStreamReader` in
`packages/quereus-sync-client/src/snapshot-reader.ts`). Nothing paces the sender, so a client
whose disk writes are slower than the server's sends holds the not-yet-applied remainder of
the snapshot in memory. It ships with a high-water-mark warning and no flow control.

This is the mirror image of the server arm and the same fix resolves both: whatever pacing
signal the streaming send path grows, the client is where the "I am behind" signal has to come
from. Design the two together rather than separately.
