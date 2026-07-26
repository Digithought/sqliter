---
description: Renaming a table or column to a name containing a broken half-character used to quietly damage saved views and materialized views; now the rename is refused up front and nothing is changed. Needs a review pass.
files:
  - packages/quereus/src/util/ast-spine-clone.ts                    # NEW — the clone helper
  - packages/quereus/src/schema/catalog-persistability.ts           # NEW — assertRenameDependentsPersistable
  - packages/quereus/src/runtime/emit/alter-table.ts                # both call sites + resolver hoist
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # tripwire NOTE only
  - packages/quereus/src/vtab/module.ts                             # hook docstring
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts         # 13 new tests
  - docs/schema.md                                                  # § View and materialized-view persistence
  - docs/store.md                                                   # surrogate-guard section
difficulty: medium
---

## What the bug was

A **lone surrogate** is a broken half of a Unicode character (`'\uD800'`). JavaScript
strings can hold one; no UTF-8 byte sequence encodes it, so the persistent store refuses to
write text containing one.

Renaming a table or column to such a name used to **succeed** and then damage every saved
view / materialized view that depended on it, because the rename propagation is unfailable
by construction: it rides `SchemaChangeNotifier` (which try/catches each listener and only
logs) and then the store's async persist queue (which `.catch`-logs). Four observed shapes,
all reproduced at `30d5e107`, all reporting success:

| Statement | Symptom |
| --------- | ------- |
| rename a memory-backed MV to a lone surrogate | MV catalog entry **deleted**; MV answered queries all session, absent after reopen. Only sign: a `console.warn`. |
| rename a memory table under a persisted view | live view body rewritten, persisted entry keeps the OLD text — silent divergence |
| rename a memory table under a persisted MV | same divergence on the MV entry |
| …with a **store-backed** dependent MV | worse: propagation threw mid-way, `failMaterializedViewRenamePropagation` swallowed it, MV left **permanently stale** naming a column that no longer existed. No warning at all. |

## What landed

A **pre-flight dependent scan** running before the first side effect of either rename arm.

`assertRenameDependentsPersistable(db, schema, rewrite)` in
`schema/catalog-persistability.ts` walks every view and every maintained table in the
renamed object's own schema, applies `rewrite` to a **clone** of the body, and — when the
clone changed — offers the resulting prospective object to the existing module hook
`VirtualTableModule.assertCatalogObjectPersistable`. The first refusal throws out of the
statement, leaving catalog and physical storage untouched.

Supporting pieces:

- **`util/ast-spine-clone.ts` (new).** `spineCloneAst` deep-copies plain objects and arrays
  and passes everything else through **by reference**. Needed because the rename rewriters
  mutate in place — a veto thrown after mutating the live AST would strand a view body
  naming a table that was never renamed. `structuredClone` is unusable here:
  `LiteralExpr.value` is typed `MaybePromise<SqlValue>` and a Promise is not
  structured-cloneable.
- **`runRenameTable`** — after the name-conflict check, before `module.renameTable`. Also
  vets the prospective record `{ ...tableSchema, name: newName }` as `'materializedView'`
  when the renamed table is itself maintained; that checks the new catalog **key** as well
  as the new DDL text, and runs long before the `materialized_view_removed` that used to
  delete the old entry.
- **`runRenameColumn`** — after the column existence / collision checks, before
  `module.alterTable`.
- **Resolver hoist.** `buildColumnSourceResolver(db)` now builds the
  `ResolveColumnInSource` once per statement; the pre-flight probe and
  `propagateColumnRename` share the same instance, so the rewrite the probe computes is the
  rewrite that later lands. (`propagateColumnRename` gained it as a parameter instead of
  building its own.)
- **Early-out (beyond the ticket).** The scan returns immediately when no registered module
  implements the hook, so a memory-only database pays nothing. Worth a look: it is the one
  place where behavior depends on hook *presence* rather than on what a module answers.

## Testing and validation

**Run:** `yarn build`, `yarn test` (all 13 workspaces green — quereus 7329, store 1074,
sync 481, …), `yarn lint`, `yarn typecheck`. All clean. No test was skipped or loosened; no
pre-existing failures surfaced.

**13 new tests** in `packages/quereus-store/test/lone-surrogate-keys.spec.ts`, in a new
`describe('a RENAME that would make a persisted view or materialized view unwritable')`.
Its `beforeEach` creates a **store** table (so the module is subscribed and the veto is
live) plus a **memory** table `m` to rename — using a memory table matters, because the
store's own physical-store-name guard would otherwise fire first and hide whether the
pre-flight works at all.

- memory-backed MV renamed to a lone surrogate → refused; MV survives under its own name,
  still queryable, and its **catalog entry** is still present (asserted through
  `buildMaterializedViewCatalogKey` after `whenCatalogPersisted()` — the bug was
  durable-only)
- memory table rename under a persisted view → refused; `select … from vm` still returns
  its row, which is the real pin that the pre-flight did not leak its rewrite onto the live
  AST
