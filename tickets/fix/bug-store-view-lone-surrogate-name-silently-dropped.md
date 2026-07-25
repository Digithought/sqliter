----
description: Creating a view or materialized view whose name contains a broken half-character (a lone surrogate) looks like it succeeded, but the definition is silently lost when the database is reopened, because the error that is supposed to reject it gets swallowed on the background save path.
files:
  - packages/quereus-store/src/common/store-module.ts   # enqueuePersist (swallows), view_added / materialized_view_added dispatch, saveViewDDL / saveMaterializedViewDDL / persistObjectCatalogEntryIfChanged
  - packages/quereus-store/src/common/key-builder.ts     # buildViewCatalogKey / buildMaterializedViewCatalogKey (guard exists, but throw never reaches caller)
difficulty: medium
----

## What's wrong

A companion fix (`bug-store-catalog-key-lone-surrogate-identifier-collision`) made the store
**refuse** identifiers and DDL text that contain a lone (unpaired) surrogate — a broken half of a
Unicode character that persistent storage cannot key faithfully (every one of them folds to the
same replacement byte sequence, so distinct names collide). That guard is wired into
`buildViewCatalogKey` / `buildMaterializedViewCatalogKey` and into the DDL-text encoder, and it
works at the unit level.

But for **views and materialized views the guard's error never reaches the user.** `create view
"<lone-surrogate>" as select …` returns successfully and the view is queryable in-session, yet its
catalog write is silently dropped, so a close → reopen loses the view.

Root cause: `view_added` / `materialized_view_added` schema-change events route their persist work
through `StoreModule.enqueuePersist`, which wraps the async save in
`.catch(err => console.warn(...))` **by design** — so a listener failure can never abort the SQL
statement that triggered it. The guard fires (correctly), throws, and the throw is swallowed with a
`console.warn`. Same behavior as any other advisory-persist failure on that path today.

This is distinct from plain `CREATE TABLE`, where the DDL is persisted lazily on first data access
(`StoreTable.initializeStore` → `saveTableDDL`, awaited directly) so the guard's rejection *does*
surface — as an error on the first `INSERT`/`SELECT`.

## Why it matters

The name is exotic (a lone surrogate essentially never occurs by accident), so real-world impact is
low-frequency. But the outcome — "looked like it worked, gone after reopen, only a `console.warn`" —
is exactly the kind of silent data loss the parent ticket set out to eliminate on the value/table
side. The guard is present but inert for views.

## What good looks like

`CREATE VIEW` / `CREATE MATERIALIZED VIEW` with an unfaithful identifier should **fail the statement
synchronously**, mirroring how a plain `CREATE TABLE` at least fails on first data access — rather
than succeeding and dropping the write. The natural fix is to validate the identifier (and the
view's DDL text) at statement-execution time, *before* handing the persist to the fire-and-forget
`enqueuePersist` path — so the error propagates while the swallow still protects genuine
listener/IO failures.

Note this touches the `enqueuePersist` / schema-change-event dispatch architecture, which is why the
implementer of the parent ticket did **not** fold it in (it is beyond "the same one-line guard").
Decide whether synchronous pre-validation belongs in `StoreModule`'s event handler, in the engine's
`CREATE VIEW` path, or both.

## How to reproduce

A throwaway (uncommitted) check during review confirmed: `db.exec('create view "\uD800" as select
1')` does **not** throw, the view is usable in-session, and no integration test can assert it rejects
because it provably does not. Unit coverage for the guard itself lives in
`packages/quereus-store/test/key-builder.spec.ts`
(`buildViewCatalogKey` / `buildMaterializedViewCatalogKey`).
