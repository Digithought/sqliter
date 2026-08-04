---
description: When a table is altered, the notification the database sends out says only "this table changed" — it does not say what changed. Make it carry the exact SQL statement that made the change, so anything listening (including the device-sync layer) can act on it.
prereq:
files:
  - packages/quereus/src/planner/nodes/alter-table-node.ts        # AlterTableNode — gains the rendered statement text
  - packages/quereus/src/planner/nodes/add-constraint-node.ts     # AddConstraintNode — same
  - packages/quereus/src/planner/building/alter-table.ts          # buildAlterTableStmt — the one place that has the AST and the table reference together
  - packages/quereus/src/emit/ast-stringify.ts                    # alterTableToString (line 1233) already renders every arm
  - packages/quereus/src/vtab/module.ts                           # SchemaChangeInfo (line 618) — gains `ddl`
  - packages/quereus/src/vtab/events.ts                           # VTableSchemaChangeEvent — gains `oldObjectName`
  - packages/quereus/src/core/database-events.ts                  # DatabaseSchemaChangeEvent — same
  - packages/quereus/src/runtime/emit/alter-table.ts              # every runX arm; revertAddColumn; the inline-constraint install loop (~line 828)
  - packages/quereus/src/runtime/emit/add-constraint.ts           # runAddConstraintViaModule (~line 127)
  - packages/quereus/src/runtime/emit/alter-schema-event.ts       # AlterSchemaEventShape — the engine's own (no-module-emitter) path
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # ~2493/2529/3048 — engine-internal reshape calls, must stay silent
  - packages/quereus-store/src/common/events.ts                   # SchemaChangeEvent — gains ddl/oldObjectName plumbing
  - packages/quereus-store/src/common/store-module-alter.ts        # 6 alter arms, each emitting at its tail
  - packages/quereus-store/src/common/store-module-alter-column.ts # the ALTER COLUMN arm (~line 282)
  - packages/quereus-store/src/common/store-module-rename.ts       # renameTable's emit (~line 249)
  - packages/quereus-store/test/alter-events.spec.ts               # existing home for ALTER event assertions
  - packages/quereus-store/test/database-events.spec.ts            # guards the engine-vs-module double-emit rule
  - docs/sync-schema.md                                            # § What replicates
difficulty: hard
---

# The schema-change event describes the alteration

## Why

Today an `ALTER TABLE` on a store-backed table announces
`{ type: 'alter', objectType: 'table', schemaName, objectName }` and nothing else.
Anything downstream — a UI cache, and above all the device-sync layer — knows only
that *some* table changed, not what changed, so it cannot reproduce the change
anywhere else. That is the root of the "table alterations don't sync" gap.

This ticket does not touch sync. It makes the event self-describing; the two
follow-on tickets consume it.

## What lands

**1. Each `ALTER TABLE` statement carries its own canonical SQL down to the module.**

`SchemaChangeInfo` (the per-alteration description the engine hands `module.alterTable`)
gains one optional field. Express it as an intersection so every arm gets it without
repeating it:

```ts
export type SchemaChangeInfo = (
	| { type: 'addColumn'; /* … */ }
	| { type: 'dropColumn'; columnName: string }
	// … unchanged arms …
) & {
	/**
	 * Canonical, fully-qualified SQL for the ONE statement this call carries out —
	 * the text a peer re-executes to reproduce it. Set by the engine only for the
	 * call that IS the statement's action.
	 *
	 * ABSENT means "engine-internal sub-step": the module must emit NO schema-change
	 * event for that call. See § One event per statement.
	 */
	readonly ddl?: string;
};
```

`(A | B) & C` distributes, so discriminated-union narrowing on `change.type` keeps
working in every existing `switch`.

`RENAME TO` does not go through `SchemaChangeInfo` — it routes through
`VirtualTableModule.renameTable`. Give that hook a trailing optional `ddl?: string`
parameter carrying the same text, under the same rule.

**2. The engine renders that SQL once, at plan-build time.**

`buildAlterTableStmt` (`planner/building/alter-table.ts`) is the only place that holds
the parsed statement and the resolved table reference together. Render there and store
the string on `AlterTableNode` / `AddConstraintNode` as a new readonly constructor
field (`sql`), which the runtime arms then pass through.

