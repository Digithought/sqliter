---
description: Renaming a table or column to a name containing a broken half-character used to quietly damage saved views and materialized views; the rename is now refused up front and nothing is changed. Reviewed and complete.
files:
  - packages/quereus/src/util/ast-spine-clone.ts                    # NEW — the clone helper
  - packages/quereus/src/schema/catalog-persistability.ts           # NEW — assertRenameDependentsPersistable
  - packages/quereus/src/runtime/emit/alter-table.ts                # both call sites + resolver hoist
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # tripwire NOTE only
  - packages/quereus/src/vtab/module.ts                             # hook docstring
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts         # 13 rename tests
  - packages/quereus-store/test/view-mv-persistence.spec.ts         # 2 reopen-after-refusal tests added in review
  - docs/schema.md                                                  # § View and materialized-view persistence
  - docs/store.md                                                   # surrogate-guard section
---

## The bug

A **lone surrogate** is a broken half of a Unicode character (`'\uD800'` in JavaScript).
A JS string can hold one; no UTF-8 byte sequence encodes it, so the persistent store
refuses to write text containing one.

Renaming a table or column to such a name used to **succeed** and then damage every saved
view / materialized view that depended on it. The rename propagation cannot fail by
construction: it rides `SchemaChangeNotifier` (which try/catches each listener and only
logs) and then the store's async persist queue (which `.catch`-logs). Four observed
shapes, all reporting success:

| Statement | Symptom |
| --------- | ------- |
| rename a memory-backed MV to a lone surrogate | MV catalog entry **deleted**; MV answered queries all session, absent after reopen. Only sign: a `console.warn`. |
| rename a memory table under a persisted view | live view body rewritten, persisted entry keeps the OLD text — silent divergence |
| rename a memory table under a persisted MV | same divergence on the MV entry |
| …with a **store-backed** dependent MV | propagation threw mid-way, `failMaterializedViewRenamePropagation` swallowed it, MV left **permanently stale** naming a column that no longer existed. No warning at all. |

## What shipped

A **pre-flight dependent scan** before the first side effect of either rename arm.
`assertRenameDependentsPersistable(db, schema, rewrite)` in
`schema/catalog-persistability.ts` walks every view and every maintained table in the
renamed object's own schema, applies `rewrite` to a **clone** of the body, and — when the
clone changed — offers the resulting prospective object to the existing module hook
`VirtualTableModule.assertCatalogObjectPersistable`. The first refusal throws out of the
statement, leaving catalog and physical storage untouched.

- **`util/ast-spine-clone.ts`.** `spineCloneAst` deep-copies plain objects and arrays and
  passes everything else through by reference. Needed because the rename rewriters mutate
  in place — a veto thrown after mutating the live AST would strand a view body naming a
  table that was never renamed. `structuredClone` is unusable: `LiteralExpr.value` is
  `MaybePromise<SqlValue>` and a Promise is not structured-cloneable.
- **`runRenameTable`** — after the name-conflict check, before `module.renameTable`. Also
  vets `{ ...tableSchema, name: newName }` as `'materializedView'` when the renamed table
  is itself maintained, which checks the new catalog **key** as well as the new DDL text,
  long before the `materialized_view_removed` that used to delete the old entry.
- **`runRenameColumn`** — after the column existence / collision checks, before
  `module.alterTable`.
- **Resolver hoist.** `buildColumnSourceResolver(db)` builds one `ResolveColumnInSource`
  per statement, shared by the probe and `propagateColumnRename`.
- **Early-out.** The scan returns immediately when no registered module implements the
  hook, so a memory-only database pays nothing.

## Review findings

**Diff read first, from the commit, before the handoff summary.** Validation re-run from a
clean tree: `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` — all green, all 13
workspaces, no test skipped or loosened, no pre-existing failures surfaced.

### Verified correct (no action)

- **Single-schema scoping of the scan is consistent, not a hole.** Read
  `propagateTableRenameInSchema` and `propagateColumnRenameInSchema`: both gate their
  view and MV loops on `schema.name.toLowerCase() === renamedSchemaLower`. A cross-schema
  dependent is never rewritten, so it has nothing new to persist and nothing for the scan
  to veto. (That such a dependent is left naming a vanished table is pre-existing and out
  of scope here.)
- **Probe / propagation agreement under the shared resolver.** The resolver reads the
  **live** catalog on every call, and the probe runs pre-mutation while the propagation
  runs post-, so sharing one instance does not by itself make them agree. Read
  `isTableInUnaliasedScope`: it explicitly `continue`s past the renamed table itself and
  only asks about *other* sources, whose column sets a column rename does not touch. The
  conclusion holds; the reasoning in the handoff was attached to the wrong fact. Comments
  corrected (below).
- **Renamed-MV self-veto approximation is sound.** The probe checks new name + old body;
  the scan's maintained-table loop separately checks old name + new body. For an
  "is any character unencodable anywhere in the text" check, either half alone fires.
- **Clone containment.** Every mutation in the scan lands on a `spineCloneAst` copy, so a
  mid-loop throw leaves nothing to unwind. Confirmed behaviourally by the existing test
  that queries a dependent view after a refused rename.
