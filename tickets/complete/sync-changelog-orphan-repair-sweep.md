description: A cleanup pass now removes dead change-log bookkeeping entries left behind on devices that were syncing before an earlier leak fix landed — reviewed and complete.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (repairChangeLog, ~line 1502)
  - packages/quereus-sync/src/sync/manager.ts (SyncManager interface, ~line 141)
  - packages/quereus-sync/src/sync/maintenance.ts (SyncMaintenanceTarget, runSyncMaintenancePass)
  - packages/sync-coordinator/src/service/maintenance.ts (cadence doc comment)
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts (repair sweep describe block)
  - packages/quereus-sync/test/sync/maintenance.spec.ts
  - packages/sync-coordinator/test/maintenance.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts (MockSyncManager)
  - docs/sync.md, docs/migration.md, packages/quereus-sync/README.md
----

## What shipped

`SyncManagerImpl.repairChangeLog(): Promise<number>` — full scan of
`ChangeLogStore.getAllChanges()`, resolving each entry through the existing private
`resolveLogEntry()` (the same resolver `collectChangesSince` uses) and deleting it via
`deleteEntryByIdentityBatch` when it resolves to `null`. One `WriteBatch` for the pass,
same shape as `pruneTombstones`. Returns the number of entries removed.

Wired as a fifth sweep on the `SyncManager` interface, `SyncMaintenanceTarget`, and
`runSyncMaintenancePass` (after `pruneTombstones`). No host-side wiring needed — both
hosts (quoomb-web worker via `createSyncMaintenanceTicker`, sync-coordinator via
`runSyncMaintenancePass`) drive the pass structurally.

Code landed in `fc924d4a` (plan pass); `9aa757cc` (implement pass) fixed one stale
doc comment and re-verified.

## Review findings

### Correctness — checked, clean

- **Deletion criterion matches the orphan definition exactly.** The main risk in a sweep
  like this is deleting *live* entries because `resolveLogEntry` returned `null` for a
  transient reason (table out of basis, schema unresolvable, quarantine). Read
  `resolveLogEntry` (`sync-manager-impl.ts:1191`): it returns `null` only when the `cv:`
  column version or `tb:` tombstone is physically absent, via identity-keyed lookups that
  need no schema. No basis/schema/quarantine filtering. Deletion criterion is sound.
- **No torn read/write window.** Verified every production writer of `cl:` entries
  (`change-applicator.ts:1064,1098`, `snapshot.ts:254`, `snapshot-stream.ts:636`,
  `sync-manager-impl.ts:950,1030`) puts the `cl:` entry and its `cv:`/`tb:` record into
  the **same** `WriteBatch` — including snapshot streaming, whose flush boundary sits
  after both puts. So a concurrent scan cannot observe a half-written pair and delete a
  live entry. The unbatched `recordColumnChange` / `recordDeletion` variants have no
  production callers (tests only).
- **Re-insert race is closed by the key.** `deleteEntryByIdentityBatch` builds the key
  from the entry's HLC, so a delete staged during the scan cannot collide with a newer
  entry written before `batch.write()` — different HLC, different key.
- **No watermark/grouping regression.** `collectChangesSince`'s transaction-boundary
  counting keys off `deterministicTxnId(logEntry.hlc)` and only increments its count for
  entries that resolve, so removing non-resolving entries leaves batch boundaries
  identical. Confirmed the only other change-log range deletion,
  `ChangeLogStore.pruneEntriesBefore`, is a different (still deliberately unwired)
  operation that *does* drop live entries — this sweep does not.

### Docs — checked, one stale comment found and fixed

`docs/sync.md`, `docs/migration.md`, and `packages/quereus-sync/README.md` were all
updated correctly (4→5 sweeps, new "Repairing pre-existing orphans" section).

**Fixed inline:** `packages/sync-coordinator/src/service/maintenance.ts:28` still said
"What actually reclaims here is `pruneTombstones` / `pruneQuarantine`" — stale, since
`repairChangeLog` depends on neither the basis oracle nor the reclaim callback and so does
real work on a relay too. `docs/sync.md` had been corrected on this point but the source
comment had not. Corrected.

