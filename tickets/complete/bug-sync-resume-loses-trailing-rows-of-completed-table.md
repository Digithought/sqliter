description: Hardened the database-copy receiver so a table can never be recorded as "fully copied" while some of its rows are still only in memory, and added tests for resuming an interrupted copy. No user-visible bug existed — this closes a gap that was only accidentally safe.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts  # applySnapshotStream: staged-then-graduated completedTables
  - packages/quereus-sync/test/sync/snapshot-resume.spec.ts  # interrupt+resume e2e, checkpoint invariant probe
  - docs/sync.md  # SnapshotCheckpoint: completedTables durability invariant
difficulty: easy
----

## What shipped

**Receiver (`applySnapshotStream`).** A finished table's key now lands in a
`stagedCompletedTables` holding area at `table-end`, and graduates into
`completedTables` only inside `flushDataToStore`, immediately after
`applyDataToStore` has returned. A saved resume checkpoint can therefore never
name a table whose trailing rows are still in memory.

Why that matters: a resumed sender **skips** every table the checkpoint names,
and the receiver **preserves** those tables' metadata through the resume's
up-front clear. A prematurely-named table loses its trailing rows permanently —
never re-sent, never reconciled, never reported. Being late is harmless (the
table is merely re-streamed); being early is silent data loss.

Before this change the property happened to hold, but only as a side effect of
an unrelated flush in the `tombstone` chunk handler (added for DDL ordering).
Nothing enforced it structurally.

**This is hardening, not an observable-bug fix.** No data loss was reproducible
at HEAD.

**Tests** (`snapshot-resume.spec.ts`, both using the real engine via
`_peer-harness.ts`):

1. *Interrupt + resume end-to-end* — 150-row and 1000-row tables, connection
   dropped before the footer, checkpoint asserted to name only the flushed
   table, then resumed; every row of both tables and each table's last row
   verified, checkpoint verified cleared on completion.
2. *Checkpoint invariant probe* — a scenario that fires a genuine mid-stream
   checkpoint save (a fully-deleted 1200-row table whose tombstone flush crosses
   the receiver's 1000-entry metadata-batch bound), with the receiver's store
   apply and key-value `put` instrumented to assert that no checkpoint names a
   table as complete before that table's rows are durable.

## Review findings

### Checked and clean

- **The invariant itself.** Traced every path that can save a checkpoint. All
  of them go through `flushMetadataBatch`, which writes the pending metadata
  batch *before* saving, and graduation happens only after the store apply
  returns. So a checkpoint can name a table only when both that table's rows and
  its metadata are durable. Also checked the reverse direction: if the store
  apply throws, staged tables stay staged and the checkpoint under-reports —
  the safe direction.
- **Resume seeding.** `completedTables` seeded from the checkpoint at `header`
  cannot duplicate entries (a resumed sender never re-emits a completed table's
  `table-end`), and the footer's bootstrap-finalize now still receives the full
  table set because the footer flushes before reading it.
- **Error handling / cleanup.** No new failure paths; the staging array is
  function-local and dies with the call.
- **Type safety.** No `any` in the diff; the test's two instrumentation points
  use narrow casts and the package type-checks its test files (`typecheck` runs
  `tsc -p tsconfig.test.json`).
- **Validation.** `yarn workspace @quereus/sync test` → 639 passing, 0 failing.
  `yarn workspace @quereus/sync run typecheck` → clean. `yarn lint` (whole
  repo) → clean. No pre-existing failures surfaced.

### Fixed in this pass (minor)

- **`docs/sync.md` did not state the invariant.** The `SnapshotCheckpoint`
  documentation described the field list and the wire-encoding wart but said
  nothing about when a table may be added to `completedTables` — the exact
  property this work exists to protect. Added it, including why late is safe and
  early is not.
- **The invariant probe was brittle and could go silently vacuous.** It pinned
  the checkpoint count to exactly 1 (any future change to batch sizes or seed
  sizes would fail it for an unrelated reason) and guarded its one real
  assertion behind a hardcoded `includes('main.big')` — if that table key ever
  changed spelling, the test would pass while asserting nothing. Rewritten to
  track applied rows **per table**, assert non-vacuity explicitly (at least one
  save, at least one save naming a completed table), check every completed table
  in every save generically, and **fail** rather than skip if a checkpoint names
  a table the scenario has no expected row count for.

### Recorded as a tripwire, not a ticket

- `lastTableIndex` / `lastEntryIndex` are written into every checkpoint and
  serialized across the wire but **never read anywhere** in the repo. Staging
  means `lastTableIndex` can now exceed `completedTables.length` while tables
  are staged. Harmless while unread, wrong the moment someone resumes by index.
  Parked as a `NOTE:` at the write site in `snapshot-stream.ts`.

### Found but deliberately not filed

- **`applySnapshotStream` is a single ~364-line function** (measured:
  `snapshot-stream.ts` lines 370–733, file total 803 via `wc -l`), well past this
  repo's "small single-purpose functions" rule. It is a chunk-type dispatch
  switch that would decompose cleanly into per-chunk handlers over a shared
  state object. Not filed: this ticket's diff added 15 lines to a file that was
  already this size, and four open tickets already queue changes to
  `snapshot-stream.ts` (`bug-coordinator-stale-snapshot-blocks-store-open`,
  `bug-sync-recreated-table-inherits-dropped-table-metadata`,
  `bug-sync-resume-snapshot-unvalidated-checkpoint`,
  `feat-sync-client-snapshot-bootstrap`) — a decomposition ticket would conflict
  with all of them. Worth revisiting once that queue drains.

### Known coverage limits (accepted)

- **No test can reach the original danger window without editing source.** Every
  path that saves a mid-stream checkpoint is only reachable after a flush has
  already drained the previous table's rows, so no realistic interruption can
  catch a checkpoint mid-violation. The end-to-end test is therefore a strong
  resume-mechanics regression test but not proof of the fix; the invariant probe
  is what would catch a future reintroduction, and it is written generically
  over whatever checkpoints occur. Confirmed the implementer's analysis
  independently rather than taking it on trust.
- **Multi-checkpoint runs (n > 1) are not exercised** — this scenario produces
  one. The probe's assertions are written as a loop over all saves, so they
  extend to n > 1 without change.
- **Resuming from a checkpoint with no completed tables** (interruption during
  the very first table) is not covered. Lower risk: that path clears everything
  and re-streams from scratch, which is the same code the non-resumed transfer
  already exercises throughout the suite.
- Left `tickets/backlog/bug-sync-resume-snapshot-unvalidated-checkpoint` alone —
  different site (sender trusting a client-supplied checkpoint), different
  concern.
