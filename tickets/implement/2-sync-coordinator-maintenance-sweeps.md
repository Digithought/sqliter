description: The sync server never runs any of its own housekeeping, so records it is supposed to expire and delete — deletion markers and changes held for tables it does not recognise — pile up on disk for the life of every database it hosts.
prereq: sync-changelog-orphan-cleanup
files:
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/quoomb-web/src/worker/sync-maintenance.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts
  - docs/sync.md
difficulty: medium
----

## Problem

`@quereus/sync` is deliberately timer-free. It exposes housekeeping as explicit methods and
leaves the scheduling to whoever embeds it (`docs/sync.md` § *Who drives the sweep*):

| method | reclaims |
|--------|----------|
| `drainHeldChanges()` | replays changes held for a table that has since reappeared |
| `pruneQuarantine()` | held changes past the retention horizon |
| `pruneTombstones()` | deletion markers past the retention horizon |
| `evictExpiredBasisTables()` | storage of detached tables quiet past their horizon |

The browser host does this correctly: `packages/quoomb-web/src/worker/sync-maintenance.ts`
defines a single-flight, per-sweep-error-isolated pass, and `quereus.worker.ts:800` arms it on
a 5-minute `setInterval`.

**`sync-coordinator` runs none of them.** `grep -rn "pruneTombstones\|pruneQuarantine\|evictExpiredBasisTables\|drainHeldChanges" packages/sync-coordinator/src`
returns nothing. The only timers in the package are `StoreManager.cleanup` (closes idle
stores, `store-manager.ts:168`) and the S3 snapshot scheduler — neither touches sync metadata.

So on a running coordinator, tombstones and quarantined changes accumulate for the life of
every hosted database, even though `retentionHorizonMs` (default 30 days, config'd at
`coordinator-service.ts:107`) says they should expire.

`docs/sync.md:217` currently states *"The relay-only `sync-coordinator` has **no** such loop —
with no `getTableSchema` oracle, `drainHeldChanges` is a no-op there anyway."* That
justification is correct **only for `drainHeldChanges`**. It does not apply to
`pruneTombstones` or `pruneQuarantine`, which do real work on a relay. The doc needs
correcting alongside the code.

## Related: the eligibility check is also unwired

`CoordinatorService.canDeltaSync` (`coordinator-service.ts:502`) exists but has no caller.
The `get_changes` WebSocket handler (`src/server/websocket.ts:193`) deserializes the client's
`sinceHLC` and passes it straight to `getChangesSince`. Harmless today — nothing prunes the
change log, so an arbitrarily-old `sinceHLC` still yields a complete answer. **Do not wire it
in this ticket**; it is the precondition for `backlog/feat-sync-changelog-horizon-pruning`
and belongs with that design. Mentioned here so the next reader does not rediscover it.

## Direction

Mirror the quoomb-web shape rather than inventing a second one. The tick body in
`packages/quoomb-web/src/worker/sync-maintenance.ts` is deliberately dependency-free (it takes
a structural `SyncMaintenanceTarget`, not a `SyncManager`) — the cleanest option is to lift it
into `@quereus/sync` as a shared, host-agnostic helper both hosts import, rather than copying
it. If that lift turns out to drag unwanted surface into the library, copying the ~40 lines
into the coordinator is an acceptable fallback; say which you chose and why in the handoff.

Coordinator-specific concerns the browser host does not have:

- **Multi-tenant.** One coordinator holds many `StoreEntry` values in `StoreManager.stores`
  (`store-manager.ts:141`), each with its own `syncManager`. The pass must iterate the
  currently-open stores.
- **Must not resurrect evicted stores.** Iterate only entries already in `stores`; never
  `acquire()` a database just to sweep it. A closed store's metadata is swept the next time
  it is legitimately opened and the timer fires. Adding a `NOTE:` comment about that
  trade-off is worth more than an eager scan of every database on disk.
- **Races with `cleanup()` / `closeStore()`.** A sweep is async; the store it is sweeping can
  be closed underneath it. Either take a refcount for the duration (`acquire`/`release` on an
  already-open id) or snapshot the entry list and tolerate a "store closed" throw per entry —
  the pass already isolates per-sweep errors. Pick one and comment the reasoning.
- **Cadence.** The horizon is 30 days; there is nothing latency-sensitive here (unlike
  quoomb-web, where `drainHeldChanges` gates a visible UI update). Minutes-to-hours is fine.
  Follow the existing convention and make it a documented constant, not a config knob, unless
  a knob falls out naturally from `CoordinatorConfig`.
- **`drainHeldChanges` really is a no-op** on a relay (no `getTableSchema` oracle). Include it
  anyway for symmetry with the shared pass, or omit it and comment why — implementer's call.

If `sync-changelog-orphan-cleanup` added a change-log sweep to the shared pass, include it
here too. As written, that ticket needs no sweep (it fixes the write paths), so the pass is
expected to stay at the four existing sweeps.

## TODO

- Decide shared-helper-in-`@quereus/sync` vs. copy-into-coordinator; record the choice and rationale in the handoff.
- If lifting: move the tick-body + ticker from `packages/quoomb-web/src/worker/sync-maintenance.ts` into `@quereus/sync`, re-export, and repoint quoomb-web's import. Its tests in `packages/quoomb-web/src/__tests__/sync-maintenance.test.ts` must keep passing (move them with the code if the code moves).
- Add a maintenance loop to `CoordinatorService`: start it in `initialize()`, stop it in shutdown, iterate only already-open `StoreManager` entries.
- Handle the close-during-sweep race explicitly (refcount for the duration, or tolerate-and-log); comment the choice at the call site.
- Comment (`NOTE:`) that closed-on-disk databases are not swept until next opened, and why an eager all-databases scan was rejected.
- Tests in `packages/sync-coordinator`: pass runs every sweep once per open store; a throw in one sweep or one store does not stop the rest; passes are single-flight; a closed store is skipped cleanly; the loop stops on shutdown and no timer fires after.
- Correct `docs/sync.md:217` — the "no loop on the coordinator" claim now holds only for `drainHeldChanges`; describe the coordinator's loop and its per-open-store scope.
- Run `yarn build`, `yarn workspace @quereus/sync-coordinator run test`, and `yarn workspace quoomb-web run test` (the latter only matters if the shared helper moved).
