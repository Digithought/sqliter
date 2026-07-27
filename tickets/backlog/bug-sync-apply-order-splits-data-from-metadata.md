description: When a device receives a batch of changes in an unexpected order, it can end up deleting a row from its tables while still believing it has the row — and then telling other devices the row exists. Only happens on devices configured to let re-created rows win over deletes.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
difficulty: medium
----

## Symptom

A device with `allowResurrection: true` receives, in a single `applyChanges`
call, both the deletion of a row and a later re-creation of that same row. If the
re-creation's transaction happens to come **before** the deletion's transaction in
the array of transactions handed to `applyChanges`, the device ends up in two
states at once:

- the actual table row is **gone**, but
- the sync bookkeeping says the row exists (its per-column records and change-log
  entries survive), so the device **relays that row to other devices** it does not
  itself have.

Under the default setting (`allowResurrection: false`) the outcome is correct in
either order, so only devices that opt into resurrection are affected.

## Why it happens

Two layers answer the same question by two different rules:

- The change applicator decides which writes survive an in-batch delete by
  comparing timestamps (`reconcileInBatchDeletes` in `change-applicator.ts`).
- The store adapter decides what the table row should end up as by replaying the
  batch **in arrival order** (`buildRowOp` in `store-adapter.ts`) — it has no
  timestamps to work with, because the internal `DataChangeToApply` record does
  not carry one.

The two agree as long as arrival order matches timestamp order, which
`getChangesSince` guarantees for a single sender. They disagree the moment
something reorders the batch.

## How a reordered batch is reachable today

`applyChanges` accepts whatever array of transactions its caller passes and never
validates or re-sorts it. The coordinator's `onBeforeApplyChanges` hook
(`coordinator-service.ts:366`) returns a caller-supplied array of approved
transactions, and the REST/WebSocket ingress accepts an arbitrary array from any
client. Neither is required to preserve or produce timestamp order.

## Reproduction

Confirmed against real `Database` peers (review of
`sync-inbound-batch-delete-blocks-same-batch-writes`):

1. Origin: insert row 1, delete row 1, re-insert row 1 — three local transactions.
2. Receiver with `allowResurrection: true` calls
   `applyChanges([...sets].reverse())` on the origin's `getChangesSince` output.
3. Result: `select * from orders` returns no rows, but the receiver still holds
   both cell records for row 1 and re-emits two column changes from
   `getChangesSince`.

## Expected

A device must not persist row bookkeeping for a row it deleted from its own
tables, and must not advertise that row to peers. Whatever ordering rule the
sync layer uses to decide which writes survive a delete, the table contents must
follow the same rule.

## Notes for whoever picks this up

The two obvious directions, neither costed:

- Make the sync layer emit an apply list the adapter cannot mis-read — e.g. drop
  the delete's store operation for a row whose re-creation won, and mark the
  surviving writes so the adapter rebuilds the row from primary key + nulls
  instead of the pre-delete image. This keeps the ordering decision in the one
  place that has the timestamps.
- Or carry the timestamp on `DataChangeToApply` so the adapter can sort. This is
  an internal type (not on the wire), but it is threaded through the whole store
  seam.

Whichever is chosen, `applyChanges` accepting unordered input is worth an explicit
decision: either document the ordering as part of its contract and validate it, or
make the implementation order-independent.