### Tests — one gap found and closed

The four existing cases (delete-entry orphan, column-entry orphan, live entries survive,
idempotency) were correct but exercised only the **column** arm of `resolveLogEntry` for
the survival case — every "live entry" in them was a column entry.

**Fixed inline:** added `keeps a delete entry whose tombstone is still live` to
`changelog-orphan-cleanup.spec.ts` — inserts then deletes a row, leaving one live delete
entry backed by a real tombstone, and asserts `repairChangeLog()` returns 0 and keeps it.
Closes the delete-arm survival gap.

The implement handoff flagged that no test singles out `repairChangeLog` failing mid-scan
for the maintenance error-isolation path. Reviewed and deliberately **not** added: the
isolation tests in `maintenance.spec.ts` drive `ALL_SWEEPS` generically through the same
`runStep` wrapper, and `repairChangeLog` is now a member of that list, so it is already
covered by the generic case. A sweep-specific duplicate would test `runStep`, not
`repairChangeLog`.

### Tripwires (recorded, not filed)

- **Unparseable change-log keys are unreachable by this sweep.** `getAllChanges()` skips
  entries `parseChangeLogKey` cannot decode, so repair skips them too. Only reachable via
  key-format drift or corruption. Parked as a `NOTE:` above `repairChangeLog`.
- **Single unbounded `WriteBatch`.** The pass accumulates every orphan delete into one
  batch before writing. Identical to `pruneTombstones`' existing shape, and bounded by
  orphan count (which is zero after the first pass), so it is not a new risk — noted here
  rather than in code to avoid duplicating a comment that belongs to the shared shape.

### Major finding — ticket filed

**Filed `tickets/backlog/debt-sync-repair-changelog-rescans-every-tick.md`.** The sweep's
work is essentially one-time (orphans can only be produced by write paths that no longer
exist), but it runs unconditionally on every maintenance tick — 5-minutely in the browser
host, hourly in the coordinator. Read from the code (not benchmarked): the pass iterates
the full `cl:` range and does one key-value point read per entry, and the change log holds
roughly one entry per live cell, so a caught-up device pays ~O(live cells) reads per tick
forever for a repair that can never find anything again. Nothing is *incorrect* — this is
recurring cost that scales with database size — so it is backlog `debt-`, not a bug. A
`NOTE:` at the site points at the slug. Checked the board first: the three open tickets
touching `sync-manager-impl.ts` (`bug-sync-delta-served-past-retention-horizon`,
`bug-sync-recreated-table-inherits-dropped-table-metadata`,
`bug-sync-materialized-views-replicate-as-plain-tables`) all resolve at different sites.

### Checked, nothing found

- **Source hygiene** — `repairChangeLog` is ~20 lines, single-purpose, reuses the existing
  resolver rather than re-deriving resolution. No duplication with `pruneTombstones`
  beyond the shared batch shape, which is idiomatic here. No file-size concern.
- **Type safety** — no `any`, no casts; the interface addition is a required member, which
  is why the `MockSyncManager` test double needed a stub. Correct (structural typing
  catching an incomplete implementation is the type system working).
- **Resource cleanup / error handling** — `count` is returned only after `batch.write()`
  resolves; a throw propagates to `runStep`, which logs and continues the pass.
- **Host wiring** — confirmed `packages/quoomb-web/src/worker/quereus.worker.ts:809` uses
  `createSyncMaintenanceTicker` and `sync-coordinator/src/service/maintenance.ts:102` uses
  `runSyncMaintenancePass`, so both hosts pick up the fifth sweep with no edit. The docs'
  "runs all five sweeps" claim is accurate.

## Verification

- `yarn workspace @quereus/sync run test` — 648 passing, 0 failing (647 before, +1 new)
- `yarn workspace @quereus/sync-coordinator run test` — 134 passing
- `yarn workspace @quereus/sync-client run test` — 52 passing
- `yarn build` — clean
- `yarn typecheck` — clean
- `yarn lint` — clean

No pre-existing failures encountered; nothing written to `.pre-existing-error.md`.
