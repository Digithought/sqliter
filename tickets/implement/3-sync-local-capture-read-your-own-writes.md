----
description: When a single database transaction touches the same row more than once, the sync bookkeeping written for that transaction is computed as if the earlier touches had not happened — leaving behind records for rows that no longer exist and, in some cases, two index entries where there must be exactly one.
prereq: sync-write-batch-op-order-guarantee, sync-inbound-batch-delete-blocks-same-batch-writes
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - docs/sync.md
difficulty: hard
----

Second half of `sync-delete-cleanup-misses-same-batch-writes`: the **local capture**
path. The inbound half is `sync-inbound-batch-delete-blocks-same-batch-writes`.

## Vocabulary

- **cell record** — one `cv:` key-value record: the value and timestamp of a single
  column of a single row.
- **tombstone** — one `tb:` record marking a row deleted, with the deletion timestamp.
- **change log** — the `cl:` keyspace: a timestamp-ordered index over live cell
  records and tombstones, used to compute "what changed since" for a peer.

## What goes wrong

`handleTransactionCommit` (`sync/sync-manager-impl.ts:709`) records one committed
engine transaction. It opens **one** `WriteBatch` (`kvBatch`), walks the
transaction's events through `recordDataEvent` / `recordColumnVersions`, and writes
the batch once at the end.

Every read those two methods perform hits **committed storage**, so none of them can
see writes this same transaction has already staged into `kvBatch`:

- `recordColumnVersions` reads `columnVersions.getColumnVersion` to find the cell
  version it is replacing — so it can delete that version's change-log entry and
  record it as the before-image.
- `recordDataEvent`'s delete branch reads `tombstones.getTombstone` for the same
  reason, then calls `deleteRowVersionsAndLogEntries` (`sync/sync-context.ts:123`),
  which *scans* for the row's cell records and removes what it finds — in its own
  batch, written immediately, i.e. before `kvBatch` lands.

The engine does not coalesce per-row events inside a transaction
(`packages/quereus/src/core/database-events.ts` `flushBatch` delivers every batched
event), so a transaction really can carry two writes to one cell, or a write and a
delete of one row.

## Measured against `main`

All four are one transaction against `main.users`, no schema oracle (columns are
`col_0…`). "Expected" is what the same statements produce when split into separate
transactions.

| transaction | cell records after | change-log entries after | expected |
| --- | --- | --- | --- |
| insert row 1, then delete row 1 | **3** | 4 | 0 cells, 1 entry (the delete) |
| (row already present) update one column, then delete row 1 | **1** | 2 | 0 cells, 1 entry |
| (row already present) update one column, then update it again | 1 | **2** | 1 cell, 1 entry |
| (row already present) delete row 1, insert row 1, delete row 1 | **1** | 3 | 0 cells, 1 entry |

Note the parent ticket estimated three leaked cell records for the
update-then-delete case; the measured number is one — the scan does clean the two
columns this transaction did not rewrite, and leaks only the rewritten one.

The first, second and fourth rows are storage that grows without bound: the row is
tombstoned, so nothing ever revisits those cell records unless the exact same primary
key is deleted again. Other devices resolve the row as deleted, so this shows up as
local storage growth rather than as wrong data.

The third and fourth rows are worse than a leak: they leave **two change-log entries
for one key**. That breaks the LOAD-BEARING INVARIANT documented on
`collectChangesSince` (`sync/sync-manager-impl.ts:1063`) — at most one change-log
entry per key, whose timestamp equals its record's current timestamp. Boundary
detection there keys off the log entry's timestamp while grouping keys off the
resolved record's, so a stale second entry re-attributes a change to an older
transaction in the stream a peer receives.

