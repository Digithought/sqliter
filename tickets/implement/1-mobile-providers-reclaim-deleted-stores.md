---
description: On the two mobile storage plugins, dropping a table never actually erases its data — so creating a new table with the same name later comes back full of the old table's rows. Fix both plugins, and add a shared test every storage plugin runs so no future plugin can reintroduce it.
files:
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts        # deleteIndexStore (212), deleteTableStores (217) — close only, no erase
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts         # deleteIndexStore (159), deleteTableStores (164) — close only, no erase; wrong comment at 161
  - packages/quereus-plugin-leveldb/src/provider.ts                     # clearAndDropStore (387) — the shape that is correct today
  - packages/quereus-plugin-indexeddb/src/provider.ts                   # deleteIndexStore (145), deleteTableStores (199) — correct today
  - packages/quereus-store/src/common/kv-store.ts                       # KVStoreProvider.deleteTableStores / deleteIndexStore contract (377-400)
  - packages/quereus-store/src/testing/kv-naming-conformance.ts         # the sibling battery to model the new one on
  - packages/quereus-store/src/testing/index.ts                         # test-support entry point — export the new battery here
  - packages/quereus-plugin-react-native-leveldb/test/mock-leveldb.ts   # MockLevelDB — needs a reopen-after-close story (see below)
  - packages/quereus-plugin-react-native-leveldb/test/conformance.spec.ts
  - packages/quereus-plugin-nativescript-sqlite/test/conformance.spec.ts
  - packages/quereus-plugin-leveldb/test/conformance.spec.ts
  - packages/quereus-plugin-indexeddb/test/conformance.spec.ts
difficulty: medium
repro: verified
---

# Mobile storage plugins must actually erase a dropped table's data

## The defect

`KVStoreProvider.deleteTableStores(schema, table, indexNames)` is the hook the engine calls
to **erase** a table's physical storage — its row data and each of its secondary indexes.
`DROP TABLE` calls it (`store-module.ts:576`); so does `ALTER TABLE … RENAME TO` on a
provider with no native move hook, which copies the rows to the new name and then calls
this to reclaim the old ones (`store-module-rename.ts:403`). `deleteIndexStore` is the same
promise for one index (`store-module-index.ts:673`).

Two of the four providers implement those methods as **close the handle and forget it**.
Nothing is erased. Store handles are re-opened lazily by name, so the next table to use that
name opens the same physical storage and starts life holding the dropped table's rows.

`@quereus/plugin-leveldb` (clears the sublevel) and `@quereus/plugin-indexeddb` (deletes the
object store) are already correct — they are the reference shape.

## Verified, not inferred

Reproduced in-process against both plugins' existing test doubles (`MockLevelDB`, and
better-sqlite3 behind the `SQLiteDatabase` interface). Write a row into a table's data store
and its index store, call `deleteTableStores`, re-open both by the same names:

```
rn-leveldb:      on-device db names: [ 'quereus.main.t', 'quereus.main.t_idx_ix' ]
                 data store row after delete:  Uint8Array(1) [ 170 ]     (expected undefined)
                 index store row after delete: Uint8Array(1) [ 187 ]     (expected undefined)
nativescript:    sqlite tables: [ 'quereus_main_2Et', 'quereus_main_2Et_5Fidx_5Fix' ]
                 data store row after delete:  <Buffer aa>               (expected undefined)
                 index store row after delete: <Buffer bb>               (expected undefined)
```

`deleteIndexStore` fails the same way on both. The repro specs were temporary and are not in
the tree — the shared battery below replaces them.

Note the NativeScript plugin's comment at `provider.ts:161`, which is simply false and should
go: *"SQLite doesn't need explicit store deletion - table is dropped when closed."* Closing a
connection does not drop a table.

## Two stale claims in the source ticket, for the record

- The naming defect it points at (`bug-mobile-provider-physical-store-name-collisions`) has
  **already landed** — both providers now build names via `buildDataStoreName` /
  `buildIndexStoreName` and escape them injectively. Nothing to fix in one pass with it.
- Both packages **do** have test harnesses now (`test/` with a conformance spec each), so
  this is testable off-device.

