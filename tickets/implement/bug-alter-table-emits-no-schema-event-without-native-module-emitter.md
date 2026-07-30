---
description: An application watching a database for structural changes is never told when a table is altered — renamed, or having a column or constraint added, dropped, renamed, or retyped — unless the storage backend happens to provide its own notifications. Make the engine report those changes itself, the way it already reports table and index creation.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts              # 12 ALTER arms; none emits a schema event
  - packages/quereus/src/runtime/emit/add-constraint.ts           # ADD CONSTRAINT — a SEPARATE emitter, same gap
  - packages/quereus/src/schema/manager.ts                        # emitAutoSchemaEventIfNeeded (line 2581) — private today
  - packages/quereus/src/core/database-events.ts                  # DatabaseSchemaChangeEvent (line 51)
  - packages/quereus/src/vtab/memory/layer/manager.ts             # the parity reference: what memory-with-an-emitter emits
  - packages/quereus/test/alter-table-events.spec.ts              # lines 1019-1080 assert the OLD (silent) behaviour — must change
  - packages/quereus-store/test/database-events.spec.ts           # line 161 create-table no-double-emit control; add an ALTER one
  - docs/usage.md                                                 # § Subscribing to Schema Changes (lines 389-424)
  - docs/sql-ddl.md                                               # line 633 asserts ALTER raises no schema event on any arm
  - docs/module-events.md                                         # lines 10-11, 178-186 — the auto-event contract
difficulty: medium
---

# `ALTER TABLE` must raise a schema-change event on the engine's own path

## Reproduced on current `main`

A default `new Database()` uses the `memory` module registered *without* an event emitter, so
every schema event has to come from the engine's own fallback. Subscribing with
`db.onSchemaChange` and running one statement per arm: `create table` emits, **all eight ALTER
arms tested emit nothing**.

```
✔ create table DOES emit          ['create/table/t']
✗ rename table                    []   expected ['alter/table/t2']
✗ rename column                   []   expected ['alter/column/t/v2']
✗ add column                      []   expected ['alter/column/t/w']
✗ drop column                     []   expected ['drop/column/t/w']
✗ alter column set data type      []   expected ['alter/column/t/v']
✗ alter primary key               []   expected ['alter/table/t']
✗ drop constraint                 []   expected ['alter/table/t']
✗ rename constraint               []   expected ['alter/table/t']
```

`ALTER TABLE … ADD CONSTRAINT` has the same gap and lives in a **different file** —
`runtime/emit/add-constraint.ts`, not `alter-table.ts`. It is in scope.

## The parity reference (measured, not inferred)

The same statements against a `MemoryTableModule` constructed **with** a
`DefaultVTableEventEmitter` — the backend that does emit — produce exactly this. These are the
shapes the engine fallback must reproduce, so a subscriber sees the same facts regardless of
backend:

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename to` | `alter` | `table` | **new** table name | — | — |
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` (all four attribute forms) | `alter` | `column` | table | altered column | — |
| `alter primary key` | `alter` | `table` | table | — | — |
| `add constraint` | `alter` | `table` | table | — | — |
| `drop constraint` | `alter` | `table` | table | — | — |
| `rename constraint` | `alter` | `table` | table | — | — |

Note `drop column` is `type: 'drop'`, **not** `'alter'` — the ticket's summary said every arm
should be `type: 'alter'`, but parity with the emitting backend wins. Follow the table.

The store module differs from memory on the column arms (it reports `alter`/`table` where memory
reports `alter`/`column`), but that divergence is pre-existing and belongs to the store module.
The engine fallback **never runs for the store module** — the store has a native emitter — so the
memory shape is the only one the fallback has to match. Do not chase the store's shape here.

## Design

### One gate, called from each arm

