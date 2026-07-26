---
description: Renaming a table or column to a name containing a broken half-character quietly destroys any saved view or materialized view that mentions it — the object still works for the rest of the session and is gone the next time the database is opened.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                # rename emitters + the dependent-rewrite propagation loops
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # applyMaterializedViewRewrite (fires materialized_view_modified)
  - packages/quereus/src/schema/catalog-persistability.ts           # existing pre-flight driver to reuse
  - packages/quereus-store/src/common/store-module.ts               # assertCatalogObjectPersistable impl + dispatchSchemaChange
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts         # existing rejection cases
  - packages/quereus-store/test/view-mv-persistence.spec.ts         # existing close→reopen cases (already covers rename round-trip)
  - docs/schema.md                                                  # § View and materialized-view persistence documents this gap
  - docs/store.md                                                   # surrogate-guard section documents this gap
difficulty: medium
---

## Background

A **lone surrogate** is a broken half of a Unicode character. A JavaScript string can hold
one (`'\uD800'`) and Quereus accepts it as a `text` value, but no UTF-8 byte sequence
encodes it — `TextEncoder` folds every one of them onto the replacement character U+FFFD.
The persistent store therefore refuses to write text containing one.

`bug-store-view-lone-surrogate-name-silently-dropped` fixed the CREATE side of this for
views and materialized views. It added an optional module hook,
`VirtualTableModule.assertCatalogObjectPersistable(db, kind, object)`, asked of every
registered module **before** the object is registered; the store implements it and refuses
a view/MV whose catalog key or generated DDL text it could not encode. That hook is wired
into four call sites: `emitCreateView`, `materializeView`, and the two SET TAGS paths in
`SchemaManager`.

## What is still broken

Those four sites are not the only ways a view's or materialized view's persisted DDL text
changes. `alter table … rename to` and `alter table … rename column` rewrite the new name
into **every dependent view and materialized-view body** and re-persist them, and renaming
a materialized view moves its own catalog entry. None of those re-persists is vetted, and
all of them are fire-and-forget: the write is queued behind `SchemaChangeNotifier` (which
try/catches each listener and only logs) and then behind the store's own persist-queue
`.catch`. So the statement reports success, the object keeps working for the rest of the
session, and it is simply absent after reopen — visible only as a `console.warn`.

The implement ticket assumed this path was safe, reasoning that "a propagated body rewrite
cannot introduce a surrogate that was not already there." That is false: a rename *is* how
new text enters the body. It only looks safe for **store-backed** tables, which are
incidentally protected because the store's physical store-name guard refuses the rename
before anything else happens. A **memory** table, or a **memory-backed materialized view**,
has no such guard.

### Reproductions

All three were confirmed against `f967181e` (the implement commit) with an in-memory KV
provider and a store module registered on the database. In each case the statement
**succeeds**, and the only sign of loss is a `[StoreModule] Failed to persist catalog DDL
after schema change: …` warning.

1. **Renaming a memory-backed materialized view.** This is the worst one — the old catalog
   entry is deleted before the new one fails to write, so the MV is destroyed outright
   rather than merely left stale.

   ```sql
   create table t (id integer primary key, v integer) using store;
   create materialized view mv as select id, v from t;   -- memory backing (the default)
   alter table mv rename to "<lone surrogate>";           -- succeeds; MV gone after reopen
   ```

2. **Renaming a column of a memory table that a persisted view reads.**

   ```sql
   create table t (id integer primary key, v integer) using store;  -- makes the store subscribe
   create table m (id integer primary key, x integer);              -- memory
   create view vm as select id, x from m;                           -- persisted
   alter table m rename column x to "<lone surrogate>";             -- succeeds; view gone after reopen
   ```

3. **Renaming a memory table that a persisted view reads.** Same shape as (2) with
   `alter table m rename to "<lone surrogate>"`.

## Expected behavior

A rename that would leave a persisted view or materialized view unwritable must **fail the
statement**, leaving the catalog and any physical storage untouched — the same clean-no-op
guarantee the CREATE paths now give. It must never report success and lose the object.

The existing `assertCatalogObjectPersistable` hook is the right instrument; the difficulty
is *placement*. The current rename flow mutates first and propagates second:
`module.renameTable` moves physical storage, the table catalog entry is swapped, and only
then are dependent view/MV bodies rewritten. A veto discovered during propagation is
already too late to be a no-op. The fix therefore needs a **pre-flight pass over the
dependents** — compute what each dependent view/MV body *would* become and ask the modules
about it — before the first side effect. Two further details for whoever picks this up:

- Renaming a materialized view re-keys its catalog entry
  (`materialized_view_removed` old name → `materialized_view_added` new name), so the veto
  must consider the new **key** as well as the new DDL text, and must run before the
  removal.
- A store-backed table's rename is already refused earlier by the physical store-name
  guard. Whatever is added must not turn that into a second, differently-worded error for
  the same statement.

## Scope note

The observable symptom is specific to lone surrogates because that is the only thing any
module currently refuses. The defect is the *unvetted path*, not the surrogate: any future
"the store cannot persist this" condition would leak through the same hole. Fix the path.

Out of scope: the separate, already-tracked gap where a store module that has not yet
subscribed to a database never vetoes at all
(`bug-store-untouched-table-and-early-view-never-persisted`).
