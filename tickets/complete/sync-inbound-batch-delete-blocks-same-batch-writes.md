description: A device that received a row's deletion and a later re-creation of that row in one sync round used to lose the re-created row. One sync round now leaves the same state as the same changes received across separate rounds.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/src/sync/store-adapter.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts
  - docs/sync.md
----

Inbound-apply half of `sync-delete-cleanup-misses-same-batch-writes`. The
local-capture half is `sync-local-capture-read-your-own-writes` (still in
`implement/`); it depends on the `keepColumns` helper parameter added here.

## What shipped

- **`reconcileInBatchDeletes`** (`change-applicator.ts`): runs between Phase 1
  (resolve) and Phase 2 (store write) in both `applyChanges` and the quarantine
  drain (`drainTableGroup`). Each row's max-timestamp in-batch applied delete
  blocks that batch's column changes by the same rule
  `TombstoneStore.isDeletedAndBlocking` applies to a stored tombstone: everything
  blocked under the default, and under `allowResurrection` only changes at or
  below the delete's timestamp. Blocked changes flip to `skipped`; surviving
  columns are recorded on the winning delete's `ResolvedChange.keepColumns`.
  Counters, the store apply list, and the `onRemoteChange` payload are all built
  from the reconciled outcomes.
- **`deleteRowVersionsAndLogEntries`** (`sync-context.ts`) and
  `ColumnVersionStore.deleteRowVersionsBatch` take `keepColumns?: ReadonlySet<string>`
  — post-delete cleanup skips those columns' cell records and their paired
  change-log entries.
- **Store adapter** (`store-adapter.ts`): row-group collapse changed from
  delete-wins to net effect in batch order, so a re-creation that wins resolution
  reaches the actual table, rebuilt from primary key + nulls rather than the
  pre-delete image.
- **Prior-lineage erasure** (added in review — see findings): a column write that
  resurrects past a same-batch delete records no before-image, matching both the
  origin and a separate-applies receiver.
- Grouping keys share `rowIdentityKey`; docs and the `SyncConfig.allowResurrection`
  comment corrected to match the code (the default blocks unconditionally until
  tombstone pruning, not "any write with earlier HLC").

## Validation

`yarn lint`, `yarn typecheck`, and `yarn test` all green at review time.
`@quereus/sync` 549 passing (547 at implement + 2 added in review).

## Review findings

### Checked

Read the implement diff (`d33afc1d`) before the handoff summary. Traced
`reconcileInBatchDeletes` against `commitChangeMetadata`'s collapse (winner object
identity across the two maps, tie behavior, fresh-table keying), the `keepColumns`
plumbing down to `cv:`/`cl:` cleanup, and the adapter's net-effect collapse against
`applyExternalRowChanges` upsert-replaces-row semantics. Confirmed the drain path's
held-change ordering really is timestamp order (`buildQuarantineKey` puts the HLC
bytes ahead of the type byte). Verified the corrected `allowResurrection` doc against
`TombstoneStore.isDeletedAndBlocking`. Re-read every touched doc plus the `SyncConfig`
block in `docs/sync.md` § Configuration. Two defects below were reproduced against real
peers with throwaway specs before being reported.

### Major — filed

- **Store data and sync bookkeeping disagree when a batch arrives out of order.**
  `reconcileInBatchDeletes` decides which writes survive a delete by timestamp;
  `buildRowOp` decides what the table row becomes by arrival order. They agree only
  while arrival order matches timestamp order. Reproduced with store-backed peers:
  `allowResurrection: true` plus a reversed changeset array leaves the `orders` row
  absent from the table while both cell records survive and two column changes go
  back out on `getChangesSince` — the peer relays a row it does not have.
  Reachable today through `coordinator-service.ts`'s `onBeforeApplyChanges` hook and
  the REST/WebSocket ingress, neither of which is required to preserve order. Filed
  as `backlog/bug-sync-apply-order-splits-data-from-metadata`; the existing `NOTE`
  at `buildRowOp` was sharpened to say what actually breaks rather than "could
  mis-net".

### Minor — fixed in this pass

- **Stale before-image persisted and relayed.** A receiver that already held the
  row recorded the *pre-delete* cell value as the resurrecting write's
  `priorHlc`/`priorValue`, because Phase 1 read the pre-batch version and the
  in-batch delete never erased it. Measured: the batched receiver stored
  `priorValue: 'x'` and put it on the wire, while both the origin (past its own
  delete) and a separate-applies twin stored none — a parity break in *persisted*
  state, not just events, and not in the handoff's gap list. Fixed with
  `ResolvedChange.priorErasedByInBatchDelete`, which suppresses the prior in
  `commitColumnMetadata` while still dropping the stale `cl:` entry (the delete's
  cleanup now skips that column, so the entry has no other reaper).
- **`docs/sync.md` overclaimed parity** ("produces the same result"). Narrowed to
  state + re-emitted changes, and the two known event-stream divergences are now
  stated in the doc instead of living only in the handoff.

### Test gaps — closed

- No coverage for a receiver that already held the row before the delete +
  re-creation batch (the case that exposed the before-image defect). Added
  `allowResurrection: true — a receiver that already holds the row records no
  stale before-image`, asserting against the origin's own records, the
  separate-applies twin, and the wire.
- `drainTableGroup` gained the reconciliation with zero direct coverage — every
  in-batch test went through `applyChanges`. Added `a held delete blocks a held
  column write for the same row` to `unknown-table-disposition.spec.ts`; pre-fix it
  reported `applied: 2` and left the row re-created in the store.

### Noted, not filed

- `change-applicator.ts` is 983 lines and now carries apply orchestration, the
  quarantine drain, resolution, reconciliation, metadata commit, key helpers, and
  the basis-lifecycle bump. Cohesive around one pipeline and this ticket added only
  ~60 lines, so no split ticket — but `bumpLastDirectlyMappedWrites` is the odd one
  out and would be the first thing to move if the file is ever broken up.
- The implement handoff left open whether `allowResurrection: false` *should* block
  unconditionally (as the code does) or only earlier-timestamp writes (as the old
  comment claimed). Not re-litigated here: the behavior and its consequence are now
  accurately documented in `docs/sync.md` and `protocol.ts`, so a future change is a
  deliberate policy decision, not a latent surprise.
- The handoff's accepted gaps (conflict-resolution events emitted before
  reconciliation; a batched delete + re-create surfacing as one net store event)
  were re-verified as real and are now stated in `docs/sync.md` rather than only in
  a ticket.
- A NUL byte sits in a `store-adapter.ts` comment (a literal `\0` illustrating a key
  delimiter), which makes ripgrep treat the file as binary. Pre-dates this ticket —
  present at `d33afc1d~1` — and unrelated to it.

### Tripwires

None recorded. The one conditional concern the implementer parked as a tripwire —
the adapter's batch-order assumption — turned out to be a reproducible defect with
a reachable trigger, so it was promoted to a ticket rather than left as a comment.
The fresh-table keying edge (a same-batch create-table plus collation-variant
primary-key spellings grouping differently at reconcile than at Phase 3) stays as
the implementer's comment at `rowIdentityKey` — genuinely conditional, and correct
as parked.
