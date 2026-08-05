---
description: When a column's value is worked out from another column — either as its default or as a computed column — renaming that other column silently breaks it, and the table can no longer accept new rows.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts            # rewriteTableForColumnRename (~2318) — the missing columns loop; runDropColumn (~1105) — where the new guard is called
  - packages/quereus/src/runtime/emit/drop-column-guards.ts     # the three existing DROP COLUMN guards; the new default guard joins them
  - packages/quereus/src/schema/catalog-persistability.ts       # cloneTableRewritableAsts (~156) — must clone the new in-place-rewritten ASTs too
  - packages/quereus/src/schema/rename-rewriter.ts              # renameColumnInCheckExpression / columnReferencedInCheckExpression — the walk to reuse; where a new collection helper belongs
  - packages/quereus/src/schema/column.ts                       # ColumnSchema.defaultValue (line 30), .generatedExpr (line 52)
  - packages/quereus/src/index.ts                               # public re-export list for the new collection helper (store package consumes it)
  - packages/quereus-store/src/common/store-module-alter.ts     # renameColumnChange (~397-433) — the in-hook rewrite the store needs for parity
  - packages/quereus/src/vtab/memory/layer/manager.ts           # renameColumn (~2240-2344) — investigated; believed to need NO arm, confirm
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic          # rename arm tests
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # drop-guard arm tests
  - packages/quereus-store/test/add-column-inline-constraint-reopen.spec.ts     # the in-memory KV provider harness to copy for the store reopen test
  - docs/sql-ddl.md                                             # documents `default (new.<column>)` as the supported spelling
  - docs/sql-alter.md                                           # RENAME COLUMN / DROP COLUMN behaviour
repro: verified
difficulty: medium
---

# `ALTER TABLE … RENAME COLUMN` never looks at column expressions

## Root cause — one site, two arms

`rewriteTableForColumnRename` (`alter-table.ts` ~2318) is the pass that propagates a
column rename into every dependent catalog record. It loops over three collections:
`checkConstraints`, `foreignKeys`, and `indexes`. **It never loops over `table.columns`.**

Two expressions live on a `ColumnSchema` and are therefore invisible to it:

| field | written as | rename | drop |
| --- | --- | --- | --- |
| `defaultValue` (`column.ts:30`) | `default (new.<col> + 1)` | **broken** | **unguarded** |
| `generatedExpr` (`column.ts:52`) | `generated always as (<col> + 1)` | **broken** | guarded (see below) |

The DROP COLUMN half already refuses a generated column that names the dropped column,
but by a different mechanism: `extractGeneratedColumnDependencies` (`table.ts` ~1318)
resolves generated dependencies to column *indices*, and `runDropColumn` (~1128) refuses
off that map. There is no equivalent for a default, so a drop that orphans one succeeds.

Everything else follows from those two facts. The `ALTER TABLE … ALTER COLUMN … SET
DEFAULT` spelling is **not** a separate gap — it writes the same `defaultValue` field, so
it breaks and is fixed at the same site.

## Verified behaviour (in-process, memory module, at `4af957d8`)

```
create table D (id integer primary key, a integer, b integer default (new.a + 1))
insert into D (id, a) values (1, 5)          -> OK, b = 6
alter table D rename column a to z           -> OK          <- default not rewritten
insert into D (id, z) values (2, 7)          -> ERR: new.a isn't a column

create table D2 (id integer primary key, a integer, b integer default (new.a + 1))
alter table D2 drop column a                 -> OK          <- should be refused
insert into D2 (id) values (3)               -> ERR: new.a isn't a column

create table D3 (id integer primary key, a integer, b integer)
alter table D3 alter column b set default (new.a + 1)
alter table D3 rename column a to z          -> OK
insert into D3 (id, z) values (2, 7)         -> ERR: new.a isn't a column

create table D4 (id integer primary key, a integer, b integer default (NEW.A + 1))
alter table D4 rename column a to z          -> OK
insert into D4 (id, z) values (1, 7)         -> ERR: NEW.A isn't a column   (case folding)

create table G (id integer primary key, a integer, g integer generated always as (a + 1))
insert into G (id, a) values (1, 5)          -> OK, g = 6
alter table G rename column a to z           -> OK          <- generated expr not rewritten
insert into G (id, z) values (2, 7)          -> ERR: Column not found: a

create table G3 (id integer primary key, a integer, g integer generated always as (a + 1))
alter table G3 drop column a
   -> ERR: Cannot drop column 'a' from 'G3': it is referenced by generated column 'g'
                                             <- drop half already correct for generated
```

Do **not** use a table-qualified generated expression (`generated always as (G2.a + 1)`)
as a test case: that spelling fails on insert with or without a rename, tracked
separately by `bug-generated-column-own-table-qualified-reference-unusable`.

