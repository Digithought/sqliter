description: A cleanup pass that can only ever find leftovers from an old bug still re-scans the entire sync history every few minutes on every device, forever, even after it has confirmed there is nothing left to clean.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # repairChangeLog (~line 1502) — the full scan
  - packages/quereus-sync/src/sync/maintenance.ts              # runSyncMaintenancePass — calls it unconditionally each tick
  - packages/quoomb-web/src/worker/quereus.worker.ts           # ~line 809 — the 5-minute host loop
  - packages/sync-coordinator/src/service/maintenance.ts       # the coordinator's hourly loop
difficulty: medium
tradeoffs: The cost is read from the code rather than measured, the sweep is correct if wasteful, and retiring it needs a durable this-device-is-clean marker that is new state to get right.
----

## What is going on

The sync engine keeps a change log: an index over the data it holds, with roughly one
entry per stored cell. An older defect could leave entries in that log pointing at
records that no longer exist ("orphans"). That defect is fixed — records and their log
entries now die together — but devices that were syncing before the fix still carry the
old orphans, so a repair sweep (`SyncManager.repairChangeLog`) was added to clean them
out.

The sweep runs on every maintenance tick, unconditionally: every 5 minutes in the
browser host, hourly in the coordinator. Each run reads the whole change log and does one
storage lookup per entry to ask "does your target still exist?".

## Why that is a problem

The work the sweep exists to do is essentially **one-time**. Orphans can only be created
by write paths that no longer exist. Once a device has completed one clean pass, every
subsequent pass reads the entire change log and finds nothing, forever.

Cost, as read from the code (not benchmarked): `repairChangeLog` iterates the full `cl:`
key range and calls `resolveLogEntry` per entry, which is a single key-value point read
(`getColumnVersionByIdentity` or `getTombstoneByIdentity`). So a caught-up device pays
roughly one storage read per live cell it holds, per tick. On a small database that is
noise. On a large one, on a browser device on a 5-minute cadence, it is a recurring cost
with no possible benefit.

There is one residual source of new orphans, so the sweep cannot simply be deleted after
running once: `pruneTombstones` (same file, ~line 1446) warns and leaves an entry
orphaned when it hits a tombstone key it cannot parse. That is rare and already a
warning-level anomaly.

## What we want instead

Some form of "stop paying full price once the log is known clean" — the shape is open.
Reasonable directions, not a decision:

- Persist a "repaired" marker after a pass that deletes nothing, and skip (or heavily
  down-cadence) later passes unless something invalidates it.
- Give the sweep its own much slower cadence than the rest of the maintenance pass,
  independent of the 5-minute drain cadence that sets the current tick rate.
- Make it a host-invoked one-shot (e.g. at sync-module init only) rather than a member of
  the periodic pass.

Whichever is chosen, the residual `pruneTombstones` orphan path above should still be
reachable by cleanup eventually.

## Not urgent

Nothing is incorrect today; an orphan produces no output and the sweep deleting it
changes nothing observable. This is purely recurring cost that scales with database size.
