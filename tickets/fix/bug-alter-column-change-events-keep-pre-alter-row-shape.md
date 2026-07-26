---
description: When a table's columns are changed in the middle of an open transaction, the change notifications sent to listeners afterwards still describe rows in the old shape — so anything listening (such as the sync engine) records values under the wrong column names, or invents a column that no longer exists.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts        # PendingChange log; installReshapedColumns / convertColumn / rekeyPrimaryKey rewrite rows but not this log
  - packages/quereus/src/vtab/memory/layer/manager.ts            # collectPendingChanges + emitDataChange at commit
  - packages/quereus/src/core/database-events.ts                 # DatabaseDataChangeEvent { oldRow, newRow }
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # recordColumnVersions zips newRow[i] against the CURRENT schema's column names
difficulty: medium
---

# `ADD` / `DROP COLUMN` inside a transaction does not reach the change-notification log

## What happens

A memory table records every insert/update/delete of an open transaction twice: once in the
rows themselves, and once in a separate per-transaction log used only to notify listeners
(`db.onDataChange`). At commit the log is flushed as `DatabaseDataChangeEvent`s carrying
`oldRow` / `newRow`.

`ALTER TABLE ... ADD COLUMN` / `DROP COLUMN` issued inside that transaction now rewrites the
pending *rows* to the new column set (ticket `bug-memory-add-column-loses-pending-rows`,
landed). It does not rewrite the notification log. So writes made *before* the `ALTER` are
announced in the *pre-`ALTER`* shape while the table itself is in the post-`ALTER` shape.

Reproduced (current `main`, after the fix):

```ts
db.onDataChange(e => console.log(e.newRow));
await db.exec(`create table t (id integer primary key, v text, w text)`);
await db.exec(`begin`);
await db.exec(`insert into t values (1, 'a', 'p')`);
await db.exec(`alter table t drop column w`);
await db.exec(`commit`);
// emitted newRow: [1, "a", "p"]   ← three values; the table has two columns
```

and the mirror case:

```ts
await db.exec(`create table t (id integer primary key, v text)`);
await db.exec(`begin`);
await db.exec(`insert into t values (1, 'a')`);
await db.exec(`alter table t add column w text default 'z'`);
await db.exec(`commit`);
// emitted newRow: [1, "a"]        ← two values; the table has three columns
```

## Why it matters

`newRow` is positional; a consumer has to pair it with the table's column list to know what
each value means. `quereus-sync` does exactly that — `recordColumnVersions` loops
`for (let i = 0; i < newRow.length; i++)` and names value `i` with
`tableSchema.columns[i].name`, reading the schema *at event time*, i.e. the post-`ALTER` one.
Consequences:

- **`DROP COLUMN`**: every value after the dropped slot is attributed to the wrong column, and
  the trailing value falls off the end of the column list and is recorded under the fallback
  name `col_<n>`. That writes wrong values into the sync change log — silent data corruption
  for a replicated table.
- **`ADD COLUMN`**: the added column is simply never versioned for rows written earlier in the
  same transaction, so a peer never learns its value.

Same family, lower severity, and **also in scope** — the same log is left stale by the two
sibling rewrites:

- `TransactionLayer.convertColumn` (`alter column ... set data type` / `set not null`): arity is
  right but the emitted value is the *pre-conversion* one.
- `TransactionLayer.rekeyPrimaryKey` (`alter column ... set collate` on a key column): the
  emitted `key` is the pre-re-key one.

## Expected behaviour

Every `DatabaseDataChangeEvent` a commit emits describes its row in the schema that is current
at the moment it is emitted: `newRow.length === columns.length`, value `i` belongs to column
`i`, and `key` matches the committed key.

## The part that needs a decision, not just an edit

`ADD COLUMN`'s backfill is a per-row expression (`default (new.<col>)`). For `newRow` the answer
is obvious — it is the same row the reshape already computed, so the reshape can carry it. For
an update's `oldRow` (the *pre-image* of a row as it was before the update) there is no
obviously right value: evaluating a `new.<col>` default against a pre-image is meaningful only
if the expression happens not to reference a column the update changed. Options worth weighing
in the fix:

- reuse the same backfill result the `newRow` reshape produced (cheap; the pre-image then
  carries a value derived from the post-update row, which can make a spurious "this column
  changed" comparison);
- backfill `oldRow` with the plain literal default / `NULL` and accept that a per-row default is
  not reconstructible for a pre-image;
- suppress the pre-image entirely for rows written before an in-transaction column change, and
  let consumers treat the event as a full-row upsert.

Whichever is chosen, say so in the code and in `docs/memory-table.md` § DDL and transactions —
the current text describes the row reshape and is silent about events.

## Notes

- Found during review of `bug-memory-add-column-loses-pending-rows`; not a regression from it —
  the pre-fix behaviour was worse (the rows were wrong too). No test covers it today.
- Change tracking is only populated when a listener is registered (`enableChangeTracking`), so
  a plain embedded user without `onDataChange` / sync sees nothing. That is what keeps this out
  of the landed fix's blast radius, not correctness.
- The store backend has its own change path and was not examined; check whether it shares the
  defect before concluding the fix is memory-module-local.