Render from a **synthetic** statement whose table name is rebuilt from the resolved
`TableSchema` (`schemaName` + `name`), not from `stmt.table` as the user wrote it — an
unqualified `alter table orders …` must not become a statement a receiver resolves
against a different default schema. `schema-differ.ts` (~line 2719) already builds a
synthetic `AST.AlterTableStmt` exactly this way; follow that shape:

```ts
const stmt: AST.AlterTableStmt = {
	type: 'alterTable',
	table: schemaName.toLowerCase() === 'main'
		? { type: 'identifier', name: tableName }
		: { type: 'identifier', name: tableName, schema: schemaName },
	action,           // the AST action, verbatim
};
const sql = astToString(stmt);
```

`alterTableToString` already covers every arm including `addConstraint`, so no new
rendering code is needed. Qualify the same way `generateTableDDL` does (that is what
the object-lifecycle migrations already put on the wire), so the two sources agree.

**3. One event per statement — engine-internal sub-steps announce nothing.**

`runAddColumn` decomposes `add column sku text unique` into an `addColumn` module call
plus a follow-up `addConstraint` module call per inline constraint (see the install
loop, `alter-table.ts` ~line 828). Today an emitter-backed module announces two events
for that one statement. The engine's own auto path already deliberately emits **one**
(see the comment at `alter-table.ts` ~line 853); this makes the module path agree.

Rule, stated once in `module.ts` and enforced at each store arm:

> A module emits a schema-change event for an `alterTable` call **iff** `change.ddl` is
> set, and puts that text on the event.

Calls that must therefore pass **no** `ddl`, and emit nothing:

- the inline-constraint install loop in `runAddColumn`;
- every call in `revertAddColumn` (a statement that unwound must announce nothing at
  all — today a revert inside an explicit transaction leaves real `alter` events in the
  batch for a change that never happened);
- the materialized-view backing reshape calls in `materialized-view-helpers.ts`
  (~2493, ~2529, ~3048) — engine scaffolding, not something the application did.

**4. A rename says what it renamed *from*.**

Add `oldObjectName?: string` to `VTableSchemaChangeEvent`, `DatabaseSchemaChangeEvent`
and the store's `SchemaChangeEvent`, alongside the existing `oldColumnName`. The store's
`renameTable` arm sets it to the old table name. Without it the event names only the new
table and a receiver cannot tell which of its tables the event is about.

**5. The engine's own (no-module-emitter) path carries the same text.**

`AlterSchemaEventShape` gains `ddl` and `oldObjectName`; every `emitAlterSchemaEvent`
call site in `alter-table.ts` and `add-constraint.ts` passes the node's rendered SQL
(and, for `RENAME TO`, the old name). Update the doc comment on
`emitAlterSchemaEvent`, which currently states that auto events carry no `ddl` —
the ALTER ones now do, and the reason is written there.

## Edge cases & interactions

- **`add column x text unique check (x <> '') references p(id)`** — one statement, three
  inline constraints, four module calls, and it must still produce exactly **one**
  event, carrying the whole statement's text.
- **Failed ADD COLUMN with an inline constraint** — the revert path runs
  `dropConstraint` + `dropColumn` through the module. Zero events, before and after.
  Assert this inside an explicit transaction that then *commits* other work, so a
  leaked event would actually be delivered rather than discarded by rollback.
- **`ALTER TABLE … RENAME TO` mid-transaction** — the arm already calls
  `renameBatchedEvents` to relabel batched DATA events. Batched SCHEMA events stay
  unrelabelled (a schema event records an operation, not current state); the `NOTE` at
  `alter-table.ts` ~line 244 says so and points at this work — update it to point at the
  new answer rather than at a stale ticket slug.
- **A maintained table (materialized view)** — structural ALTERs are rejected up front;
  only rename and the derivation verbs reach the module. The reshape helpers must stay
  silent (point 3) and `alter materialized view` tag paths are untouched.
- **Tag arms (`SET TAGS` / `ADD TAGS` / `DROP TAGS`)** — catalog-only, no module
  round-trip, and on an emitter-backed module they emit **nothing at all** today. Out of
  scope here; already tracked as `feat-alter-table-tags-emit-no-schema-event`. Do not
  widen this ticket to cover them, but do not regress them either.