- memory table **column** rename under a persisted view → refused; column and view intact
- both rename shapes × dependent MV {memory-backed, store-backed} → refused, MV still
  queryable, and `derivation.stale` is **false** (the store-backed cases are the ones the
  old code left permanently stale)
- regression pins: store-backed table rename, store-backed table column rename,
  store-backed MV rename, and a store-backed table rename *with a dependent view* all still
  reject and leave the object intact
- a well-formed astral rename (`'\u{10000}'`) of both a table and a column still succeeds
  with a view **and** an MV depending on it — the guard must not over-reject
- a database with no store module registered still accepts every one of these renames

**Verified the tests actually pin the fix**: with the pre-flight stubbed out and the
libraries rebuilt, **7 of the 13 fail** — exactly the seven bug cases. The other six are the
regression pins / astral / no-module cases, which do not depend on the new code.

`packages/quereus-store/test/view-mv-persistence.spec.ts`'s rename → close → reopen
round-trips stay green (they are the pin that ordinary renames are not rejected).

**Not exercised by an automated test:** an actual close → reopen after a *refused* rename.
The tests assert the durable catalog entry directly instead, which is the same fact one
level lower.

## Known gaps — please probe these

1. **Cross-schema dependents are not scanned.** The scan is scoped to the renamed object's
   own schema, matching `propagateTableRenameInSchema`, whose view/MV loops carry the same
   gate. So a view in schema B over `A.t` is never rewritten and has nothing new to
   persist. That is consistent, but it means a cross-schema dependent is *already* left
   naming a vanished table by the pre-existing propagation — a separate, pre-existing
   question this ticket did not touch.

2. **Dependent TABLE catalog entries are still fire-and-forget, and I did not verify how
   reachable that is.** `rewriteTableForTableRename` rewrites the new name into other
   tables' CHECK expressions, FK `referencedTable` fields, and partial-index predicates,
   and those re-persists ride the same swallowing path. `assertCatalogObjectPersistable`
   is a view/MV hook only (`CatalogObjectKind` is `'view' | 'materializedView'`), so
   nothing vets them. My reasoning says the reachable-and-consequential version needs a
   memory-backed renamed table with a store-backed dependent — and a memory table does not
   survive reopen anyway, so the divergence looks low-consequence. **I did not test this.**
   If the reviewer finds a shape where it bites, it is a real ticket, not a tripwire.

3. **MV reading the renamed table only through a plain view** — deliberately uncovered.
   Its own body AST is unchanged, so `persistObjectCatalogEntryIfChanged` skips the write;
   there is no new text to veto.

4. **`select *` MV backing column list** — parked as a tripwire, not fixed. See below.

5. **Self-veto approximation.** The renamed-MV probe does not apply the self-reference
   rewrite `rewriteTableForTableRename` performs. That rewrite only substitutes `newName`,
   which is already under test as the record's own `name`, so the check is not weakened —
   but it is an approximation worth a second opinion.

6. **Error-message ordering changed, deliberately.** For a store-backed table *with a
   dependent view*, the pre-flight now fires ahead of the store's physical store-name
   guard, so the message shifts from `cannot store the identifier …` to `cannot store
   persisted schema text …`. Both name an unpaired surrogate and both leave a clean no-op.
   The tests assert on `/unpaired surrogate/i` and the absence of a spurious `UNIQUE`,
   matching the existing `rejects()` helper, rather than on exact wording.

## Tripwires recorded

- **`NOTE:` on `restoreUnaffectedMaterializedViews`** in
  `runtime/emit/materialized-view-helpers.ts`: that pass fires no
  `materialized_view_modified`, but `renameShiftedBackingColumns` does change the backing
  column names, which *are* part of the persisted DDL. So a `select *` materialized view's
  persisted column list goes stale after any source column rename — clean or not — and the
  new pre-flight cannot see it either (the body AST never changes). Harmless today because
  reopen re-derives an implicit MV's shape from its body and reshapes. If implicit MVs ever
  stop reshaping on import, this becomes real durable drift and the pass needs an event.
- **`NOTE:` on `assertRenameDependentsPersistable`** in `schema/catalog-persistability.ts`:
  the scan clones and re-renders every view / maintained-table body in the schema on every
  `ALTER … RENAME`, and the propagation renders each changed one again. DDL is rare and
  bodies are small; if a schema-heavy workload ever shows up hot, thread the prospective
  object through to the propagation instead of rebuilding it.

## Docs updated

- `docs/schema.md` § View and materialized-view persistence — the paragraph that described
  this as an open gap now describes the rename pre-flight, the clone rationale, the
  message-ordering change, and what remains uncovered.
- `docs/store.md` surrogate-guard section — same, from the store's side.
- `packages/quereus/src/vtab/module.ts` — the hook docstring now lists all call sites
  including the two rename arms, and names the one thing that still never asks.

## Out of scope

`bug-store-untouched-table-and-early-view-never-persisted` — a store module that has not yet
subscribed to a database never vetoes at all. Separately tracked; untouched here.
