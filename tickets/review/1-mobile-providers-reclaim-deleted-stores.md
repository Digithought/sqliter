---
description: Dropping a table on the two mobile storage plugins used to leave its data in place, so a new table with the same name came back full of the old rows; both plugins now erase it, and a shared test every storage plugin runs keeps future plugins honest.
files:
  - packages/quereus-store/src/testing/kv-reclaim-conformance.ts        # NEW — the shared battery (primary deliverable)
  - packages/quereus-store/src/testing/kv-lifecycle.ts                  # NEW — the shared open/teardown adapter
  - packages/quereus-store/src/testing/kv-naming-conformance.ts         # KVNamingBackend is now an alias of that
  - packages/quereus-store/src/testing/index.ts                         # exports + header
  - packages/quereus-store/src/common/kv-store.ts                       # contract wording on both delete hooks
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts        # clearAndDropStore; closed-handle eviction; 3 NOTEs
  - packages/quereus-plugin-react-native-leveldb/src/store.ts           # new isClosed()
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts         # physicalTableName + dropStoreByName; 1 NOTE
  - packages/quereus-plugin-react-native-leveldb/test/mock-leveldb.ts   # file/handle split, MockLevelDBFiles
  - packages/quereus-plugin-{leveldb,indexeddb,react-native-leveldb,nativescript-sqlite}/test/conformance.spec.ts
  - packages/quereus-store/README.md                                    # battery docs
  - docs/store.md                                                       # "deleting a store must erase it"
difficulty: medium
---

# Review: mobile providers now actually erase a dropped table's data

## What the defect was

`KVStoreProvider.deleteTableStores` / `deleteIndexStore` are how the engine reclaims a
dropped table's physical storage. `@quereus/plugin-react-native-leveldb` and
`@quereus/plugin-nativescript-sqlite` implemented both as **close the cached handle and
forget it** — nothing was erased. Store handles are re-opened lazily by name, so the next
table created under that name opened the same physical storage and started life holding the
dropped table's rows.

## What landed

**Arm 1 — the shared battery (`runStoreReclaimConformance`).** New
`packages/quereus-store/src/testing/kv-reclaim-conformance.ts`, modelled on
`kv-naming-conformance.ts`. Seven cases, all driving a data store plus index stores through
nothing but the public `KVStoreProvider` surface:

- `deleteTableStores` erases the data store and every named index store (checked through
  both read paths — a point `get` and a full `iterate`);
- a table re-created under a dropped name holds only its own new rows (the user-visible
  corruption scenario);
- `deleteIndexStore` erases only that index, leaving the data store and the other index;
- a store whose handle the caller **already closed** is still erased — see "extra fix" below;
- sibling tables survive, including one literally named `t_idx_y`;
- the reserved `__stats__` / `__catalog__` stores survive a table delete;
- deleting a table or an index that never existed is a no-op, not a throw.

Both hooks are optional on `KVStoreProvider`; a provider omitting one is skipped for those
cases and the skip is **printed** (`… SKIPPED — the provider does not implement …`), so a
provider cannot silently opt out. All four shipped providers implement both, so no skip is
printed today.

The `open`/`teardown` pair `KVNamingBackend` had is now `KVProviderLifecycle`
(`kv-lifecycle.ts`); `KVNamingBackend` and `KVReclaimBackend` are both aliases of it, and
each plugin spec builds ONE `providerBackend()` closure it hands to both batteries.

**Arm 2 — React Native LevelDB.** `clearAndDropStore` empties the store's keyspace in
bounded chunks (`CLEAR_CHUNK_SIZE = 512`, read a chunk → delete it in one `WriteBatch` →
resume strictly past the last key), then closes and evicts the handle. Both delete hooks go
through it. Resuming past the last key (rather than re-reading from the start) is what makes
the walk terminate in one pass even if a delete does not land.

**Arm 3 — NativeScript SQLite.** `drop table if exists <physical name>` in both hooks, after
closing and evicting the handle. The physical name comes from one new private
`physicalTableName(storeName)` that `getOrCreateStore` also uses — no second hand-derived
spelling. The false comment (`"SQLite doesn't need explicit store deletion - table is dropped
when closed"`) is gone.

**Contract + docs.** `KVStoreProvider.deleteTableStores` now states what "delete" has to
accomplish (re-opens empty; absent store is a no-op; other stores untouched; releasing bytes
on disk is not part of the contract) and points at the battery, the way the naming paragraph
points at `runStoreNameDistinctness`. `deleteIndexStore` refers to it. Mirrored in
`docs/store.md` and `packages/quereus-store/README.md`.

## Extra fix found while implementing — worth a reviewer's attention