- **The in-process isolation overlay** (`quereus-isolation/src/isolation-module.ts`
  ~1443) forwards `change` verbatim to the underlying module, so `ddl` rides through
  unchanged. It also drives `addColumn` with `insertAtIndex`, with no `ddl` — which
  correctly stays silent.
- **A module with no emitter** (the default memory module) goes through
  `emitAlterSchemaEvent` and must get the identical text, so a memory-backed and a
  store-backed alteration announce the same string.
- **Quoting / round-trip.** The rendered SQL must re-parse. Identifiers needing quotes
  (`add column "select" text`), string-literal defaults containing quotes, and a
  `GENERATED ALWAYS AS` expression are the cases to pin.

## Tests

`packages/quereus-store/test/alter-events.spec.ts` is the home for most of these; it
already drives a real `Database` + `StoreModule` + `StoreEventEmitter`.

- One spec per ALTER arm asserting the emitted event's `ddl` — add column, drop column,
  rename column, add constraint, drop constraint, rename constraint, alter column
  (each of set data type / set default / drop default / set not null / drop not null /
  set collate), alter primary key, rename to. Expected shape, for
  `alter table orders add column sku text` on `main.orders`:
  `alter table "orders" add column "sku" text` — assert against
  `astToString` of the same synthetic statement rather than a hand-typed literal only
  where the rendering is incidental; hand-type at least a few so a silent rendering
  change is visible.
- `alter table orders rename to orders2` emits `objectName: 'orders2'` **and**
  `oldObjectName: 'orders'`.
- `alter table orders add column sku text unique` emits exactly ONE event, whose `ddl`
  is the whole statement.
- A failed `add column … check (…)` over violating rows emits zero events (drive it
  inside `begin` … `commit` where the transaction survives, per the edge case above).
- Every emitted `ddl` re-parses: feed it back through `new Parser().parse(ddl)` and
  assert no throw, for each arm.
- `packages/quereus-store/test/database-events.spec.ts` — its double-emit guard must
  still hold; extend it so the engine auto path and the module path produce the same
  `ddl` for the same statement.

## Out of scope

Nothing in `packages/quereus-sync` changes here. After this ticket, an alteration on a
store-backed table records a **non-blank** `alter_column` migration, so the origin-side
warning in `recordSchemaMigration` stops firing and the receiver starts executing that
DDL through the existing one-for-one expectation path. That is safe precisely because
of point 3 (exactly one event per statement), but the receiver-side hardening and
idempotency are ticket 2's job — land these in order.

## TODO

- Add `ddl` to `SchemaChangeInfo` as an intersection field; document the
  "set ⇒ announce, absent ⇒ silent" rule on it and in `docs/module-authoring.md`
  § Schema Changes.
- Add a trailing `ddl?: string` to `VirtualTableModule.renameTable`.
- Add `oldObjectName?: string` to `VTableSchemaChangeEvent`,
  `DatabaseSchemaChangeEvent`, store `SchemaChangeEvent`, and `AlterSchemaEventShape`;
  add `ddl` to `AlterSchemaEventShape`.
- Render the canonical statement in `buildAlterTableStmt` from a synthetic
  `AST.AlterTableStmt` with a schema-qualified table identifier; store it on
  `AlterTableNode` and `AddConstraintNode`.
- Thread it through every `module.alterTable` / `module.renameTable` call that IS the
  statement's action, in `alter-table.ts` and `add-constraint.ts`.
- Leave it unset on the inline-constraint install loop, on `revertAddColumn`, and on the
  three `materialized-view-helpers.ts` reshape calls.
- Store module: emit iff `change.ddl` is set, and put it on the event — all 8 arms plus
  `renameTable` (which also sets `oldObjectName`).
- Pass `ddl` / `oldObjectName` through every `emitAlterSchemaEvent` call site; update
  that function's "carries no ddl" doc comment.
- Update the `renameBatchedEvents` NOTE in `alter-table.ts` (~244) and the
  `docs/sync-schema.md` § What replicates paragraph that says ALTER carries no DDL — it
  now does, though nothing consumes it until ticket 2.
- Tests as above; then `yarn build`, `yarn test`, `yarn lint`.
