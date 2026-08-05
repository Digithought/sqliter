description: When a table gets renamed and the storage backend doesn't support moving data efficiently, the engine should copy the rows to the new name instead of silently leaving them behind and losing them.
prereq:
files:
  - packages/quereus-store/src/common/store-module-rename.ts:150-165 (the `if (this.provider.renameTableStores)` guard, and where the new fallback helper goes)
  - packages/quereus-store/src/common/kv-store.ts:279-299 (`KVStoreProvider.deleteTableStores` / `renameTableStores` doc comments)
  - packages/quereus-store/test/rename-catalog-durability.spec.ts (reference: `createPersistentProvider()` test-provider pattern to copy/adapt)
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts (ships without `renameTableStores` — becomes exercised by the fallback, no plugin change needed)
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts (same)
difficulty: easy
repro: verified
----

## Root cause

`StoreModuleRename.renameTable` (packages/quereus-store/src/common/store-module-rename.ts:162)
relocates a table's physical storage by calling the *optional* provider hook
`renameTableStores`. When a backend doesn't implement it, the call is just
skipped:

```ts
if (this.provider.renameTableStores) {
	await this.provider.renameTableStores(schemaName, oldName, newName, indexNames);
}
```

There is no `else`. The catalog is rewritten under the new name regardless, so
the table appears to rename successfully — but its rows are still sitting in
the storage area keyed by the *old* name, which nothing addresses anymore.
Read `select * from <newName>` and get zero rows. No error, no log.

Two shipped backends hit this today: `packages/quereus-plugin-react-native-leveldb`
and `packages/quereus-plugin-nativescript-sqlite` both implement
`deleteTableStores` but not `renameTableStores`. Since table renames now
replicate between sync peers, a rename issued on one device silently empties
the table on every mobile peer that re-executes it as a migration.

## Fix: generic copy fallback in the shared store module

Rather than requiring every provider to implement `renameTableStores` (which
would need real per-backend work — e.g. actual LevelDB-file or SQLite-table
renaming in the two plugins above) or hard-failing the rename on backends that
lack it (which would take rename away from RN/NativeScript entirely until
someone implements the hook), add a fallback that works for **every**
provider using only the required parts of `KVStoreProvider`
(`getStore`/`getIndexStore`, both mandatory). This fixes the shared code path
once and both mobile plugins get correct (if slower) renames for free — no
plugin-side change needed.

In `StoreModuleRename` (store-module-rename.ts), replace the bare `if` at
line 162 with:

```ts
if (this.provider.renameTableStores) {
	await this.provider.renameTableStores(schemaName, oldName, newName, indexNames);
} else {
	await this.copyTableStores(schemaName, oldName, newName, indexNames);
}
```

New helper `copyTableStores(schemaName, oldName, newName, indexNames)`:

- Open the old and new data stores via `this.provider.getStore(schemaName, oldName)` /
  `getStore(schemaName, newName)`. Stream every entry from the old store's
  `iterate()` into `put()` on the new store — don't buffer the whole table in
  memory, this path exists for backends that can't do a cheap native move, so
  assume it may be a large table.
- Repeat per index name via `getIndexStore` (old and new).
- After the copy, reclaim the old physical storage:
  - If `this.provider.deleteTableStores` is implemented, call it
    (`schemaName, oldName, indexNames`) — it both closes and physically drops
    the old-named stores.
  - If not, at least close the stale handles via the *required*
    `provider.closeStore`/`closeIndexStore` so they're not leaked, and
    `console.warn('[StoreModule] ...')` (matching the existing warning style
    in `store-module.ts`/`store-module-catalog.ts`) that the old-named data
    was left behind as an orphaned duplicate — nudging whoever owns that
    provider to implement `deleteTableStores` or `renameTableStores` for real.
- Failures here should propagate (don't swallow) — a failed copy must not let
  `renameTable` continue on to rewrite the catalog under `newName`, which
  would recreate exactly today's data-loss bug via a different path.

## Doc update

`KVStoreProvider.renameTableStores`'s doc comment (kv-store.ts:281-299)
currently only says what to do when the hook IS implemented. Add a line
stating what happens when it's omitted: the store module falls back to a
generic read-all/write-all copy via `getStore`/`getIndexStore`, which is
correct but doesn't stream at the backend's native speed and is O(table size)
in a single rename. Point provider authors at `renameTableStores` as the
efficient escape hatch.

## Tasks

- Add `copyTableStores` to `StoreModuleRename` and wire it into the `if
  (this.provider.renameTableStores)` guard at store-module-rename.ts:162, per
  the design above.
- Update the `renameTableStores` doc comment in kv-store.ts to describe the
  fallback and its cost.
- Add a test exercising the fallback path specifically: a provider modeled on
  `createPersistentProvider()` in `rename-catalog-durability.spec.ts` but with
  `renameTableStores` omitted, asserting rows (and a secondary index, to cover
  the index-store copy arm) survive `alter table ... rename to ...` and read
  back correctly under the new name. Also assert the old-named store no
  longer exists afterward (via `deleteTableStores` in the test provider).
- Run `yarn workspace @quereus/store run test` (or the monorepo `yarn test`)
  and confirm the new test passes alongside the existing rename suite
  (`rename-catalog-durability.spec.ts`, `rename-stats-migration.spec.ts`,
  `rename-table-default-reopen.spec.ts`).
- Confirm `yarn lint` / `yarn typecheck` are clean for `packages/quereus-store`.