## Which walk to use

Exactly the branch split the CHECK and index-predicate arms of the same function already
use — do not invent a second rule:

- **The renamed table's own columns** → `renameColumnInCheckExpression`. It seeds the
  scope stack with an implicit unaliased binding to the owning table, which is what makes
  a generated column's *bare* `a` resolve, and it owns the `new.` / `old.` row-image
  namespace, which is what makes a default's `new.a` resolve. Case folding and the
  shadowing edge (a real table literally named `new`, reached from a subquery inside the
  expression) come along for free and must behave exactly as the CHECK arm does.
- **Any other table's columns** → `renameColumnInAst` (no seed). A default can reach
  another table only through a subquery, so an unqualified ref there must bind inside the
  subquery's own FROM.

Both are already imported at the site. The natural shape is a `rewriteEach`-backed
collection helper next to `renameColumnInCheckConstraints` in `rename-rewriter.ts` —
call it something like `renameColumnInColumnExpressions(columns, …)` — picking both
`defaultValue` and `generatedExpr` off each column. The store package needs it, so it
also needs a line in `packages/quereus/src/index.ts` alongside the existing
`renameColumnInCheckConstraints` export.

The rewrite is **in place**, like the CHECK and predicate rewrites, and for the same
reason: a module's rename hook rebuilds only the renamed column's `ColumnSchema` (from
`newColumnDefAst`) and keeps every other `ColumnSchema` by reference, so one in-place
mutation reaches every holder. `buildConstraintsFromColumn` (`alter-table.ts` ~2399)
passes `col.defaultValue` / `col.generatedExpr` into the new `ColumnDef` **by reference**
and `columnDefToSchema` (`table.ts` 414 / 428) assigns the same reference back, so even
the renamed column's own expressions stay one shared node across old and new schema.

## The three consequences that are easy to miss

**1. The pre-flight veto probe must clone the new ASTs.**
`runRenameColumn` calls `assertRenameDependentsPersistable` (`catalog-persistability.ts`)
*before* the first side effect, handing it `rewriteTableForColumnRename` to run against a
probe copy built by `cloneTableRewritableAsts` (~156). That helper spine-clones
`checkConstraints[].expr` and `indexes[].predicate` only. Add `columns[].defaultValue` and
`columns[].generatedExpr` to it, or the pre-flight probe mutates the **live** catalog ASTs
and a veto thrown afterwards leaves a table whose defaults name a column that was never
renamed.

**2. The store module needs its own in-hook arm.**
`storeModuleAlter.renameColumnChange` (~397-433) already rewrites index predicates and
CHECK expressions in place before `saveTableDDL`, because the engine's propagation pass
runs only after the hook returns and a crash in between would durably persist a bundle
naming a column the table no longer has. A column DEFAULT is rendered into that same
bundle by `formatColumnDef` (`ddl-generator.ts` ~528), so it needs the same treatment —
add the new helper to the existing `rewriteColumn(from, to)` closure so the failure path
reverses it along with the others. (A generated expression is *not* rendered into the
bundle at all today — see the "Known confounder" note below — so the store arm is about
the default; adding generated exprs to the same helper call is still correct and becomes
load-bearing once that other bug lands.)

**3. The memory module is believed to need no arm — confirm, don't assume.**
`MemoryTableManager.renameColumn` (~2240) rewrites index predicates in its own hook
because `handleColumnRename` recompiles them against the new column list. Nothing in that
rebuild compiles a default or a generated expression — both are compiled by the *engine*
at INSERT plan time — so the engine's post-hook pass should be sufficient. Verify with the
memory-backed sqllogic tests before concluding.

## Known confounder for the store-leg test

The store DDL round-trip silently drops `generated always as` entirely — a computed column
comes back after a reopen as a plain nullable column holding `null`, with or without any
rename. That is a different site (`ddl-generator.ts` `formatColumnDef` never emits the
clause) and is filed separately as `bug-store-reopen-loses-computed-columns`. So the
store reopen test in this ticket should assert on the **default** arm; a generated-column
reopen assertion will fail for that unrelated reason until the other ticket lands.

## Expected behaviour after the fix

- `alter table T rename column a to z` rewrites `a` → `z` inside every column DEFAULT and
  every generated-column expression on `T` (and inside any such expression on another
  table that reaches `T.a` through a subquery), so both keep evaluating.
- `alter table T drop column a` is refused with `StatusCode.CONSTRAINT` when a column
  DEFAULT on `T` names `a`, naming the column whose default is in the way. This matches
  the policy the existing expression-dependent guards chose: a DEFAULT is arbitrary
  user-authored logic with no narrowed form, so refuse rather than silently delete.
