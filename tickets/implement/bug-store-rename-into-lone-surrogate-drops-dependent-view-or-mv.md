---
description: Renaming a table or column to a name containing a broken half-character quietly damages saved views and materialized views — one kind is destroyed outright, others keep working for the rest of the session but come back wrong (or not at all) the next time the database is opened.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                # runRenameTable / runRenameColumn — where the pre-flight goes
  - packages/quereus/src/schema/catalog-persistability.ts           # existing pre-flight driver; new dependent-scan helper goes here
  - packages/quereus/src/schema/rename-rewriter.ts                  # renameTableInAst / renameColumnInAst (in-place mutators — hence the clone)
  - packages/quereus/src/schema/ddl-generator.ts                    # generateViewDDL / generateMaintainedTableDDL — what the prospective object renders as
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # propagate*ToMaterializedViews, applyMaterializedViewRewrite, restoreUnaffectedMaterializedViews
  - packages/quereus/src/vtab/module.ts                             # assertCatalogObjectPersistable docstring says the rename path is uncovered
  - packages/quereus-store/src/common/store-module.ts               # StoreModule.assertCatalogObjectPersistable (no change expected)
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts         # where the new rejection cases belong
  - packages/quereus-store/test/view-mv-persistence.spec.ts         # existing close→reopen rename round-trips must stay green
  - docs/schema.md                                                  # § View and materialized-view persistence — documents this as an open gap
  - docs/store.md                                                   # surrogate-guard section — same
difficulty: medium
---

## Background

A **lone surrogate** is a broken half of a Unicode character. A JavaScript string can hold
one (`'\uD800'`); Quereus accepts it as a `text` value, but no UTF-8 byte sequence encodes
it, so the persistent store refuses to write text containing one.

Ticket `bug-store-view-lone-surrogate-name-silently-dropped` closed the CREATE side. It
added an optional module hook, `VirtualTableModule.assertCatalogObjectPersistable(db, kind,
object)`, asked of every registered module **before** a view / materialized view is
registered; the store implements it by running exactly the key + DDL-text derivation its
write path runs. Four call sites use it: `emitCreateView`, `materializeView`, and the two
SET TAGS paths in `SchemaManager`.

The rename paths were left uncovered. `alter table … rename to` and `alter table … rename
column` rewrite the new name into every dependent view and materialized-view body and
re-persist them; renaming a materialized view additionally moves its own catalog entry. All
of those re-persists ride `SchemaChangeNotifier` (which try/catches each listener and only
logs) and then the store's persist queue (which `.catch`-logs), so **nothing can fail the
statement**.

## Reproduced

All confirmed at `30d5e107` against an in-memory KV provider with a store module registered
(scratch specs, since deleted — the permanent versions are the TODO list below). In every
case the statement **succeeded**.

| # | Statement | Symptom |
| - | --------- | ------- |
| A | `alter table <memory-backed MV> rename to "<lone surrogate>"` | MV catalog entry **deleted**. The MV answers queries for the rest of the session and is simply absent after reopen. Only sign: a `console.warn`. |
| B | `alter table <memory table> rename column x to "<lone surrogate>"`, with a persisted view over it | Live view body is rewritten; the persisted entry keeps the **old** text. Live and durable definitions silently diverge. |
| F | `alter table <memory table> rename to "<lone surrogate>"`, with a persisted MV over it | Same divergence on the MV entry. |
| G | Same as F but the dependent MV is **store-backed** | Worse and quieter: the propagation throws while renaming the MV's backing column, `failMaterializedViewRenamePropagation` swallows it, and the MV is left **permanently stale** with a body naming a column that no longer exists. No `console.warn` at all — the failure only reaches the debug log channel. |

Already loud and already clean no-ops (the store's physical store-name / DDL-text guard
fires first) — these must **stay** loud and must not gain a second, competing error:

- `alter table <store table> rename to "<lone surrogate>"`
- `alter table <store table> rename column v to "<lone surrogate>"`
- `alter table <store-backed MV> rename to "<lone surrogate>"`

## Expected behavior

A rename that would leave any persisted view or materialized view unwritable must **fail the
statement**, leaving the catalog and all physical storage untouched — the same clean-no-op
guarantee the CREATE paths give. It must never report success and then lose or silently
diverge from the object.

