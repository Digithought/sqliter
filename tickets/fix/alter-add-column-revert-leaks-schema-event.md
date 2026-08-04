---
description: When adding a column fails partway and is undone, the database still tells listeners — and other synced devices — that the column was added, so a peer can end up with a column the original device does not have.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts               # runAddColumn / revertFailedAddColumn — the arm that marks the module call before the statement is known to succeed
  - packages/quereus/src/vtab/memory/module.ts                     # MemoryTableModule.alterTable — emits inside the module call
  - packages/quereus-store/src/common/store-module-alter.ts        # StoreModuleAlter.alterTable — same, at the dispatcher tail
  - packages/quereus/src/core/database-events.ts                   # DatabaseEventEmitter — batched schema events, savepoint layers
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # the engine's own path, which gets this right
  - packages/quereus-store/test/alter-events.spec.ts               # "a failed ADD COLUMN announces nothing" — passes, but only for an earlier failure mode
  - docs/usage.md                                                  # § What each ALTER TABLE arm reports — currently documents the exception
difficulty: medium
repro: verified
---

# A failed ADD COLUMN can still announce that the column was added

## What happens

`alter table t add column c integer default 5 unique` on a table whose existing rows
would all get the same value fails: the inline `UNIQUE` cannot be installed. The engine
unwinds the whole statement and the table is left exactly as it was — no `c` column.

But on a storage backend that raises its own change events (the store module, and the
memory module when built with an emitter), listeners are still told the column was added,
and the announcement now carries the statement's SQL text. If the database is syncing,
another device executes that SQL and really does add the column — so the two devices end
up with different tables, which is precisely the outcome the DDL-carrying event was added
to prevent.

The backends without their own emitter get this right: the engine announces the change
only after the whole statement succeeded.

## Reproduction (verified)

Against a store-backed table, inside an explicit transaction that then commits (an
autocommit statement rolls back and discards the event, which is why this hid):

```ts
await db.exec('create table p (id integer primary key) using store');
await db.exec('insert into p values (1), (2)');
await db.exec('begin');
await db.exec('insert into p values (3)');
await assert.rejects(db.exec('alter table p add column c integer default 5 unique'));
await db.exec('commit');
// Observed: one schema event,
//   { type: 'alter', objectType: 'table', objectName: 'p',
//     ddl: 'alter table p add column c integer default 5 unique' }
// Expected: none. `select * from p` returns only `id`.
```

## Root cause

One decision, in one place. `runAddColumn` (`runtime/emit/alter-table.ts`) marks the
module's `addColumn` call with the statement's DDL — the marker that means "this call IS
the statement, announce it". A module with its own emitter therefore announces from
*inside* that call. But the statement is not over: the engine still installs each inline
constraint through further module calls afterwards, and a failure there runs
`revertFailedAddColumn`. By then the announcement has already been made, and nothing
retracts it.

So the emit boundary is **call-scoped** where it needs to be **statement-scoped**. The
engine's own announcement path already is statement-scoped — it announces at the arm's
tail, after the constraint installs — which is why the two paths disagree.

## Expected behavior

A statement that unwinds announces nothing, on every backend. Concretely:

- The reproduction above must deliver zero schema events, on the store module and on an
  emitter-backed memory module alike.
- The success cases must be unchanged: one event per statement, carrying the whole
  statement's text, in the shape `docs/usage.md` § *What each `ALTER TABLE` arm reports*
  tabulates.
- Whatever mechanism is chosen must not depend on the enclosing transaction rolling back
  — the failing statement can sit inside a transaction that goes on to commit other work.

Two directions worth weighing, without committing to either here: give the engine a way
to retract (or scope) the schema events a failing statement produced — the event emitter
already keeps savepoint-scoped layers of batched events — or move the marker onto the last
module call of the statement, so nothing that can fail follows it. The second is cheaper
but changes which call carries the marker for `add column … <inline constraint>`, and with
it the announced event's shape unless the modules compensate.

## Notes

- Not a regression introduced by `sync-alter-table-event-carries-ddl`: the spurious event
  existed before it. What changed is the consequence — the event used to carry no SQL, so
  a receiver skipped it; now it carries SQL a receiver executes.
- Related but distinct from `sync-replicate-alter-table-ddl`, which reworks the
  *receiver's* one-for-one event expectation. This one is the origin emitting an event it
  should not have.
- `docs/usage.md` documents the exception today, pointing at this slug; remove that
  paragraph when this lands.
