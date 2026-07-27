---
description: Renaming a table part-way through a transaction used to leave the change notifications for earlier writes labelled with the old table name; they are now relabelled so every notification names the table as it exists when the notification is delivered.
prereq:
files:
  - packages/quereus/src/core/database-events.ts              # new renameBatchedEvents (~line 834)
  - packages/quereus/src/runtime/emit/alter-table.ts          # call site in runRenameTable (~line 229)
  - packages/quereus/test/alter-table-events.spec.ts          # 9 new cases (auto path + memory-native path)
  - packages/quereus-store/test/alter-events.spec.ts          # 1 new case (store path)
  - docs/usage.md                                             # as-of-delivery contract now covers tableName
  - docs/module-authoring.md                                  # same, plus who upholds it
  - docs/memory-table.md                                      # why the memory module needs no relabel
difficulty: medium
---

# What changed

`ALTER TABLE … RENAME TO` executed inside an open transaction now relabels the change
events the transaction already recorded, so a commit delivers every event under the table's
current name.

## The fix

**`DatabaseEventEmitter.renameBatchedEvents(schemaName, oldTableName, newTableName)`** —
new sibling of `remapBatchedDataEvents` in `packages/quereus/src/core/database-events.ts`.
Walks the base batch plus every open savepoint layer of *two* channels — data events and
maintenance-collision events — case-insensitively matching `schemaName` + `tableName`, and
replaces each match with `{ ...event, tableName: newTableName }`. Early-returns when not
batching. Synchronous and un-failable (it reads no schema and moves no value), so unlike
the row remap it needs no per-event `try`. `key` and `changedColumns` are untouched.

**Call site** — `runRenameTable` in `packages/quereus/src/runtime/emit/alter-table.ts`,
placed *after* `await module.renameTable(...)` and *before* `schema.removeTable(oldName)`.
Both halves of that ordering matter and are commented in place:

- after the module call, so a module failure leaves the event batch as untouched as the
  catalog;
- also after, because the store module's `renameTable` calls `ddlCommitPendingOps()`, which
  flushes its queued write events into the engine batch under the old name *during* that
  call — they must already be in the batch when the walk runs.

Batched **schema** events are deliberately not relabelled; a `NOTE:` at the call site says
so and why (a schema event records a DDL operation, not current state — its `objectName`
and its `ddl` text would have to be rewritten together). That whole question is
`fix/sync-schema-migrations-replicate-empty-ddl`'s.

## What to exercise

The three producer paths and how each is now covered:

| path | how to build it | before | now |
| --- | --- | --- | --- |
| engine auto-event | `new Database()` | `t` ✗ | `t2` ✓ (engine relabel) |
| store module | `db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()))` | `t` ✗ | `t2` ✓ (same engine relabel) |
| memory-native | `db.registerModule('memory_events', new MemoryTableModule(emitter))` | `t2` ✓ | `t2` ✓ (unchanged; now pinned) |

Base case, on any of the three:

```sql
begin;
insert into t values (1, 'a');
alter table t rename to t2;
commit;
-- the delivered data event must carry tableName 't2', key [1], newRow [1, 'a']
```

Cases now pinned by tests (`packages/quereus/test/alter-table-events.spec.ts`, engine
auto-event describe, unless noted):

- insert / update / delete each crossing the rename — relabelled, both row images and
  `changedColumns` intact
- rename chain `t` → `t2` → `t3` in one transaction, with a write between each: all events
  end at `t3`
- three-step name swap `a`→`tmp`, `b`→`a`, `tmp`→`b`: `a`'s rows land labelled `b` and
  `b`'s labelled `a`
- write inside an open savepoint layer, rename in the base transaction, then release
- the mirror: write in the base, rename inside the savepoint layer, then release
- `rollback to savepoint` spanning the rename — DDL escapes savepoint rollback, so the
  surviving event stays labelled `t2`
- cross-table isolation: renaming `t` leaves an untouched `u`'s events naming `u`
- autocommit is a no-op: a write delivered before a *separate* rename statement stays `t`
- `onTransactionCommit`'s grouped batch carries `t2` too
- memory-native describe: `RENAME TO` already delivers `t2` (pins that the name is stamped
  at commit from `_tableName`, so a refactor that starts stamping at write time is caught)
- store path (`packages/quereus-store/test/alter-events.spec.ts`): insert, rename, commit →
  `t2`. Note this case deliberately does **not** use the `tableName === 't'` filter its
  neighbours use — that filter is what would hide the bug.

Validation run: `yarn build`, `yarn lint`, `yarn test` from the repo root — all clean,
7381 + 1077 + the rest passing, 0 failing. The store spec runs inside `yarn test`, so no
`yarn test:store` pass was needed.

## Known gaps — read before signing off

**The collision channel is code-only, untested.** `renameBatchedEvents` walks
`batchedCollisionEvents` / `collisionEventLayers` (a maintained table — a materialized view
— can be renamed, and `runRenameTable` explicitly supports that). No test exercises it:
producing one needs a materialized view with a *coarsened* backing key plus a colliding
merge plus a mid-transaction rename of the view, which is a much larger fixture than
anything else here. The walk is a near-copy of the data-channel walk directly above it, so
the risk is low, but it is unverified. Worth a reviewer's eye on whether the fixture is
cheap enough to build after all.

**A schema-event gap is left open on purpose.** `begin; create table t; insert; alter table
t rename to t2; commit` delivers a `create` schema event naming `t` (whose `ddl` text
creates `t`), then data events naming `t2`. A replicating consumer creates `t` and receives
rows for `t2`. Fixing that means deciding how a rename crosses the wire, which is
`fix/sync-schema-migrations-replicate-empty-ddl`. Related and filed separately during the
reproduce pass: on the engine auto-event path no ALTER arm emits a schema event at all —
`backlog/bug-alter-table-emits-no-schema-event-without-native-module-emitter`.

**A separate data-loss bug was found and filed, not fixed here.**
`fix/memory-table-rename-with-savepoint-loses-transaction-rows`: on the memory module, a
transaction that renames a table *and* uses a savepoint (in either order) silently discards
every row the transaction wrote — commit reports success, the rows are gone. Root cause is
independent of this ticket's diff: `MemoryTableManager.renameTable` mints a new
`tableSchema` object, and `commitTransaction`'s reference-identity guard
(`readLayer.getSchema() === this.tableSchema`, `layer/manager.ts:471`) then refuses to
publish the savepoint snapshot. Every other schema-mutating arm in that manager calls
`adoptSchemaOnOpenLayers`; `renameTable` is the one that does not. The filed ticket has the
full 10-case probe table.

Consequence for this ticket's tests: the savepoint-and-rename cases assert **only** the
delivered event names, not that the rows survived. The DROP COLUMN twin asserts row
survival; the RENAME twin has a `NOTE:` in place of that assertion pointing at the ticket.
**Restore the row assertion once that fix lands** — it is the natural regression guard, and
right now this file would pass even if the rename kept losing data.
