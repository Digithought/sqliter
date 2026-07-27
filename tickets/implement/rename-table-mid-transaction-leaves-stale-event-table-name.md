---
description: When a table is renamed part-way through a transaction, the change notifications for writes made before the rename still carry the old table name, so a listener such as the sync engine files those rows under a table that no longer exists.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                 # add renameBatchedEvents alongside remapBatchedDataEvents (~line 780)
  - packages/quereus/src/runtime/emit/alter-table.ts             # runRenameTable (~line 185); call site right after `await module.renameTable(...)` (~line 227)
  - packages/quereus/test/alter-table-events.spec.ts             # engine auto path + memory-native path tests
  - packages/quereus-store/test/alter-events.spec.ts             # store path test
  - docs/usage.md                                                # ~line 350, the "schema current at delivery" contract paragraph
  - docs/module-authoring.md                                     # ~line 1205, same contract for module authors
  - docs/memory-table.md                                         # ~line 368/402, why the memory-native path needs nothing
difficulty: medium
---

# `ALTER TABLE … RENAME TO` inside a transaction leaves earlier change events labelled with the old name

## Reproduced

Probed on current `main` (scratch specs, since removed). Three producer paths, the same
transaction each time: insert a row, rename the table, insert another row, commit.

| path | how it was built | `tableName` on the two delivered events |
| --- | --- | --- |
| engine auto-event | `new Database()` (memory module, no emitter) | **`t`**, `t2` ← wrong |
| store module | `db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()))` | **`t`**, `t2` ← wrong |
| memory-native | `db.registerModule('memory_events', new MemoryTableModule(emitter))` | `t2` ✓ already correct |

The `onTransactionCommit` grouped batch carries the same stale `t` — it is built from the same
projection, so it is fixed by the same change and does not need its own handling.

## Why the memory-native path is already right

`MemoryTableManager` stamps `tableName: this._tableName` onto each event at **commit** time
(`vtab/memory/layer/manager.ts:592`), and `renameTable` (~line 1494) sets `_tableName = newName`
during the ALTER. Its queued `PendingChange` records carry no name at all, so there is nothing
to rewrite. This path needs no code change — only a test, so a future refactor that starts
stamping the name at write time is caught.

## Why the other two are wrong

The engine's auto-event path stamps `event.tableName` at write time (`dml-executor.ts`), pushes
the event into `DatabaseEventEmitter`'s batch, and delivers it at commit. Nothing revisits it.

The store module lands in the same batch: its `renameTable`
(`quereus-store/src/common/store-module.ts:2556`) calls `ddlCommitPendingOps()` — which flushes
every queued write event into the engine batch under the **old** name — before it moves physical
storage. This is exactly the ordering the ADD/DROP COLUMN fix already relies on, so one
engine-level fix covers both paths.

## The fix

Add a sibling to `remapBatchedDataEvents` in `DatabaseEventEmitter`:

```ts
/**
 * Relabel every BATCHED event naming `(schemaName, oldTableName)` to `newTableName`,
 * in place, after a mid-transaction `ALTER TABLE … RENAME TO`. Covers batchedDataEvents,
 * every dataEventLayers savepoint layer, and the collision channel. No-op when not
 * batching: in autocommit the earlier events were already delivered under the name the
 * table had at the time, which is correct.
 */
renameBatchedEvents(schemaName: string, oldTableName: string, newTableName: string): void
```

Same walk shape as `remapBatchedDataEvents` — case-insensitive match on
`schemaName` + `tableName`, replace the entry with `{ ...event, tableName: newTableName }`.
Unlike the row remap it cannot fail, so it is synchronous and needs no per-event `try`.

Call it from `runRenameTable` immediately **after** `await module.renameTable(...)` returns and
**before** the catalog swap (`schema.removeTable(oldName)`), matching where the ALTER arms call
`remapBatchedDataEvents`. After the module call, so a module failure leaves the batch untouched
alongside the untouched catalog; after it rather than before, so the store's mid-call flush is
already in the batch when the relabel runs.

`event.key` is unaffected — a rename moves no value and changes no column. `changedColumns`
likewise.

### Also relabel collision events

`MaintenanceCollisionEvent` (same file) carries `schemaName` / `tableName` for the maintained
table, batched in `batchedCollisionEvents` / `collisionEventLayers`. `runRenameTable` explicitly
supports renaming a maintained table (materialized view), so walk that channel in the same pass —
a few extra lines, same correctness argument. Batched **schema** events are deliberately *not*
relabelled; see below.

## Sequences that must work

Because each rename relabels against the name events carry *at that moment*, chains compose:

- `t → t2 → t3` in one transaction: the first relabel moves `t`→`t2`, the second `t2`→`t3`.
- A three-step swap `a → tmp`, `b → a`, `tmp → b`: `a`'s events end up labelled `b` and `b`'s
  labelled `a`, which is right.
- Rename inside a savepoint layer, and rename in the base transaction with events sitting in an
  open savepoint layer — both are why the walk must cover `dataEventLayers`, not just the base
  batch.
