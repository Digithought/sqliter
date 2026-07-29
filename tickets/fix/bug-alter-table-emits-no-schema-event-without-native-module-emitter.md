---
description: An application watching a database for structural changes is told when tables and indexes are created or dropped, but is never told when a table is altered — renamed, or having a column added, dropped, renamed, or retyped — unless the storage backend happens to provide its own notifications.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts    # every ALTER arm; none emits a schema event
  - packages/quereus/src/schema/manager.ts              # emitAutoSchemaEventIfNeeded (~line 2519) — the helper the ALTER arms never call
  - packages/quereus/src/core/database-events.ts        # DatabaseSchemaChangeEvent
  - docs/usage.md                                       # § Subscribing to Schema Changes
difficulty: medium
---

# `ALTER TABLE` emits no schema-change event on the engine's own event path

## What happens

`db.onSchemaChange(...)` is the engine's "the structure of the database changed" channel.

For a storage backend that supplies its own event emitter — the store module, or the memory
module constructed with one — every `ALTER TABLE` arm raises an event on it, and the engine
forwards it. For a backend that does not, the engine synthesizes events itself. But it only does
so for four operations: create table, drop table, create index, drop index. **No `ALTER TABLE`
arm synthesizes anything.**

The default `new Database()` is such a backend. So on a plain database:

```ts
const db = new Database();
db.onSchemaChange(e => console.log(e.type, e.objectType, e.objectName));
await db.exec('create table t (id integer primary key, v text)');  // logs: create table t
await db.exec('alter table t rename to t2');                       // logs nothing
await db.exec('alter table t2 rename column v to v2');             // logs nothing
await db.exec('alter table t2 add column w text null');            // logs nothing
```

Verified on current `main`.

## Why it matters

A UI that refreshes its table list, a cache that invalidates on DDL, or a replicator that ships
schema changes to a peer all subscribe to this channel. On a default database, all of them miss
every alteration and silently keep working against a schema that no longer exists. The failure is
quiet: the create and drop events arrive, so the channel looks alive.

## Expected behaviour

Every `ALTER TABLE` arm should raise a schema-change event on the engine's own path, so a
subscriber sees the same set of structural changes regardless of which storage backend is in use.
The events should match the shape the backends that do emit already produce
(`type: 'alter'`, `objectType: 'table'` or `'column'`).

## Notes

- The existing helper `emitAutoSchemaEventIfNeeded` in `schema/manager.ts` already handles the
  "only when a listener needs it, and only when the module has no emitter of its own" gating.
  The ALTER arms live in `runtime/emit/alter-table.ts` and simply never call it.
- Whatever lands must not double-emit alongside a backend that already emits — that is exactly
  what the gate in `emitAutoSchemaEventIfNeeded` is for, and the same double-emit hazard the
  data-event path documents in `dml-executor.ts`.
- Related but distinct, and each tracked separately:
  `fix/rename-table-mid-transaction-leaves-stale-event-table-name` (data events keep a stale
  table name across a rename) and `fix/sync-schema-migrations-replicate-empty-ddl` (the schema
  events that *are* emitted carry no DDL text, so a peer cannot replay them). The second is worth
  reading before deciding this ticket's event payload — a rename event that names only the new
  table is not replayable either, since `DatabaseSchemaChangeEvent` has no field for the old
  table name.
- Found while reproducing the rename-table ticket above.