- **MV self-column rename is not a reachable shape.** `alter table` refuses every action
  but `renameTable` / `setMaintained` / `dropMaintained` on a maintained table, so an MV's
  own declared column list cannot be renamed into an unwritable name.

### Major — filed as a new ticket

- **Dependent TABLE catalog entries still diverge silently.** The implementer flagged this
  as untested; it reproduces. With a store table present (so the module is subscribed), an
  in-memory `m`, and a store-backed `s2` holding `references m(id)`,
  `alter table m rename to "<lone surrogate>"` **succeeds**: `s2`'s live foreign key takes
  the new name, its persisted DDL keeps `references m(id)`, and the only trace is
  `[StoreModule] Failed to persist catalog DDL after schema change: … unpaired surrogate
  (U+D800 at offset 137)`. `assertCatalogObjectPersistable` cannot cover it —
  `CatalogObjectKind` is `'view' | 'materializedView'`, with no `'table'` case. Consequence
  is bounded (the renamed table must be in-memory, so the durable state is no worse than a
  no-rename baseline), but the contract is the same one this ticket declared unacceptable
  for views: success reported, store failure logged, live and durable definitions
  disagreeing for the session. Filed as
  `backlog/bug-store-rename-diverges-dependent-table-catalog-entry` with the reproduction.
  `docs/schema.md`, `docs/store.md` and the hook docstring now list it as uncovered — they
  previously said "two things stay uncovered", which was one short.

### Tripwire validated, left as recorded (no ticket)

- The `select *` MV backing-column-list drift on `restoreUnaffectedMaterializedViews` is
  correctly a tripwire, and its load-bearing claim now has evidence. Probed directly: a
  clean `alter table st rename column v to w` under `create materialized view mvm as
  select * from st` leaves the persisted DDL saying `("id","v")` while the live MV says
  `["id","w"]` — and reopen rehydrates the MV as `["id","w"]` with rows intact and zero
  rehydration errors, exactly as the `NOTE:` claims. The surrogate variant of the same
  shape writes nothing at all, so it introduces no new durable corruption. Both `NOTE:`
  tripwires (that one and the re-render cost on `assertRenameDependentsPersistable`) stay
  where the implementer put them.

### Minor — fixed in this pass

- Two comments in `runtime/emit/alter-table.ts` credited the resolver *hoist* with making
  the probe and the propagation compute the same rewrite. It does not — the resolver
  resolves lazily against the live catalog. Both now say what the hoist actually buys (the
  two passes cannot drift apart in code) and point at the real runtime guarantee. Left as
  written by a future reader, the old wording invites deleting the safety reasoning.

### Test coverage added

The handoff named one gap explicitly: "an actual close → reopen after a *refused* rename"
was never exercised. Two tests added to `packages/quereus-store/test/view-mv-persistence.spec.ts`,
which already owns the close → reopen harness:

- a refused materialized-view rename → close → reopen: the MV rehydrates under its own
  name with zero rehydration errors and its rows intact. This is the real pin — pre-fix
  this MV's catalog entry was deleted outright.
- a refused column rename under a persisted view → close → reopen: the view rehydrates
  still naming the old column and queries end-to-end. A regression pin (this shape was
  already refused by the store's own guard), and its comment says so.

Both pass; whole spec 23 passing.

### Checked, nothing found

- **Source hygiene.** Both new files are small and single-purpose; every function is short
  and named for what it does. Comment density is high but each block carries a
  non-obvious *why* (clone rationale, call ordering, scope choice) rather than restating
  code.
- **Error handling / cleanup.** The scan allocates only clones and throws before any
  mutation; there is nothing to release on the failure path.
- **Type safety.** No `any`; `isMaintainedTable` narrows before `table.derivation` is read;
  `spineCloneAst`'s generic preserves the node type through the clone.
- **Over-rejection.** Covered by the existing astral (`'\u{10000}'`) rename tests and the
  no-store-module test, plus the `view-mv-persistence` rename round-trips that pin ordinary
  renames as still accepted.
- **DRY.** The scan reuses the existing `assertCatalogObjectPersistable` hook and the
  existing rewriters rather than duplicating either.

### Deliberately not pursued

- The error-message ordering change for a store-backed table with a dependent view
  (`cannot store the identifier …` → `cannot store persisted schema text …`) is intended,
  documented in both docs files, and both messages name the unpaired surrogate and leave a
  clean no-op. The tests assert on `/unpaired surrogate/i`, which is the right level.
- The `anyModuleCanVeto` early-out is semantically identical to the loop it skips (the
  per-module hook is optional and no-ops when absent), so it is a pure performance
  short-circuit, not a behavior-on-hook-presence dependency.
- Cross-schema dependents (handoff gap 1) and MVs reading the renamed table only through a
  plain view (gap 3): both verified consistent with the propagation's own behavior above;
  neither is a defect this ticket introduced or should carry.

## Out of scope

`bug-store-untouched-table-and-early-view-never-persisted` — a store module that has not
yet subscribed to a database never vetoes at all. Separately tracked; untouched here.
