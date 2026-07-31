---
description: Fixed two silent losses in persistent databases — a table that was created but never used, and a view created before the first such table, both vanished on reopen.
files:
  - packages/quereus-store/src/common/store-module-schema-sync.ts   # new `table_added` arm; subscription docstrings
  - packages/quereus-store/src/common/store-module-catalog.ts       # persistTableCatalogEntryIfChanged; ownsTableCatalogEntry now protected; veto docstring
  - packages/quereus-store/src/common/store-table-base.ts           # lazy save is now a compare-write BACKSTOP; StoreTableModule interface
  - packages/quereus-store/src/common/store-module.ts               # onRegister; teardown drains the persist queue before deleting the entry
  - packages/quereus/src/vtab/module.ts                             # new optional `onRegister` hook
  - packages/quereus/src/core/database.ts                           # registerModule calls onRegister
  - packages/quereus-isolation/src/isolation-module.ts              # forwards onRegister
  - packages/quereus-store/test/view-mv-persistence.spec.ts         # 5 new regression tests
  - packages/quereus-store/test/isolated-store.spec.ts              # 2 new tests behind the isolation wrapper
  - docs/store.md, docs/schema.md, docs/module-authoring.md, packages/quereus-isolation/README.md
difficulty: medium
---

## What shipped

### Arm 1 — an empty, never-touched persistent table is now saved

A store table's catalog entry used to be written lazily, the first time its underlying
storage was opened. A table nobody read or wrote never opened its storage, so its entry
was never written and the table was gone at the next reopen.

The entry is now written when the **engine registers the table** — a new `table_added`
arm on the store's schema-change listener (`store-module-schema-sync.ts`). Registration
is the right moment: `SchemaManager.createTable` runs `validateForeignKeyCollations`
*after* `module.create` returns and throws there without calling `destroy`, so an eager
write inside `create` could leave an entry for a table the user never got — a phantom
table on reopen.

The arm:
- **self-filters on ownership** via `ownsTableCatalogEntry` (now `protected`), which also
  recognizes a store table behind the isolation wrapper (`vtabModule.underlying === this`);
- **compare-writes** (`persistTableCatalogEntryIfChanged`, new) rather than blind-putting,
  because `table_added` is re-delivered during rehydration for a store-hosted
  materialized-view backing whose entry is already current.

### Arm 2 — a view created before the first persistent table is now saved

The store module used to learn which `Database` it served only from its first *table*
hook. Views and materialized views never route through a module hook, so a `create view`
issued before the first store table fired at a module that was not listening — nothing
persisted it, and the persistability pre-flight (`assertCatalogObjectPersistable`) did
not even veto it, because that hook self-gated on `subscribedDb === db`.

New optional `VirtualTableModule.onRegister(db, moduleName)`, called at the end of
`Database.registerModule`. `StoreModule` implements it as `ensureSchemaSubscription(db)`;
`IsolationModule` forwards it to `underlying`. The module is now subscribed before any
statement can run.

## Two deviations from the ticket's plan — please check these first

**1. The ticket said to call `markDdlSaved()` in the `table_added` arm. I did not.**

Doing so broke two existing tests in `lone-surrogate-keys.spec.ts`. Reason: the lazy
first-access `saveTableDDL` is the only site where a table whose *generated DDL text*
cannot be encoded (a lone surrogate in a quoted column name, a `default '…'` string
constant, a `check` constant) raises on a statement. The `table_added` write rides
`persistQueue`, which logs and swallows — so suppressing the lazy save converted a loud
error at first `insert` into a silent loss. The ticket's claim that "the encodability
failure is still raised up front by the pre-flight veto" is **not true for tables**:
`assertCatalogObjectPersistable`'s `'table'` kind is only offered during a RENAME
propagation scan; `create table` never asks.

