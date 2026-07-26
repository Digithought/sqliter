---
description: When a transaction adds or drops a column and later rolls back to a savepoint taken before that change, rows the transaction had already inserted vanish without any error.
prereq: bug-memory-add-column-loses-pending-rows
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable, migrateOverlayForAlter (~1647), adoptRebuiltOverlay (~979), createOverlaySchema (~2052)
  - packages/quereus/src/core/database.ts                # registerConnection savepoint replay (~2040)
  - packages/quereus/src/vtab/memory/layer/manager.ts    # addColumn / dropColumn
difficulty: hard
---

# Isolation overlay ALTER migration erases every write staged before the DDL

Sibling of `bug-isolation-index-ddl-rebuild-drops-savepoint-writes`, split out because it needs a
different fix. Read that ticket first — it carries the full root-cause write-up; this one only
covers what differs.

## Behavior

Store backend, and equally a plain memory table wrapped by the isolation layer:

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'a');
savepoint s;
alter table t add column w text;
rollback to savepoint s;
select id from t;   -- []  — row (1,'a') is GONE
```

`rollback to savepoint s` must never discard work done before `s`.

## Why

Same root cause as the index-DDL sibling. `IsolationModule.alterTable` does not tell a
connection's existing staging **overlay** about the column change — it builds a replacement
overlay and copies the staged rows across (`migrateOverlayForAlter`, isolation-module.ts ~1647).
The first copied write registers the new overlay's connection with the `Database`, and
`registerConnection` (database.ts ~2040) replays the active savepoint stack *before* the rows are
copied. Every staged row therefore lands above the replayed savepoint and the next
`rollback to savepoint` unwinds all of them.

## Why it needs a different fix

The sibling ticket fixes the index paths by having the overlay adopt the index change **in place**,
so its layer chain and savepoint snapshots survive. That is only possible because
`MemoryTableManager.createIndex` / `dropIndex` propagate a schema change into open transaction
layers (`adoptSchemaOnOpenLayers` → `TransactionLayer.adoptSchema`).

`MemoryTableManager.addColumn` / `dropColumn` do **not** — that gap is
`bug-memory-add-column-loses-pending-rows`, filed separately because it is a data-loss bug in the
plain memory backend on its own. Until an open transaction layer can adopt a column change, an
in-place forward here would leave the overlay's staged rows at the wrong arity.

So: land the memory-side propagation first, then forward the ALTER to each non-poisoned overlay in
place, mirroring what the sibling does for indexes.

A fallback if in-place adoption turns out not to be reachable: keep the rebuild but copy the rows
*before* the new overlay's connection is registered, then register it and replay the savepoint
stack. That stops the data loss, but it makes every staged row survive a `rollback to savepoint`
— including rows staged *after* the savepoint, which should be discarded. Wrong in a different
direction, and worth taking only if in-place adoption is ruled out; record the tradeoff explicitly
if so.

## Behavior that must be preserved

`migrateOverlayForAlter` also does the ADD COLUMN backfill into staged rows (literal default,
per-row `new.<col>` evaluator, or NULL; tombstone rows get NULL) and routes a `CONSTRAINT` from a
NOT NULL backfill to `INTERNAL` for the issuer / poison for a foreign connection
(`adoptRebuiltOverlay`). Whatever replaces the rebuild has to keep both.

## Reproduce

Add to `packages/quereus-isolation/test/isolation-layer.spec.ts` (memory as the underlying), and
mirror as a `.sqllogic` under `packages/quereus/test/logic/` so the store leg is covered too:

```
cd packages/quereus && node test-runner.mjs --store --grep "<your-file>"
```

Cover both directions — the row staged before the savepoint must survive the rollback, and rows
staged after it must not.
