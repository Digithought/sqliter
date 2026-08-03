description: A device interrupted while downloading a database copy can now find out that a partial download exists, list it, resume it, or throw it away — and a partial download always leaves a record saying so.
files:
  - packages/quereus-sync/src/metadata/keys.ts                              # sc: prefix, buildSnapshotCheckpointKey, buildAllSnapshotCheckpointScanBounds
  - packages/quereus-sync/src/sync/snapshot-stream.ts                       # decodeCheckpoint, listSnapshotCheckpoints, exported clearSnapshotCheckpoint, buildCheckpointRecord, header-time save
  - packages/quereus-sync/src/sync/manager.ts                               # SyncManager interface — two new methods
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                     # delegations
  - packages/quereus-sync/test/sync/snapshot-checkpoint-discovery.spec.ts   # NEW — 9 tests
  - packages/quereus-sync-client/test/sync-client.spec.ts                   # MockSyncManager in-memory checkpoint map
  - docs/sync.md                                                            # § Streaming Snapshot API + new § Checkpoint presence means partial data
  - packages/quereus-sync/README.md                                         # § Checkpoint / Resume example
difficulty: medium
----

## What shipped

Two gaps closed so a saved snapshot-resume position is actually reachable.

**Discovery.** `SyncManager` gained `listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]>`
and `clearSnapshotCheckpoint(snapshotId): Promise<void>`. Previously the only accessor was
`getSnapshotCheckpoint(snapshotId)` — useless to a restarted client, which never held the id
(it arrives only in the snapshot's header chunk).

**Always-present checkpoint.** `applySnapshotStream`'s `header` case now saves a checkpoint
immediately after `clearExistingMetadata`. Before, the first save came from `flushMetadataBatch`
(every 1000 metadata entries), so an interruption in between left a replica whose sync metadata
had been wiped and whose rows were partly written, with nothing on disk saying a transfer was
underway. Both header gates (wire format, clock drift) still reject *before* the clear, so a
refused snapshot leaves no checkpoint.

Net effect: "a checkpoint exists" ⇔ "this replica's data is partial". That biconditional is
what `feat-sync-client-snapshot-bootstrap` is built on.

### Supporting changes

- `sc:` moved out of `snapshot-stream.ts`'s private `CHECKPOINT_PREFIX` into
  `SYNC_KEY_PREFIX.SNAPSHOT_CHECKPOINT` (keys.ts), with `buildSnapshotCheckpointKey(id)` and
  `buildAllSnapshotCheckpointScanBounds()`. Pure relocation of the same three bytes — stored
  key layout unchanged, `SYNC_METADATA_FORMAT_VERSION` stays at 4.
- `decodeCheckpoint(bytes)` extracted; `getSnapshotCheckpoint` and `listSnapshotCheckpoints`
  share it. The at-rest encoding (decimal-string `wallTime`, number-array `siteId`) was left
  deliberately un-unified with the wire codec, per the existing NOTE above that section.
- `buildCheckpointRecord(id, hlc)` closure inside `applySnapshotStream`; both save sites
  (header, `flushMetadataBatch`) build the record through it so they cannot drift.
- `MockSyncManager` in the sync-client spec now backs checkpoints with a real
  `Map<string, SnapshotCheckpoint>` (public field `checkpoints`), so a bootstrap test can seed
  it to look like a replica interrupted mid-transfer, and get/list/clear agree with each other.

## Validation

`yarn build`, `yarn test`, `yarn typecheck`, `yarn lint` all green from repo root. Full test run:
8612 + 657 + others passing, 0 failing, no pre-existing failures surfaced.

New spec: `packages/quereus-sync/test/sync/snapshot-checkpoint-discovery.spec.ts` (9 tests, all
against real engine peers via `_peer-harness.ts`):

| Case | Asserts |
|---|---|
| empty replica | `listSnapshotCheckpoints()` → `[]`, not a throw |
| drop right after header | exactly one checkpoint, naming that snapshotId, `completedTables: []`; and `getSnapshotCheckpoint(id)` agrees |
| discovered checkpoint resumes | resume driven purely off the listed record (id never observed) recovers all rows and clears the checkpoint |
| complete apply | footer clears the header-time save → `[]` |
| wire-format mismatch | rejected → `[]` |
| clock drift (1h ahead) | rejected → `[]` |
| `bootstrapFinalize` throws | checkpoint survives (finalize-before-clear ordering preserved) |
| two abandoned transfers | both listed, no dedup; and the second apply's `clearExistingMetadata` spares the first — the regression guard for `sc:` never joining the `cv:`/`tb:`/`cl:` sweep |
| `clearSnapshotCheckpoint` | discards without applying; list and by-id lookup both empty after |

**Mutation-checked.** With the header-time save disabled, 5 of the 9 fail. The tests are
load-bearing, not decoration.

## Honest gaps for the reviewer

- **Concurrency is untested.** The `clearSnapshotCheckpoint`-races-an-in-flight-apply
  interaction is documented on the interface (the apply re-saves at its next flush) but has no
  test. Writing one needs interleaving control the current harness doesn't offer.
- **`listSnapshotCheckpoints` decodes eagerly.** It materializes every `sc:` record. In practice
  there is roughly one, and only ever a handful (one per abandoned transfer) — but nothing
  prunes them. A replica that repeatedly starts and abandons transfers accumulates records
  forever. No pruning was in scope; whether abandonment should auto-clear is a caller-policy
  question that `feat-sync-client-snapshot-bootstrap` will have to answer.
- **`decodeCheckpoint` trusts its bytes.** It `JSON.parse`s and reaches into `obj.hlc.*` with no
  validation, exactly as the prior inline code did. A corrupt or truncated `sc:` value now
  throws out of `listSnapshotCheckpoints()` — i.e. out of a *discovery* call, which a client
  makes at connect time, rather than only out of a resume that already knew an id. Same failure
  mode as before, slightly wider blast radius. Note `bug-sync-resume-snapshot-unvalidated-checkpoint`
  (backlog) covers unvalidated checkpoints arriving over the *wire*; this is the at-rest sibling,
  and neither was in this ticket's scope.
- **Checkpoint `siteId` is the receiver's, not the sender's.** Pre-existing (`buildCheckpointRecord`
  preserves `flushMetadataBatch`'s `ctx.getSiteId()`), and `resumeSnapshotStream` feeds it straight
  into the resumed header's `siteId`. Existing tests pass because nothing reads it, but it looks
  wrong. Not touched here — flagging it as something a reviewer may want to trace.
- **Docs.** `docs/sync.md` gained a `#### Checkpoint presence means partial data` subsection under
  the Streaming Snapshot API. It states the biconditional and warns that `clearExistingMetadata`
  must never grow to include `sc:`. Worth checking it reads correctly to someone who has not seen
  this ticket.
