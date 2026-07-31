description: Hardened the receiver side of database-copy resume logic so a table can never be marked "fully copied" while a few of its rows are still only in memory, and added the missing tests for resuming an interrupted copy — no user-visible bug existed at HEAD, this closes an undocumented, only-accidentally-safe gap.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts  # applySnapshotStream: staged-then-graduated completedTables
  - packages/quereus-sync/test/sync/snapshot-resume.spec.ts  # new: interrupt+resume e2e, checkpoint invariant probe
  - packages/quereus-sync/test/sync/snapshot-stream-order.spec.ts  # unmodified, nearest sibling coverage/style
  - packages/quereus-sync/test/sync/_peer-harness.ts  # unmodified, shared test harness used by the new spec
difficulty: easy
----

## What changed

`packages/quereus-sync/src/sync/snapshot-stream.ts`, `applySnapshotStream`:

- Added `stagedCompletedTables`. The `table-end` handler now pushes the
  just-finished table's key here instead of directly into `completedTables`.
- `flushDataToStore` (the function that actually calls `applyDataToStore` and
  awaits its return) now graduates every staged table into `completedTables`
  immediately after that await, then clears the staging array.

Net effect: a table can only appear in a **saved checkpoint's**
`completedTables` after its rows have durably returned from `applyDataToStore`.
Before this change the same thing happened to be true today, but only because
one *other*, unrelated flush (the `tombstone` handler's DDL-ordering
`flushDataToStore()` call, added by a prior ticket) always ran first. Nothing
enforced the ordering; a future refactor of that unrelated flush could have
silently reopened the gap. Full investigation, code trace, and a reverted
counter-experiment proving the pre-fix gap (commenting out that one line
reproducibly lost 50 of 150 rows on resume) are preserved in this repo's git
history on the `implement/` version of this ticket.

**This is hardening, not an observable-bug fix.** No data loss was reproducible
at HEAD; do not describe this as fixing user-visible corruption.

## Tests added (`snapshot-resume.spec.ts`)

Two specs, both using the real engine via `_peer-harness.ts` (no mocked
storage):

1. **`resuming an interrupted snapshot transfer`** — seeds a 150-row table
   (`big`, `DATA_FLUSH_SIZE + 50`) and a 1000-row table (`filler`), streams a
   real snapshot into a fresh receiver via a wrapper that throws instead of
   delivering the final `footer` chunk (simulating a dropped connection),
   confirms the receiver's saved checkpoint marks only `main.big` complete,
   then drives `resumeSnapshotStream` back into the same receiver and asserts
   **every row of both tables** is present and the last row of each table has
   its correct value.
2. **`checkpoint invariant probe`** — reproduces the exact scenario from the
   manual verification during investigation (`big`: 150 rows; `ghost`: 1200
   rows inserted then fully deleted, so its tombstone flush crosses the
   internal 1000-row metadata-batch bound and fires a real mid-stream
   checkpoint save). Monkey-patches the receiver's `applyToStore` (counts rows
   actually returned as applied) and `kv.put` (captures `completedTables` on
   every `sc:` checkpoint write) to assert: the one checkpoint this run saves
   never names a table as complete before that table's row count is durable.
   Runtime ~3s; both `it`s set an explicit 10s mocha timeout (default 2s is too
   short).

Both specs passed; full suite: `yarn workspace @quereus/sync test` → 639
passing, 0 failing. `yarn workspace @quereus/sync run typecheck` → clean.
`yarn workspace @quereus/sync run lint` → no-op (only `packages/quereus` has a
real lint config).

## Gaps / things the reviewer should know

- **Test 1 (interrupt+resume) cannot, by construction, hit the exact historical
  danger window.** I traced the code carefully: every code path that can save a
  checkpoint mid-stream is only reachable *after* some `flushDataToStore()` call
  has already drained the previous table's pending rows (either the tombstone
  handler's unconditional flush, or a later table's `table-start` flush). So no
  realistic chunk-stream interruption can catch a checkpoint naming a table
  complete while rows are still pending — that window is only reachable by
  literally deleting the tombstone-handler's flush line (which I did, and
  reverted, during investigation). Test 1 is therefore a strong **resume-
  mechanics** regression test (proves interrupt+resume loses nothing end-to-end
  across a completed table and an in-flight one) but is not itself proof the
  fix prevents the originally-predicted bug — test 2 (the invariant probe) is
  the one that encodes the actual invariant generically, so it would fail if a
  future change reintroduced the gap in some new way.
- **Test 2 exercises exactly one checkpoint save per run** (`checkpointSaves.length`
  asserted `=== 1`, matching the scenario's known behavior). The invariant
  assertion loop is written generically over all captured saves, but this
  scenario only ever produces one, so multi-checkpoint sequences aren't
  exercised. If a future change makes checkpoints fire more often (e.g. smaller
  `BATCH_FLUSH_SIZE`, or more heavily-deleted tables), this same probe should
  still catch a violation — just untested at n>1 today.
- Did not automate the counter-experiment (temporarily removing the tombstone
  handler's `flushDataToStore()` call) as a permanent regression test — that
  would require either patching module internals not currently exported, or a
  build-time toggle, and wasn't in the TODO list. The manual result is recorded
  in the `implement/`-stage ticket body (now in git history) for anyone who
  wants to re-run it by hand.
- Left `tickets/backlog/bug-sync-resume-snapshot-unvalidated-checkpoint` alone —
  different site (sender/coordinator trusting a client-supplied checkpoint),
  different concern, per the original ticket's explicit note.
