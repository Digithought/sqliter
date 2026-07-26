description: A synced table column whose name contains a colon is silently skipped when data is sent to other devices, so that column never reaches them — and can be wiped locally when a fresh copy of the database is loaded in.
files:
  - packages/quereus-sync/src/metadata/keys.ts
  - packages/quereus-sync/src/sync/snapshot-stream.ts
  - packages/quereus-sync/src/sync/snapshot.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/test/metadata/keys.spec.ts
difficulty: medium
----

## What happens

A column name may contain a colon — SQL allows it via a quoted identifier
(`create table t ("a:b" text)`), and the sync layer's identifier check
(`assertKeyableIdentifiers`) rejects only unpaired surrogates, not colons.

The sync engine stores one record per cell under a key that packs several parts
together separated by colons:

```
cv:{schema}.{table}:{primary_key_json}:{column_name}
cl:{hlc_bytes}{type_byte}{schema}.{table}:{primary_key_json}:{column_name}
```

To read those parts back, `parseColumnVersionKey` and `parseChangeLogKey`
(`packages/quereus-sync/src/metadata/keys.ts`) split at the **last** colon and
assume everything before it is the primary key. With a colon in the column name
that split lands in the wrong place, the primary-key half fails to parse as JSON,
and both functions return `null`.

Every caller treats `null` as "skip this record". Consequences, all silent:

- **Full sync drops the cell.** `collectAllChanges` (the path taken when a peer
  syncs from scratch, with no "since" timestamp) skips it, so the column's value
  never reaches that peer.
- **Snapshots drop the cell.** `getSnapshot` and `getSnapshotStream` skip it too.
- **Delta sync can't see it either.** `getChangesSince` iterates the change-log
  index and skips the unparseable entry, so the cell is invisible on that path as
  well.
- **Applying an incoming snapshot can delete it.** `clearNonPreservedMetadata`
  (`snapshot-stream.ts`) keeps a record only when it can parse the key AND the
  table is on the preserve list. An unparseable key falls through to the delete
  branch, so the local cell is wiped even when its table was meant to be kept.

Nothing warns. The data is simply absent on every other replica.

## Why it is filed separately

Found while fixing change-log orphan cleanup
(`1-sync-changelog-orphan-cleanup`). That work fixed the one place that could be
fixed cheaply: `ColumnVersionStore.getRowVersions` knows the row's primary key, so
it now strips the exact known prefix instead of guessing at the last colon, and
round-trips any column name. The two `parse*Key` functions above get only the raw
key bytes with no primary key to anchor on, so they cannot use that trick — fixing
them needs a different key encoding or a real scan of the JSON, which is a bigger
change than that ticket's scope.

`packages/quereus-sync/src/metadata/keys.ts` carries a `NOTE:` at
`parseColumnVersionKey` pointing here.

## Expected behaviour

Any column name that the engine accepts must survive a full round trip through
sync: local write → full sync / delta sync / snapshot → peer, and back. No cell may
be silently skipped or deleted because of characters in its name.

The same must hold for schema and table names, and for primary-key values —
primary keys go through `JSON.stringify`, which escapes quotes but not colons, so
they deserve the same scrutiny.

If some character class genuinely cannot be supported, sync must **reject** it
loudly at write time (the way `assertKeyableIdentifiers` already rejects unpaired
surrogates) rather than accepting the write and losing the data later.

## Reproducing

`packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts` has a test
("cleans up a column whose name contains the key separator") that exercises a
column named `a:b`. It deliberately counts raw key-value records rather than going
through the change-log reader, precisely because the reader cannot see that entry
— that comment marks the seam. A test for this ticket should assert the cell
survives a full sync and a snapshot round trip.
