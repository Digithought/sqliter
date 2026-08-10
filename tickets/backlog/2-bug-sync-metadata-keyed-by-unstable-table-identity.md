description: The sync engine files every row's conflict-tracking record under the table's current name, so renaming a table, changing which columns identify its rows, or dropping and re-creating a table with the same name makes the engine either lose that history or apply the wrong table's history — and rows from other devices are then silently dropped or silently overwritten.
files:
  - packages/quereus-sync/src/metadata/keys.ts             # cv:/tb:/cl: key layout — table name and pk values are both baked into the key
  - packages/quereus-sync/src/metadata/column-version.ts   # per-cell version records
  - packages/quereus-sync/src/metadata/tombstones.ts       # deletion markers; isDeletedAndBlocking — "any tombstone blocks" when allowResurrection is false
  - packages/quereus-sync/src/metadata/change-log.ts       # the index over both
  - packages/quereus-sync/src/sync/change-applicator.ts    # resolveChange's blocking check; reconcileInBatchDeletes (~850) — the same-batch arm
  - packages/quereus-sync/src/sync/sync-manager-impl.ts    # handleTransactionCommit — where a rename/pk-change could trigger a re-key; evictExpiredBasisTables (~630) reclaims table storage but not sync metadata
  - packages/quereus-sync/src/sync/snapshot-stream.ts      # clearExistingMetadata — the existing per-table metadata wipe, for reference
  - packages/quereus/src/runtime/emit/alter-table.ts       # runRenameTable, runAlterPrimaryKey — the statements that cause it
repro: verified
severity: corruption
likelihood: normal-use
tradeoffs: Introducing a stable table identity changes the on-disk metadata key layout, which means a migration for every device already syncing — a maintainer may prefer the far cheaper partial answers (wipe the table's metadata on rename, stamp tombstones with a table generation) even though those lose history rather than carry it.
----

# Sync bookkeeping is filed under a name that does not identify the table

Sync keeps three kinds of per-row bookkeeping for every synced table: the version of each
cell (`cv:`), deletion markers (`tb:`), and an index over both (`cl:`). **Every one of those
records is filed under a key built from the table's name and the row's primary-key values**
(`metadata/keys.ts`).

A table's name is not its identity. Three ordinary statements break the assumption, and
they break it in opposite directions — one *strands* history, the other *inherits* the
wrong history.

## The invariant that retires the class

Give each table a stable identity that outlives its name and its key definition — a
generation id minted at CREATE and stored on the table's sync metadata — and key `cv:`,
`tb:` and `cl:` by that identity instead of by `schema.table`. Then:

- a rename is a catalog change and touches no metadata key;
- a primary-key change is an explicit re-key of that table's records, which the engine can
  perform because it can enumerate them;
- a drop retires the generation, so a later same-name create mints a new one and cannot
  inherit anything.

The two arms below are the same fix approached from two directions, which is why they are
one ticket.

## Arm A — rename and primary-key change strand the history (static)

```
alter table orders rename to orders2
```
Every record stays filed under `orders`; all new activity files under `orders2`. Nothing
re-files them.

```
alter table orders alter primary key (…)
```
Every record stays filed under the old key values; all new activity files under the new
ones.

From the next write onward, the table behaves — to sync — like a brand-new table with no
history. That is not merely untidy; it changes which writes win:

- an old deletion no longer blocks a resurrected row, so a row another device deleted can
  come back;
- a stale edit from another device is no longer compared against a newer local cell
  version, so it can win over a newer write.

## Arm B — drop then re-create inherits the old table's history (verified)

Dropping a table removes the table but leaves all three kinds of bookkeeping behind, keyed
under the same `schema.table` name. Create a new table with that name and the new table
inherits it.

The sharpest consequence is on deletion markers. When a change arrives from another device
for a row whose primary key matches a row that was deleted in the *previous* incarnation,
the apply path treats it as an attempt to resurrect a deleted row and **silently discards
it**. Under the default configuration (`allowResurrection: false`), *any* surviving
tombstone blocks the write, with no comparison of when the deletion happened — so an
unrelated, much newer row simply never lands, and nothing is logged as an error.

Same-name re-creation is not exotic: a schema migration that rebuilds a table by dropping
and re-creating it produces exactly this.

**Secondary effect:** beyond the blocked writes, the leftover bookkeeping is never
reclaimed. It is scanned on every delta extraction and re-shipped to every newly
bootstrapping device, forever. `evictExpiredBasisTables` (~630) reclaims table storage but
not sync metadata.

## Notes for whoever picks this up

- `clearExistingMetadata` in `snapshot-stream.ts` is the existing per-table metadata wipe
  and is the shape of the cheap partial answer for arm B.
- `handleTransactionCommit` in `sync-manager-impl.ts` is where a rename or pk-change event
  would trigger a re-key under the cheap answer for arm A.
- Arm B is verified; arm A is read from the key layout and has no reproduction yet. A
  two-peer test that renames and then relays is what would confirm it.
