description: An application watching the database for structural changes is promised one clearly-described notification per ALTER TABLE statement, but the disk-backed storage backend only says "this table changed" without naming the column, and the statements that attach descriptive labels say nothing at all.
files:
  - packages/quereus-store/src/common/store-module-alter.ts   # StoreModuleAlter.alterTable — the single emit block at the dispatcher tail
  - packages/quereus/src/vtab/memory/module.ts                # MemoryTableModule.alterTable + alterEventShape — the shape to match
  - packages/quereus/src/runtime/emit/alter-table.ts          # runSetTableTags and its 8 siblings (lines 1315-1419) — the arms that emit nothing
  - packages/quereus/src/core/database-events.ts              # DatabaseSchemaChangeEvent — the fields at issue
  - packages/quereus-store/test/alter-events.spec.ts          # only asserts `ddl` today; would gain shape assertions
  - docs/usage.md                                             # § What each ALTER TABLE arm reports — the table this contradicts
  - docs/sql-ddl.md                                           # § SET TAGS / ADD TAGS / DROP TAGS
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Nothing inside the engine consumes these events — the cost falls only on applications that subscribe — and a subscriber can always re-read the catalog after any event, so a maintainer may prefer to weaken the documented promise instead of meeting it.
----

# The documented per-arm schema-event contract is not met on two fronts

`docs/usage.md` § *What each `ALTER TABLE` arm reports* states that every structural arm
raises exactly one event "whether or not the storage backend ships an emitter of its own …
so a subscriber sees the same facts either way", and tabulates a per-arm shape:

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` | `alter` | `column` | table | altered column | — |

Two separately-filed gaps, both verified, both about that one contract. They are one ticket
because the fix is "make the emitted event match the documented table" and any change to
one half invites a decision about the other.

## Arm A — the store backend reports a coarser shape than the in-memory one (verified)

The in-memory backend matches the table above. The store backend reports
`alter` / `table` / `<table name>` for **every** arm, with `columnName` and `oldColumnName`
always absent. So a subscriber is told the table changed but not which column, and a
`drop column` looks like an ordinary alteration rather than a removal — the same statement
reports differently depending only on where the data happens to live.

`StoreModuleAlter.alterTable` has a single emit block at the dispatcher tail;
`MemoryTableModule.alterTable` + `alterEventShape` is the shape to match.
`packages/quereus-store/test/alter-events.spec.ts` asserts only that a `ddl` event
happened, which is why the divergence survived.

## Arm B — tag statements raise nothing at all (verified)

Quereus lets you attach free-form key/value **tags** to a table, a column, or a named
constraint — metadata that travels with the schema:

```sql
alter table orders set tags (owner = 'billing', reviewed = 1);
alter table orders drop tags (reviewed);
```

`db.onSchemaChange(...)` is the channel an application subscribes to in order to hear that
the structure of the database changed — a UI refreshing its table list, a cache
invalidating on DDL, a replicator shipping changes to a peer. **No tag statement raises
anything on it.** Verified on current `main` against both a default database and a memory
backend constructed with its own event emitter: nine tag statement forms (table / column /
constraint × SET / ADD / DROP), zero events.

`runSetTableTags` and its eight siblings live at `runtime/emit/alter-table.ts:1315-1419`.

## Notes for whoever picks this up

- Arm B needs a decision the docs do not currently make: is a tag change *structural*? If
  the answer is no, the fix is to say so in `docs/usage.md` and `docs/sql-ddl.md` rather
  than to emit. Say which, either way.
- Arm A's fix is mechanical once the memory backend's `alterEventShape` is reused; the
  work is mostly widening `alter-events.spec.ts` from "an event happened" to "this event".
