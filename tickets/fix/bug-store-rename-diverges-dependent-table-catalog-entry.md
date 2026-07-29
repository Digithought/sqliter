---
description: Renaming an in-memory table to a name the persistent store cannot write leaves any saved table that referenced it holding an out-of-date definition on disk, and the statement still reports success.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                # rewriteTableForTableRename / rewriteTableForColumnRename, and the two rename pre-flights
  - packages/quereus/src/schema/catalog-persistability.ts           # assertRenameDependentsPersistable — scans views and materialized views only
  - packages/quereus/src/vtab/module.ts                             # CatalogObjectKind, assertCatalogObjectPersistable
  - packages/quereus-store/src/common/store-module.ts               # the store's implementation of the veto hook
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts         # where the sibling rename tests live
difficulty: medium
---

## What happens

Renaming a table (or one of its columns) also updates every *other* table that mentioned
it — foreign-key targets, `check` expressions, partial-index predicates. For a table that
lives in the persistent store, that means its saved definition has to be rewritten on disk.

That rewrite is fire-and-forget: it runs from a schema-change listener whose failures are
caught and logged, so nothing can fail the statement. If the new name cannot be written to
disk, the statement still reports success, the in-memory definition takes the new name, and
the saved definition keeps the old one. The only trace is a line on the console.

A recent fix (`bug-store-rename-into-lone-surrogate-drops-dependent-view-or-mv`) added a
pre-flight check that refuses such a rename up front — but it only inspects dependent
**views and materialized views**. Dependent plain **tables** are not inspected, because the
module hook it asks (`VirtualTableModule.assertCatalogObjectPersistable`) only accepts a
view or a materialized view; there is no `'table'` case.

## Confirmed reproduction

A "lone surrogate" is a broken half of a Unicode character (`'\uD800'` in JavaScript). No
UTF-8 byte sequence encodes one, so the store refuses to write text containing it.

```
create table st (id integer primary key, v integer) using store;   -- makes the store live
create table m  (id integer primary key, x integer);               -- in-memory, so no store guard
create table s2 (id integer primary key,
                 mid integer references m(id)) using store;

alter table m rename to "<lone surrogate>";                        -- SUCCEEDS
```

Observed after the statement returns:

- in-memory: `s2`'s foreign key now points at the lone-surrogate name
- on disk: `s2`'s saved definition still reads `references m(id)`
- console only: `[StoreModule] Failed to persist catalog DDL after schema change: cannot
  store persisted schema text containing an unpaired surrogate (U+D800 at offset 137)`

`alter table m rename column x to "<lone surrogate>"` is the same shape through the
foreign key's column list. `check` expressions and partial-index predicates that name the
renamed table go through the same rewrite and the same swallowed write.

## Why it is narrow

The renamed table has to be in-memory. A store-backed table is already protected — the
store refuses to rename its own physical storage to that name, before any side effect. And
an in-memory table does not survive a reopen, so the stale saved definition is no worse
than it would have been had the rename never run.

What is genuinely wrong is the contract: the statement reports success while the store logs
a failure, and the live and saved definitions of a *persistent* table silently disagree for
the rest of the session. That is exactly the class of failure the sibling ticket declared
unacceptable for views; tables were left out only because the hook has no shape for them.

## What a fix would need

- A way for a module to veto a prospective **table** definition, alongside the existing
  view / materialized-view cases — most likely a `'table'` member of `CatalogObjectKind`
  and a matching branch in the store's hook that runs the same definition-text derivation
  its write path runs.
- The rename pre-flight extended to the dependent-table rewrites, on the same
  rewrite-a-clone-then-offer-it pattern the view scan already uses. Note the table rewrite
  is spread over several fields (`checkConstraints`, `foreignKeys`, index predicates)
  rather than one body, and it is *not* scoped to the renamed table's own schema — the
  propagation walks every schema for these.
- Tests alongside the existing rename cases in
  `packages/quereus-store/test/lone-surrogate-keys.spec.ts`, covering both rename shapes
  and at least the foreign-key and `check`-expression dependents.

Worth deciding as part of the fix whether the veto should also cover the ordinary
`create table` path, or stay rename-only; today a store table's definition text is checked
lazily, on first access to its storage, not at create time.
