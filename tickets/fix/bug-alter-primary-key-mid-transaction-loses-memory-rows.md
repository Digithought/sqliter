---
description: Changing a table's primary key part-way through a transaction throws away every row that transaction had written, and the commit still reports success — the rows are simply gone afterwards.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # rebuildMemoryTable (~line 1531) — copies from the committed layer only
  - packages/quereus/src/vtab/memory/layer/manager.ts              # scanAllRows (~line 1563), insertRow (~line 1572)
  - packages/quereus/src/vtab/memory/module.ts                     # alterTable rejects alterPrimaryKey (~line 973) — why the rebuild runs
  - packages/quereus-isolation/src/isolation-module.ts             # ~line 1336 — the same hazard, already refused there
difficulty: medium
---

# What happens

On the default in-memory table module (a plain `new Database()`), this loses data silently:

```sql
create table t (a integer not null, b integer not null, v text, primary key (a));
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
commit;
```

`commit` succeeds. `select * from t` afterwards returns **no rows**. The row inserted inside
the transaction is gone. Rows that were already committed before the transaction started do
survive — only the transaction's own writes are lost.

The change-notification listener is told the insert happened (an `insert` event for
`(1, 9, 'x')` is delivered on commit), so a consumer's copy of the table and the database
disagree from that moment on.

If the module was constructed with its own event emitter
(`new MemoryTableModule(emitter)`), the events are lost too: nothing at all is delivered for
the transaction's writes.

## Why

The memory module does not support re-keying a table in place — its `alterTable` throws
`UNSUPPORTED` for `alterPrimaryKey` — so the runtime falls back to rebuilding the table
(`rebuildMemoryTable`). The rebuild copies rows out of the old table with `scanAllRows()`,
which reads the **committed** layer only, and writes them into a fresh table with
`insertRow()`, which writes straight to the base layer. The open transaction's pending layer
is never consulted; the old table manager (and with it the pending rows *and* the pending
change-event log) is then discarded.

The transaction-isolation package already treats this exact situation as impossible to
carry: it refuses `ALTER PRIMARY KEY` outright when the issuing transaction has uncommitted
rows staged, with the message *"Cannot alter the primary key of '…' while this transaction
has uncommitted changes staged for it; commit or roll back first."* The bare engine has no
such guard.

# Expected

One of two outcomes, both acceptable, neither silent:

- the transaction's uncommitted rows are carried through the rebuild and are present after
  the commit (with their change events intact); or
- the statement is **rejected** the way the isolation layer already rejects it, so the
  application learns it must commit or roll back first.

What must not happen is the current behavior: a successful commit that quietly drops rows
the application wrote and was told about.

# Scope note

Found while reproducing `bug-alter-primary-key-leaves-stale-event-key` (now in
`implement/`), which fixes a different defect in the same statement — the primary-key values
carried on the delivered events. That ticket's engine-side fix is correct and independent;
this one is about the rows themselves. The store module is unaffected (it re-keys natively
and flushes pending writes first, and its rows survive).

Worth checking while here: the third rebuild path, `rebuildViaShadowTable` (used by modules
that neither re-key natively nor are the memory module), copies rows with
`insert into <shadow> select … from <table>` and then renames the shadow over the original.
Inside an open transaction that emits a fresh insert event per copied row, and the trailing
rename relabels them onto the real table name — so every pre-existing row would appear to a
listener as a brand-new insert. Not reproduced here (no in-tree module takes that path);
confirm before deciding whether it belongs in this ticket or its own.