- `ROLLBACK TO SAVEPOINT` spanning the rename: DDL escapes savepoint rollback (the table stays
  renamed), so the relabelled events must stay relabelled. Same reasoning the ADD/DROP COLUMN
  review recorded.

## Known remaining gap — do not try to close it here

`begin; create table t; insert; alter table t rename to t2; commit` delivers a `create` **schema**
event naming `t` (with `ddl` text creating `t`), then — on the paths that emit one at all — an
`alter` schema event naming `t2` with no record of the old name, and (after this fix) data events
naming `t2`. A replicating consumer therefore creates `t` and receives rows for `t2`.

Do **not** rewrite batched schema events to fix this. A schema event is a record of a DDL
operation, not a snapshot of current state, and its `objectName` and its `ddl` text would have to
be rewritten together. That whole problem — schema changes that reach a peer as unreplayable or
empty instructions — is the subject of `fix/sync-schema-migrations-replicate-empty-ddl`, which
must decide how a rename crosses the wire. Reference it in the review handoff; leave a `NOTE:`
at the `renameBatchedEvents` call site saying schema events are deliberately out of its scope
and why.

Related, and filed separately during this reproduce pass: on the engine auto-event path no ALTER
arm emits a schema event **at all** — `backlog/bug-alter-table-emits-no-schema-event-without-native-module-emitter`.

## Answers to the reproduce-pass questions the fix ticket raised

- **Schema-level rename** (`ALTER SCHEMA … RENAME`): not reachable. No parser rule, no AST node,
  no emitter — searching the engine for a schema-rename path finds only a doc comment. Nothing
  to fix.
- **Does the rename's own schema event let a listener correlate old and new names?** No. The
  memory-native and store modules emit `{ type: 'alter', objectType: 'table', objectName: <new> }`
  and `DatabaseSchemaChangeEvent` has no old-object-name field (it has `oldColumnName`, for
  column renames only). The auto path emits nothing at all. Covered by the two tickets named
  above; not this ticket's job.
- **What the store path does:** confirmed broken, as suspected — see the table above.

## TODO

Phase 1 — fix

- Add `renameBatchedEvents(schemaName, oldTableName, newTableName)` to `DatabaseEventEmitter`,
  next to `remapBatchedDataEvents`, walking base + savepoint layers of both the data and
  collision channels. Early-return when `!this.isBatching`. Log the relabelled count the way
  `remapBatchedDataEvents` does.
- Call it from `runRenameTable` after `module.renameTable` and before `schema.removeTable`,
  with a comment giving the ordering rationale (module failure leaves the batch clean; the
  store's `ddlCommitPendingOps` flush has already landed).
- Add the `NOTE:` explaining that batched schema events are deliberately left alone.

Phase 2 — tests

In `packages/quereus/test/alter-table-events.spec.ts` (extend both existing describes; widen the
file header comment, which currently names only the column-shape cases):

- auto path: insert, rename, commit → single event with `tableName === 't2'` and the row intact.
- auto path: update crossing the rename → both images intact, name `t2`.
- auto path: delete crossing the rename → `oldRow` intact, name `t2`.
- auto path: `t → t2 → t3` in one transaction.
- auto path: the three-step `a`/`b` swap; assert each table's rows land under the right name.
- auto path: write in a savepoint layer, then rename in the base transaction, then commit —
  and the mirror (rename inside the savepoint layer, then release).
- auto path: `rollback to savepoint` after a rename, then commit — surviving events name `t2`.
- auto path: cross-table isolation — renaming `t` leaves an untouched `u`'s events naming `u`.
- auto path: autocommit rename is a no-op — a write before a *separate* `alter table t rename to
  t2` statement was already delivered as `t`, and stays `t`.
- auto path: the `onTransactionCommit` grouped batch carries `t2` too.
- memory-native path: pin that it already delivers `t2`.

In `packages/quereus-store/test/alter-events.spec.ts`: insert, rename, commit → `t2`. Note the
existing tests filter on `e.tableName === 't'`; the rename test must not.

Phase 3 — docs

- `docs/usage.md` (~line 350) and `docs/module-authoring.md` (~line 1205): extend the
  "schema current at delivery" contract to say the **table name** is likewise as-of-delivery —
  a mid-transaction `RENAME TO` relabels events already recorded. In `module-authoring.md`, add
  it to the "who upholds it" list: the engine relabels events sitting in its batch; a module that
  holds its own queue across the rename must either stamp the name at emit time (what the memory
  module does) or relabel its queue itself.
- `docs/memory-table.md` (~line 368/402): one line on why the memory module needs nothing for
  `RENAME TO` — the name is stamped at commit from `_tableName`, which the rename already moved.

Phase 4 — validate

- `yarn build`, `yarn lint`, `yarn test` from the repo root, streamed with `tee`.
- Store spec is inside `yarn test` (it is a Vitest/Mocha workspace test, not a `test:store`
  logic-suite run), so no `yarn test:store` pass is needed for this change.
