---
description: Dropping a table on the two mobile storage plugins used to leave its data in place, so a new table with the same name came back full of the old rows; both plugins now erase it, and a shared test every storage plugin runs keeps future plugins honest.
files:
  - packages/quereus-store/src/testing/kv-reclaim-conformance.ts        # the shared battery (primary deliverable)
  - packages/quereus-store/src/testing/kv-lifecycle.ts                  # the shared open/teardown adapter
  - packages/quereus-store/src/testing/kv-naming-conformance.ts         # KVNamingBackend is now an alias of that
  - packages/quereus-store/src/testing/index.ts                         # exports + header
  - packages/quereus-store/src/common/kv-store.ts                       # contract wording on both delete hooks
  - packages/quereus-plugin-react-native-leveldb/src/store.ts           # clear(); isClosed()
  - packages/quereus-plugin-react-native-leveldb/src/provider.ts        # clearAndDropStore; closed-handle eviction; NOTEs
  - packages/quereus-plugin-nativescript-sqlite/src/provider.ts         # physicalTableName + dropStoreByName; NOTE
  - packages/quereus-plugin-react-native-leveldb/test/mock-leveldb.ts   # file/handle split, MockLevelDBFiles
  - packages/quereus-plugin-{leveldb,indexeddb,react-native-leveldb,nativescript-sqlite}/test/conformance.spec.ts
  - packages/quereus-store/README.md                                    # battery docs
  - docs/store.md                                                       # "deleting a store must erase it"
---

# Mobile providers now actually erase a dropped table's data

## The defect

`KVStoreProvider.deleteTableStores` / `deleteIndexStore` are how the engine reclaims a dropped
table's physical storage. `@quereus/plugin-react-native-leveldb` and
`@quereus/plugin-nativescript-sqlite` implemented both as "close the cached handle and forget
it" — nothing was erased. Store handles are re-opened lazily by name, so the next table created
under that name opened the same physical storage and started life holding the dropped table's
rows.

## What shipped

**The shared battery** — `runStoreReclaimConformance`
(`packages/quereus-store/src/testing/kv-reclaim-conformance.ts`), registered by all four
plugins alongside the naming battery. Nine cases, driving nothing but the public
`KVStoreProvider` surface:

- `deleteTableStores` erases the data store and every named index store (checked through both
  a point `get` and a full `iterate`);
- a table re-created under a dropped name holds only its own new rows (the user-visible
  corruption scenario);
- a store holding more rows than a provider erases in one pass comes back empty to the last key;
- `deleteIndexStore` erases only that index;
- a store whose handle the caller already closed is still erased (the order every `drop index`
  takes);
- sibling tables survive, including one literally named `t_idx_y`;
- an index store the caller did not name survives;
- the reserved `__stats__` / `__catalog__` stores survive;
- deleting a table or index that never existed is a no-op, not a throw.

Both hooks are optional on `KVStoreProvider`; a provider omitting one is skipped for those
cases and the skip is printed. All four shipped providers implement both.

The `open`/`teardown` pair is now the shared `KVProviderLifecycle` (`kv-lifecycle.ts`), so each
plugin spec builds ONE `providerBackend()` closure for both provider-level batteries.

**React Native LevelDB** — `ReactNativeLevelDBStore.clear()` empties the keyspace in bounded
passes (512 keys: read a pass → delete it in one `WriteBatch` → resume strictly past the last
key), and the provider's `clearAndDropStore` clears then closes and evicts the handle. Both
delete hooks go through it. Also `isClosed()` + stale-handle eviction in `getOrCreateStore`,
without which every real `drop index` threw (`tearDownIndexStore` closes the cached index
handle before asking the provider to delete that store).

**NativeScript SQLite** — `drop table if exists <physical name>` in both hooks, after closing
and evicting the handle, with the physical name coming from one private `physicalTableName()`
that `getOrCreateStore` shares.

**Contract + docs** — both delete hooks now state what "delete" has to accomplish, mirrored in
`docs/store.md` and `packages/quereus-store/README.md`.

## Review findings

### Verified first, before reading the handoff

Read the implement diff cold, then the surrounding code: the `KVStoreProvider` contract, all
four provider implementations, the RN store and its mock, and the engine call sites
(`StoreModuleBase.tearDownTableStorage`, `reclaimDetachedTable`, the rename fallback).

**The battery bites — watched, not assumed.** Disabling the NativeScript `drop table` made 4
reclaim cases fail; forcing the RN clear to a single pass made the new bulk case fail. Both
probes reverted.

**Lint, typecheck and the full workspace sweep are green** — `yarn lint` (only
`packages/quereus` has a real lint; it ran clean), `yarn typecheck`, and `yarn test` (9508 +
387 + 156 + 89 + 78 + 89 + 1710 + 725 + 85 + 31 + 34 + 134 + 22 passing, 0 failing). Per-plugin:
leveldb 89, indexeddb 156, react-native-leveldb 89, nativescript-sqlite 78 — each +2 from the
new cases. No pre-existing failures surfaced.

### Minor — fixed in this pass

