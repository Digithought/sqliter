description: The sync "resume an interrupted snapshot download" message cannot survive being sent over the network — it would crash if a client ever tried to use it. Nothing uses it today, but the broken path needs fixing before that feature is wired up.
prereq:
files:
  - packages/quereus-sync/src/sync/wire.ts                 # ResumeSnapshotMessage.checkpoint (carried as-is today)
  - packages/quereus-sync/src/sync/manager.ts              # SnapshotCheckpoint interface (siteId: Uint8Array, hlc: bigint)
  - packages/sync-coordinator/src/server/websocket.ts      # handleResumeSnapshot receives msg.checkpoint from JSON.parse
difficulty: medium
----

## Problem

The sync protocol has a "resume snapshot" message: when a full-database snapshot
download is interrupted partway, the client can ask the server to continue from a saved
checkpoint instead of restarting from scratch. That message carries the checkpoint.

The checkpoint is **not JSON-safe**, so it cannot actually travel over the wire:

- `SnapshotCheckpoint` (`manager.ts:274`) holds `siteId: SiteId` — a raw `Uint8Array` —
  and `hlc: HLC`, whose `wallTime` is a `bigint`.
- `JSON.stringify` **throws** on a bigint. So the client cannot even serialize the
  message to send it.
- `JSON.parse` on the receiving side would not restore the `Uint8Array` (it becomes a
  plain object) — so even if the bigint were worked around, the server would read a
  corrupt siteId.

`ResumeSnapshotMessage.checkpoint` in the shared wire module is typed `SnapshotCheckpoint`
and carried **as-is** — the codec does nothing to make it transport-safe. This mirrors the
pre-existing coordinator declaration; the shared-module ticket faithfully copied the broken
shape rather than inventing a fix out of scope.

## Why this is filed as debt, not a live bug

The path is **dormant**: no client anywhere sends `resume_snapshot` today (the coordinator
*handles* it — `websocket.ts:119,270` — but nothing on the client side emits it). So the
defect harms nothing right now. It becomes a hard failure the moment a client-side snapshot
resume is wired up.

## What's needed

Give the checkpoint a real serialized form so the message round-trips like the rest of the
wire protocol:

- Add a `SerializedSnapshotCheckpoint` shape to `wire.ts` — `siteId` as base64 (via
  `siteIdToBase64` / `siteIdFromBase64`), `hlc` as the base64 transport encoding (via
  `serializeHLCForTransport` / `deserializeHLCFromTransport`), the rest of the fields
  pass through unchanged.
- Point `ResumeSnapshotMessage.checkpoint` at the serialized shape, and add
  `serializeSnapshotCheckpoint` / `deserializeSnapshotCheckpoint` codec functions with a
  round-trip test (assert the bigint HLC becomes a string and `JSON.stringify` does not
  throw, mirroring the existing tombstone-chunk test).
- Update the coordinator's `handleResumeSnapshot` to deserialize the incoming checkpoint.

This is a natural companion to the protocol cutover (`sync-protocol-migrate-and-version`),
but is independent of it — that ticket does not touch checkpoint JSON-safety, and the defect
survives the cutover unchanged. Can land before or after that work.
