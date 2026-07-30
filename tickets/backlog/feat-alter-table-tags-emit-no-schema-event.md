---
description: Attaching, changing, or removing the descriptive labels stored alongside a table, column, or constraint currently notifies nobody — an application watching the database for structural changes hears nothing, on every storage backend.
prereq: bug-alter-table-emits-no-schema-event-without-native-module-emitter
files:
  - packages/quereus/src/runtime/emit/alter-table.ts    # runSetTableTags and its 8 siblings (lines 1315-1419)
  - packages/quereus/src/core/database-events.ts        # DatabaseSchemaChangeEvent
  - docs/sql-ddl.md                                     # § SET TAGS / ADD TAGS / DROP TAGS
difficulty: easy
---

# Tag changes raise no schema-change event

## Background

Quereus lets you attach free-form key/value **tags** to a table, a column, or a named
constraint — metadata that travels with the schema:

```sql
alter table orders set tags (owner = 'billing', reviewed = 1);
alter table orders drop tags (reviewed);
```

Separately, `db.onSchemaChange(...)` is the channel an application subscribes to in order to hear
"the structure of the database changed" — a UI refreshing its table list, a cache invalidating on
DDL, a replicator shipping changes to a peer.

## What happens

No tag statement raises anything on that channel. Verified on current `main` against both a
default database and a memory backend constructed with its own event emitter: nine tag statement
forms (table / column / constraint × SET / ADD / DROP), zero events.

The cause is structural rather than an oversight in one place: tags touch no stored row and no
physical layout, so the tag arms deliberately never call into the storage backend at all — they
update the in-memory catalog directly. Every other `ALTER TABLE` arm gets its event either from
the backend or from the engine's fallback on the way through; the tag arms pass through neither.

## Why it is filed separately from the sibling ticket

The prerequisite ticket makes the engine report the *structural* ALTER arms (rename, add/drop
column, retype, constraint changes) so that a subscriber sees the same facts whichever storage
backend is in use. Tags are not that: **no** backend reports them, so there is no parity to
restore and nothing is currently inconsistent. Adding the event is a new capability.

That also makes it the wrong thing to bolt onto the sibling fix. The engine's fallback is
suppressed for any backend that emits its own events — so an engine-only tag event would fire for
a plain in-memory database and stay silent for a persistent one, introducing exactly the kind of
backend-dependent gap the sibling ticket exists to remove.

## Decisions a human should make before this is worked

- **Is a tag change a schema change at all?** Tags carry no structural meaning of their own — but
  some reserved `quereus.*` keys do change engine behaviour, so the answer may differ by key. A
  blanket yes/no may be the wrong shape.
- **Where should the event come from?** Uniformly from the engine (simple, but bypasses the
  backend that may want to persist and forward it), or by routing tag changes through the backend
  the way every other arm is routed (consistent, but gives the backends new work and a new failure
  mode on a statement that currently cannot fail).
- **What shape?** `DatabaseSchemaChangeEvent` has no field for *which* tags changed, so a
  subscriber would learn only "something about this object's tags changed" and have to re-read the
  catalog. That may be sufficient, or may argue for a payload field.

Found while fixing the sibling ticket; recorded so the gap is not silently inherited as
"intended".