- **The chunked clear was never tested above its chunk size.** Every case seeded a single
  marker key, so the resume-between-passes path — the only non-trivial new logic — never ran.
  A walk that restarted, or stopped after one pass, would have shipped green. Added a case
  seeding 1100 rows (`BULK_ROW_COUNT`, above the 512-key pass any shipped provider uses) and
  watched it fail against a deliberately single-pass clear.
- **The contract's "index stores that were not named must be untouched" had no test.** Added
  one: seed indexes `x` and `unnamed`, delete naming only `x`, assert `unnamed` keeps its row.
  All four providers already hold it.
- **The clearing walk lived in the provider, reaching through the store's `iterate`/`batch`.**
  Moved into `ReactNativeLevelDBStore.clear()`, so it parallels `@quereus/plugin-leveldb`
  exactly (store owns the erase, provider owns the handle) and the pass size lives with the
  walk. Split the read half into `readKeyChunk` so `clear()` reads as its loop.
- **Batch-per-pass, deliberately.** `WriteBatch` is documented SINGLE USE with reuse-after-write
  explicitly unspecified across backends, so hoisting one batch across passes (tried, reverted)
  would lean on RN-specific behavior. Noted at the site so the next reader does not "optimize"
  it back.
- **`deleteTableStores`'s summary line contradicted its own new bullets** — it said "Delete all
  stores for a table (data, indexes, stats)" while the bullets below require `__stats__` be left
  alone. Reworded to say what stats actually are (one entry in a shared store) and whose job
  they are.
- **Both mobile providers claimed the stats entry "will be removed by the calling code if
  needed".** Nothing removes it — see the ticket below. Comments corrected to say so.
- **`MockLevelDBFiles.names()` was dead** on arrival; removed.
- **NativeScript comment claimed `encodeSqliteName` produces `[a-z0-9_]`** — its escapes are
  UPPERCASE hex. The no-injection conclusion holds; the premise was wrong. Corrected.
- Both docs (`docs/store.md`, `packages/quereus-store/README.md`) updated for the two new cases.

### Major — filed as tickets

- `backlog/bug-drop-table-leaves-stale-stats-entry` — a table's persisted row count lives as one
  entry in the shared `__stats__` store, and NOTHING deletes it on drop (rename migrates it;
  drop is the outlier). So `drop table t; create table t` gives the new empty table the old
  one's row count, permanently inflating the planner's size estimate. Estimate only — no query
  returns wrong rows, which is why it is backlog and not fix. Root cause is one site,
  `StoreModuleBase.tearDownTableStorage`; the ticket asks for the generalized assertion ("after
  a drop, nothing keyed to that table survives anywhere") rather than a stats-only test, since
  this is the third kind of per-table residue.
- `backlog/debt-reclaim-battery-not-self-checked` — the handoff flagged this and it is real: the
  battery's assertions are inline in its `it()` blocks, so unlike its sibling
  `runStoreNameDistinctness` (whose core assertion is exported and driven against broken
  provider doubles in `test/store-name-distinctness.spec.ts`) nothing catches a future edit that
  neuters a case. Hand-probing twice this pass is not durable.

### Tripwires — recorded at the site, not filed

- `packages/quereus-plugin-react-native-leveldb/test/mock-leveldb.ts` header — the mock's
  file/handle split does not model LevelDB's single-writer lock: a real database directory
  admits one open handle, `MockLevelDBFiles.open` hands out any number. Nothing exercises the
  difference today (the provider keeps one handle per name), but a future path holding two would
  pass here and fail on device.
- The implement stage's own NOTEs were checked and kept: three at RN `clearAndDropStore` (empty
  on-device directory left behind; clearing an absent store creates an empty database; the clear
  is not crash-atomic — this one moved to `store.ts` with the walk) and one at NativeScript
  `dropStoreByName` (`drop table` frees pages to the freelist but does not shrink the file).

### Checked and clean — stated, not silent

- **RN caches its `__stats__` / `__catalog__` handles in plain fields with no `isClosed()`
  eviction**, unlike the store map. Traced every out-of-band closer: `StoreTableBase` never
  closes its stats handle, and `closeStore`/`closeIndexStore` do not touch those two. No dead
  handle is reachable, so no ticket — the same shape `@quereus/plugin-leveldb` has.
- **Retaining a pass's worth of key buffers** during the clear is safe: the `KVStore` contract
  requires `get`/`iterate` to hand back buffers independent of store state, and the mock asserts
  it.
- **No accepted-tradeoff `NOTE:`** sits at any site touched here, so nothing was re-filed against
  a decision already made.
- **The deviation the implement stage documented** (a sibling table named `t_idx_x` alongside
  index `x` on table `t` is not representable — both compose to `main.t_idx_x`, and
  `StoreModuleBase.assertStoreNameFree` is what keeps the pair from coexisting) is correct;
  `t_idx_y` catches the same prefix-scan defect.

### Still open — not fixed here, not filed

Nothing in this work runs on a real device: RN is driven by `MockLevelDB` and NativeScript by
better-sqlite3 behind the `SQLiteDatabase` interface. The clearing walk against real rn-leveldb
(iterator snapshot semantics while deleting through a `WriteBatch`) and `drop table` against
@nativescript-community/sqlite remain unverified on hardware. That needs a device, not a ticket.
The 512-key pass size is likewise a judgement call, documented as such at the constant — nothing
has profiled a drop on a phone.
