---
description: An application watching for structural changes gets a vaguer notification when the data is stored on disk than when it is held in memory — it is told "this table changed" instead of which column was added, renamed, or removed, and a removal is reported as a change rather than a removal.
files:
  - packages/quereus-store/src/common/store-module-alter.ts    # StoreModuleAlter.alterTable — the single emit block at the dispatcher tail
  - packages/quereus/src/vtab/memory/module.ts                 # MemoryTableModule.alterTable + alterEventShape — the shape to match
  - packages/quereus/src/core/database-events.ts               # DatabaseSchemaChangeEvent — the fields at issue
  - docs/usage.md                                              # § What each ALTER TABLE arm reports — the table this contradicts
  - packages/quereus-store/test/alter-events.spec.ts           # only asserts `ddl` today; would gain shape assertions
repro: verified
---

# The disk-backed storage backend reports a coarser shape for `ALTER TABLE` than the in-memory one

## What the docs promise

`docs/usage.md` § *What each `ALTER TABLE` arm reports* states that every structural arm
raises exactly one event "whether or not the storage backend ships an emitter of its own …
so a subscriber sees the same facts either way", and tabulates a per-arm shape:

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` | `alter` | `column` | table | altered column | — |

## What actually happens

The in-memory backend matches the table. The store backend reports `alter` / `table` /
`<table name>` for **every** arm, with `columnName` and `oldColumnName` always absent — so a
subscriber is told the table changed but not which column, and a `drop column` looks like
an ordinary alteration rather than a removal.

Observed (store backend, four successive statements on one table):

```
alter table s add column x text null      →  alter / table / s
alter table s rename column v to vv       →  alter / table / s
alter table s drop column w               →  alter / table / s
alter table s rename to s2                →  alter / table / s2   (oldObjectName: 's')
```

The same four statements on an emitter-backed in-memory table report
`alter/column/s/x`, `alter/column/s/vv` (with `oldColumnName: 'v'`), `drop/column/s/w`,
and `alter/table/s2`. Only `rename to` agrees, because the store handles it on a separate
code path.

## Why it matters

A consumer that mirrors the catalog, or that wants to invalidate a per-column cache, cannot
act on the store's event without re-reading the whole table definition — and cannot tell a
column removal from a column addition at all. Anything written against the documented shape
on the in-memory backend silently degrades when the same application is pointed at durable
storage, which is the normal deployment.

The statement's SQL text (`ddl`) IS present and correct on both backends, so a replicating
peer that re-executes the DDL is unaffected. This is about the structured fields only.

## Shape of a fix

The store emits from a single block at the tail of its `alterTable` dispatcher, which sees
the whole `SchemaChangeInfo` and therefore already has the column name and the arm kind
available — the in-memory module derives its shape from exactly the same input. The existing
store test asserts only `ddl` and the event count, which is why the divergence went
unnoticed; shape assertions should land with the fix.

Deliberately left as a specification, not a plan: whether both backends should keep deriving
the shape independently, or whether the engine should hand one canonical shape down to the
modules the way it already hands down `ddl`, is the design call to make when this is picked up.

## Relationship to other work

Independent of `alter-add-column-revert-leaks-schema-event` (a failed ALTER announcing an
event it should not have), which explicitly leaves the success-path shapes unchanged so the
two stay separately reviewable.
