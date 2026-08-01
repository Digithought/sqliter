description: A one-shot cleanup pass now removes dead change-log bookkeeping entries left behind on devices that were syncing before an earlier leak fix landed — ready for review.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (repairChangeLog, ~line 1502)
  - packages/quereus-sync/src/sync/manager.ts (SyncManager interface, ~line 156)
  - packages/quereus-sync/src/sync/maintenance.ts (SyncMaintenanceTarget, runSyncMaintenancePass)
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts (repair sweep describe block, ~line 745)
  - packages/quereus-sync/test/sync/maintenance.spec.ts
  - packages/sync-coordinator/test/maintenance.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts (MockSyncManager)
  - docs/sync.md
  - docs/migration.md
  - packages/quereus-sync/README.md
difficulty: easy
---

## Summary

Code was already implemented and committed during the plan pass (`fc924d4a`,
`ticket(plan): debt-sync-changelog-orphan-repair-sweep`) — the plan pass
resolved the three open design questions itself (see that commit / the prior
`plan/debt-sync-changelog-orphan-repair-sweep.md`) and landed the fix directly
rather than deferring to a separate implement pass. This implement pass's job
was to verify the claims and re-run the full check suite before handoff; one
stale doc-comment bug was found and fixed along the way (see below).

## What shipped

New `SyncManagerImpl.repairChangeLog(): Promise<number>`
(`sync-manager-impl.ts:1502`) — full scan of `ChangeLogStore.getAllChanges()`,
resolving each entry through the existing private `resolveLogEntry()` (the
same resolver `collectChangesSince` uses) and deleting it via
`deleteEntryByIdentityBatch` when it resolves to `null`. One `WriteBatch` for
the whole pass, same shape as `pruneTombstones`.

Wired as a fifth sweep: added to the public `SyncManager` interface
(`manager.ts:156`), to `SyncMaintenanceTarget`, and to
`runSyncMaintenancePass` (`maintenance.ts`) right after `pruneTombstones` — no
host-side wiring needed since both hosts (`quoomb-web` worker,
`sync-coordinator`) already drive `runSyncMaintenancePass` structurally
against `SyncManager`. Runs unconditionally on every maintenance tick (no
"ran once" bookkeeping) — cheap when nothing needs repair since a clean
replica resolves every entry and deletes none.

Docs updated (`docs/sync.md`, `docs/migration.md`,
`packages/quereus-sync/README.md`): sweep count bumped 4→5, new "Repairing
pre-existing orphans" paragraph in the change-log section.

## Fixed during this pass

`packages/quereus-sync/src/sync/maintenance.ts:28` — doc comment above
`SyncMaintenanceTarget` still said "four host-driven sweeps" while the
interface itself lists five (`drainHeldChanges` / `pruneQuarantine` /
`pruneTombstones` / `repairChangeLog` / `evictExpiredBasisTables`) — a leftover
from before `repairChangeLog` was added. Corrected to "five". No behavior
change; confirmed via a scoped rebuild of `@quereus/sync` after the edit.

## Test coverage (for reviewer spot-check)

`changelog-orphan-cleanup.spec.ts`, new `describe('repair sweep
(repairChangeLog)')` block (line ~749), four cases:
- delete-entry orphan (tombstone never written) is removed, count returned is 1
- column-entry orphan (column version never written) is removed
- live entries (verified via `getChangesSince` before/after equality) survive
  a repair pass that runs alongside a genuine orphan in the same log
- idempotency: a second pass over an already-repaired log finds and deletes
  nothing

`maintenance.spec.ts` (both `@quereus/sync` and `@quereus/sync-coordinator`)
extended so their fake targets and `ALL_SWEEPS` lists include the fifth
sweep, and the coordinator's own spec exercises `repairChangeLog` through
`MaintenanceStoreSource` (confirms it does real cleanup work on a relay-only
host — it depends on neither `getTableSchema` nor `dropLocalTable`, unlike
`drainHeldChanges` / `evictExpiredBasisTables` which are inert there).

`quereus-sync-client`'s `MockSyncManager` (test double, not production code)
needed a `repairChangeLog()` stub added (returns 0) once the interface grew
the new required member — structural-typing ripple, not a logic bug.

## What was NOT independently re-derived by this pass

This implement pass did not re-derive the three design resolutions
(automatic-vs-on-demand, exposed via existing maintenance sweep vs. a new
op, count-returning) from scratch — it read the plan ticket's stated
rationale, found it consistent with the existing four-sweep architecture
(`drainHeldChanges` / `pruneQuarantine` / `pruneTombstones` /
`evictExpiredBasisTables` all already run unconditionally, host-driven, per
tick), and treated it as settled. If the review pass wants a second opinion
on those three calls, they're documented inline in the code comments above
`repairChangeLog` (`sync-manager-impl.ts:1484`) and `SyncMaintenanceTarget`
(`maintenance.ts:1`), not just in the now-deleted implement ticket body.

## Verification run this pass

- `yarn workspace @quereus/sync run build` — clean
- `yarn workspace @quereus/sync-coordinator run build` — clean
- `yarn workspace @quereus/sync run test` — 647 passing, 0 failing
- `yarn workspace @quereus/sync-coordinator run test` — 134 passing, 0 failing
- `yarn workspace @quereus/sync-client run test` — 52 passing, 0 failing
- `yarn typecheck` (whole monorepo) — clean
- `yarn lint` (whole monorepo) — clean (no-op on every package but
  `@quereus/quereus`, per that package's design)
- `yarn workspace @quereus/sync run build` re-run after the maintenance.ts
  comment fix — clean

No pre-existing test failures encountered anywhere in the run; nothing
written to `.pre-existing-error.md`.

## Gaps / things the reviewer should weigh

- No test exercises `repairChangeLog` failing mid-scan and the failure
  isolation actually kicking in for *this specific* sweep (the maintenance
  isolation tests are generic across all five steps, not `repairChangeLog`-
  specific) — low risk since the wiring is identical to the other four
  sweeps' isolation, but flagging since it wasn't singled out.
- The "cheap on a clean replica" cost claim (full `getAllChanges()` scan every
  tick) is architectural, not benchmarked — no perf test measures scan cost
  against a large change log. Matches the existing `pruneTombstones` sweep's
  cost shape exactly, so this is consistent with prior art rather than a new
  risk, but there's no regression guard if that shape ever changes.
