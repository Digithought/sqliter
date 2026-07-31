description: Renaming a table can silently throw away every row in it, with no error, if the storage backend in use has not implemented an optional piece of the storage interface.
prereq:
files:
  - packages/quereus-store/src/common/store-module-rename.ts:160 (the `if (this.provider.renameTableStores)` skip)
  - packages/quereus-store/src/common/kv-store.ts:299 (the optional `renameTableStores` declaration)
  - packages/quereus-sync/test/sync/_peer-harness.ts (a provider that omits the hook — where this was observed)
difficulty: easy
repro: verified
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

Every shipped backend (LevelDB, IndexedDB) does implement the method, and most
of the store package's own test backends do too, so no shipped configuration
loses data today. The exposure is to anyone writing their own storage backend —
a plugin author following the interface, which documents the method's contract
but never says that omitting it destroys data on rename.

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
state the consequence of omitting it, and the sync test harness's backend should
be brought in line so it stops modelling a configuration that loses data.
