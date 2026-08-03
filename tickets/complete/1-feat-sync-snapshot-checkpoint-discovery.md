description: A device interrupted while downloading a database copy can now find out that a partial download exists, list it, resume it, or throw it away — and a partial download always leaves a record saying so.
files:
  - packages/quereus-sync/src/metadata/keys.ts                              # sc: prefix, buildSnapshotCheckpointKey, buildAllSnapshotCheckpointScanBounds
  - packages/quereus-sync/src/sync/snapshot-stream.ts                       # decodeCheckpoint, listSnapshotCheckpoints, clearSnapshotCheckpoint, clearOtherSnapshotCheckpoints, buildCheckpointRecord, header-time save
  - packages/quereus-sync/src/sync/manager.ts                               # SyncManager interface — two new methods
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                     # delegations
  - packages/quereus-sync/test/sync/snapshot-checkpoint-discovery.spec.ts   # 10 tests
  - packages/quereus-sync-client/test/sync-client.spec.ts                   # MockSyncManager in-memory checkpoint map
  - docs/sync.md                                                            # § Storage Layout row + § Checkpoint presence means partial data
  - packages/quereus-sync/README.md                                         # § Checkpoint / Resume example
difficulty: medium
----

## What shipped

Two gaps closed so a saved snapshot-resume position is actually reachable, plus one
correctness fix found in review that the invariant depended on.

