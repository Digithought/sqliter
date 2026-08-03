description: A device that was interrupted while downloading a database copy has no way to find out that a partial download exists, so it cannot pick up where it left off. Give the sync engine a way to list and discard those saved positions, and make sure one is always saved.
files:
  - packages/quereus-sync/src/metadata/keys.ts                 # SYNC_KEY_PREFIX — `sc:` prefix moves here; new scan bounds
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # CHECKPOINT_PREFIX, getSnapshotCheckpoint, saveSnapshotCheckpoint, clearSnapshotCheckpoint, applySnapshotStream header case
  - packages/quereus-sync/src/sync/manager.ts                  # SyncManager interface — Streaming Snapshot API section (~line 249-292)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # delegation stubs (~line 1542-1564)
  - packages/quereus-sync-client/test/sync-client.spec.ts      # MockSyncManager implements SyncManager — must gain the new methods
  - packages/quereus-sync/test/sync/snapshot-resume.spec.ts    # existing resume coverage to extend
  - docs/sync.md                                               # § Streaming Snapshot API (~line 789-825)
difficulty: medium
----

## Why

A streaming snapshot apply (`applySnapshotStream`) periodically writes a
**checkpoint** — a small record under the key `sc:<snapshotId>` saying which
tables of the transfer have already landed locally. If the transfer is
interrupted, that record is what lets the next attempt resume instead of
restarting.

Two things stop a client from ever using it:

1. **You can only read a checkpoint if you already know its `snapshotId`.**
   The only accessor is `SyncManager.getSnapshotCheckpoint(snapshotId)`. A
   client that restarts has forgotten the id — it was only ever announced
   mid-stream, in the snapshot's header chunk. There is no "is there a partial
   transfer sitting here?" query, so the saved position is unreachable.

2. **There is a window in which no checkpoint exists at all.** Checkpoints are
   written only from `flushMetadataBatch`, which fires every 1000 metadata
   entries. A transfer interrupted before the first flush has already cleared
   the receiver's existing sync metadata (`clearExistingMetadata`, run at the
   header) and may have written rows — but leaves no record that a transfer was
   underway. The database is partial and nothing says so.

Closing both makes "a checkpoint exists" the single, durable, honest answer to
"is this database mid-bootstrap?" — which is what the client work in
`feat-sync-client-snapshot-bootstrap` builds on.

## Design

### Checkpoint key prefix moves to the shared table

`snapshot-stream.ts` declares its own `const CHECKPOINT_PREFIX = 'sc:'` while
every other sync metadata prefix lives in `SYNC_KEY_PREFIX` (keys.ts). Move it:

```ts
export const SYNC_KEY_PREFIX = {
  // ...existing entries...
  SNAPSHOT_CHECKPOINT: encoder.encode('sc:'),
} as const;
```

and add the scan bounds alongside the existing `buildAll*ScanBounds` helpers:

```ts
export function buildAllSnapshotCheckpointScanBounds(): { gte: Uint8Array; lt: Uint8Array };
```

This is a pure relocation of the same three bytes — the stored key layout does
not change, so `SYNC_METADATA_FORMAT_VERSION` stays at 4.

Note in keys.ts that `sc:` keys are **not** length-prefixed the way `cv:` /
`tb:` / `cl:` keys are (the suffix is a single UUID, which cannot contain the
separator), so they need no `parse…Key` counterpart — the checkpoint's own
`snapshotId` field is read back from the record value.

### Two new `SyncManager` methods

Added to the *Streaming Snapshot API* section of the `SyncManager` interface,
next to `getSnapshotCheckpoint`:

```ts
/**
 * List every saved checkpoint for an interrupted snapshot apply.
 *
 * A non-empty result means this replica's data is PARTIAL: a snapshot apply
 * cleared existing sync metadata and did not reach its footer. Callers use
 * this to discover a resumable transfer whose `snapshotId` they no longer
 * hold (it only ever arrived in the snapshot's header chunk).
 *
 * Ordering is unspecified; pick by `createdAt` when more than one exists.
 */
listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]>;

/**
 * Discard a saved checkpoint without applying anything.
 *
 * `applySnapshotStream` already clears its own checkpoint on success; this is
 * for callers abandoning a transfer they will not resume (e.g. discarding
 * superseded checkpoints when several are present).
 */
clearSnapshotCheckpoint(snapshotId: string): Promise<void>;
```

Implementation in `snapshot-stream.ts`:

- Factor the at-rest decode currently inlined in `getSnapshotCheckpoint` into a
  `decodeCheckpoint(bytes: Uint8Array): SnapshotCheckpoint` helper, and have
  both `getSnapshotCheckpoint` and the new `listSnapshotCheckpoints` use it.
  (The at-rest encoding — decimal-string `wallTime`, number-array `siteId` — is
  deliberately not the wire encoding; the existing comment above the checkpoint
  section explains why. Do not unify them here.)