## Where the fix belongs

Highest rung first: the class here is "a provider's delete does not delete", and nothing in
the codebase would catch the next provider that gets it wrong. `@quereus/store/testing`
already pins two provider-level properties across every backend — `runKVStoreConformance`
(the `KVStore` contract) and `runStoreNameDistinctness` (no two logical stores fold onto one
physical store). This is a third property of exactly that kind, so **the shared battery is
the primary deliverable** and the two provider fixes are what it proves.

### Arm 1 — a shared reclaim battery every provider runs

New `packages/quereus-store/src/testing/kv-reclaim-conformance.ts`, modelled closely on
`kv-naming-conformance.ts` (same module-local Mocha globals, same per-test lifecycle,
same "needs nothing beyond the public `KVStoreProvider` surface" property).

The lifecycle adapter is the same two methods `KVNamingBackend` already has:

```ts
interface KVReclaimBackend {
	/** Open a provider over a fresh, EMPTY physical keyspace. Called once per test. */
	open(): Promise<KVStoreProvider>;
	/** Release everything open() created (close the provider, rm dirs / delete dbs). */
	teardown(): Promise<void>;
}
```

Rather than duplicate it, factor the pair into one shared `KVProviderLifecycle` interface and
let `KVNamingBackend` alias it — one shape, one place, and a plugin's two adapters stay
interchangeable.

The property under test, stated for a reader with no context:

> After a provider is told to delete a table's stores, re-opening those stores by the same
> names must find them empty — and every other store must be untouched.

Cases, each driving a data store plus at least one index store:

- **`deleteTableStores` erases the data store and every named index store.** Re-open by the
  same names; both read back empty (`get` → `undefined`, `iterate` yields nothing).
- **Re-create-and-reuse.** Delete, re-open, write a *different* row, read the whole store
  back: exactly the new row is present. This is the user-visible corruption scenario.
- **`deleteIndexStore` erases just that index store**, leaving the table's data store and its
  other index stores intact.
- **Siblings survive.** A second table, and a table literally named `t_idx_x` alongside table
  `t`'s index `x`, must be untouched when `t` is deleted. `_idx_` is a legal substring of an
  ordinary identifier, which is exactly why the contract forbids prefix scans; this is the
  behavioral counterpart of that rule.
- **Reserved stores survive.** The unified `__stats__` store and the `__catalog__` store
  still hold what was written to them after a table delete.
- **Deleting what was never created is a no-op, not a throw** — the engine calls these
  speculatively on reclaim paths (`store-module.ts:531` says so explicitly). Both an
  unknown table and an index name the table never had.

Both hooks are **optional** in `KVStoreProvider`, so the battery must skip gracefully when a
provider omits one rather than crash — and say in its output that it skipped, so a provider
cannot silently opt out of the property.

Export from `packages/quereus-store/src/testing/index.ts` and register in all four plugins'
`test/conformance.spec.ts`, beside the existing `runStoreNameDistinctness` call. Each spec
already has a provider adapter of the right shape to copy.

`plugin-leveldb` and `plugin-indexeddb` are expected to pass unchanged — if either does not,
that is a real finding, not a battery bug; fix the provider.

#### The React Native adapter needs a reopenable mock

`MockLevelDB.close()` sets a terminal `closed` flag, and the naming spec's `openFn` memoizes
one mock **instance** per database name — so the second open of a name after a close throws
`Database is closed`. Real rn-leveldb re-opens the same on-device file with a fresh handle,
and this battery depends on that (it deletes, then re-opens). Separate the "file" from the
"handle" in `test/mock-leveldb.ts`: persistent per-name data, with each open handing back a
fresh handle whose `close()` drops only the handle. Keep the mock faithful — its header
explains why a mock defect and a store defect are indistinguishable in the failure output.

### Arm 2 — React Native LevelDB: clear the store's keyspace

Each logical store is its own on-device LevelDB database, and the provider is handed only an
`openFn`, so the portable erase is to empty the keyspace: open the store, then repeatedly
read a bounded chunk of keys and delete them through a `WriteBatch` until the store is empty,
then close and evict the cached handle. Chunked, not one batch, so peak memory is a chunk
rather than the table — the same bounded-peak rule `KVStore.iterate` is held to. Put the
chunk size in a named, documented constant.