`StoreModuleIndex.tearDownIndexStore` closes the table's cached index handle
(`StoreTableBase.releaseIndexStore`) and **then** calls `provider.deleteIndexStore`. The RN
provider's `getOrCreateStore` handed back that now-closed handle, so the new clearing walk
threw `ReactNativeLevelDBStore is closed` on every real `drop index`. Fixed by giving
`ReactNativeLevelDBStore` an `isClosed()` and evicting a stale entry in `getOrCreateStore` —
the same shape `@quereus/plugin-leveldb` already had. The battery case above covers it; it
was watched failing (temporarily disabling the eviction reproduces the throw).

Note this also means the RN provider previously returned dead handles from
`getIndexStore`/`getStore` after any out-of-band close. Every such path in the engine
happens to be followed immediately by a delete or a `closeIndexStore`, both of which evict,
so it was not reachable — but the guard is now there regardless.

## How to validate

```
yarn build                                            # batteries import @quereus/store's dist
yarn workspace @quereus/plugin-leveldb run test        # 87 passing
yarn workspace @quereus/plugin-indexeddb run test      # 154 passing
yarn workspace @quereus/plugin-react-native-leveldb run test   # 87 passing
yarn workspace @quereus/plugin-nativescript-sqlite run test    # 76 passing
yarn test        # full workspace sweep — green
yarn typecheck   # green
```

`yarn lint` was **not** run: it only does real work in `packages/quereus`, which this diff
does not touch (every other package's `lint` is the intentional no-op).

**To watch the battery bite** (this is how it was validated, since the two provider fixes
landed in the same session as the battery):

- NativeScript: make `dropStoreByName` return before its `db.execute` → 3 reclaim cases fail
  with "the data store of main.t still serves its pre-delete row on a point read", "a table
  re-created under a dropped name reads back the dropped table's rows", and the
  `deleteIndexStore` equivalent.
- React Native: point `deleteIndexStore` back at `closeStoreByName` → the `deleteIndexStore`
  case fails the same way.
- React Native: disable the `store?.isClosed()` eviction in `getOrCreateStore` → the
  closed-handle case fails with `ReactNativeLevelDBStore is closed`.

## Known gaps — please probe these

- **Nothing here runs on a real device.** The RN plugin is driven by `MockLevelDB` and the
  NativeScript plugin by better-sqlite3 behind the `SQLiteDatabase` interface. The clearing
  walk's behavior against real rn-leveldb (iterator snapshot semantics while deleting through
  a `WriteBatch`) and `drop table` against @nativescript-community/sqlite are unverified
  on-device. The walk deliberately re-reads through a fresh iterator per chunk and resumes by
  key rather than holding one cursor across deletes, which is the conservative choice.
- **No "watched failing" spec for this battery**, unlike `runStoreNameDistinctness`, whose
  core assertion is exported standalone and driven against deliberately-broken provider
  doubles in `packages/quereus-store/test/store-name-distinctness.spec.ts`. This battery's
  assertions live inside its `it()` blocks, so the equivalent would mean extracting them.
  It *was* watched failing by hand (see above), but that is not durable — a future edit that
  neutered a case would not be caught.
- **`CLEAR_CHUNK_SIZE = 512` is a judgement call, not a measurement.** Nothing has profiled a
  drop on a phone. Documented as such at the constant.
- **The ticket asked for a sibling table literally named `t_idx_x` alongside index `x` on
  table `t`.** That is not representable: both compose to the logical name `main.t_idx_x`, so
  no provider can tell them apart (`StoreModuleBase.assertStoreNameFree` is what keeps the
  pair from coexisting — `runStoreNameDistinctness` excludes it for the same reason). The
  battery uses a sibling table named `t_idx_y` instead, which still catches the `{table}_idx_`
  prefix-scan defect the case exists for. The deviation is documented in the case.
- **`MockLevelDB` now splits file from handle** (`MockLevelDBFiles` registry: persistent data
  per database name, a fresh handle per open). Worth a look that this stayed faithful to
  rn-leveldb rather than becoming convenient — the mock's header explains why a mock defect
  and a store defect are indistinguishable in the failure output.

## Tripwires recorded (not tickets)

- `packages/quereus-plugin-react-native-leveldb/src/provider.ts` — three `NOTE:`s at
  `clearAndDropStore`: clearing leaves the empty on-device LevelDB directory behind (add an
  optional `destroyFn` if that residue ever matters); clearing a store that never existed
  creates an empty database as a side effect; and the chunked clear is not crash-atomic, so a
  process death partway through leaves a tail of keys (same exposure as
  `@quereus/plugin-leveldb`'s sublevel clear, and strictly better than erasing nothing).
- `packages/quereus-plugin-nativescript-sqlite/src/provider.ts` — `NOTE:` at
  `dropStoreByName`: dropping a table returns pages to the SQLite file's freelist but does not
  shrink the file; that needs a `vacuum`, which is not run here.
