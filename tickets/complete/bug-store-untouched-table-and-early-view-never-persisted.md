---
description: Fixed two silent losses in persistent databases — a table that was created but never used, and a view created before the first such table, both vanished on reopen.
files:
  - packages/quereus-store/src/common/store-module-schema-sync.ts   # `table_added` arm; subscription docstrings
  - packages/quereus-store/src/common/store-module-catalog.ts       # persistTableCatalogEntryIfChanged; ownsTableCatalogEntry now protected
  - packages/quereus-store/src/common/store-table-base.ts           # lazy save is now a compare-write backstop
  - packages/quereus-store/src/common/store-module.ts               # onRegister; teardown drains the persist queue before deleting
  - packages/quereus/src/vtab/module.ts                             # new optional `onRegister` hook
  - packages/quereus/src/core/database.ts                           # registerModule calls onRegister
  - packages/quereus-isolation/src/isolation-module.ts              # forwards onRegister
  - packages/quereus-store/test/view-mv-persistence.spec.ts         # 5 regression tests
  - packages/quereus-store/test/isolated-store.spec.ts              # 2 tests behind the isolation wrapper
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # review fix: test premise invalidated by the change
  - docs/store.md, docs/schema.md, docs/module-authoring.md, packages/quereus-isolation/README.md
---

## What shipped

A store table's catalog entry used to be written lazily, the first time its storage was
opened. A table nobody read or wrote never opened its storage, so it was gone at the next
reopen. The entry is now written when the **engine registers the table** — a `table_added`
arm on the store's schema-change listener. That arm self-filters on ownership
(`ownsTableCatalogEntry`, now `protected`, which also recognizes a store table behind the
isolation wrapper) and compare-writes (`persistTableCatalogEntryIfChanged`) rather than
blind-putting, because `table_added` is re-delivered during rehydration for a store-hosted
materialized-view backing whose entry is already current.

Separately, the store module used to learn which `Database` it served only from its first
*table* hook. Views never route through a module hook, so a `create view` issued before the
first store table fired at a module that was not listening — nothing persisted it, and the
persistability pre-flight did not even veto it. A new optional
`VirtualTableModule.onRegister(db, moduleName)` is called at the end of
`Database.registerModule`; `StoreModule` implements it as `ensureSchemaSubscription(db)`
and `IsolationModule` forwards it.

`StoreTableBase.initializeStore` keeps a catalog write on first storage access, now as a
compare-write **backstop**: it is the only site where a table whose generated DDL text
cannot be encoded raises on a statement, since the `table_added` write rides the persist
queue, which logs and swallows. `tearDownTableStorage` drains that queue before deleting a
table's entry, so a create-then-drop in one session cannot resurrect a phantom.

## Review findings

### Verification of the two deviations the implementer flagged

Both hold up.

**Not calling `markDdlSaved()` in the `table_added` arm** (the fix ticket asked for it) is
correct. The ticket's premise — "the encodability failure is still raised up front by the
pre-flight veto" — is false for tables: `assertCatalogObjectPersistable`'s `'table'` kind is
only offered during a RENAME propagation scan, and `create table` never asks. Suppressing
the first-access write would have converted a loud error at first `insert` into a silent
loss. Keeping it as a compare-write costs one extra catalog read per newly created table's
first storage access (connected/rehydrated tables set `ddlSaved = isConnected` and skip it
entirely), and is already recorded as a `NOTE:` tripwire at the arm.

**The persist-queue drain in `tearDownTableStorage`** is correct and the re-entrancy the
implementer asked me to check does not exist. Every `persistQueue` task body is a catalog
read/write (`persistTableCatalogEntryIfChanged`, `persistCatalogIfChanged`, the view/MV
saves and removes, `writeDurableStaleMvSet`, `removeTableDDL`); none reaches teardown. The
only caller of `reclaimDetachedTable` is the host-driven basis-eviction sweep in
`quoomb-web/src/worker/quereus.worker.ts`, not a queued task. Recorded as a `NOTE:` at the
drain site with the escape hatch (capture the queue tail instead of awaiting the live one)
if a persist task ever needs to drop a table.

### Ordering hazards checked beyond the drop path

The drop path was the one the implementer hardened. I checked the same
queued-write-vs-direct-write hazard on every other catalog write path, since the
`table_added` write is queued while `createIndex` / `dropIndex` / the `alterTable` arms /
`renameTable` all write the table bundle directly:

- `createIndex` and `dropIndex` both fire `table_modified` after the module hook returns
  (`schema/manager.ts:2405`, `:2633`), so a queued compare-write follows the direct put and
  re-establishes the index-bearing bundle even if the two raced. Same for the structural
  `alterTable` arms.
- `renameTable` writes the new-name entry directly (a different key, so no conflict with a
  pending `table_added` write for the old name) and enqueues the old-entry delete, which is
  FIFO-behind that write. Correct without further change.
- The `initializeStore` backstop is not on the queue, but it writes byte-identical content
  to the queued `table_added` write, so interleaving is harmless.

The implementer's stated invariant — "every other direct catalog write is followed by a
queued event that re-establishes the truth" — holds.

### The two "known gaps" that turned out not to be gaps

**Store-hosted MV backing across reopen with the `table_added` arm active** is already
covered, contrary to the handoff. `mv-rehydrate-adopt.spec.ts` has *"catalog fixed point:
bytes after an adopt session equal bytes after a refill session"* and *"catalog fixed point:
clean atomic-domain reopen cycles converge to identical catalog bytes"*. The refill session
in the first drops and recreates the store-hosted backing through `createBackingTable`,
which is exactly the `table_added` re-delivery path, and the catalog bytes still match the
adopt session's. Both green. No new test needed.

