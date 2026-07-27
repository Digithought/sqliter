----
description: When a device receives a row's deletion and a later re-creation of that same row in one sync round, it throws away the re-created row's bookkeeping while still writing the re-created row into the table — so the two disagree and the row can never be passed on to other devices.
files:
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/sync/_peer-harness.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - docs/sync.md
difficulty: hard
----

Half of `sync-delete-cleanup-misses-same-batch-writes`: the **inbound apply** path.
The local-capture half is `sync-local-capture-read-your-own-writes`, which depends on
this ticket only because it reuses the helper signature changed here.

## Vocabulary

- **cell record** — one `cv:` key-value record: the value and timestamp of a single
  column of a single row. A three-column row has three of them.
- **tombstone** — one `tb:` record marking a row as deleted, with the deletion's
  timestamp.
- **change log** — the `cl:` keyspace: a timestamp-ordered index over the live cell
  records and tombstones, used to compute "what changed since" for a peer.
- **apply batch** — everything handed to one `applyChanges` call. A relay or a
  reconnecting client routinely gets many source transactions in one such call.

## What goes wrong

`applyChanges` (`sync/change-applicator.ts:101`) resolves every incoming change in
Phase 1 against **pre-batch** stored state. Two changes in the same apply batch never
see each other. Phase 3 (`commitChangeMetadata`, line 683) does collapse in-batch
repeats, but it keeps two independent maps — `deleteWinners` keyed by row, and
`columnWinners` keyed by row+column — and never compares one against the other. Then,
after writing both, it calls `deleteRowVersionsAndLogEntries` for every winning
delete, which scans committed storage — which by then *includes* the column records
the same batch just wrote — and removes them.

So an apply batch carrying "delete row 1" and "re-create row 1" ends with the
re-created row's cell records gone.

### Measured against `main`

Origin does three separate local transactions on `main.users` row 1: insert
`x,y,z`; delete; insert `a,b,c`. A relay applies all of it in **one**
`applyChanges` call.

| scenario | relay cell records for row 1 |
| --- | --- |
| one apply batch (today) | **0** |
| same three transactions, three separate applies, `allowResurrection: false` (the default) | 0 — the re-creation is `skipped` (3 skipped, 0 applied) |
| same three transactions, three separate applies, `allowResurrection: true` | **3** (`a`,`b`,`c`) |

Two distinct defects fall out of that table:

1. **Under `allowResurrection: true`, the batched result is wrong.** The re-creation
   won conflict resolution and must survive; it is deleted instead. This is the data
   loss the parent ticket names.

2. **Under either setting, the row data and its bookkeeping disagree.** Phase 1
   marked the re-creation `applied` and pushed its `dataChange` into
   `dataChangesToApply`, so Phase 2's `applyToStore` writes the row back into the
   actual table (the delete and the update are applied in timestamp order, so the
   re-creation lands last). Phase 3 then leaves zero cell records for it. A row that
   exists in the table with no cell records is invisible to `getChangesSince`, so it
   is never passed on to any other device, and every later conflict resolution for it
   behaves as if its columns had never been written.

   Defect 2 is reasoned from the code, not yet measured — the relay in the
   reproduction has no store adapter wired. **Confirm it first** with a real
   `Database` peer via `test/sync/_peer-harness.ts` before building on it; if the
   store adapter turns out to behave differently, say so in the handoff and adjust.

## The rule to implement

An in-batch delete must take part in tombstone blocking exactly as a
already-committed tombstone would. `TombstoneStore.isDeletedAndBlocking`
(`metadata/tombstones.ts:214`) is the existing predicate:

- `allowResurrection: false` (the default) — any tombstone blocks any column write.
- `allowResurrection: true` — a tombstone blocks a column write whose timestamp is
  less than or equal to the tombstone's.

Note the doc comment on `SyncConfig.allowResurrection`
(`sync/protocol.ts:596`) describes the `false` case as "prevents any column write
with earlier HLC", which is **not** what the code does (it blocks unconditionally).
Do not change the behaviour under this ticket — fix the comment to match the code and
note the discrepancy in the review handoff, so whoever owns that semantic question
sees it.

Applying the predicate to in-batch deletes gives, for a row with a winning in-batch
delete at timestamp D:

- `allowResurrection: false` — every column change for that row in the batch is
  blocked: it must resolve as `skipped`, its `dataChange` must never reach
  `applyToStore`, and its metadata must never be written. The row's cell records are
  cleaned up as they are today.
- `allowResurrection: true` — a column change with timestamp greater than D survives:
  its data change is applied, its metadata and change-log entry are written, and the
  cleanup must **not** remove it. Column changes at or below D are blocked as above.

