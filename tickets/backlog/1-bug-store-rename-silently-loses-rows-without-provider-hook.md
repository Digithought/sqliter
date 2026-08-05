description: Renaming a table can silently throw away every row in it, with no error, if the storage backend in use has not implemented an optional piece of the storage interface.
prereq:
files:
  - packages/quereus-store/src/common/store-module-rename.ts:160 (the `if (this.provider.renameTableStores)` skip)
  - packages/quereus-store/src/common/kv-store.ts:299 (the optional `renameTableStores` declaration)
  - packages/quereus-sync/test/sync/_peer-harness.ts (a provider that omits the hook — where this was observed)
difficulty: easy
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: No shipped storage provider omits the hook - only a test harness does - so a maintainer may prefer to make renameTableStores a required part of the interface rather than add a runtime guard.
----

## What happens

Quereus stores each table's rows in a storage area named after the table. When a
table is renamed, the rows have to move to the area named after the *new* name.
That move is delegated to the storage backend through an **optional** method,
`renameTableStores`.

If the backend does not provide that method, the store module skips the move
entirely — one bare `if` at `store-module-rename.ts:160` with no `else`. The
catalog is then rewritten under the new name, so the database happily reports a
table of the new name with the right columns. Its rows are still sitting under
the old name, unreachable. The renamed table reads as empty. Nothing throws and
nothing is logged.

## Reproduction

Observed at HEAD while working an unrelated sync ticket. The two-peer test
harness in `packages/quereus-sync/test/sync/_peer-harness.ts` builds an in-memory
storage backend that does not implement `renameTableStores`:

```
insert into orders values (1, 'one'), (2, 'two')   -- select * -> 2 rows
alter table orders rename to orders2               -- no error
select * from orders2                              -- []
```

The desktop/browser backends (LevelDB, IndexedDB) do implement the method, and
most of the store package's own test backends do too. The exposure is to anyone
writing their own storage backend — a plugin author following the interface,
which documents the method's contract but never says that omitting it destroys
data on rename — **and to two backends we ship ourselves** (see below).

## Expected behavior

A rename must either move the rows or fail loudly. Silently producing an empty
table is the one outcome that should not be possible.

Two directions, both defensible, and the choice is the substance of this ticket:

- **Refuse the rename.** If the backend cannot relocate storage, raise a clear
  error saying so, and leave the table alone. Simple, honest, and makes the
  requirement obvious to a backend author the first time they try it.
- **Fall back to a copy.** Read every key out of the old storage area and write
  it into the new one, then clear the old. Works everywhere, but is unbounded in
  memory/IO for a large table and duplicates what backends can do natively far
  more cheaply.

Whichever is chosen, the interface documentation on `renameTableStores` should
state the consequence of omitting it. (The sync test harness half is done:
`sync-replicate-rename-table` added `renameTableStores` to the harness's
in-memory backend, so it no longer models the data-losing configuration. The
store module's silent skip — the root cause — remains.)

## Second arm — two shipped mobile backends omit the method (found during `sync-replicate-rename-table` review)

The claim above that only third-party backends are exposed is wrong. Both mobile
backends implement `deleteTableStores` but not `renameTableStores`:

- `packages/quereus-plugin-react-native-leveldb/src/provider.ts` (`deleteTableStores` at
  line 150, no `renameTableStores`)
- `packages/quereus-plugin-nativescript-sqlite/src/provider.ts` (`deleteTableStores` at
  line 131, no `renameTableStores`)

So a rename on React Native or NativeScript empties the table today, silently.

This got worse rather than staying local: renames now replicate between devices
(`sync-replicate-rename-table`). A rename typed on a laptop reaches the phone as a
migration the phone re-executes, so one device's rename silently empties the table on
every mobile peer — no error on either side.

That raises the priority but does not change the decision the ticket asks for. Whichever
direction is chosen, these two providers need the method (or need to fail loudly).
