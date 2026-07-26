---
description: A persistent table that is created but never read or written, and any view created before the first such table, both vanish when the database is reopened — the create looked like it succeeded and nothing warned.
files:
  - packages/quereus-store/src/common/store-module.ts   # create(), ensureSchemaSubscription, dispatchSchemaChange, closeAll
  - packages/quereus-store/src/common/store-table.ts    # initializeStore — the lazy "save the DDL on first store access" point
  - packages/quereus-store/test/view-mv-persistence.spec.ts  # has the close→reopen harness these cases need
difficulty: medium
---

## What's wrong

Two related silent losses, both measured against a persistent in-memory provider with a
close → reopen (the harness in `view-mv-persistence.spec.ts`):

**1. An empty, never-touched persistent table is not saved.**

```sql
create table lonely (id integer primary key) using store;
-- close, reopen
```

After reopen the catalog store is completely empty — not just missing rows, missing the
table. The `create table` reported success and nothing warned.

The cause is that a store-backed table's schema text is written *lazily*, on first access to
its underlying storage (`StoreTable.initializeStore` → `saveTableDDL`). A table nobody ever
reads or writes never reaches that point, and `StoreModule.create` does not write it either
— it only opens the physical store. The engine's `table_added` event is not handled by the
store's schema-change listener, so nothing else covers it. Adding a single row to the table
before closing makes it survive.

**2. A view created before the first persistent table is not saved.**

```sql
create view early as select 1 as x;
create table later (id integer primary key) using store;
insert into later values (1);
-- close, reopen
```

`later` survives; `early` does not. The store module only starts listening for view/materialized-view
creations the first time the engine hands it a database handle — which happens inside
`create` / `connect` / `rehydrateCatalog`. A view created before any of those fired is never
seen, so it is never persisted, and no warning is emitted.

## Why it matters

Both are shaped like the silent data loss the lone-surrogate tickets set out to eliminate:
a DDL statement returns success, the object is usable for the rest of the session, and it is
simply gone next time the database opens. Case 1 is the more likely to bite in practice —
"create the schema, close, reopen, then start loading data" is an ordinary thing to do, and
an empty table is exactly the state a freshly-created schema is in.

Case 2 is narrower (it needs a view created before the very first persistent table in the
process) but has the same failure signature.

## Expected behavior

A `create table … using store` that returns success should survive a close → reopen even
with no rows, and a `create view` in a database that has a persistent-storage module
registered should be persisted regardless of statement order. If some object genuinely
cannot be persisted, that should be an error on the statement, not a silent omission.

## How this was found

Discovered while reproducing `bug-store-view-lone-surrogate-name-silently-dropped` (now in
`tickets/implement/`). That ticket's fix adds a pre-flight check that a persistent-storage
module can veto a view/materialized view it would be unable to store; the store's
implementation of that check deliberately no-ops while it has not yet been handed a database
handle, precisely because of case 2 above. If this ticket lands, revisit that condition — it
should become unconditional.
