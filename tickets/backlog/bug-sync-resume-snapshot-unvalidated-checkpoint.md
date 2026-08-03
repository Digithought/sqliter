description: When a client asks the sync server to resume a partial download, the server trusts the client's description of where to resume without checking it, so a malformed or hostile request can drive the resume off the rails.
files:
  - packages/sync-coordinator/src/server/websocket.ts          # handleResumeSnapshot (~269)
  - packages/sync-coordinator/src/service/coordinator-service.ts # resumeSnapshotStream (~469)
  - packages/quereus-sync/src/sync/snapshot-stream.ts           # resumeSnapshotStream / SnapshotCheckpoint
----

## Problem

`resume_snapshot` accepts the client-supplied `checkpoint` (`SnapshotCheckpoint`:
`snapshotId`, completed-table set, entry offsets, `siteId`, `hlc`) and feeds it straight into
the resume stream without validation. A malformed or adversarial checkpoint (bogus offsets,
unknown/oversized table set, mismatched `snapshotId`/`siteId`, out-of-range `hlc`) drives the
resume with unchecked input.

Surfaced by the same review as the shared-protocol work; separable from it.

## Direction / open questions (for the fix pass)

- Define what a *valid* checkpoint is: bounds on offsets, `completedTables` membership against
  the actual snapshot's tables, `snapshotId` recognized/owned by this session, `siteId`/`hlc`
  well-formed and consistent with the session.
- Decide the failure response: reject with an `error` (which code? fatal?) vs. silently
  restart the snapshot from the beginning.
- Confirm whether checkpoints are server-issued (and thus could be signed/opaque) or purely
  client-held — that changes whether validation or authentication is the right guard.

Security-adjacent input hardening; needs a validation design before implementation.

## Second arm — settle what `checkpoint.siteId` actually denotes

Found while planning `feat-sync-client-snapshot-bootstrap`. The bullet above wants the
checkpoint's `siteId` validated "consistent with the session", but the field's meaning is
currently ambiguous, so there is nothing to validate against yet.

- The **receiver** writes it: `applySnapshotStream` saves `siteId: ctx.getSiteId()` — the
  downloading client's own site id (`packages/quereus-sync/src/sync/snapshot-stream.ts`,
  checkpoint save in `flushMetadataBatch`).
- The **sender** reads it back as if it were its own: `resumeSnapshotStream` passes
  `checkpoint.siteId` through to `streamSnapshotChunks`, which stamps it into the resumed
  stream's header — where a fresh stream puts `ctx.getSiteId()`, the *server's* site id.

So a resumed snapshot's header advertises the client's site id as the snapshot's origin.
Nothing reads `header.siteId` today (`applySnapshotStream` uses only `snapshotId`, `hlc`,
`tableCount`, `snapshotFormat`), so it is inert — but any future consumer of that field on a
resumed stream gets the wrong site. Decide which site the field names, fix the writer or the
reader accordingly, and only then write the session-consistency check.

(By contrast `checkpoint.hlc` is used correctly: the resumed header carries the *original*
snapshot's HLC, which is the point-in-time the transfer is completing.)

## Third arm — the same trust gap at rest, now on a discovery call

Found reviewing `feat-sync-snapshot-checkpoint-discovery`. The two arms above are about a
checkpoint arriving over the wire. The stored copy is read with no validation either:
`decodeCheckpoint` (`packages/quereus-sync/src/sync/snapshot-stream.ts`) `JSON.parse`s the
record and reaches straight into `obj.hlc.wallTime` / `obj.hlc.siteId` / `obj.siteId`. A
truncated or corrupt record throws a raw `SyntaxError`/`TypeError`.

What changed: that decode now also runs inside `listSnapshotCheckpoints()`, which a client is
expected to call at connect time to ask "is my data partial?". Previously a corrupt record only
broke a resume that already knew the snapshot id; now one bad record breaks the discovery call
itself, and the client cannot even learn that it holds partial data. Same root cause as the
wire arms — settle what a valid checkpoint is, then apply it at both the wire and at-rest
decode sites (and decide whether a record that fails validation should be dropped rather than
thrown, since an undecodable checkpoint is not resumable anyway).
