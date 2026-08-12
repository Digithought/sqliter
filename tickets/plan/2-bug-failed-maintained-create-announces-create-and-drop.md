---
description: A `create table … maintained as …` that fails still tells listeners (and syncing peer devices) that a table was created and then dropped, even though no such table ever existed.
files:
  - packages/quereus/src/runtime/emit/create-table.ts                # statement boundary — where a scope would go
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # createMaintainedTable — creates the backing table, then fills it
  - packages/quereus/src/runtime/emit/alter-schema-event.ts          # withStatementScopedSchemaEvents — the existing fix shape for ALTER
  - packages/quereus/src/core/database-events.ts                     # beginSchemaEventScope / discardSchemaEventsSince
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Needs a failing maintained-table create inside an explicit transaction on an emitter-backed module to observe, and a subscriber that re-reads the catalog after any event is unaffected either way.
---

# A failed maintained-table create announces a table that never existed

## What happens

`create table mv (…) maintained as <select>` creates the backing table first and only then
fills it from the query body. When filling the table breaks a constraint the declaration
asked for, the statement fails and the engine tears the backing table down again — but a
storage backend that raises its own change events has already announced the creation, and
the teardown announces a drop. Subscribers, and any peer device replicating those events,
are told a table was created and then dropped. Neither happened as far as the application is
concerned.

## Reproduction

Observed on an emitter-backed `MemoryTableModule` (`new MemoryTableModule(new
DefaultVTableEventEmitter())`, registered as the default module), driven inside an explicit
transaction that then commits other work — the transaction wrapper matters, because in
autocommit the failed statement rolls back and the whole event batch is thrown away:

```sql
create table src (id integer primary key, v integer);
insert into src values (1, -5);
begin;
insert into src values (2, 7);
-- fails: the body's row violates the declared CHECK
create table mv (id integer primary key, v integer check (v > 0)) maintained as select id, v from src;
commit;
```

Two events are delivered for `mv`, each carrying re-executable SQL:

```
create/table/mv   ddl: CREATE TABLE "main"."mv" (…, constraint _check_v check on insert, update (v > 0)) USING memory_events
drop/table/mv     ddl: drop table "main"."mv"
```

A peer applying both in order ends up where it started, so the common case self-cancels.
It is still wrong: the pair is churn a receiver has to apply and undo, the create/drop cycle
can strand per-table replication metadata (see `bug-sync-recreated-table-inherits-dropped-table-metadata`
for the shape of that hazard), and if the teardown ever fails to announce, the peer is left
holding a table the origin does not have.

## Expected

A statement that unwound announces nothing at all, on every backend — the rule
`ALTER TABLE` already follows (see `docs/usage.md` § *What each `ALTER TABLE` arm reports*
and `docs/module-events.md` § *A failed ALTER announces nothing, even from a native emitter*).

## Notes for whoever picks this up

- The engine already has the mechanism: `DatabaseEventEmitter.beginSchemaEventScope()` /
  `discardSchemaEventsSince()`, wrapped as `withStatementScopedSchemaEvents` in
  `runtime/emit/alter-schema-event.ts`. `ALTER TABLE` and `ALTER TABLE ADD CONSTRAINT` run
  under it; `CREATE TABLE` does not. Whether the wrapper should simply move up to cover every
  DDL statement boundary — rather than being applied statement family by statement family —
  is the design question worth settling first, and it would want a home outside the
  ALTER-specific file.
- Only the maintained form is confirmed to leak. A plain `create table` that fails does so
  before the module call (verified: a duplicate-name create announces nothing), but the other
  object-lifecycle statements (`create index`, `drop table`) were not probed for a
  post-module-call failure.
- The *shape* of the leaked create is also wrong — a maintained table announces itself as a
  plain table — but that is the success path too, and is tracked separately as
  `bug-sync-materialized-views-replicate-as-plain-tables`. Fixing the leak does not depend on
  it.