Both `deleteTableStores` (data store plus each name in `indexNames`, built via
`buildIndexStoreName`) and `deleteIndexStore` go through this one private helper. Mirror
`plugin-leveldb`'s `clearAndDropStore` shape (`provider.ts:387`).

Two residues to record as `NOTE:` tripwires at the site, not to solve here:

- Clearing empties the database but leaves the on-device LevelDB directory in place (a few KB
  of `MANIFEST`/`LOG`/`CURRENT`). The row data — the leak that matters on a phone — is gone.
  If empty-database residue ever matters, add an optional `destroyFn` provider option
  (rn-leveldb's database-destroy entry point) and call it after clearing; do not guess that
  API's shape without checking the installed version, as it is only a peer dependency here.
- Clearing a store that never existed opens it first, which with the default
  `createIfMissing` **creates** an empty database as a side effect. Harmless (the operation is
  still a no-op for data), same residue as above.

### Arm 3 — NativeScript SQLite: drop the backing table

Each logical store is a table in one shared SQLite database, so the erase is
`drop table if exists <physical name>` — a genuine reclaim (pages return to the file's
freelist), and a natural no-op when the table is absent, creating nothing. Close and evict
the cached handle first.

The physical name **must** come from the same derivation `getOrCreateStore` uses
(`${tablePrefix}${encodeSqliteName(storeName)}`). Factor it into one private
`physicalTableName(storeName)` that both call. A second hand-derived spelling here is the
precise defect class the naming work already had to remove from this file once.

Delete the false comment at `provider.ts:161`.

Tripwire to record as a `NOTE:` at the site: dropping a table returns its pages to the SQLite
file's freelist for reuse, but does not shrink the file on disk — that needs a `vacuum`,
which is not run here. If a mobile app's database file growing and never shrinking becomes a
complaint, that is the thread to pull.

## Contract wording

`KVStoreProvider.deleteTableStores` / `deleteIndexStore` in
`packages/quereus-store/src/common/kv-store.ts` describe *which* stores to delete but never
say what "delete" has to accomplish, which is how "close the handle" passed for an
implementation twice. State it: the stores must read back empty when re-opened under the same
names, deleting an absent store is a no-op rather than an error, and other stores — including
the reserved `__stats__` and `__catalog__` stores — must be untouched. Point at the new
battery as the enforcement, the way the naming paragraph points at
`runStoreNameDistinctness`.

## TODO

Phase 1 — the shared battery (write it first; it should fail on the two mobile plugins)

- Add `packages/quereus-store/src/testing/kv-reclaim-conformance.ts` with
  `runStoreReclaimConformance(name, makeBackend)`, covering the cases listed above.
- Factor the shared `open`/`teardown` lifecycle interface and alias `KVNamingBackend` to it.
- Export the battery and its backend type from `packages/quereus-store/src/testing/index.ts`;
  extend that file's header, which lists the batteries.
- Give `MockLevelDB` a persistent-per-name / fresh-handle split so a database re-opens after
  close; keep the existing specs and the naming adapter working.
- Register the battery in all four plugins' `test/conformance.spec.ts`.
- Run all four plugin test suites. Confirm `plugin-leveldb` and `plugin-indexeddb` pass, and
  that the two mobile plugins fail on exactly the reclaim cases.

Phase 2 — the two provider fixes

- React Native LevelDB: private chunked clear helper; route `deleteTableStores` and
  `deleteIndexStore` through it; named chunk-size constant; the two `NOTE:` tripwires.
- NativeScript SQLite: private `physicalTableName(storeName)` shared with `getOrCreateStore`;
  `drop table if exists` in both delete hooks; remove the false comment; the `vacuum`
  `NOTE:` tripwire.
- Update the `KVStoreProvider` contract wording for both hooks.

Phase 3 — validate

- `yarn build`, then the four plugin test suites (the batteries import from `@quereus/store`'s
  built `dist`, so build first), then `yarn test` and `yarn typecheck`.
- Check whether either plugin's README documents the delete/drop behavior and correct it if so.