The one ordering that already works is delete-then-reinsert, pinned by
`changelog-orphan-cleanup.spec.ts:139` ("keeps a reinsert that follows a delete of
the same row in one transaction"). It works by accident — the cleanup ran before
those cell records existed. **It must stay green.**

## Shape of the fix

Give local capture read-your-own-writes over the transaction's own staged metadata,
and stage the delete cleanup into `kvBatch` alongside everything else. Then the
transaction's event order — which *is* commit order, and therefore the engine's own
authority on the row's final state — decides the outcome, with no cross-comparison
of timestamps needed.

This relies on the `WriteBatch` ordering guarantee added by
`sync-write-batch-op-order-guarantee`: within one batch, the later operation on a key
wins. That is what makes "stage the cell record, then later stage its removal" (and
the reverse) come out right.

Two pieces:

**1. A per-transaction staged-metadata overlay.** One instance per
`handleTransactionCommit` call, threaded through `recordDataEvent` /
`recordColumnVersions`. Rough shape:

```ts
/**
 * What this transaction has already staged into its WriteBatch, so the
 * transaction's own later events read their own writes instead of pre-transaction
 * storage. Keyed by pk IDENTITY (ctx.getPkKeying + encodePkIdentity) so it agrees
 * with the cv:/tb:/cl: storage keys. Lives for one transaction only.
 */
class StagedTransactionMetadata {
  /** undefined = nothing staged (fall back to storage); null = staged as deleted. */
  columnVersion(schema, table, pk, column): ColumnVersionData | null | undefined;
  tombstone(schema, table, pk): Tombstone | null | undefined;
  /** Columns of this row that currently have a staged live cell record. */
  stagedColumns(schema, table, pk): ReadonlyMap<string, HLC>;

  noteColumnVersion(...), noteColumnDeleted(...), noteTombstone(...)
}
```

Reads become "overlay first, storage on miss"; every stage into `kvBatch` also
records into the overlay.

**2. Delete cleanup moves into `kvBatch`.** `deleteRowVersionsAndLogEntries` takes a
caller-supplied `WriteBatch` and does not write it; the caller owns the write. Its
column set becomes *(committed scan) ∪ (overlay's live staged columns)*, minus
overlay entries already marked deleted, and it uses each column's overlay timestamp
where present so it removes the right `cl:` entry.

> `sync-inbound-batch-delete-blocks-same-batch-writes` lands first and gives this
> helper a `keepColumns` parameter. Keep it; the inbound caller still needs it. This
> ticket adds the batch parameter and the overlay-aware column set. The inbound
> caller passes a fresh batch and writes it itself, so its behaviour is unchanged.

Walk the four measured cases through the result:

- insert then delete — the delete's overlay lookup finds the three staged cell
  records, stages their `cv:` and `cl:` removals into the same batch, and batch
  ordering makes the removals win. → 0 cells, 1 entry.
- delete then reinsert (the pinned test) — the delete stages removals of the
  committed cells; the reinsert stages fresh puts *after* them, so the puts win. The
  reinsert's overlay lookup sees "deleted", so it records no before-image and deletes
  no prior entry, which is exactly today's behaviour. → 3 cells, 4 entries.
- update then update — the second read sees the first's staged version, so it deletes
  the first's change-log entry. → 1 cell, 1 entry.
- delete, insert, delete — the second delete's overlay lookup finds both the staged
  tombstone (so it removes its change-log entry) and the staged cell records. → 0
  cells, 1 entry.

Two incidental improvements worth calling out in the handoff: the whole transaction's
metadata now lands in one atomic batch (today the cleanup commits separately and
ahead of it, so a crash between them loses metadata), and a throw part-way through
`recordDataEvent` no longer leaves already-committed cleanup behind.

## TODO

- Add the staged-metadata overlay. Put it in its own module under
  `packages/quereus-sync/src/sync/` rather than growing `sync-manager-impl.ts`; it is
  self-contained and unit-testable.
- Thread it through `handleTransactionCommit` → `recordDataEvent` →
  `recordColumnVersions`, replacing the direct `getColumnVersion` / `getTombstone`
  reads with overlay-first lookups, and recording every staged write into it.
- Change `deleteRowVersionsAndLogEntries` (`sync/sync-context.ts`) to take a
  `WriteBatch` it does not write, plus the overlay's staged columns; keep the
  `keepColumns` parameter the inbound ticket added. Update both callers.
- Verify the local delete path still emits the same inline `Change[]` (the
  `emitLocalChange` payload) it does today — the overlay must not change what a
  transaction reports to listeners, only what it stores.
- Tests, in `changelog-orphan-cleanup.spec.ts` under the `local deletes` describe (or
  a sibling describe if it reads better) — one per measured case above, asserting
  both the cell-record count (`columnVersions.getRowVersions`) and the raw `cl:`
  record count (`countChangeLog`, which counts KV records rather than parsed entries
  so a leak cannot hide). Assert against the split-into-separate-transactions result
  where practical, not just hardcoded numbers.
- Add a case with a real column-name oracle (`usersSchemaOracle`), not only the
  `col_N` fallback, so the overlay's key derivation is exercised with real names.
- Add a case where two rows are touched in the same transaction and only one is
  deleted, confirming the overlay does not bleed across rows.
- Keep `changelog-orphan-cleanup.spec.ts:139` and the whole existing suite green.
- Remove the `KNOWN LIMITATION` comment block at `sync/sync-context.ts:115` — both
  halves are closed once this lands.
- Update `docs/sync.md` § *Transaction-Based Change Grouping* (line ~225) to state
  that local capture reads its own transaction's staged metadata, so repeated touches
  of one row inside a transaction record the same metadata as the equivalent sequence
  of separate transactions.
- Run `yarn workspace @quereus/sync run test`, `yarn typecheck`, and `yarn test`.