**`yarn test:store`** (deferred by the implementer as the one run that exercises real async
IO ordering on the catalog write path) — I ran it: **8140 passing, 21 pending, 0 failing**.

### Minor findings, all fixed in this pass

1. `store-module-schema-sync.ts` — the `rehydrateCatalog` docstring still said the
   subscription is established there because "all the lazy subscription points are table
   hooks", directly contradicting the body comment three lines below it. Rewritten.
2. `store-module-catalog.ts` — `ownsTableCatalogEntry`'s closing paragraph claimed it is
   "STRICTER than the write path" because `persistCatalogIfChanged` skips an absent entry,
   and pointed at "that table's eventual lazy `saveTableDDL`". Both premises died with this
   change: the `table_added` write path is `persistTableCatalogEntryIfChanged`, which has no
   absent-skip, so the filter now *agrees exactly* with it. Rewritten to distinguish the two
   write paths.
3. `store-module-catalog.ts` — `tableCatalogEntry`'s docstring named `saveTableDDL` as the
   sole write path sharing it. Now names both.
4. `store-module.ts` `closeAll` and `store-module-schema-sync.ts` `computeStaleMvSet` both
   documented the no-`subscribedDb` case as "opened but never rehydrated and never had a
   store table created/connected". Since `onRegister` subscribes at `registerModule`, that
   arm is now reachable only by a module never registered on any `Database`. Both rewritten.
5. `mv-rehydrate-adopt.spec.ts` — the test *"a close with no subscribed db writes an empty
   stale set"* silently lost the branch it named: its session-2 module goes through
   `open()`, which registers it, so it is now subscribed and passes only because the fresh
   db has no maintained tables. Split into a genuinely unregistered module (the real
   no-`subscribedDb` arm, now the only way to reach it) plus the registered-but-idle case,
   and renamed.
6. `database.ts` and `vtab/module.ts` — both said a throw from `onRegister` "fails the
   registration". It does not: `schemaManager.registerModule` and `hookModuleEvents` have
   already run, so a throw propagates to the caller with the module fully registered. Not a
   live defect (`StoreModule.onRegister` only warns), but the contract as written invites a
   future module to use the hook as an abort seam. Both reworded to say what actually
   happens. Left the call site where it is rather than reordering — nothing depends on abort
   semantics today, and moving it would change `hookModuleEvents` ordering for no gain.

### Categories checked with nothing to report

- **Ownership filter false positives/negatives.** `this.tables` is keyed
  `schema.table` lowercased and is populated by `create`/`connect` and cleared by
  `tearDownTableStorage`, so a foreign module's table cannot inherit a stale entry. A second
  `StoreModule` on the same db, a memory table, and a memory-hosted MV backing all fail the
  filter correctly.
- **Rehydration re-entry.** Plain table import is silent (`importTable` fires no
  `notifyChange`), so the arm only sees the MV-backing re-delivery it was designed for.
- **Type safety.** `table_added`'s `newObject` is `TableSchema` in the event union; no casts
  added. `onRegister` is synchronous by signature, which is required — `registerModule` is
  synchronous and could not await it.
- **Source hygiene.** No file grew materially: the four touched store files are 518–911
  lines and `vtab/module.ts` is 720. `isolation-module.ts` is 1860 lines but gained only 16,
  and its size is already tracked by `backlog/debt-isolation-module-file-too-large`.
- **Resource cleanup.** No new listeners, handles, or timers; the drain awaits an existing
  chain.
- **New tickets.** None filed. The one genuinely out-of-scope defect
  (`create table` never being offered the persistability pre-flight) was already filed by
  the implementer as `backlog/bug-create-table-not-checked-for-persistability`; I read it and
  it is well-formed — plain-language description, correct root-cause site
  (`SchemaManager.createTable`), `repro: static`, and it names the two
  `lone-surrogate-keys.spec.ts` tests that would need rewriting.

### Tripwires recorded (not tickets)

- `store-module.ts` `tearDownTableStorage` — `NOTE:` that the drain self-deadlocks if a
  `persistQueue` task ever calls `destroy`/`reclaimDetachedTable`, with the fix if it
  happens. Verified unreachable today.
- The `table_added` compare-write costing one catalog read per `CREATE TABLE`, plus a second
  from the backstop — already recorded as a `NOTE:` by the implementer at the arm, with the
  escape (hand the freshly written bundle to the `StoreTable`, as `createIndex` does with
  `markDdlSaved`). Left as-is.
- `onRegister` firing after `hookModuleEvents` is fixed but untested. No module depends on
  the order, so this stays a comment at `database.ts` rather than a test.
- The engine's built-in memory module is registered through the internal
  `schemaManager.registerModule` at `database.ts:185`, which does not call `onRegister`.
  Deliberate — `MemoryTableModule` implements no hook — and those are the only two
  `schemaManager.registerModule` call sites, so no other module can be missed this way.

## Validation

- `yarn build` — clean
- `yarn typecheck` — clean
- `yarn lint` — clean
- `yarn test` (all workspaces) — 0 failing (8148 + 1222 + 594 + 355 + 134 + 113 + 68 + 63 +
  52 + 34 + 31 + 28 + 22 + 17 passing; 13 pending)
- `yarn test:store` (LevelDB re-run of the engine logic suite — the deferral this pass
  closed) — 8140 passing, 21 pending, 0 failing
- `yarn workspace @quereus/store run test` re-run after the review edits — 1222 passing
