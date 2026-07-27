description: The sync server now runs its own periodic housekeeping, so expired deletion markers and held-aside changes are cleaned up instead of piling up on disk forever.
files:
  - packages/quereus-sync/src/sync/maintenance.ts
  - packages/quereus-sync/src/index.ts
  - packages/quereus-sync/test/sync/maintenance.spec.ts
  - packages/sync-coordinator/src/service/maintenance.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/sync-coordinator/src/service/index.ts
  - packages/sync-coordinator/test/maintenance.spec.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts
  - docs/sync.md
  - docs/migration.md
difficulty: medium
----

## What changed

`@quereus/sync` exposes four housekeeping sweeps (`drainHeldChanges`, `pruneQuarantine`,
`pruneTombstones`, `evictExpiredBasisTables`) and deliberately schedules none of them — the
embedding host owns the timer. The browser host did that; `sync-coordinator` did not, so
tombstones and quarantined changes accumulated for the life of every hosted database despite
a 30-day `retentionHorizonMs`. This adds the coordinator's loop.

**Decision: lifted the shared tick body into `@quereus/sync` rather than copying it.** The
quoomb-web module was already dependency-free (a structural `SyncMaintenanceTarget`, no
`SyncManager` import, no timer), so moving it drags no new surface into the library — it is
the *shape* of one pass (sweep order, per-sweep error isolation, single-flight), which is
exactly the thing both hosts should agree on. The library still arms no timer.

| moved from | moved to |
|---|---|
| `packages/quoomb-web/src/worker/sync-maintenance.ts` | `packages/quereus-sync/src/sync/maintenance.ts` (re-exported from the package root) |
| `packages/quoomb-web/src/__tests__/sync-maintenance.test.ts` (vitest) | `packages/quereus-sync/test/sync/maintenance.spec.ts` (mocha/chai — the sync package's framework) |

`quereus.worker.ts` now imports `SYNC_MAINTENANCE_INTERVAL_MS` / `createSyncMaintenanceTicker`
from `@quereus/sync`; nothing about its behaviour changed.

**Coordinator loop** — `packages/sync-coordinator/src/service/maintenance.ts`:

- `runCoordinatorMaintenancePass(source, log)` — snapshots the open-store list, then for each
  store pins it, runs the library pass, releases. Never rejects: failures are isolated per
  sweep (by the library) *and* per store (here), so one bad tenant cannot starve the rest.
- `CoordinatorMaintenanceLoop` — hourly timer (`COORDINATOR_MAINTENANCE_INTERVAL_MS`, a
  documented constant, not a config knob). `CoordinatorService.initialize()` starts it;
  `shutdown()` stops it *before* `StoreManager.shutdown()` closes the stores.

**Race handling — chose refcount pinning over tolerate-and-log.** Two new `StoreManager`
methods: `openDatabaseIds()` (array copy of the open set) and `acquireIfOpen()` (synchronous
refcount bump; returns `undefined` if the store is not open, and **never opens one**), paired
with `releasePin()`. Rationale, commented at both sites: the failure being avoided is not a
clean "store closed" throw, it is a sweep issuing reads against a LevelDB handle that closes
mid-scan. `acquireIfOpen`'s sync section is atomic against `closeStore`'s equally-sync
"guard then delete" section, which is the invariant already documented on `closeStore`.

`acquireIfOpen`/`releasePin` deliberately do **not** touch `lastAccess` — a background sweep
is not user access, and refreshing it every pass would hold otherwise-idle stores above the
idle-close threshold. That is why `releasePin` exists instead of reusing `release()`
(`release` refreshes `lastAccess`; both delegate to a private `decRef(id, touch)`).

**`drainHeldChanges` is called anyway** even though it is inert on a relay (no
`getTableSchema` oracle → returns 0), for symmetry with the shared pass and because it costs
nothing. Same for `evictExpiredBasisTables` (no `dropLocalTable` callback → returns 0). The
two that do real work on a coordinator are `pruneTombstones` and `pruneQuarantine`.

Docs corrected: `docs/sync.md` § *Who drives the sweep* said the coordinator has no loop —
that justification only ever held for `drainHeldChanges`. Now describes the coordinator loop,
its per-open-store scope, and the hourly cadence. `docs/migration.md` carried the same stale
claim in its § *Where the maintenance path lives*; corrected too.

## Use cases to validate

- **The reclaim actually happens.** Run a coordinator with a short `retentionHorizonMs`, apply
  some deletes, wait a maintenance interval, confirm tombstone keys (`tb:` prefix) are gone
  from the store. The tests here use fakes and one real-LevelDB smoke pass; **no test proves
  a tombstone is actually deleted end-to-end through the coordinator's loop.** Known gap.
- **Multi-tenant fan-out.** Two databases open, both swept in one pass; a third that is on
  disk but closed is not swept and is not opened.
- **Shutdown.** `CoordinatorService.shutdown()` while a pass is mid-sweep — `stop()` awaits
  the in-flight pass, so no sweep is reading a store when `StoreManager.shutdown()` closes it.
- **Idle-close interaction.** A store swept by the loop must still reach the idle-close
  threshold on schedule (this is what the `lastAccess` carve-out protects; there is a unit
  test for the field, not for the end-to-end close timing).
- **Browser host unchanged.** quoomb-web's maintenance behaviour (5-min cadence, immediate
  startup pass, local-create drain listener) must be byte-for-byte the same after the import
  move.

## Known gaps / things to look at

- **No end-to-end reclaim test.** As above: coverage is `runCoordinatorMaintenancePass` over
  fakes, plus one pass over a real `StoreManager` + real `SyncManager` that asserts only "does
  not throw, refcount returns to 0" (nothing is expired in that fixture). A test that seeds an
  expired tombstone and asserts it is gone after a pass would be stronger.
- **Timer tests use real timers** (1–10 ms intervals with `setTimeout` waits). They passed
  repeatedly here but are wall-clock-sensitive and could flake on a loaded CI box. A fake-timer
  approach was not attempted (mocha here has no sinon).
- **`CoordinatorService.initialize()` / `shutdown()` wiring is not directly tested** — the loop
  is tested in isolation. The existing `service.spec.ts` does not cover timer lifecycle.
- **`acquireIfOpen` skips during shutdown** (returns `undefined` once `_shuttingDown`), which
  means a pass that starts during shutdown sweeps nothing. Intended, untested.
- **Cadence is a constant, not config.** If a deployment wants tuning, that is a follow-up.
- **`canDeltaSync` remains unwired**, as the ticket instructed — it belongs with
  `backlog/feat-sync-changelog-horizon-pruning`. Not touched.
- Tripwire parked as a `NOTE:` in `runCoordinatorMaintenancePass`: only already-open databases
  are swept; a database closed on disk keeps its expired metadata until it is next opened. An
  eager all-databases scan was rejected because with disk eviction enabled it would re-download
  cold databases from S3.

## Validation run

- `yarn build` — clean.
- `yarn typecheck` (all workspaces) — clean.
- `yarn workspace @quereus/sync-coordinator run test` — 132 passing (13 new).
- `yarn workspace @quereus/sync run test` — 495 passing (includes the 7 moved tests).
- `yarn workspace @quereus/quoomb-web run test` — 68 passing.
- `yarn test` (full workspace sweep) — green, no failures.
