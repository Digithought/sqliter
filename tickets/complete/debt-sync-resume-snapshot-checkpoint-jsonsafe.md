description: The sync message for resuming an interrupted database download used to crash if a client tried to send it; it now converts its data into a form that survives the network, and the server decodes it on arrival.
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

**`wire.ts`** — added `SerializedSnapshotCheckpoint`, the JSON-safe form of
`SnapshotCheckpoint` with `siteId` and `hlc` as base64 strings (via the existing
`siteIdToBase64` / `serializeHLCForTransport` helpers) and everything else
passing through. Added `serializeSnapshotCheckpoint` /
`deserializeSnapshotCheckpoint`. `ResumeSnapshotMessage.checkpoint` now points at
the serialized shape.

**Coordinator** — `handleResumeSnapshot` calls `deserializeSnapshotCheckpoint`
on the incoming message before handing the checkpoint to `CoordinatorService`,
which still expects the binary in-memory shape.

**Docs** — `docs/sync.md`'s resume example previously showed
`JSON.stringify({ type: 'resume', checkpoint })` with the raw checkpoint, i.e.
the exact crash; it now routes through the codec and uses the real message type
(`resume_snapshot`). The `SnapshotCheckpoint` interface block in the same file,
the message-type table in `docs/sync-coordinator.md`, and the Checkpoint/Resume
section of `packages/quereus-sync/README.md` all now say the type is not
JSON-safe on its own and name the codec.

## Review findings

### Checked

Read the implement diff first, then every touched file plus the ones it should
have touched: `manager.ts` (`SnapshotCheckpoint` definition),
`snapshot-stream.ts` (`resumeSnapshotStream`, header emission, at-rest
checkpoint storage), `coordinator-service.ts` (`resumeSnapshotStream`
authorization), `sync-client.ts` (does it send this message? — no), and the
`SnapshotCheckpoint` doc block in `docs/sync.md` against the real interface
(matches, field for field).

Validation run clean at the end of this pass: `yarn build`, `yarn typecheck`,
`yarn lint`, full `yarn test` (all workspaces, ~4m). `@quereus/sync` 481
passing, `@quereus/sync-coordinator` 118 passing. No pre-existing failures
surfaced, so no `.pre-existing-error.md` was written.

### Fixed in this pass (minor)

- **Codec could silently drift from the type it mirrors.**
  `SerializedSnapshotCheckpoint` was hand-written as a standalone interface
  duplicating all eight fields of `SnapshotCheckpoint`, which lives in a
  different file (`manager.ts`). Adding a field there would have compiled fine
  while the codec quietly dropped it on the wire. Now derived —
  `interface SerializedSnapshotCheckpoint extends Omit<SnapshotCheckpoint,
  'siteId' | 'hlc'>` with the two binary fields re-typed as base64 strings — so
  a new field is a compile error in both `serializeSnapshotCheckpoint` and
  `deserializeSnapshotCheckpoint` until it is carried.

- **End-to-end test did not actually prove the bigint survived.** The
  WebSocket resume test asserted the resumed header echoed the checkpoint's
  `snapshotId` and `siteId`, but not its `hlc` — and `hlc` is the field that
  motivated the whole ticket. Added the `hlc` echo assertion (the header carries
  `checkpoint.hlc` verbatim, so it only matches if base64 → bigint → base64
  round-tripped) and hoisted the checkpoint into a local so the assertions
  compare against the real sent value rather than repeated literals.

- **Module doc in `wire.ts` was stale.** Its own summary listed codecs "for
  change sets, snapshot chunks, and HLCs" — checkpoints were missing. Added.

- **`docs/sync.md` resume example mixed client and server code in one
  function.** `resumeSnapshot(ws)` sent the resume request and then, in the same
  body, iterated `syncManager.resumeSnapshotStream(...)` and pushed chunks back
  down the socket — i.e. the server's half, labelled with a `// Server ...`
  comment inside a client function. Split into `requestResume` (client: send the
  serialized checkpoint, apply the incoming chunks) and `handleResume` (server:
  deserialize, stream), matching the `sendSnapshot` / `receiveSnapshot` pair
  directly above it. Both halves now show their import.

### Filed as new tickets (major)

- `backlog/feat-sync-client-snapshot-bootstrap` — the shipped `SyncClient`
  speaks only `handshake` / `get_changes` / `apply_changes`. It has no snapshot
  path at all, so a new empty device can never catch up, and nothing anywhere
  sends `resume_snapshot`. The implement handoff flagged "client-side resume
  remains unwired"; reviewing the client showed the gap is larger than resume —
  the whole bootstrap is absent. Server and engine halves already exist, so this
  is client wiring plus several design decisions (when to trigger, what happens
  to concurrent local writes, how a half-applied database is surfaced).

### Recorded as tripwires, not tickets

- **Two JSON encodings for one checkpoint type** — the at-rest one in
  `snapshot-stream.ts` (`wallTime` as a decimal string, `siteId` as a number
  array) and the new base64 wire one. Unifying them is a stored-format
  migration, so it is not work today. The implementer had already parked this as
  a `NOTE:` above the Checkpoint Management section of
  `packages/quereus-sync/src/sync/snapshot-stream.ts`; verified it is there and
  accurate, left as-is.

- **Every `deserialize*` in `wire.ts` trusts its input.** Malformed JSON throws
  from inside a base64/HLC helper with an opaque message rather than a named
  validation error. Callers catch it (`handleResumeSnapshot` returns
  `SNAPSHOT_ERROR`), so it is a diagnostics gap, not a crash, and it is
  module-wide rather than something this ticket introduced. Parked as a `NOTE:`
  in the `wire.ts` module doc comment saying to add validation across the module
  if peers ever need actionable protocol errors.

### Reviewed and deliberately left alone

- **`PROTOCOL_VERSION` not bumped.** The constant's doc says to bump on any
  breaking message-shape change, and this is one. Confirmed the implementer's
  reasoning holds: the old shape threw at `JSON.stringify`, so no peer has ever
  emitted it and there is nothing to be incompatible with. Version comparison is
  strict integer equality, so a bump would reject otherwise-compatible peers for
  no gain. Agreed — no bump.

- **Coordinator trusts the checkpoint's contents.** `authorize({ type:
  'resume_snapshot' })` gates *whether* a client may resume, but `siteId` /
  `hlc` / `completedTables` are taken on faith. Already tracked in
  `backlog/bug-sync-resume-snapshot-unvalidated-checkpoint`, filed by an earlier
  review — not re-filed. Added a one-line pointer to that slug at the decode
  site in `websocket.ts` so a reader there knows the gap is known.

- **No other call site JSON-encodes a raw `SnapshotCheckpoint`.** Swept all
  `SnapshotCheckpoint` references across the monorepo: the remaining users are
  the `SyncManager` API surface, `snapshot-stream.ts`'s at-rest persistence (its
  own encoding), and `CoordinatorService.resumeSnapshotStream` (correctly takes
  the binary shape). Nothing else needs the codec.

- **Codec test coverage.** The implementer's `wire.spec.ts` block covers
  round-trip, a real `JSON.parse(JSON.stringify(...))` hop asserting `siteId
  instanceof Uint8Array` and `typeof hlc.wallTime === 'bigint'`, empty
  `completedTables`, and non-aliasing of `completedTables`. `opSeq` rides along
  in the binary HLC encoding and is exercised by the round-trip fixture. Judged
  sufficient; nothing added beyond the end-to-end `hlc` assertion above.

- **Malformed-input tests not added.** Deliberate: asserting the current opaque
  throw messages would pin behaviour the parked validation tripwire exists to
  change.
