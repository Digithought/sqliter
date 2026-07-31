description: If you drop a table and later create a new one with the same name, the sync engine still holds the old table's deletion records, so rows arriving from another device can be silently rejected as "already deleted" even though they belong to the brand-new table.
files:
  - packages/quereus-sync/src/metadata/tombstones.ts            # isDeletedAndBlocking — "any tombstone blocks" when allowResurrection is false
  - packages/quereus-sync/src/sync/change-applicator.ts         # resolveChange's blocking check; reconcileInBatchDeletes (~850) — the same-batch arm
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # local capture; evictExpiredBasisTables (~line 630) reclaims table storage but not sync metadata
  - packages/quereus-sync/src/sync/snapshot-stream.ts           # clearExistingMetadata — the existing per-table metadata wipe, for reference
difficulty: medium
repro: verified
----

## What is wrong

Sync keeps three kinds of per-row bookkeeping for every table: current cell values,
deletion markers (tombstones), and an index over both. Dropping a table removes the
table but leaves all three behind, keyed under the same `schema.table` name.

Create a new table with that same name later and the new table inherits the old one's
bookkeeping. The sharpest consequence is on deletion markers: when a change arrives
from another device for a row whose primary key matches a row that was deleted in the
*previous* incarnation of the table, the apply path treats it as an attempt to
resurrect a deleted row and silently discards it. With the default configuration
(`allowResurrection: false`) *any* surviving deletion marker blocks the write, with no
comparison of when the deletion happened — so an unrelated, much newer row simply never
lands, and nothing is logged as an error.

Same-name re-creation is not exotic: a schema migration that rebuilds a table by
dropping and re-creating it produces exactly this.

## Secondary effect

Beyond the blocked writes, the leftover bookkeeping is never reclaimed. It is scanned
on every delta extraction and re-shipped to every newly-bootstrapping device, forever,
for a table that no longer exists.

## Why it was not fixed alongside the drop-capture bug

It was raised as an open question on
`sync-commit-capture-lost-when-table-dropped-in-same-transaction` and deliberately
deferred, because "just purge on drop" is not obviously right:

- A relay device that retires a table locally is still expected to keep forwarding that
  table's changes to other devices.
- Retired tables are deliberately kept for a retention window before their storage is
  reclaimed (`evictExpiredBasisTables`), so peers that are behind can still catch up.

So the question is a retention-policy decision — when is a dropped table's history
genuinely finished with? — not a one-line guard. Someone needs to decide the policy
before the code is written.

## Questions to settle

- Should a drop purge immediately, or mark the table's bookkeeping for reclamation at
  the existing retention horizon?
- Does a relay (a device that forwards changes it does not itself store) need different
  treatment from an ordinary device?
- If a purge is too aggressive, is the narrower fix to make the apply path ignore
  deletion markers older than the table's most recent `create_table` migration?

## Not yet reproduced

The blocked-write path was identified by reading `isDeletedAndBlocking` and its caller,
not by running it. First step is a test: two devices, drop and re-create a table on one,
then send a row with a primary key that was deleted before the drop, and confirm it is
discarded.

## Second arm — same decision, second code site (added while fixing `bug-sync-batch-of-drop-then-recreate-hides-the-table`, repro: verified)

The stored deletion marker above is one of **two** ways a dropped table's deletion can
block the new table's row. The other needs no stored marker at all: when both the old
deletion and the new row arrive in the **same** batch.

`change-applicator.ts`'s `reconcileInBatchDeletes` (~line 850) applies the
deletion-blocks-write rule *within* one batch, and — like `isDeletedAndBlocking` — has no
notion of which incarnation of the table each fact belongs to. Under the default
`allowResurrection: false` it blocks *every* same-row write in the batch, whatever its
timestamp. So a deletion that happened **before** the drop blocks a write that happened
**after** the re-create.

That combination is not exotic: it is what a device gets on a first (from-zero) delta
sync. Verified — origin runs `create` → `insert pk 1` → `delete pk 1` → `drop` →
`create` → `insert pk 1`, then a fresh receiver pulls and applies:

```
migrations: create_table@…641, drop_table@…835, create_table@…876
changes:    delete:[1]@…729, column:[1]@…908, column:[1]@…908
result:     { applied: 3, skipped: 3 }   ← both post-re-create columns skipped
```

The receiver ends with the table present and pk 1 missing, and — because the pre-drop
delete is itself applied — a fresh deletion marker for pk 1 written into the *new*
incarnation's metadata, so the row stays blocked on every later batch too.

The ticket already asks (third bullet under **Questions to settle**) whether the narrow
fix is to ignore deletion markers older than the table's most recent `create_table`. That
same rule, applied to the batch's own facts rather than to stored ones, is what this arm
needs — hence one ticket, two sites, one policy decision:

- `packages/quereus-sync/src/metadata/tombstones.ts` — `isDeletedAndBlocking` (stored markers)
- `packages/quereus-sync/src/sync/change-applicator.ts` — `reconcileInBatchDeletes` (same-batch facts)

The sibling fix that landed alongside this finding is deliberately narrower: it stops the
re-created table's rows from consulting *stored* cell versions and deletion markers
(`freshLocalTable`), which is safe without a policy decision because a re-created table is
empty by construction. It does **not** touch either blocking rule.