Instead, `StoreTableBase.initializeStore` now calls the new
`persistTableCatalogEntryIfChanged` rather than `saveTableDDL`. For a normally-persisted
table it reads and compare-skips (no second put — the ticket's actual goal); for an
unencodable one the entry is absent (the queued write threw), so it attempts the write
and the encoding guard throws into the statement, exactly as before.

Cost: one extra catalog read per table's first storage access. Recorded as a `NOTE:`
tripwire at the `table_added` arm.

**2. I added a persist-queue drain in `tearDownTableStorage` that the ticket did not ask
for.** `create table t; drop table t` in one session: the `table_added` write is queued,
the drop's `removeTableDDL` is direct, so the queued write could land *after* the delete
and resurrect a phantom entry. Every other direct catalog write in the module is followed
by a queued `table_modified` (or, for RENAME, a queued `removeTableDDL`) that
re-establishes the truth; a drop has no such follow-up. `tearDownTableStorage` now awaits
`whenCatalogPersisted()` before removing. **Reviewer: verify no re-entrancy** — no
`persistQueue` task calls `destroy` today, but that is an invariant, not an enforced one.

## Use cases to exercise

Direct (`packages/quereus-store/test/view-mv-persistence.spec.ts`, 5 new tests):
- `create table lonely (…) using store` with **no read and no write**, close, reopen →
  table rehydrates, `count(*)` is 0, and an `insert` afterwards works.
- Empty store table + `create index`, close, reopen → table *and* index rehydrate.
- `create table` then `drop table` (never touched), close, reopen → **no** phantom entry.
- `create view early as select 1 as x` as the **first statement of a brand-new database**
  (no rehydrate, no prior store table), then a table, close, reopen → view is queryable.
- `create view "<lone surrogate>"` as the first statement → now **refused** (previously
  slipped past the veto gate entirely).

Behind the isolation wrapper (`packages/quereus-store/test/isolated-store.spec.ts`,
2 new tests, pinning both the `ownsTableCatalogEntry` wrapper branch and the `onRegister`
forward):
- empty never-touched store table survives reopen;
- view as the first statement survives reopen.

Pre-existing tests that matter as guards, all still green:
- "a second consecutive reopen yields identical catalog bytes" — guards the
  `table_added` compare-write against double-writing.
- "view/MV writes enqueue on the persist queue" — asserts an exact put count; unaffected
  because the table bundle is written before the spy is installed.
- The two `lone-surrogate-keys.spec.ts` tests described above.

## Known gaps

- **A store table with unencodable DDL text that is never read or written is still
  silently lost.** Same family as this ticket, now narrower. Root cause: `create table`
  is never offered the persistability pre-flight. Filed as
  `backlog/bug-create-table-not-checked-for-persistability` (not fixed here — it is an
  engine-side change to `SchemaManager.createTable`, and it would require rewriting the
  two `lone-surrogate-keys.spec.ts` tests to expect the error at `create`).
- **No test covers a store-hosted materialized-view backing across reopen with the new
  `table_added` arm active.** The idempotency test covers a *memory*-hosted MV backing.
  The re-delivery no-op argument for the store-hosted case rests on the compare-write
  plus reading the code, not on a test that exercises it. Worth a reviewer look — it is
  the one path where `table_added` fires during rehydration.
- **`onRegister` firing order vs. `hookModuleEvents`** is fixed (events hooked first,
  then `onRegister`) but nothing tests it. No module depends on the order today.
- The engine's built-in memory module is registered through the internal
  `schemaManager.registerModule` at `database.ts:185`, which does **not** call
  `onRegister`. Deliberate (that module implements no hook), but it means `onRegister`
  is not universally guaranteed for internally-registered modules.

## Validation run

- `yarn build` — clean
- `yarn workspace @quereus/store run test` — 1222 passing, 0 failing
- `yarn test` (all workspaces) — all green (8148 + 355 + 113 + 63 + 17 + 28 + 1222 + 594
  + 52 + 31 + 34 + 134 + 22 passing; 13 pending)
- `yarn lint` — clean
- `yarn typecheck` — clean

Not run: `yarn test:store` (the LevelDB re-run of the engine logic suite). The change
touches the store's catalog write path, so a reviewer with time should run it — the
in-memory provider used by the new tests resolves its IO in a handful of microtasks,
which is exactly what makes the queued-write-vs-direct-write ordering hazards hard to
observe there.

## Docs updated

- `docs/store.md` § Catalog persistence — new "When a table's entry is written" block;
  the `DROP TABLE` bullet notes the drain.
- `docs/schema.md` — "Subscription is established at `Database.registerModule`" (replacing
  the documented gap); the uncovered-cases paragraph now names the `create table` gap
  instead of this ticket slug.
- `docs/module-authoring.md` — `onRegister` added to the signaling table, the surface
  inventory, and the isolation-forwarding note.
- `packages/quereus-isolation/README.md` — `onRegister` added to the transparent-hook
  forwarding paragraph.