`SchemaManager.emitAutoSchemaEventIfNeeded` (`schema/manager.ts:2581`) already encodes both
halves of the decision: emit only when a listener needs the event
(`db._needsSchemaEvents()`, which is also false inside a `withPublicEventsSuppressed` scope), and
only when the owning **module** has no emitter of its own (`hasNativeEventSupport` on the module
registration, not the vtab instance — the distinction that caused the data-channel double-emit
bug the store package's `database-events.spec.ts` guards). It is `private` today and both new
call sites are outside `SchemaManager`.

Make it **public** and call it from the arms:

```ts
rctx.db.schemaManager.emitAutoSchemaEventIfNeeded(tableSchema.vtabModuleName, {
  type: 'alter', objectType: 'column',
  schemaName: tableSchema.schemaName,
  objectName: tableSchema.name,
  columnName: columnDef.name,
});
```

Do **not** reimplement the gate in `runtime/emit/` — one gate is what keeps the double-emit
hazard closed in a single place. Keep its existing doc comment (the `ddl` NOTE stays accurate).

### Emit at the END of each arm, on the success path only

The emitting modules emit from *inside* `module.alterTable` — i.e. early, before the engine's
catalog swap. Diverge deliberately: place the fallback emit **after** the catalog swap and the
internal `changeNotifier.notifyChange(...)`, at the point each arm returns. Rationale: an arm
that fails after the module call (the `ADD COLUMN` inline-constraint revert path, an
`assertRenameDependentsPersistable` refusal) must announce nothing at all. Announcing a change
that then unwound is worse than the intra-statement ordering drift, and the drift is
unobservable — each arm produces exactly one schema event, and delivery is batched to commit.

The existing `revertAddColumn` path needs no change: it runs from the `catch`, so control never
reaches the emit.

### `ADD COLUMN` with an inline constraint: emit ONE event, not two

Measured: `alter table a add column y text null unique` on the emitter-backed memory module emits
**two** events — `alter/column/a/y` then `alter/table/a` — because the arm makes a second
`module.alterTable(addConstraint)` round-trip per inline constraint. That second event is an
artifact of the module's internal call pattern, not a second thing the application did.

Emit **one** `alter`/`column` event for the whole statement. This is the one deliberate
divergence from the parity table; state it in a code comment at the emit site so a future reader
does not "fix" it into two.

### Out of scope — and why

- **`SET TAGS` / `ADD TAGS` / `DROP TAGS`.** Measured: these emit nothing on the emitter-backed
  memory module either — the tag arms are catalog-only and never call `module.alterTable`. So
  emitting here would not be restoring parity; it would be a new capability, and (because the
  gate suppresses the engine path for a native-emitter module) it would emit for memory and stay
  silent for the store — a *new* asymmetry. Filed as `backlog/feat-alter-table-tags-emit-no-schema-event`.
- **`SET MAINTAINED` / `DROP MAINTAINED`.** Materialized-view lifecycle raises only *internal*
  catalog notifications (`materialized_view_added` / `_modified` / `_removed`); no backend raises
  a public schema event for it. A separate, larger question.
- **The `ddl` payload.** The fallback carries no `ddl`, matching every other auto event (see the
  NOTE on `emitAutoSchemaEventIfNeeded`). Owned by `fix/sync-schema-migrations-replicate-empty-ddl`.
- **An old-table-name field for renames.** `DatabaseSchemaChangeEvent` has `oldColumnName` but no
  `oldObjectName`, so a rename event names only the new table. The emitting backends have the
  identical gap, so parity holds. Do **not** add the field here — it is a public-interface change
  the replication ticket above should drive.

## Existing tests that assert the OLD behaviour

`packages/quereus/test/alter-table-events.spec.ts`, describe `'ALTER PRIMARY KEY via shadow-table
rebuild: the rebuild is notification-silent'` (line 1019). After the fix the *shadow-table churn*
stays suppressed but the arm's own event fires, so two of its cases change:

- line 1053 `'delivers zero schema-change events, and nothing naming the shadow table'` → becomes
  exactly one `alter`/`table` naming `t`; keep the assertion that nothing names `__rekey_`.
- line 1069 `'groups nothing on the transaction-commit channel either'` → one batch, with
  `schemaEvents.length === 1` and `dataEvents` still empty.
- The failed-rebuild case (~line 1130) asserting `schemaEvents == []` stays correct as-is — the
  statement throws, so nothing is emitted. Leave it.
- That describe's header comment names this ticket slug as the tracker for the missing positive
  event; update the wording.

Rewriting those is the point of the change, not collateral damage — but say so plainly in the
review handoff so the reviewer does not read it as a weakened test.

## Docs to update

- `docs/usage.md` § Subscribing to Schema Changes (389-424): the paragraph at 419-424 claims
  ALTER PRIMARY KEY "is the one DDL statement that reports nothing here" — after the fix it
  reports one `alter`/`table`; only the shadow-table create/drop pair stays hidden. Add the
  per-arm shape table above so a subscriber can see what to expect from each statement.
- `docs/sql-ddl.md` line 633: "`ALTER TABLE` raises no schema event on the engine's own path for
  **any** arm today, tracked separately" — now false. The rebuild is still silent about its four
  internal statements, but the re-key itself now reports.
- `docs/module-events.md` lines 10-11 / 178-186: the auto-event contract says the engine emits
  "for all successful DML operations"; make the DDL coverage explicit (which arms, and that tags
  and MV lifecycle are excluded).

## TODO

- Make `SchemaManager.emitAutoSchemaEventIfNeeded` public; keep its doc comment intact.
- Add the fallback emit to each arm in `runtime/emit/alter-table.ts`, matching the parity table:
  `runRenameTable`, `runRenameColumn`, `runAddColumn`, `runDropColumn`, `runAlterColumn`,
  `runAlterPrimaryKey` (**both** the native-re-key branch and the rebuild-fallback tail),
  `runDropConstraint`, `runRenameConstraint`.
- Add the same to `runtime/emit/add-constraint.ts` — **both** paths: `runAddConstraintViaModule`
  and `runAddCheckEngineSide` (the latter is the no-`alterTable`-hook module, exactly the kind of
  backend this fallback exists for).
- Comment the single-event decision at the `runAddColumn` emit site.
- New spec `packages/quereus/test/alter-table-schema-events.spec.ts`: arm-by-arm on a default
  `Database` asserting the parity table exactly (one event, right shape); plus a failed ALTER
  emits nothing; plus events batch to commit and are dropped on rollback; plus an ALTER inside a
  savepoint that is rolled back emits nothing.
- Same spec, second describe: an emitter-backed `MemoryTableModule` emits **exactly one** event
  per arm on `db.onSchemaChange` — the direct no-double-emit guard.
- Add an ALTER counterpart to `packages/quereus-store/test/database-events.spec.ts` next to the
  create-table control at line 161: `alter table … add column` over a store-backed table emits
  exactly one `onSchemaChange` event.
- Update the two cases + header in `packages/quereus/test/alter-table-events.spec.ts` per above.
- Update the three doc sites.
- `yarn build`, `yarn test`, `yarn lint`. Run `yarn test:store` too — this change touches the
  store's double-emit gate surface, which the default suite does not exercise.