## Design

Add a **pre-flight dependent scan** that runs before the first side effect of either rename
arm, computes what each dependent view / MV body *would* become, and asks every registered
module about the prospective object via the existing
`assertCatalogObjectPersistable` hook.

### The prospective-object problem

`renameTableInAst` / `renameColumnInAst` mutate the AST **in place** and return whether
anything changed. The pre-flight cannot use them directly on the live AST: a veto thrown
after the mutation would leave the live view body naming a table that was never renamed.

So clone first. A full `structuredClone` is not safe — `LiteralExpr.value` is typed
`MaybePromise<SqlValue>`, and a Promise is not structured-cloneable. The rewriters only ever
assign to `.name` / `.schema` string fields on AST nodes (see `rename-rewriter.ts`), so a
**spine clone** is sufficient and safe: deep-copy plain objects and arrays, pass everything
else (primitives, `Uint8Array`, `bigint`, any class instance or Promise) through by
reference.

Rendering a prospective object then works without further plumbing, because both DDL
generators read the AST, not a cached string:

- `generateViewDDL(view)` reads `view.selectAst` → prospective view is
  `{ ...view, selectAst: clone }`.
- `generateMaintainedTableDDL(table)` reads `table.derivation.selectAst` and
  `table.columns` → prospective MV is `{ ...mv, derivation: { ...mv.derivation, selectAst: clone } }`.

### Placement

Both rename arms live in `packages/quereus/src/runtime/emit/alter-table.ts`.

`runRenameTable` — insert after the existing name-conflict check and **before**
`module.renameTable` (the physical move, i.e. the first side effect):

