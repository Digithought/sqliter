description: Let a sync server forget its index of old changes after a set retention period, so a database that has been running for years does not carry an index entry for data nobody will ever ask for incrementally again — which first requires the server to tell far-behind clients "you are too far behind, take a full copy instead."
prereq: sync-changelog-orphan-cleanup
files:
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
difficulty: hard
----

## Background

`@quereus/sync` keeps an HLC-ordered index (KV prefix `cl:`, the "change log") over the live
per-cell values and deletion markers. Its sole purpose is to let a peer say "give me
everything after this point in time" and get a forward range-scan instead of a full database
scan. Bootstrap-from-nothing and full snapshots read the underlying data directly and never
consult it.

After `sync-changelog-orphan-cleanup` lands, that index is bounded by live data size — one
entry per live cell, one per live deletion marker. That is a legitimate cost, not a leak, so
this ticket is an **optimisation**, not a bug fix.

## The idea

`ChangeLogStore.pruneEntriesBefore(hlc)` already exists and is correct: change-log keys sort
by `(wallTime, counter, siteId, opSeq)`, exactly `compareHLC`'s field order, so its
scan-and-stop-at-the-boundary logic is sound. It has never been called.

Calling it with `Date.now() - retentionHorizonMs` would cap index size by *time* rather than
by dataset size — attractive for a long-lived server hosting large, mostly-cold databases.
The argument that it is safe: `SyncManager.canDeltaSync` already declares a peer whose last
sync predates the retention horizon ineligible for incremental sync, so by construction no
eligible peer can ask for a range that pruning removed.

## Why it is not safe today

That argument holds only if the eligibility check is actually enforced. It is not.

`canDeltaSync` has **no production caller**. `CoordinatorService.canDeltaSync`
(`coordinator-service.ts:502`) wraps it but nothing calls the wrapper; the `get_changes`
WebSocket handler (`websocket.ts:193`) deserializes whatever `sinceHLC` the client sent and
passes it straight to `getChangesSince`.

Enable horizon pruning without fixing that and a client that has been offline past the
horizon receives a **silently truncated** delta — it looks like a successful sync but the
replica has permanently missed writes. Silent divergence is strictly worse than an index that
is larger than it needs to be.

## What has to be designed first

- **How does the server refuse?** Today's wire protocol has no "your starting point is too
  old, take a snapshot" response for `get_changes`. That is a protocol addition.
- **What does the client do with the refusal?** It has to fall back to snapshot bootstrap.
  `backlog/feat-sync-client-snapshot-bootstrap` covers exactly that client-side story and
  already names `canDeltaSync` as the trigger — these two should almost certainly be designed
  together, and this one should not start first.
- **Is time-based even the right axis?** The alternative is watermark-based: prune below the
  minimum `lastSyncHLC` across known peers, which is exactly lossless but requires trusting
  peer-state bookkeeping and does nothing for a peer that never returns. Worth comparing
  before committing to the horizon approach.
- **Cost of the sweep itself.** `pruneEntriesBefore` accumulates every deleted key into one
  unbounded `WriteBatch` before writing. On a first run over a long-neglected log that is a
  large memory spike; it likely needs chunking.

Not urgent. Revisit when a deployment shows the change log is materially larger than the data
it indexes, or when snapshot bootstrap lands and makes the refusal path cheap to add.
