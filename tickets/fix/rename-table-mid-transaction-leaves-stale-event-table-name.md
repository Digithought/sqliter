---
description: If a table is renamed in the middle of an open transaction, the change notifications for writes made before the rename are still labelled with the old table name, so a listener such as the sync engine files those changes under a table that no longer exists.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts             # runRenameTable (line 181)
  - packages/quereus/src/core/database-events.ts                 # DatabaseEventEmitter — batchedDataEvents / dataEventLayers hold the stale events
  - packages/quereus/src/runtime/emit/dml-executor.ts            # emitAutoDataEvent stamps event.tableName at write time
  - packages/quereus-store/src/common/store-module.ts            # rename arm also calls ddlCommitPendingOps, flushing queued events under the old name
  - packages/quereus/src/vtab/memory/layer/manager.ts            # memory module stamps `this._tableName` into each event at commit
difficulty: medium
---

# `ALTER TABLE … RENAME TO` inside a transaction leaves earlier change events labelled with the old name

## What happens

Every `db.onDataChange` event carries `schemaName` / `tableName` identifying which table
changed. The name is stamped at write time. Renaming the table later in the same transaction
does not revisit the events already recorded, and the whole batch is delivered only at commit
— so a listener is told about changes to a table name that, by the time it hears about them,
no longer exists.

Reproduced on current `main`:

```ts
const db = new Database();
db.onDataChange(e => console.log(e.tableName, e.newRow));
await db.exec(`create table t (id integer primary key, v text)`);
await db.exec(`begin`);
await db.exec(`insert into t values (1, 'a')`);
await db.exec(`alter table t rename to t2`);
await db.exec(`commit`);
// emitted: tableName "t", newRow [1,"a"]   ← the committed table is named t2
```

## Why it matters

`quereus-sync` keys every recorded change by `(schema, table, pk, column)`. An event naming
`t` produces change-log entries for a table the local database does not have, and the
corresponding entries for `t2` are simply missing. A peer either never receives the row or
receives it filed under a phantom table.

## Expected behaviour

Every event a commit delivers names the table as it is named at delivery. Writes made before
a mid-transaction rename are reported against the new name.

## Notes

- Found while fixing `alter-column-set-restates-pending-change-events`, which is the same
  channel and the same "events recorded under one schema, delivered under another" family, but
  a different axis: that ticket is about the *shape* of the row, this one about the table's
  *identity*. They are deliberately separate — the shape fix rewrites row images, this one
  rewrites an identifier — but a fix here will likely reuse the batched-event remap seam that
  ticket introduces in `DatabaseEventEmitter`, so it is worth landing after it.
- Not yet investigated: whether a schema *rename* (`ALTER … RENAME` at the schema level, if
  reachable) has the same problem, and whether the rename event itself
  (`onSchemaChange` `type: 'alter'`) gives a listener enough to correlate the old and new
  names. Both belong in this ticket's reproduce pass.
- Also not yet checked: what the store-backed path does. Its rename arm calls
  `ddlCommitPendingOps()`, which flushes queued data events into the engine's batch under the
  old name — very likely the same defect, but confirm rather than assume.
- No test covers this today.
