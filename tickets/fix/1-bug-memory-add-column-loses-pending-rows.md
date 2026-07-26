---
description: Adding a column to a table inside a transaction leaves rows that transaction just inserted looking like they still have the old columns, and if a savepoint was taken first those rows disappear entirely when the transaction commits.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts       # addColumn (~1756), dropColumn (~1839), ensureSchemaChangeSafety (~2960), convertColumnOnOpenLayers (~3339)
  - packages/quereus/src/vtab/memory/layer/transaction.ts   # TransactionLayer.adoptSchema / convertColumn
  - packages/quereus/src/vtab/memory/layer/base.ts          # addColumnToBase
difficulty: hard
---

# Memory backend: ALTER TABLE ADD COLUMN does not reach the transaction's own uncommitted rows

Found while investigating `bug-isolation-index-ddl-rebuild-drops-savepoint-writes`. This is the
**plain in-memory table module**, no isolation layer and no store involved.

## Two defects, same cause

Probed directly against `new Database()` with the default memory module.

**1. Uncommitted rows keep the old column layout.**

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'a');
alter table t add column w text default 'z';
select * from t;   -- {"id":1,"v":"a"}   -- expected {"id":1,"v":"a","w":"z"}
commit;
select * from t;   -- {"id":1,"v":"a"}   -- w is still missing
```

The row this transaction inserted is short a column, before and after commit. Rows that were
already committed when the ALTER ran do get `w` — only the transaction's own pending rows miss it.

**2. With a savepoint before the ALTER, the row is lost outright.**

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'a');
savepoint s;
alter table t add column w text default 'z';
rollback to savepoint s;
select * from t;   -- {"id":1,"v":"a"}  (still there mid-transaction)
commit;
select * from t;   -- []                -- the row is GONE
```

`rollback to savepoint s` must not discard the insert that happened before `s`, and a `commit`
must not drop a row that was visible one statement earlier. Silent data loss.

## Why

`MemoryTableManager.addColumn` (manager.ts ~1756) calls `ensureSchemaChangeSafety`, updates the
base layer, calls `baseLayer.addColumnToBase(...)`, and swaps the manager's cached schema — but it
never touches the **open transaction layers**. `ensureSchemaChangeSafety` deliberately lets the
DDL-issuing connection keep its uncommitted work (it only raises `BUSY` for *other* connections),
so those layers are still live and still hold rows at the pre-ALTER arity, under the schema they
froze at creation.

The manager already has the machinery for exactly this. `alterColumn` propagates its change into
every open layer via `convertColumnOnOpenLayers` / `adoptSchemaOnOpenLayers` (manager.ts
~2369–2415, ~3318–3345), applied oldest-first so each layer's copy-on-write base is already
converted. `addColumn` and `dropColumn` have no equivalent, so the same class of change is simply
not propagated. Defect 2 is presumably what happens when a layer whose rows are the wrong arity
meets the savepoint-snapshot chain at commit; that specific mechanism has not been traced yet.

`dropColumn` (manager.ts ~1839) has the same shape and should be probed alongside — it was not
tested, only read.

## Scope

Confirm and fix in the memory module. Note that
`bug-isolation-alter-column-rebuild-drops-savepoint-writes` is waiting on this: the isolation
layer's per-connection overlays are themselves memory tables, and the clean fix there is to have
an overlay adopt an ALTER in place rather than be rebuilt — which is only possible once the memory
module can propagate a column change into an open transaction layer.

## Reproduce

Drop a spec into `packages/quereus/test/` with the two sequences above and run:

```
cd packages/quereus && node test-runner.mjs --grep "<your-spec>"
```
