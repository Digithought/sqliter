description: Devices that had already been syncing before the recent leak fix landed still carry dead bookkeeping entries the fix cannot reach; add a one-shot cleanup pass that finds and removes them.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/manager.ts
  - packages/quereus-sync/src/sync/maintenance.ts
  - packages/quereus-sync/test/sync/maintenance.spec.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/sync-coordinator/test/maintenance.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - docs/sync.md
  - docs/migration.md
  - packages/quereus-sync/README.md
difficulty: easy
----

## Status: implementation already landed during design resolution

This ticket's three open design questions (from `plan/debt-sync-changelog-orphan-repair-sweep.md`)
had defensible defaults once the existing maintenance-sweep architecture was read, so the
plan pass resolved them and implemented the fix directly rather than leaving them for a
separate implement pass:

- **Runs automatically, as a periodic sweep** (not on-demand-only): it is added as a fifth
  method alongside the four existing host-driven sweeps (`drainHeldChanges` /
  `pruneQuarantine` / `pruneTombstones` / `evictExpiredBasisTables`), all of which already
  run unconditionally on every maintenance tick. No "ran once" bookkeeping was added —
  the sweep is a full scan every tick, but cheap: a replica with nothing to repair
  resolves every entry and deletes none, same shape as `pruneTombstones`.
- **Exposed through the existing maintenance sweep**, not a separate operation: added to
  `SyncMaintenanceTarget` (`src/sync/maintenance.ts`) and called from
  `runSyncMaintenancePass`, so both hosts (`quoomb-web` worker, `sync-coordinator`) pick
  it up automatically — no host-side wiring needed, since both already drive
  `createSyncMaintenanceTicker` / `runSyncMaintenancePass` structurally against
  `SyncManager`.
- **Reports a count**: `repairChangeLog(): Promise<number>` returns the number of
  entries removed, matching `pruneTombstones` / `pruneQuarantine`.

## What shipped

New method `SyncManagerImpl.repairChangeLog()` (`sync-manager-impl.ts`, next to
`pruneQuarantine`): a full scan of `ChangeLogStore.getAllChanges()`, resolving each entry
through the existing private `resolveLogEntry()` (the same resolver `collectChangesSince`
uses) and deleting it via `ChangeLogStore.deleteEntryByIdentityBatch` when it resolves to
`null`. One `WriteBatch` for the whole pass, written once at the end — the same shape
`pruneTombstones` already uses.

Added to the public `SyncManager` interface (`manager.ts`) and to `SyncMaintenanceTarget`
(`maintenance.ts`), wired into `runSyncMaintenancePass` right after `pruneTombstones` (no
ordering dependency on any other sweep — placed there because both act on the change log).

Docs updated: `docs/sync.md` (new "Repairing pre-existing orphans" paragraph in the
change-log section; "four sweeps" → "five sweeps" in the Who-drives-the-sweep section,
including the coordinator-cadence bullet, since `repairChangeLog` — like
`pruneTombstones`/`pruneQuarantine` — needs no basis oracle and does real work on a
relay), `docs/migration.md` (same sweep-count/list updates), `packages/quereus-sync/README.md`
(Maintenance Exports section).

## Edge cases & interactions

- **Idempotency.** A second `repairChangeLog()` pass over an already-repaired log finds
  nothing and deletes nothing (covered by a dedicated test).
- **Live entries untouched.** The scan must not remove an entry whose target is still
  live, verified by asserting `getChangesSince` returns identical output before/after a
  repair pass that runs alongside live data (covered).
- **Relay / no-oracle hosts.** `repairChangeLog` depends on neither `getTableSchema` nor
  `dropLocalTable`, so — unlike `drainHeldChanges` / `evictExpiredBasisTables` — it is
  *not* inert on the relay-only `sync-coordinator`; it does real cleanup work there too.
  Confirmed by reading `resolveLogEntry`'s dependencies (only `columnVersions` /
  `tombstones`, both present on every host) and by the coordinator's own maintenance
  spec exercising it through the same `SyncMaintenanceTarget` structural type.
- **Failure isolation.** Wired through the existing `runStep` wrapper in
  `runSyncMaintenancePass`, so a throw from `repairChangeLog` is logged and the
  remaining sweeps still run — no special-casing needed, covered by the existing
  isolation tests (extended to include the fifth sweep).
- **Both entry types.** `ChangeLogEntry.entryType` is `'column' | 'delete'`; both must
  resolve through `resolveLogEntry` and both are deleted through the same
  `deleteEntryByIdentityBatch` call (which threads `column` through only when the entry
  is a `'column'` entry). Covered by a test per entry type.
- **Structural typing ripple.** Adding a required method to `SyncManager` breaks any
  hand-written mock that `implements SyncManager` without a build step picking up the
  new member. Found and fixed one: `MockSyncManager` in
  `packages/quereus-sync-client/test/sync-client.spec.ts` needed a `repairChangeLog()`
  stub (returns 0, matching its existing `pruneTombstones`/`pruneQuarantine` stubs).
  `yarn typecheck` across the whole monorepo is the guard against a second one existing
  elsewhere.

## Verification already run

- `yarn workspace @quereus/sync run build` and `yarn workspace @quereus/sync-coordinator run build` — clean.
- `yarn build` (whole monorepo, all packages + 3 bundled apps) — clean.
- `yarn typecheck` (whole monorepo) — caught and required the `MockSyncManager` fix above; clean after.
- `yarn lint` (whole monorepo) — clean.
- `yarn test` (whole monorepo, all workspaces) — **green, 0 failing**: `@quereus/sync` 647 passing (including 4 new `repairChangeLog` tests + updated 5-sweep maintenance-pass tests), `@quereus/sync-coordinator` 134 passing (including the updated maintenance spec exercising `repairChangeLog` through `MaintenanceStoreSource`), `@quereus/sync-client` 52 passing, plus all other workspaces green. No pre-existing failures encountered; `.pre-existing-error.md` not written.

## TODO (all completed — listed for the reviewer to spot-check)

- [x] `SyncManagerImpl.repairChangeLog()` — full change-log scan, deletes entries `resolveLogEntry` resolves to `null`, single batch write, returns count.
- [x] Add `repairChangeLog(): Promise<number>` to the `SyncManager` interface (`manager.ts`) with doc comment matching the sibling sweeps' style.
- [x] Add `repairChangeLog` to `SyncMaintenanceTarget` and to the `runSyncMaintenancePass` step sequence (`maintenance.ts`), updating its ordering doc comment.
- [x] Update `maintenance.spec.ts` (both `quereus-sync` and `sync-coordinator`) fake targets and `ALL_SWEEPS` lists to include the fifth sweep.
- [x] Add `repairChangeLog` tests to `changelog-orphan-cleanup.spec.ts`: delete-entry orphan, column-entry orphan, live-entries-untouched, idempotency.
- [x] Fix `MockSyncManager` in `quereus-sync-client`'s spec to implement the new interface member.
- [x] Update `docs/sync.md`, `docs/migration.md`, `packages/quereus-sync/README.md` sweep counts/lists and add the "Repairing pre-existing orphans" explanation.
- [x] Run `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test` across the whole monorepo and confirm green.
