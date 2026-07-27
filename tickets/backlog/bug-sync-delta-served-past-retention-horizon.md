description: A device that has been offline longer than the server's retention window can come back, sync, and be told everything is fine — while silently missing rows that were deleted while it was away.
files:
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/maintenance.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
difficulty: hard
----

## What happens

The sync server keeps a record of every deleted row (a "deletion marker") so that a client
which reconnects can be told "this row is gone". Those markers are not kept forever — they
expire after a retention window, configurable as `SYNC_RETENTION_HORIZON_MS`, 30 days by
default.

A client reconnects by saying "give me everything that changed after this point in time".
The server answers that question from whatever markers it still holds. If the client's
starting point is older than the retention window, some of the deletions it needs have
already expired, so the answer is **incomplete** — but the server sends it as if it were
complete, and the client accepts it as a successful sync. The two copies of the database
now disagree, permanently, with nothing reporting an error.

## Why it matters now

Until recently this was theoretical on the server: nothing ever actually removed expired
markers there, so answers were always complete no matter how far behind the client was.
The server now runs an hourly housekeeping sweep that does remove them
(`packages/sync-coordinator/src/service/maintenance.ts`, added by
`sync-coordinator-maintenance-sweeps`). Reclaiming that space is correct and desirable —
but it makes the incomplete-answer path live for the first time, and more so for any
deployment that shortens the retention window from its 30-day default.

## The missing piece

The library already knows how to answer the question "is this client too far behind to sync
incrementally?" — `SyncManager.canDeltaSync`. The coordinator even wraps it
(`CoordinatorService.canDeltaSync`). Nothing calls either one: the `get_changes` WebSocket
handler takes whatever starting point the client sends and answers it unconditionally.

## What needs to exist

- **A way for the server to say no.** The wire protocol has no "your starting point is too
  old, take a full copy instead" response for `get_changes`. That is a protocol addition,
  and it needs to be designed rather than bolted on.
- **A way for the client to recover from that answer** — fall back to fetching a full copy.
  `backlog/feat-sync-client-snapshot-bootstrap` is exactly that client-side story and
  already names this check as its trigger. These two want designing together.
- **A decision about the interim.** Until the refusal path exists, the safe operating
  guidance is "set the retention window longer than any client is ever offline", which is
  now noted in the coordinator README. Whether that is good enough, or whether the sweep
  should be opt-in until the gate lands, is a call worth making explicitly.

## Related

`backlog/feat-sync-changelog-horizon-pruning` wants to prune a *different* structure (the
index over changes) and is blocked on this same missing gate — it documents the hazard but
frames it as a reason not to start yet. This ticket is the hazard itself, which is now
reachable without that ticket landing.
