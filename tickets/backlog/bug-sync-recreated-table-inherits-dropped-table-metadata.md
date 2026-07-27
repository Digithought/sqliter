description: If you drop a table and later create a new one with the same name, the sync engine still holds the old table's deletion records, so rows arriving from another device can be silently rejected as "already deleted" even though they belong to the brand-new table.
prereq:
files:
  - packages/quereus-sync/src/metadata/tombstones.ts            # isDeletedAndBlocking — "any tombstone blocks" when allowResurrection is false
  - packages/quereus-sync/src/sync/change-applicator.ts         # ~line 625 — the blocking check on the apply path
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # local capture; evictExpiredBasisTables (~line 630) reclaims table storage but not sync metadata
  - packages/quereus-sync/src/sync/snapshot-stream.ts           # clearExistingMetadata — the existing per-table metadata wipe, for reference
difficulty: medium
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
