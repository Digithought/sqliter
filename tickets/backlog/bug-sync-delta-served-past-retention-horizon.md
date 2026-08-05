description: A device that has been offline longer than the server keeps its history can come back, sync, and be told everything is fine while silently missing data — and because the server has no way to refuse such a request, the server also cannot safely clean up old history it will never need again.
prereq: feat-sync-client-snapshot-bootstrap
files:
  - packages/sync-coordinator/src/server/websocket.ts          # get_changes handler (~line 193) — passes any sinceHLC straight through
  - packages/sync-coordinator/src/service/coordinator-service.ts # canDeltaSync wrapper (~line 502) — no caller
  - packages/sync-coordinator/src/service/maintenance.ts        # the hourly sweep that made this reachable
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # SyncManager.canDeltaSync — no production caller
  - packages/quereus-sync/src/metadata/change-log.ts            # ChangeLogStore.pruneEntriesBefore — exists, never called
difficulty: hard
repro: static
severity: corruption
likelihood: unusual
tradeoffs: Requires a device offline longer than the retention horizon, the fix adds a wire-protocol response every client must learn, and it is gated on the snapshot-bootstrap work landing first.
----

## Root cause: the server cannot say "you are too far behind"

A client reconnects by saying "give me everything that changed after this point in time". The
`get_changes` WebSocket handler (`websocket.ts:193`) deserializes whatever `sinceHLC` the
client sent and passes it straight to `getChangesSince`, unconditionally. The wire protocol has
**no response meaning "your starting point is too old, take a full copy instead"**.

The library already knows how to answer the eligibility question —
`SyncManager.canDeltaSync` declares a peer whose last sync predates the retention horizon
ineligible for incremental sync, and `CoordinatorService.canDeltaSync`
(`coordinator-service.ts:502`) wraps it. **Neither has a production caller.**

That single missing protocol addition is both a live correctness bug (Arm A) and the reason a
straightforward storage optimisation cannot be enabled (Arm B). Arm B's own body says it is
unsafe until the server can refuse a too-old request — which *is* Arm A. Designing the refusal
once serves both.

## Arm A (bug, live today) — an incomplete delta is served as if complete

The sync server keeps a record of every deleted row (a "deletion marker") so a reconnecting
client can be told "this row is gone". Those markers are not kept forever — they expire after
a retention window, configurable as `SYNC_RETENTION_HORIZON_MS`, 30 days by default.

If the client's starting point is older than the retention window, some of the deletions it
needs have already expired, so the answer is **incomplete** — but the server sends it as if it
were complete, and the client accepts it as a successful sync. The two copies of the database
now disagree, permanently, with nothing reporting an error.

**Why it matters now:** until recently this was theoretical on the server — nothing ever
actually removed expired markers, so answers were always complete no matter how far behind the
client was. The server now runs an hourly housekeeping sweep that does remove them
(`packages/sync-coordinator/src/service/maintenance.ts`, added by
`sync-coordinator-maintenance-sweeps`). Reclaiming that space is correct and desirable — but it
makes the incomplete-answer path live for the first time, and more so for any deployment that
shortens the retention window from its 30-day default.

**A decision about the interim is needed.** Until the refusal path exists, the safe operating
guidance is "set the retention window longer than any client is ever offline", now noted in the
coordinator README. Whether that is good enough, or whether the sweep should be opt-in until
the gate lands, is a call worth making explicitly.

## Arm B (blocked optimisation) — pruning the change-log index by time

`@quereus/sync` keeps an HLC-ordered index (KV prefix `cl:`, the "change log") over the live
per-cell values and deletion markers. Its sole purpose is to let a peer say "give me everything
after this point in time" and get a forward range-scan instead of a full database scan.
Bootstrap-from-nothing and full snapshots read the underlying data directly and never consult
it.

After `sync-changelog-orphan-cleanup` (now complete), that index is bounded by live data size —
one entry per live cell, one per live deletion marker. That is a legitimate cost, not a leak,
so this arm is an **optimisation**, not a bug fix.

`ChangeLogStore.pruneEntriesBefore(hlc)` already exists and is correct: change-log keys sort by
`(wallTime, counter, siteId, opSeq)`, exactly `compareHLC`'s field order, so its
scan-and-stop-at-the-boundary logic is sound. It has never been called. Calling it with
`Date.now() - retentionHorizonMs` would cap index size by *time* rather than by dataset size —
attractive for a long-lived server hosting large, mostly-cold databases. The safety argument is
that `canDeltaSync` already declares a too-far-behind peer ineligible, so by construction no
eligible peer can ask for a range that pruning removed.

**That argument holds only if the eligibility check is enforced — see Arm A.** Enable horizon
pruning without the refusal path and a client offline past the horizon receives a **silently
truncated** delta: it looks like a successful sync but the replica has permanently missed
writes. Silent divergence is strictly worse than an index larger than it needs to be.

**Additional questions specific to Arm B:**

- **Is time-based even the right axis?** The alternative is watermark-based: prune below the
  minimum `lastSyncHLC` across known peers, which is exactly lossless but requires trusting
  peer-state bookkeeping and does nothing for a peer that never returns. Worth comparing before
  committing to the horizon approach.
- **Cost of the sweep itself.** `pruneEntriesBefore` accumulates every deleted key into one
  unbounded `WriteBatch` before writing. On a first run over a long-neglected log that is a
  large memory spike; it likely needs chunking.

## What has to be designed

- **How the server refuses.** A `get_changes` response meaning "your starting point is too old,
  take a snapshot". A protocol addition that needs designing rather than bolting on. This is
  the shared deliverable both arms wait on.
- **How the client recovers from that refusal** — falling back to fetching a full copy.
  `feat-sync-client-snapshot-bootstrap` (now in `tickets/plan/`) is exactly that client-side
  story and already names `canDeltaSync` as its trigger; it is carried as this ticket's
  `prereq:` and the two want designing together.
- **Whether to enable horizon pruning at all**, and on which axis, once the refusal path
  exists.

Arm A is reachable today and should not wait for Arm B's optimisation question to settle. Arm B
is not urgent: revisit when a deployment shows the change log is materially larger than the
data it indexes, or once the refusal path makes it cheap to add.