- Guard order: the new default guard is the most locally-explainable violation of the set
  (it names a column of the very table being altered), so it goes **first**, ahead of
  `assertNoCheckConstraintNamesColumn` — the existing three are ordered by widening blast
  radius (this table → another table → the whole database) and it belongs at the narrow
  end. Message shape follows the neighbours: `Cannot drop column '<col>' from '<table>':
  it is referenced by the DEFAULT of column '<other>'`.
- Case folding (`NEW.A`) and the `new`-named-table shadowing edge behave exactly as the
  CHECK arm does, because the same walk decides both.

## Open question to settle while implementing

`schema-differ.ts` compares `actual.defaultValue` against the declared default (~2432) and
emits `ALTER TABLE … ALTER COLUMN … SET DEFAULT` on a mismatch, but its
`reconciledDeclaredBody` inverse-reconcile (~1712) covers named constraints only — not
column defaults. Before the fix, a diff carrying a rename would see a spurious mismatch
(declared `new.z` vs actual `new.a`) and emit a redundant `SET DEFAULT`; after the fix the
two should agree and the statement should disappear. Confirm that with a differ test
rather than reasoning about it — if a redundant `SET DEFAULT` still appears, decide
whether it is harmless (it is applied after the rename in the same batch) and record the
answer as a `NOTE:` at the differ site rather than filing a follow-up.

# TODO

## Phase 1 — the rewrite

- Add a collection helper to `rename-rewriter.ts` beside `renameColumnInCheckConstraints`
  that walks a column array and rewrites both `defaultValue` and `generatedExpr` in place,
  taking the same `(tableName, oldCol, newCol, defaultSchemaName, resolveColumnInSource)`
  signature; document why it uses the seeded entry point (row-image `new.` for defaults,
  implicit owning-table binding for generated exprs).
- Export it from `packages/quereus/src/index.ts` alongside the existing rename helpers.
- Add the `table.columns` loop to `rewriteTableForColumnRename`, branching on
  `isRenamedTable` exactly as the checks and indexes loops do (seeded helper for the
  owning table, `renameColumnInAst` otherwise), and folding into the same `changed` flag
  so the pass re-registers the table and fires `table_modified` only when something moved.
- Extend `cloneTableRewritableAsts` in `catalog-persistability.ts` to spine-clone
  `columns[].defaultValue` and `columns[].generatedExpr`; update its doc comment, which
  currently enumerates exactly which ASTs are in-place-rewritable.

## Phase 2 — the drop guard

- Add `assertNoColumnDefaultNamesColumn` to `drop-column-guards.ts`, probing every
  `columns[].defaultValue` with `columnReferencedInCheckExpression` and the catalog-backed
  `buildColumnSourceResolver`, skipping the dropped column's own default (dropping a column
  takes its default with it). Extend the module-level doc comment — it enumerates the three
  guards and their policy rationale — rather than writing a fourth standalone rationale.
- Call it first in `runDropColumn`'s guard block (~1159) and update the block's comment,
  which states the ordering rule.

## Phase 3 — the store leg

- Add the new helper to `renameColumnChange`'s `rewriteColumn(from, to)` closure in
  `store-module-alter.ts` so the DEFAULT is rewritten before `saveTableDDL` and reversed on
  the failure path; extend the existing block comment there (it explains why the in-hook
  rewrite exists at all).

## Phase 4 — tests

- `packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` — rename arms:
  default reading `new.<col>`; `NEW.<COL>` case folding; a default set via
  `alter column … set default` then renamed; a generated column reading a bare sibling;
  a default whose subquery reads a like-named column on **another** table (must NOT be
  rewritten); a default on a table with a subquery reaching the renamed table's column
  (must be rewritten); the `create table "new"` shadowing edge, mirroring the CHECK arm's
  existing case. Assert both the successful post-rename insert and its computed value.
- `packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic` —
  drop arms: refusal when a sibling default names the column; dropping a column that owns
  a default naming *itself* only still succeeds; the `"new"`-named-table case still does
  not block.
- `packages/quereus-store/test/` — a reopen spec modelled on
  `add-column-inline-constraint-reopen.spec.ts` (in-memory `KVStoreProvider`,
  `whenCatalogPersisted` → `close` → fresh `Database` + `rehydrateCatalog`): a table with a
  `default (new.<col> + 1)`, renamed, must still insert correctly after the reopen.
- A `schema-differ` test for the open question above.
- Run `yarn test`, `yarn lint`, `yarn typecheck`, and `yarn test:store` (this ticket
  touches the store leg, so the store run is in scope, not optional).

## Phase 5 — docs

- `docs/sql-ddl.md` — the section documenting `default (new.<column>)` should say the
  spelling survives a rename and blocks a drop, mirroring the sentence the CHECK ticket
  added.
- `docs/sql-alter.md` — RENAME COLUMN's propagation list and DROP COLUMN's refusal list
  both need the column-expression entries.
