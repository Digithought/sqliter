---
description: On some table backends, changing a primary key rebuilds the table behind the scenes — and that rebuild can leave the table unreadable, invent change notifications for rows nobody touched, or, if the surrounding transaction is rolled back, wipe out data that had been committed long before.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAlterPrimaryKey (~1421) — the UNSUPPORTED catch; rebuildViaShadowTable (~1785)
  - packages/quereus-isolation/src/isolation-module.ts      # ~1336 — the refusal that never reaches the caller
  - packages/quereus/test/alter-table-conformance.spec.ts   # makeNoAlterModule (~522); the `alter primary key` arm (~183) is exempt from the stub leg
  - docs/design-isolation-layer.md                          # ~869 § ALTER PRIMARY KEY: the one change no overlay can follow
  - docs/sql-ddl.md                                         # ~624, the rebuild-fallback paragraph
difficulty: medium
---

# Background

`alter table … alter primary key` first asks the table's backend to re-key itself. A backend
that cannot do that raises `UNSUPPORTED`, and the engine falls back to rebuilding the table.
There used to be two rebuilds; the fast path for the built-in in-memory backend has since been
deleted (the in-memory backend now re-keys itself in place — ticket
`bug-alter-primary-key-mid-transaction-loses-memory-rows`), leaving one:
`rebuildViaShadowTable`, the generic one, which works by running ordinary SQL:

```
create table <shadow> (… new primary key …)
insert into <shadow> (cols) select cols from <table>
drop table <table>
alter table <shadow> rename to <table>
```

This ticket is about that generic path. Three separate defects were reproduced in it.

# 1. The table is left unreadable when the backend has no rename hook

The last step renames the shadow table over the original. A backend that stores rows under
the table's name needs to hear about that rename; the engine calls the backend's rename hook
only if it has one. A backend that has neither a re-key hook (so it takes this rebuild) nor a
rename hook is left with its rows still filed under the shadow name while the catalog says
otherwise — and the table becomes unreadable.

Reproduced with the very stub backend the ALTER conformance suite already builds
(`makeNoAlterModule` in `alter-table-conformance.spec.ts` ~522: delegates storage to an inner
memory module, omits both hooks), in plain autocommit — no transaction needed:

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using noalter;
insert into t values (5, 5, 'pre');
alter table t alter primary key (a, b);   -- reports success
select * from t;
-- QuereusError: Module 'noalter' connect failed for table 't':
--   Memory table definition for 't' not found. Cannot connect.
```

The conformance suite marks the `alter primary key` arm as exempt from its no-hook leg —
"ALTER PRIMARY KEY has a rebuild fallback" — so this arm is never actually run against that
stub, which is why the suite is green.

# 2. Every copied row is announced as a brand-new insert

The `insert into <shadow> select … from <table>` step is ordinary SQL, so it emits an insert
change-notification per copied row, and the trailing rename relabels those events onto the
real table name. A listener therefore sees every pre-existing row as freshly inserted. In the
same autocommit reproduction above, one `insert` event is delivered for the untouched row
`(5, 5, 'pre')`.

Inside a transaction it is worse: the transaction's own earlier insert is announced twice —
once when the application wrote it, once when the rebuild copied it.

# 3. `rollback` after the statement destroys previously committed rows

This is the severe one, and it is reachable today through the transaction-isolation package,
whose backend takes this rebuild path.

```sql
-- table registered `using isolated` (IsolationModule over MemoryTableModule)
create table t (a integer not null, b integer not null, v text, primary key (a));
insert into t values (5, 5, 'pre');   -- committed
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
rollback;
-- select * from t  →  no rows at all. The committed row is gone.
```

The cause is the mismatch between the two halves of the rebuild. The schema half (the drop
and the rename) is not undone by `rollback` — the settled `'non-transactional'` tier from
`feat-ddl-transaction-capability`. The data half (the row copy) *is* staged in the
transaction and *is* undone. So the rollback keeps the new, empty table and throws away the
copy of the rows it replaced. Committed data the transaction never touched is destroyed.

Note this is a different failure from
`backlog/bug-rolled-back-rows-violate-surviving-ddl`, which is about a surviving *constraint*
being violated by rows a rollback brought back. Here the rows are simply gone.

# 4. Why nobody hears the isolation layer's refusal

The isolation package already treats this situation as impossible to carry and refuses it
with a specific message ("Cannot alter the primary key of '…' while this transaction has
uncommitted changes staged for it; commit or roll back first.", `isolation-module.ts` ~1336).
That message can never reach an application: it is raised as `UNSUPPORTED`, and
`runAlterPrimaryKey` catches `UNSUPPORTED` from the backend and quietly falls through to this
rebuild. Any backend's refusal of a primary-key change is swallowed the same way.

So whatever is decided below, the engine's blanket `UNSUPPORTED` catch needs narrowing, or
backends need a way to say "no, and mean it".

# What a fix has to decide

Reproductions for all four points are in this ticket; the open question is the policy, and
it is worth settling before writing code:

- Should this rebuild be **refused inside an explicit transaction** outright? Point 3 has no
  correct outcome otherwise: as long as the schema change outlives the rollback and the row
  copy does not, some data is lost either way. Refusing is consistent with what the isolation
  layer already tries to say, and `pragma ddl_transaction_policy = 'strict'` already refuses
  this class of statement for callers who opt in — the question is whether this particular
  rebuild should be refused under the default policy too.
- Should the engine **require a rename hook** before choosing this rebuild (point 1), and
  raise a sited refusal instead of silently producing an unreadable table?
- Should the copy step **suppress change notifications** (point 2)? The rows are not new; the
  table's contents are unchanged by a re-key. The engine already re-derives the keys of
  events a transaction recorded before an `alter primary key`
  (`rekeyBatchedDataEvents`) — the copy's own events are a separate, spurious set.

Whatever is chosen, the conformance suite should stop exempting `alter primary key` from its
no-hook leg, so point 1 cannot come back.