- `listSnapshotCheckpoints(ctx)` scans `buildAllSnapshotCheckpointScanBounds()`
  and decodes each value.
- Export the already-written `clearSnapshotCheckpoint(ctx, snapshotId)`.
- Delegate all three from `SyncManagerImpl` in the same style as the existing
  streaming-snapshot delegations.

### Always leave a checkpoint while an apply is in flight

In `applySnapshotStream`'s `header` case, immediately **after**
`clearExistingMetadata(...)` returns, save a checkpoint. This is the same
`saveSnapshotCheckpoint` call `flushMetadataBatch` makes, with the counters as
they stand at that moment (`completedTables` is either empty or the set seeded
from a prior checkpoint):

- It must come **after** the wire-format gate and the drift gate. Both reject
  without touching local state, and a rejected snapshot must leave no checkpoint
  behind.
- It must come **before** any chunk after the header is processed, so there is
  no interval in which local metadata has been cleared but nothing records that
  a transfer is underway.
- On a resumed apply this re-saves substantively the same record. Harmless.

Refactor so the header case and `flushMetadataBatch` build the checkpoint
record through one small helper rather than repeating the literal — the two must
not drift.

## Edge cases & interactions

- **Header gates reject → no checkpoint.** A snapshot whose `snapshotFormat`
  mismatches, or whose header HLC is outside the drift bound, throws before
  `clearExistingMetadata`. Assert that `listSnapshotCheckpoints()` is still
  empty afterwards — otherwise a rejected snapshot would make every later
  connect try to resume a transfer that was never allowed to start.
- **Interruption between header and first flush.** Feed a chunk stream that
  yields a header (and optionally a `table-start`) and then throws. Assert a
  checkpoint exists. This is the window the new header-time save closes; without
  the fix the test fails.
- **Success clears it.** A complete stream (through `footer`) must leave
  `listSnapshotCheckpoints()` empty — the footer's existing
  `clearSnapshotCheckpoint` still runs, and the header-time save must not
  survive it.
- **Footer's `bootstrapFinalize` throws.** The existing ordering deliberately
  issues finalize *before* clearing the checkpoint so a failed finalize retries.
  Confirm that ordering is preserved and that the checkpoint survives such a
  failure.
- **Several checkpoints coexist.** Two abandoned transfers leave two `sc:`
  records. `listSnapshotCheckpoints()` must return both; it must not
  deduplicate, sort, or delete. Selection policy belongs to the caller.
- **Empty replica.** `listSnapshotCheckpoints()` on a store that has never
  applied a snapshot returns `[]`, not a throw.
- **`clearExistingMetadata` must not eat checkpoints.** It scans `cv:` / `tb:` /
  `cl:` only. Adding `sc:` to `SYNC_KEY_PREFIX` must not change that — a
  regression there would delete the resume position at the very moment it is
  needed. Worth an explicit assertion.
- **Interaction with `clearSnapshotCheckpoint` racing an apply.** Calling it for
  the `snapshotId` of an in-flight apply removes the record the apply will
  re-save at its next flush; nothing corrupts, the transfer just loses one
  resume position. Document on the method rather than guarding.
- **Mock drift.** `MockSyncManager` in
  `packages/quereus-sync-client/test/sync-client.spec.ts` implements
  `SyncManager` structurally; without the two new methods that package no longer
  typechecks. Give the mock a real in-memory checkpoint map (not `return []`) —
  `feat-sync-client-snapshot-bootstrap` drives its resume tests through it.

## TODO

- Move `sc:` into `SYNC_KEY_PREFIX` as `SNAPSHOT_CHECKPOINT`; add
  `buildAllSnapshotCheckpointScanBounds()`; note in keys.ts why `sc:` keys need
  no length-prefixed parser.
- Replace `CHECKPOINT_PREFIX` in `snapshot-stream.ts` with the shared prefix.
- Extract `decodeCheckpoint` and a `buildCheckpointRecord` helper; use from
  `getSnapshotCheckpoint`, `listSnapshotCheckpoints`, the header-time save, and
  `flushMetadataBatch`.
- Add `listSnapshotCheckpoints` + export `clearSnapshotCheckpoint` in
  `snapshot-stream.ts`.
- Add both to the `SyncManager` interface with the doc comments above; delegate
  from `SyncManagerImpl`.
- Save a checkpoint in the `header` case right after `clearExistingMetadata`.
- Extend `packages/quereus-sync/test/sync/snapshot-resume.spec.ts` (or add a
  sibling spec) covering every bullet under *Edge cases & interactions*.
- Give `MockSyncManager` a working in-memory checkpoint store.
- Update `docs/sync.md` § Streaming Snapshot API: the two new methods, and the
  guarantee that a checkpoint exists for the whole duration of an apply (so
  "a checkpoint is present" means "this replica's data is partial").
- `yarn build && yarn test` green.
