----
description: The sync message for resuming an interrupted database download used to crash if a client tried to send it; it now converts its data into a form that survives the network, and the server decodes it on arrival.
prereq:
files:
  - packages/quereus-sync/src/sync/wire.ts                 # SerializedSnapshotCheckpoint + codec; ResumeSnapshotMessage retyped
  - packages/quereus-sync/src/index.ts                     # exports the new type + codec fns
  - packages/quereus-sync/src/sync/snapshot-stream.ts      # NOTE only: at-rest checkpoint encoding differs from wire
  - packages/quereus-sync/test/wire.spec.ts                # codec round-trip tests
  - packages/sync-coordinator/src/server/websocket.ts      # handleResumeSnapshot now deserializes
  - packages/sync-coordinator/src/common/index.ts          # re-exports the codec fns
  - packages/sync-coordinator/test/websocket.spec.ts       # end-to-end resume-over-WebSocket test
  - docs/sync.md, docs/sync-coordinator.md, packages/quereus-sync/README.md
difficulty: medium
----

## What was wrong

A "resume snapshot" message lets a client whose full-database download was cut
off ask the server to continue from a saved position instead of starting over.
That saved position (a "checkpoint") contains two values that plain JSON cannot
represent: a site identifier held as raw bytes, and a timestamp held as a
JavaScript `bigint`. `JSON.stringify` **throws** on a `bigint`, so a client could
not even build the message; and had it somehow arrived, the server would have
read the byte field back as a meaningless plain object.

The path was dormant — no client sends this message today — so nothing broke in
production. It would have failed hard the first time anyone wired up client-side
resume.

## What changed

**`wire.ts`** — added `SerializedSnapshotCheckpoint`, the JSON-safe mirror of
`SnapshotCheckpoint`: `siteId` and `hlc` become base64 strings (via the existing
`siteIdToBase64` / `serializeHLCForTransport` helpers), everything else passes
through. Added `serializeSnapshotCheckpoint` / `deserializeSnapshotCheckpoint`.
`ResumeSnapshotMessage.checkpoint` now points at the serialized shape.

**Coordinator** — `handleResumeSnapshot` calls `deserializeSnapshotCheckpoint`
on the incoming message before handing the checkpoint to `CoordinatorService`,
which still expects the binary in-memory shape.

**Docs** — `docs/sync.md`'s resume example previously showed
`JSON.stringify({ type: 'resume', checkpoint })` with the raw checkpoint, i.e.
the exact crash; it now routes through the codec (and uses the real message
type, `resume_snapshot`, which the old example also had wrong). The
`SnapshotCheckpoint` interface block in the same file, the message-type table in
`docs/sync-coordinator.md`, and the Checkpoint/Resume section of
`packages/quereus-sync/README.md` all now say the type is not JSON-safe on its
own and name the codec.

## How to validate

**Automated (already passing):**

- `yarn workspace @quereus/sync run test` — 481 passing. New `SnapshotCheckpoint
  codec` block in `test/wire.spec.ts`: round-trip with the bigint/binary→string
  assertions and a `JSON.stringify` no-throw check (mirrors the existing
  tombstone-chunk test); a real `JSON.parse(JSON.stringify(...))` hop asserting
  `siteId instanceof Uint8Array` and `typeof hlc.wallTime === 'bigint'` come
  back; empty `completedTables`; and a non-aliasing check on `completedTables`.
- `yarn workspace @quereus/sync-coordinator run test` — 118 passing. New
  `should resume a snapshot from a serialized checkpoint after handshake` in
  `test/websocket.spec.ts` drives a real WebSocket: handshake, send
  `resume_snapshot` carrying a codec-built checkpoint, assert no `error`
  message, a `snapshot_complete`, and that the resumed header chunk echoes the
  checkpoint's `snapshotId` and `siteId`.
- `yarn build`, `yarn typecheck`, `yarn lint`, full `yarn test` (7180 + all
  workspaces) — all clean, zero failures.

**The new coordinator test was verified non-vacuous.** With the
`deserializeSnapshotCheckpoint` call temporarily bypassed, it fails with
`SNAPSHOT_ERROR: Cannot convert undefined to a BigInt`. The bypass was reverted.

**Manual check worth a reviewer's time:** confirm no other call site still hands
a raw `SnapshotCheckpoint` to something that JSON-encodes it. Searched for
`SnapshotCheckpoint` across the monorepo; the remaining users are the
`SyncManager` API surface, `snapshot-stream.ts`'s at-rest persistence (its own
separate encoding — see below), and `CoordinatorService.resumeSnapshotStream`
(which correctly takes the binary shape).

## Known gaps / things to scrutinize

- **The path is still dormant end-to-end.** No production client emits
  `resume_snapshot`; the only sender is the new coordinator test. So this fixes
  the codec and the server half, but client-side resume remains unwired. If the
  reviewer wants that built, it is a separate feature ticket, not a fix here.

- **`PROTOCOL_VERSION` was not bumped.** This is technically a breaking change
  to a message shape, which the constant's own doc comment says should bump it.
  The judgment call: the *old* shape was unsendable (it threw at
  `JSON.stringify`), so no peer anywhere has ever spoken it and there is nothing
  to be incompatible with. Bumping would force a handshake rejection between
  otherwise-fine peers for no benefit. Reviewer should sanity-check that
  reasoning — it is the one deliberate deviation from the stated rule.

- **`deserializeSnapshotCheckpoint` does no input validation.** A malformed
  checkpoint (bad base64, missing `hlc`) throws from inside the base64/HLC
  helpers. That throw *is* caught by `handleResumeSnapshot`'s existing try/catch
  and returned as a `SNAPSHOT_ERROR` — so no crash and no unhandled rejection —
  but the client gets an opaque message like "Cannot convert undefined to a
  BigInt" rather than a clear "malformed checkpoint". Same posture as the other
  `deserialize*` functions in `wire.ts`, which are equally trusting, so this is
  consistent rather than newly sloppy. Left as-is deliberately; flagging in case
  the reviewer wants a validation pass across all of them (that would be its own
  ticket, since it is a whole-module concern).

- **The coordinator does not cross-check the checkpoint's contents against the
  session.** `authorize({ type: 'resume_snapshot' })` gates *whether* a client
  may resume, but the `siteId` / `hlc` / `completedTables` inside the checkpoint
  are taken on trust. Impact looks low — forging them mainly lets a client skip
  tables in or set the header clock of *its own* download — and this is
  pre-existing in the service signature, not introduced here. But the message is
  now actually usable, so the trust boundary is reachable in a way it wasn't
  before. Worth a reviewer's eye on whether that deserves a follow-up ticket.

- **Tripwire parked, not filed:** checkpoints now have two distinct JSON
  encodings — the at-rest one in `snapshot-stream.ts` (`wallTime` as a decimal
  string, `siteId` as a number array, under the `sc:` key prefix) and the new
  base64 wire one. Unifying them is a stored-format migration, so it is not work
  today. Recorded as a `NOTE:` comment above the Checkpoint Management section
  of `packages/quereus-sync/src/sync/snapshot-stream.ts`.

## Review findings

_(to be filled in by the review stage)_
