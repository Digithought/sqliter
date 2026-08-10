---
description: On the two mobile storage plugins, dropping a table never actually erases its data — so creating a new table with the same name later can silently come back full of the old table's rows.
files:
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts   # deleteTableStores (~line 150), deleteIndexStore
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts    # deleteTableStores (~line 131), deleteIndexStore (~line 125)
  - packages/quereus-plugin-leveldb/src/provider.ts                # deleteTableStores (~line 259) — the provider that does it correctly
  - packages/quereus-plugin-indexeddb/src/provider.ts              # deleteTableStores (~line 199) — likewise
  - packages/quereus-store/src/common/kv-store.ts                  # the KVStoreProvider contract these two violate
difficulty: medium
repro: static
severity: corruption
likelihood: normal-use
tradeoffs: Only affects the two mobile plugins, neither of which has a test harness or a known shipped consumer in this repo, so a maintainer may prefer to fix them together with the naming defect already filed against the same two files rather than twice.
---

## What the contract says

`KVStoreProvider.deleteTableStores(schema, table, indexNames)` is the hook the engine calls
to **erase** a table's physical storage — its row data and each of its secondary indexes.
`DROP TABLE` calls it. So does `ALTER TABLE ... RENAME TO` on a provider without a native
move hook: the engine copies the rows to the new name and then calls this to reclaim the
old ones.

The LevelDB and IndexedDB plugins honor that: they clear/drop the underlying keyspace or
object store.

## What the two mobile plugins actually do

Both `plugin-react-native-leveldb` and `plugin-nativescript-sqlite` implement
`deleteTableStores` (and `deleteIndexStore`) as **close the handle and forget it** — the
on-device LevelDB database, or the SQLite table, and every byte in it, survives untouched.
The NativeScript plugin even says so in a comment that is simply wrong:

```ts
// Note: SQLite doesn't need explicit store deletion - table is dropped when closed
```

Closing a SQLite connection does not drop a table.

## Why it matters

Store handles are re-opened lazily by name. So once the data outlives the delete:

- `drop table t;` then `create table t (...) using store;` — the "new" `t` opens the same
  on-device store and starts life holding the dropped table's rows. If the new table
  declares different columns, those leftover rows decode as garbage or fail outright.
- Same for `drop index` / re-`create index` with the same name.
- `alter table t rename to t2` (which now copies rather than moves on these plugins) leaves
  a full duplicate of the table's data behind under the old name, consuming device storage
  forever. The engine emits a warning when a provider has *no* `deleteTableStores` at all —
  but these two have one, so the warning does not fire and nothing tells the user.

Storage on a phone is the scarcest place for a leak like this, and the resurrection case is
silent data corruption from an ordinary sequence of statements.

Not verified on a device — neither package has a test harness here — but it is plain from
the code: the delete methods contain no delete.

## Expected behavior

- `deleteTableStores` / `deleteIndexStore` must leave no readable data behind: a store
  re-opened under the same name afterwards must be empty.
- For React Native LevelDB that means destroying (or fully clearing) the per-table LevelDB
  database; for NativeScript SQLite, `drop table` on the backing SQLite table.
- Both must remain no-ops when the store does not exist — the engine calls them
  speculatively during reclaim paths.

## Suggested coverage

The behavior is testable without a device by driving each provider with a stub
database/open function: write entries, call `deleteTableStores`, re-open the same store,
assert it is empty. Neither package has a test directory today. A shared
provider-conformance suite that every plugin runs (the fill-delete-reopen round trip above,
plus the naming rules) would catch this class across plugins instead of one plugin at a
time.

## Related

`bug-mobile-provider-physical-store-name-collisions` touches the same two provider files
for a different defect (they build physical store names by hand instead of using the shared
helper). Independent root causes; worth fixing in one pass.
