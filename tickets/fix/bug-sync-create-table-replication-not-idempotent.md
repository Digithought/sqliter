description: When two offline devices each create the same table and then connect to sync, each rejects the other's "create table" as already-existing, spamming errors and leaving that schema change stuck un-acknowledged.
prereq:
files:
  - packages/quereus-sync/src/sync/store-adapter.ts (applySchemaChange — raw db.exec of the DDL, throws on "already exists")
  - packages/quereus-sync/src/sync/change-applicator.ts (HLC-domination gate that only stops a create_table when one HLC dominates the other)
difficulty: medium
----

## What happens

Offline-first supports two devices that each run the same schema migration
(`create table orders (...)`) locally while disconnected, then connect. Each
device's `create_table` change replicates to the other, which already has that
table. `applySchemaChange` in the store adapter executes the DDL raw:

```ts
// packages/quereus-sync/src/sync/store-adapter.ts  (~line 368)
await db.exec(change.ddl);   // "create table orders ..." → throws "Table main.orders already exists"
```

The throw is caught one level up (the schema-changes loop, ~line 175-185) and
pushed to `result.errors`. Observed symptom during the sync-coordinator e2e
work: `Error handling sync message: ... Table main.orders already exists` logged
on every connect.

## Why it is only *sometimes* stopped today

`change-applicator.ts` has an HLC-domination gate: a `create_table` whose HLC is
dominated by the local one is dropped at admission (it never reaches
`applySchemaChange`). That covers the case where one create clearly "wins". It
does **not** cover two *independent* creates made offline on different site IDs
— neither HLC dominates, so both are admitted and both hit the raw `db.exec` and
throw on the peer that already has the table. That is the exact offline-first
scenario above, so it is reachable in normal use, not a corner case.

## Severity / blast radius (already scoped during review)

- **Data is NOT lost.** Schema changes and data changes apply in *separate*
  loops in the store adapter (`store-adapter.ts` ~line 175 vs ~line 197). A
  create_table that throws is isolated to `result.errors`; any DML co-batched in
  the same `applyChanges` call still applies in the following loop. So a
  `get_changes` reply that batches a `create_table` changeset together with a
  DML changeset does **not** drop the DML. (This was the open question flagged in
  the implement handoff — answered here by reading the code.)
- The real damage is (a) noise — an error logged on every connect — and (b) the
  schema change's CRDT metadata is left un-committed because the apply reported
  an error, so it can be re-sent on each sync, never converging.

## Expected behavior

Replicated `create_table` (and, by the same argument, `create_index`) should be
**idempotent**: when the object already exists and its definition matches the
incoming DDL, treat the change as successfully applied (converge + commit the
CRDT metadata), not as an error. A genuine *conflicting* redefinition (same name,
different shape) is a different case and should still surface — decide during the
fix whether that is an assertion/conflict event or a hard error.

## Out of scope note / where this came from

Surfaced by the sync-coordinator WebSocket round-trip e2e test
(`packages/sync-coordinator/test/`). That test deliberately pre-seeds the base
table *before* wiring sync capture so the bootstrap schema never replicates —
this keeps the test focused on the DML wire path and sidesteps the bug rather
than papering over it. Schema-change replication over the wire is therefore not
covered by that e2e test and is a natural companion once this is fixed.