**Discovery.** `SyncManager` gained `listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]>`
and `clearSnapshotCheckpoint(snapshotId): Promise<void>`. The only prior accessor was
`getSnapshotCheckpoint(snapshotId)` — useless to a restarted client, which never held the id
(it arrives only in the snapshot's header chunk).

**Always-present checkpoint.** `applySnapshotStream`'s `header` case saves a checkpoint
immediately after `clearExistingMetadata`. Before, the first save came from `flushMetadataBatch`
(every 1000 metadata entries), so an interruption in between left a replica whose sync metadata
had been wiped and whose rows were partly written, with nothing on disk saying a transfer was
underway. Both header gates (wire format, clock drift) still reject *before* the clear, so a
refused snapshot leaves no checkpoint.

**Stale checkpoints are pruned at the same point (added in review).** The header now also
deletes every *other* snapshot's checkpoint. See findings below.

Net effect: "a checkpoint exists" ⇔ "this replica's data is partial", now with no accumulation
path that could report a whole replica as partial.

### Supporting changes

- `sc:` moved from `snapshot-stream.ts`'s private `CHECKPOINT_PREFIX` into
  `SYNC_KEY_PREFIX.SNAPSHOT_CHECKPOINT` (keys.ts), with `buildSnapshotCheckpointKey(id)` and
  `buildAllSnapshotCheckpointScanBounds()`. Stored key layout unchanged;
  `SYNC_METADATA_FORMAT_VERSION` stays at 4.
- `decodeCheckpoint(bytes)` extracted; `getSnapshotCheckpoint` and `listSnapshotCheckpoints`
  share it. The at-rest encoding (decimal-string `wallTime`, number-array `siteId`) stays
  deliberately un-unified with the wire codec, per the existing NOTE above that section.
- `buildCheckpointRecord(id, hlc)` closure inside `applySnapshotStream`; every save site builds
  the record through it so they cannot drift.
- `MockSyncManager` in the sync-client spec backs checkpoints with a real
  `Map<string, SnapshotCheckpoint>` (public field `checkpoints`), so a bootstrap test can seed
  it to look like a replica interrupted mid-transfer.

## Validation

`yarn build`, `yarn test`, `yarn typecheck`, `yarn lint` all green from repo root, after the
review changes. Mocha suites: 8612 / 1348 / 658 (quereus-sync) / 376 / 134 / … passing,
0 failing; Vitest: 119 + 59 + 68 passing. No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

`packages/quereus-sync/test/sync/snapshot-checkpoint-discovery.spec.ts` — 10 tests against real
engine peers via `_peer-harness.ts`:

| Case | Asserts |
|---|---|
| empty replica | `listSnapshotCheckpoints()` → `[]`, not a throw |
| drop right after header | exactly one checkpoint naming that snapshotId, `completedTables: []`; `getSnapshotCheckpoint(id)` agrees |
| discovered checkpoint resumes | resume driven purely off the listed record (id never observed) recovers all rows and clears the checkpoint |
| complete apply | footer clears the header-time save → `[]` |
| wire-format mismatch | rejected → `[]` |
| clock drift (1h ahead) | rejected → `[]` |
| `bootstrapFinalize` throws | checkpoint survives (finalize-before-clear ordering preserved) |
| second interrupted transfer | the earlier, now-stale checkpoint is dropped; the running transfer's own record survives → list is exactly the second id **(rewritten in review)** |
| abandoned then completed | interrupted transfer, then a full apply of a different snapshot → `[]`, rows all present **(new in review)** |
| `clearSnapshotCheckpoint` | discards without applying; list and by-id lookup both empty after |

## Review findings

### Major — fixed in this pass (no ticket)

**A completed apply could leave a stale checkpoint, breaking the invariant this ticket exists
to establish.** `clearExistingMetadata` at the header wipes the CRDT metadata of every table
the apply did not inherit, but the footer cleared only *its own* `sc:` record. So: transfer A
interrupted → checkpoint A saved; client reconnects and does a fresh full apply of snapshot B →
B's footer clears B only → checkpoint A remains on a replica whose data is now complete.
`listSnapshotCheckpoints()` then reports "partial" forever, which is exactly the signal
`feat-sync-client-snapshot-bootstrap` is built on. Worse, A's `completedTables` names tables
whose metadata B's clear removed, so resuming A would tell the sender to skip precisely the
tables that can no longer be rebuilt — the metadata/data divergence `preserveTables` exists to
prevent.

The implement handoff surfaced the same code path only as unbounded growth ("nothing prunes
them… a caller-policy question"), which understates it: it is a wrong answer, not just a
growing list.

Fix: `clearOtherSnapshotCheckpoints(ctx, keepSnapshotId)`, called once per apply immediately
after `clearExistingMetadata` — the instant every other resume position becomes unusable. At
most one checkpoint now exists at a time, which also removes the accumulation concern entirely.
Covered by the two rewritten/added tests above; the pre-existing "several abandoned transfers
coexist" test asserted the old behaviour and was replaced (its stated purpose — guarding `sc:`
against joining the `cv:`/`tb:`/`cl:` sweep — was already weaker than advertised, since the
header *reads* the checkpoint before the clear; resume-preservation is covered by
`snapshot-resume.spec.ts` and `store-adapter-seam.spec.ts`).

### Minor — fixed inline

- **README example called `clearSnapshotCheckpoint(checkpoint.snapshotId)` outside the
  `if (checkpoint)` guard** — copy-pasteable code that throws on a replica with no checkpoint,
  and it read as "resume, then also discard". Rewritten as resume-or-abandon inside the guard.
- **Comment/code drift in `applySnapshotStream`** — the "flush the accumulated metadata batch…"
  comment ended up heading `buildCheckpointRecord` instead of `flushMetadataBatch`. Moved back.
- **`docs/sync.md` § Storage Layout key table did not list `sc:`** — the ticket promoted the
  prefix into `SYNC_KEY_PREFIX`, so the canonical table is where a reader looks for it. Row
  added, cross-referencing the new subsection. (That table is also missing `qt:` and `bl:` —
  pre-existing, outside this diff, not touched.)

### Filed as tickets

- **`decodeCheckpoint` trusts its bytes** (implement handoff flagged this). It `JSON.parse`s
  and reaches into `obj.hlc.*` with no validation, so a corrupt record now throws out of
  `listSnapshotCheckpoints()` — a *discovery* call a client makes at connect time, meaning it
  cannot even learn its data is partial. Same root cause as the existing backlog ticket
  `bug-sync-resume-snapshot-unvalidated-checkpoint` (unvalidated checkpoints over the wire), so
  it was appended there as a third arm rather than filed fresh — one validation design, two
  decode sites.

### Recorded as tripwires (not tickets)

- **`checkpoint.siteId` is the receiver's, not the sender's**, and `resumeSnapshotStream`
  stamps it into the resumed header where a fresh stream puts the sender's. Inert — nothing
  reads `header.siteId`. Already owned by the second arm of
  `bug-sync-resume-snapshot-unvalidated-checkpoint`; a `NOTE:` at the write site in
  `buildCheckpointRecord` now points there so the next reader of that field meets it.
- **`snapshot-stream.ts` is 870 lines** (`wc -l`). Cohesive, but a `NOTE:` at the *Checkpoint
  Management* section header records that this section (~150 lines, depends only on
  `SyncContext` and the `sc:` key builders) is the extraction seam if the file grows further.

### Checked, nothing found

- **Key-space safety.** `sc:` does not collide with any existing prefix (`cv tb tx ps pt sm si
  hc cl qt bl fv`), and `buildAllSnapshotCheckpointScanBounds` (`gte: 'sc:'`, `lt: 'sc;'`)
  cannot pick up another prefix's records. The un-length-prefixed suffix is safe because the id
  is appended last, so nothing can escape the prefix.
- **Non-streaming `applySnapshot`** does not clear metadata and cannot produce partial state,
  so the "checkpoint ⇔ partial" claim is not undermined by that path.
- **Other `SyncManager` implementers.** Only `SyncManagerImpl` and the sync-client spec's
  `MockSyncManager` implement the interface; both carry the two new methods, and no coordinator
  RPC surface re-declares it.
- **Format version.** Key bytes and record encoding are unchanged, so leaving
  `SYNC_METADATA_FORMAT_VERSION` at 4 is correct — an existing replica's `sc:` records still
  read.

### Explicitly not covered

- **Concurrency.** `clearSnapshotCheckpoint` racing an in-flight apply remains untested; the
  interface documents the outcome (the apply re-saves at its next flush). The harness offers no
  interleaving control, and building one is disproportionate to a documented benign race. Not
  filed — nothing is known to be wrong, only unproven.
