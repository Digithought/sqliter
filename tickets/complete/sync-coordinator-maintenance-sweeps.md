description: The sync server now runs its own periodic housekeeping, so expired deletion markers and held-aside changes are cleaned up instead of piling up on disk forever.
files:
  - packages/quereus-sync/src/sync/maintenance.ts
  - packages/quereus-sync/src/index.ts
  - packages/quereus-sync/README.md
  - packages/quereus-sync/test/sync/maintenance.spec.ts
  - packages/sync-coordinator/src/service/maintenance.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/sync-coordinator/src/service/index.ts
  - packages/sync-coordinator/test/maintenance.spec.ts
  - packages/sync-coordinator/README.md
  - packages/quoomb-web/src/worker/quereus.worker.ts
  - docs/sync.md
  - docs/migration.md
----

## What shipped

`@quereus/sync` exposes four housekeeping sweeps (`drainHeldChanges`, `pruneQuarantine`,
`pruneTombstones`, `evictExpiredBasisTables`) and schedules none of them — the host owns the
timer. The browser worker had a loop; `sync-coordinator` did not, so deletion markers and
quarantined changes accumulated for the life of every hosted database despite a 30-day
`retentionHorizonMs`. The coordinator now has one.

- **Shared pass body lifted into the library.** The quoomb-web tick runner
  (`sync-maintenance.ts`) moved to `packages/quereus-sync/src/sync/maintenance.ts` and is
  re-exported from the package root as `runSyncMaintenancePass` /
  `createSyncMaintenanceTicker` / `SYNC_MAINTENANCE_INTERVAL_MS`. The move is comment-only —
  no behaviour change, and the library still arms no timer. Its tests moved with it
  (vitest → the sync package's mocha/chai).
- **Coordinator loop** — `packages/sync-coordinator/src/service/maintenance.ts`.
  `runCoordinatorMaintenancePass` snapshots the open-store list, then pins / sweeps /
  releases each store in turn; failures are isolated per sweep (by the library) and per
  store (here). `CoordinatorMaintenanceLoop` runs it hourly, started by
  `CoordinatorService.initialize()` and stopped — with the in-flight pass awaited — before
  `StoreManager.shutdown()` closes the stores.
- **Refcount pinning** — new `StoreManager.openDatabaseIds()` / `acquireIfOpen()` /
  `releasePin()`. `acquireIfOpen` bumps the refcount synchronously and never opens a store,
  so it is atomic against `closeStore`'s equally-synchronous guard-then-delete. Neither pin
  nor unpin touches `lastAccess`: a background sweep is not user access, and refreshing it
  would hold idle stores above the idle-close threshold forever.
- **Docs** — `docs/sync.md` § *Who drives the sweep* and `docs/migration.md` § *Where the
  maintenance path lives* both claimed the coordinator has no loop; corrected.

## Review findings

### Checked

Read the implement diff before the handoff summary. Went through: the library move (verified
comment-only against the pre-move file), the coordinator loop, the `StoreManager` refcount
additions, both test files, and every doc/README the change touches or should have touched.
Ran `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test` (all workspaces) plus an explicit
`tsc -p packages/sync-coordinator/tsconfig.test.json --noEmit`, since the package's default
`typecheck` does not cover its test files.

Verified by reading the implementations rather than trusting the comments:

- `evictExpiredBasisTables` really does return 0 without a `dropLocalTable` callback, and
  `drainHeldChanges` really does return 0 without a `getTableSchema` oracle — so the two
  sweeps the coordinator calls for symmetry are inert there, as claimed. They are also
  genuinely free rather than merely cheap: with no oracle, out-of-basis detection never
  quarantines anything, so both sweeps exit on an empty list before doing any work.
- The pin/close race argument holds. `closeStore` re-checks `refCount > 0` inside the same
  synchronous section that removes the entry, so a pinned store cannot be closed underneath
  a sweep, and a store closed since the snapshot yields `undefined` and is skipped.
- Shutdown ordering is right: the loop is stopped and its in-flight pass awaited before
  `StoreManager.shutdown()` (which closes stores regardless of refcount).
- quoomb-web is untouched behaviourally — only the import source changed, and no stale
  reference to the old module path survives.

### Found and fixed here (minor)

- **No end-to-end reclaim test.** The implementer flagged this; the existing coverage proved
  the plumbing (fan-out, pinning, isolation) but never that a record actually leaves the
  store. Added two tests to `packages/sync-coordinator/test/maintenance.spec.ts` over real
  `StoreManager` + real LevelDB + real `SyncManager`s with a negative retention horizon: one
  applies an inbound delete, confirms a peer can see it, runs a pass, and confirms it is
  gone; the other does the same across two open tenants in a single pass. Expiry is asserted
  through `getChangesSince` rather than by scanning `tb:` keys — that is what a peer actually
  observes, and it does not depend on the library's key layout. Coordinator suite: 132 → 134.
- **`@quereus/sync` README did not list the new public exports.** Its § *API* enumerates the
  package surface and now has a *Maintenance Exports* subsection covering
  `runSyncMaintenancePass`, `createSyncMaintenanceTicker`, `SYNC_MAINTENANCE_INTERVAL_MS`,
  and the two types — including the trap that a collapsed tick does not join the running pass.
- **`sync-coordinator` README documented no retention or housekeeping behaviour at all**, and
  its environment-variable table omitted `SYNC_RETENTION_HORIZON_MS` and `SYNC_BATCH_SIZE`.
  Both rows added, plus a short *Housekeeping* section stating the hourly cadence, that only
  already-open databases are swept, and the offline-client caveat below.

### Found and filed (major)

- **`backlog/bug-sync-delta-served-past-retention-horizon`** — the sweep is correct, but it
  makes a previously-dormant hazard live. The server answers a returning client's "give me
  everything after this point" from the deletion markers it still holds; this change is the
  first thing that ever removes those markers on a coordinator. A client offline longer than
  the retention window now receives a silently incomplete delta and accepts it as a
  successful sync. `SyncManager.canDeltaSync` exists to refuse exactly this, and
  `CoordinatorService.canDeltaSync` wraps it, but nothing calls either — the `get_changes`
  handler answers whatever starting point the client sends. Fixing it needs a protocol
  addition (a "too far behind, take a full copy" response) and the client-side fallback
  tracked in `backlog/feat-sync-client-snapshot-bootstrap`, so it is a design ticket, not an
  inline fix. `backlog/feat-sync-changelog-horizon-pruning` documents the same gap but frames
  it as conditional on work that has not landed; it is now reachable without that work.

### Tripwires (recorded, not ticketed)

- Pinning a store makes it ineligible for LRU eviction for the duration of its sweep. Invisible
  today — one store at a time, and an empty scan is instant — but if sweeps ever get slow on a
  coordinator sitting at `maxOpenStores`, an acquire can hit "Cannot evict, all stores have
  active references" and open past the cap. Parked as a `NOTE:` at the pin site in
  `packages/sync-coordinator/src/service/maintenance.ts`.
- The already-parked `NOTE:` in `runCoordinatorMaintenancePass` (only resident databases are
  swept; a database closed on disk keeps its expired metadata until reopened) was reviewed and
  left as-is — the rejected alternative, an eager all-databases scan, would re-download cold
  databases from S3 where disk eviction is enabled.

### Noted, deliberately not acted on

- **Timer tests use real timers** (1 ms intervals, 20–30 ms waits). Green across repeated runs
  here and the margin is ~20×, so the flake risk does not justify introducing a fake-timer
  dependency into a mocha suite that has none. If it ever flakes on CI, that is the fix.
- **`CoordinatorService.initialize()` / `shutdown()` timer wiring has no dedicated test.** It is
  smoke-covered: every case in `service.spec.ts` initializes and shuts down a real service, so
  a loop that failed to disarm would hang or leak the suite. A dedicated test would assert
  little more.
- **Cadence is a constant, not a config knob.** Correct for now; promoting it is a one-line
  change if a deployment ever needs it.
- **`canDeltaSync` remains unwired.** Out of scope for this ticket by instruction, and now
  covered by the filed bug above.

### Empty categories

- No correctness defects in the loop, the pass, or the refcount additions. The pin/close and
  single-flight/stop races were each traced by hand against the code and hold.
- No resource-cleanup issues: the pin is released in a `finally`, the timer is cleared in
  `stop()`, and `stop()` awaits the in-flight pass.
- No type-safety issues: no `any`, and the structural `MaintenanceStoreSource` is proven
  assignable from a real `StoreManager` by the tests that pass one directly.
- No source-hygiene issues: both new modules are short and single-purpose (185 and 111 lines),
  functions are small, and the comments explain decisions rather than restating code.

## Validation

- `yarn build` — clean.
- `yarn typecheck` (all workspaces) — clean.
- `tsc -p packages/sync-coordinator/tsconfig.test.json --noEmit` — clean.
- `yarn lint` — clean.
- `yarn test` (all workspaces) — green, 0 failing. `@quereus/sync-coordinator` 134 passing
  (13 from implement + 2 added here), `@quereus/sync` 495 passing, `quoomb-web` 68 passing.