1. If the table being renamed is itself maintained (`isMaintainedTable`), veto the
   prospective renamed record `{ ...tableSchema, name: newName }` as
   `'materializedView'`. This covers case A: it vets the new catalog **key** as well as the
   new DDL text, and it runs long before the `materialized_view_removed` that deletes the
   old entry. (Approximation: the self-reference rewrite `rewriteTableForTableRename`
   performs is not applied to the probe. It only substitutes `newName`, which is already
   under test as the record's own `name`, so the check is not weakened.)
2. Scan dependents in the renamed table's **own schema only** — that is the same gate
   `propagateTableRenameInSchema` applies to its view/MV loops. For each view and each
   maintained table: spine-clone the body AST, run `renameTableInAst` on the clone, and if it
   reports a change, veto the prospective object.

`runRenameColumn` — insert after the column existence / collision checks and **before**
`module.alterTable`. Same dependent scan, with `renameColumnInAst` and the same
`resolveColumnInSource` resolver `propagateColumnRename` builds.

`resolveColumnInSource` is safe to evaluate pre-mutation: `isTableInUnaliasedScope` skips the
renamed table itself (`rename-rewriter.ts:608`) and probes only *other* sources, whose column
sets the rename does not touch. So the pre-flight computes the same rewrite the real pass
will.

### Deliberately not covered

- An MV that reads the renamed table only **through a plain view** (unchanged body AST,
  `sourceTables` carrying the old base) is re-persisted by `applyMaterializedViewRewrite`,
  but its DDL text is unchanged, so `persistObjectCatalogEntryIfChanged` skips the write. No
  new text, nothing to veto.
- A `select *` MV's backing **column list** shifts without any AST change, so the scan does
  not see it — see the tripwire below. That path fires no persist event at all, so there is
  nothing for a module to refuse.

### Error-message ordering

For a **store-backed** table with a dependent view, the new pre-flight now fires ahead of the
store's physical store-name guard, so the reported message changes from `cannot store the
identifier …` to `cannot store persisted schema text …`. Both name an unpaired surrogate,
both leave a clean no-op. Accept the change; assert on `/unpaired surrogate/i` (and the
absence of a spurious `UNIQUE`) rather than exact wording, matching the `rejects()` helper
already in `lone-surrogate-keys.spec.ts`.

### Cost

The scan clones and re-renders the body of every view and maintained table in the schema on
every `ALTER … RENAME`. DDL is rare and bodies are small, so this is fine today — see the
tripwire note below.

## TODO

### Phase 1 — the pre-flight

- Add a spine-clone helper for AST nodes (deep-copies plain objects/arrays, passes anything
  else through by reference). Put it where the rewriters can share it — alongside
  `rename-rewriter.ts` or in `src/util/`; document *why* it is a spine clone and not
  `structuredClone`.
- Add the dependent-scan driver next to the existing `assertCatalogObjectPersistable` in
  `packages/quereus/src/schema/catalog-persistability.ts`. Suggested shape: it takes the
  `Database`, the schema, and a rewrite callback `(ast: AST.QueryExpr) => boolean` that
  mutates the clone; it owns the cloning, the prospective-object construction, and the per-
  module veto.
- Call it from `runRenameTable` before `module.renameTable`, plus the maintained-table
  self-veto for the renamed MV's new key + DDL.
- Call it from `runRenameColumn` before `module.alterTable`, threading the same
  `resolveColumnInSource` resolver `propagateColumnRename` builds (hoist or share the builder
  so the two cannot drift).

### Phase 2 — tests

Add to `packages/quereus-store/test/lone-surrogate-keys.spec.ts`, in the existing
`a view or materialized view the store could not persist` block (its `beforeEach` already
creates the store table that makes the module subscribe):

- Renaming a memory-backed MV to a lone-surrogate name is refused; the MV survives under its
  original name and its catalog entry is still present (case A — assert the entry, not just
  the in-memory record; the bug was durable-only).
- Renaming a memory table that a persisted view reads is refused; the view's live body is
  unchanged (case B).
- Renaming a **column** of a memory table that a persisted view reads is refused; the
  column and the view body are both unchanged.
- Same two shapes with a dependent materialized view — one memory-backed, one store-backed
  (case F and case G; G additionally asserts the MV is not left stale).
- Regression pins: a store-backed table rename, a store-backed table column rename, and a
  store-backed MV rename to a lone surrogate all still reject and still leave the object
  intact.
- A well-formed astral rename (`'\u{10000}'`) still succeeds — the guard must not
  over-reject.
- A database with **no** store module registered still accepts every one of these renames
  (nothing is persisted, so nothing can be lost) — mirrors the existing
  `a database with no store module registered keeps accepting all of it` case.

Confirm `packages/quereus-store/test/view-mv-persistence.spec.ts`'s existing rename →
close → reopen round-trips stay green (they are the pin that the pre-flight does not reject
ordinary renames).

Run: `yarn workspace @quereus/store test`, then `yarn test`, `yarn lint`, `yarn typecheck`.

### Phase 3 — docs and the stale gap notes

- `docs/schema.md` § View and materialized-view persistence: the paragraph beginning "Those
  four call sites are the whole of the coverage" describes this bug as open. Rewrite it to
  describe the rename pre-flight, and state what remains uncovered (the `select *` backing
  column-list drift below, and the separately-tracked
  `bug-store-untouched-table-and-early-view-never-persisted`).
- `docs/store.md` surrogate-guard section: the sentence ending "that gap is
  `bug-store-rename-into-lone-surrogate-drops-dependent-view-or-mv`" must go, replaced with
  the covered behavior. Mention the message-ordering change for store-backed tables with
  dependents.
- `packages/quereus/src/vtab/module.ts`: the `assertCatalogObjectPersistable` docstring's
  final paragraph ("Coverage is the CREATE / SET TAGS paths only…") names this ticket —
  update it to list the rename call sites.
- **Tripwire, as a `NOTE:` comment on `restoreUnaffectedMaterializedViews` in
  `materialized-view-helpers.ts`:** that pass deliberately fires no
  `materialized_view_modified`, but `renameShiftedBackingColumns` does change the backing
  column names, which *are* part of the persisted DDL. So a `select *` materialized view's
  persisted column list goes stale after any column rename — clean or not. Harmless today
  because the reopen path re-derives an implicit MV's shape from its body and reshapes
  (verified: persisted `("id","x")` + body `select * from m` rehydrates as `("id","y")` with
  no error). If implicit MVs ever stop reshaping on import, this becomes real drift and needs
  an event.

## Out of scope

`bug-store-untouched-table-and-early-view-never-persisted` — a store module that has not yet
subscribed to a database never vetoes at all. Separately tracked.
