---
description: Renaming a table, or changing which columns identify its rows, makes the sync engine lose all of that table's conflict-tracking history — so an old deletion can stop blocking a resurrected row, and a stale edit from another device can win over a newer one.
files:
  - packages/quereus-sync/src/metadata/keys.ts                  # cv:/tb:/cl: key layout — table name and pk identity are both baked into the key
  - packages/quereus-sync/src/metadata/column-version.ts        # per-cell version records
  - packages/quereus-sync/src/metadata/tombstones.ts            # deletion markers
  - packages/quereus-sync/src/metadata/change-log.ts            # the index over both
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # handleTransactionCommit — where a rename/pk-change event could trigger a re-key
  - packages/quereus/src/runtime/emit/alter-table.ts            # runRenameTable, runAlterPrimaryKey — the statements that cause it
difficulty: medium
repro: static
---

## What is wrong

Sync keeps three kinds of per-row bookkeeping for every synced table: the version of
each cell, deletion markers, and an index over both. Every one of those records is filed
under a key built from **the table's name** and **the row's primary-key values**.

Two ordinary statements move a table out from under its own bookkeeping:

- `alter table orders rename to orders2` — every record stays filed under `orders`,
  while all new activity files under `orders2`.
- `alter table orders alter primary key (…)` — every record stays filed under the old
  key values, while all new activity files under the new ones.

Nothing re-files them. From the next write onward the table behaves, to sync, like a
brand-new table with no history.

## Why it matters

Losing that history is not merely untidy — it changes which writes win:

- **A deletion stops blocking.** By default (`allowResurrection: false`) an incoming
  change for a row that was deleted is discarded. With the deletion marker stranded under
  the old name, a change that should have been rejected is applied instead, and the
  deleted row comes back.
- **A stale edit can win.** Conflict resolution compares an incoming change against the
  stored version of that cell. With no stored version, the incoming change is taken
  read-free — so an older edit that arrives late can overwrite a newer one.
- **The stranded records are never reclaimed.** They are scanned on every delta
  extraction and re-shipped to every newly bootstrapping device, forever.

Two further consequences, observed while implementing `sync-replicate-rename-table`
(the rename now replicates, so these fire on real peers):

- **A from-scratch delta pull loses pre-rename rows to quarantine.** A device that
  re-pulls the full change history (for example after losing its sync watermark)
  receives the pre-rename rows still filed under the old table name, in the same batch
  as the rename itself. The apply path correctly concludes the old name no longer
  exists after that batch, so those rows are diverted to the unknown-table disposition
  (quarantined by default) instead of landing in the renamed table — even though the
  receiver may already hold them there.
- **A snapshot taken after the rename cannot bootstrap the pre-rename rows.** Snapshot
  data is enumerated from the stranded per-cell records, so pre-rename rows are shipped
  under the retired table name. A fresh device replays the DDL (create, then rename)
  and then fails to apply that data — the table by the old name no longer exists. Only
  rows written after the rename bootstrap cleanly.

## How to reproduce (inferred from the key layout, not yet run)

On one device: create a table, delete a row, rename the table, then have a second device
send a change for that same row. Expected today: the change lands, resurrecting the row,
where the same sequence without the rename would discard it. Confirming this needs a
two-peer test in `packages/quereus-sync/test/sync/` driving `relayAll`, plus a direct
read of the `cv:` / `tb:` keys before and after the rename to show they did not move.

## Scope

Renaming a **column** is not affected — column identity is by name inside a record, not
part of the key.

This is the mirror image of `bug-sync-recreated-table-inherits-dropped-table-metadata`,
which is about a *new* table inheriting an *old* name's bookkeeping. That one asks
"when should this be purged?"; this one asks "when should it be moved?" The two probably
want a shared answer about the lifecycle of per-table sync metadata, but they are
distinct code sites and neither blocks the other.

The condition is pre-existing for a purely local rename or primary-key change. It becomes
visible on every device once those statements replicate (`sync-replicate-alter-table-ddl`,
`sync-replicate-rename-table`), which is why those tickets name this one rather than
absorbing it.