Either way, an apply batch now produces the same result as the same changes split
across separate applies. That parity is the acceptance criterion.

## Shape of the fix

Do the reconciliation **once**, between Phase 1 and Phase 2, over
`resolvedDataChanges` — not inside `commitChangeMetadata`. Doing it there would leave
the store-data half (defect 2) unfixed and would duplicate the predicate.

Sketch (name things as fits the file):

```ts
/**
 * Re-resolve column changes against deletes that landed in the SAME unit.
 * Phase 1 compares each change only to pre-batch state, so an in-batch delete is
 * invisible to an in-batch column change for the same row. Applies the same
 * tombstone-blocking rule as TombstoneStore.isDeletedAndBlocking.
 */
function reconcileInBatchDeletes(
  ctx: SyncContext,
  resolved: ResolvedChange[],
): {
  resolved: ResolvedChange[];            // blocked column changes flipped to 'skipped'
  blocked: number;                       // for the applied/skipped counters
  /** row key -> columns that beat the row's in-batch delete (empty unless allowResurrection) */
  survivingColumns: Map<string, Set<string>>;
};
```

- Group by the same pk-identity key `deleteKey`/`columnKey` already build
  (`change-applicator.ts:734`), so in-batch grouping agrees with the on-disk keys
  (collation-equal pk spellings collapse together).
- The blocker for a row is its **max-timestamp** in-batch delete.
- Callers: `applyChanges` (rebuild `dataChangesToApply`, `appliedChanges`, and the
  `applied`/`skipped` counters from the reconciled set) and `drainTableGroup`
  (`change-applicator.ts:423`, same accumulators, its own `applied`/`skipped`).
- `commitChangeMetadata` then needs no cross-map comparison — every remaining
  `applied` column change is one that should be written. It only needs to stop its
  cleanup from removing the surviving ones.

Cleanup helper change, in `sync/sync-context.ts:123`:

```ts
export async function deleteRowVersionsAndLogEntries(
  ctx: SyncContext,
  schema: string,
  table: string,
  pk: SqlValue[],
  keepColumns?: ReadonlySet<string>,   // columns whose same-unit write beat the delete
): Promise<void>
```

`keepColumns` is skipped by both the `cv:` delete and its paired `cl:` delete. It is
empty for every caller unless `allowResurrection` is on.

> `sync-local-capture-read-your-own-writes` changes this helper further (it needs to
> stage into a caller-owned `WriteBatch`). Land this ticket's signature first; that
> ticket adapts.

## TODO

- Confirm defect 2 with a store-backed peer (`test/sync/_peer-harness.ts`): a peer
  that applies delete + re-creation in one batch and ends with the row present in
  `main.users` but zero cell records. Record the observed result in the handoff.
- Add `reconcileInBatchDeletes` (or equivalently-named) to `change-applicator.ts` and
  wire it into `applyChanges` and `drainTableGroup` before their `admitGroup` calls.
- Recompute `applied` / `skipped` / `appliedChanges` from the reconciled set so
  `ApplyResult` counts and the emitted `onRemoteChange` payloads match what was
  actually written.
- Add `keepColumns` to `deleteRowVersionsAndLogEntries` and pass the surviving set
  from `commitChangeMetadata`.
- Fix the `SyncConfig.allowResurrection` doc comment in `sync/protocol.ts` to match
  `isDeletedAndBlocking`'s actual behaviour.
- Tests in `test/sync/changelog-orphan-cleanup.spec.ts` (inbound describe block) —
  origin does insert / delete / re-insert as three local transactions, relay applies
  all three in **one** `applyChanges`:
  - `allowResurrection: true` — relay ends with the 3 re-created cell records, 3
    column change-log entries plus the tombstone's delete entry, and
    `getChangesSince` re-emits the re-created row to a third peer.
  - `allowResurrection: false` — relay ends with 0 cell records, 1 change-log entry
    (the delete), the row absent from the store-backed table, and `skipped` counting
    the blocked column changes.
  - Both must equal the result of applying the same three transactions in three
    separate `applyChanges` calls — assert the parity directly, don't just hardcode
    numbers.
  - Reverse order (re-creation older than the delete) still ends deleted — the
    existing behaviour, currently passing; pin it.
- Keep the existing `changelog-orphan-cleanup.spec.ts` inbound test
  ("returns to empty after relaying upstream inserts then deletes") green.
- Update `docs/sync.md` § *Tombstones and Deletions* (line ~157) with the in-batch
  rule: a delete inside one apply batch blocks the batch's own column changes by the
  same rule an already-stored tombstone does.
- Run `yarn workspace @quereus/sync run test` and `yarn typecheck`.
