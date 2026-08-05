---
description: Renaming a column used to break any other column whose value is worked out from it — as a default or as a computed column — leaving the table unable to accept new rows; that now propagates correctly, and dropping such a column is refused instead of silently breaking things.
files:
  - packages/quereus/src/schema/rename-rewriter.ts               # new renameColumnInColumnExpressions (~621)
  - packages/quereus/src/runtime/emit/alter-table.ts             # rewriteTableForColumnRename columns arm (~2386); rewriteOtherTableColumnExpressions (~2412); runDropColumn guard order (~1155)
  - packages/quereus/src/runtime/emit/drop-column-guards.ts      # new assertNoColumnDefaultNamesColumn (~70)
  - packages/quereus/src/schema/catalog-persistability.ts        # cloneTableRewritableAsts columns clone (~163)
  - packages/quereus/src/schema/schema-differ.ts                 # NOTE: on the redundant SET DEFAULT (~2429)
  - packages/quereus/src/index.ts                                # public re-export
  - packages/quereus-store/src/common/store-module-alter.ts      # renameColumnChange in-hook arm (~433)
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic           # §29-36
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # §15-18
  - packages/quereus-store/test/rename-column-default-reopen.spec.ts             # new
  - packages/quereus/test/schema/differ-alter-column.spec.ts     # new describe block at tail
  - docs/sql-ddl.md                                              # § Default Values
  - docs/sql-alter.md                                            # RENAME COLUMN / DROP COLUMN
difficulty: medium
---

# What landed

`ALTER TABLE … RENAME COLUMN` propagated into CHECK constraints, foreign keys and
partial-index predicates, but **never looked at `table.columns`** — so the two expressions
that live on a `ColumnSchema` were invisible to it:

| field | written as | before | after |
| --- | --- | --- | --- |
| `defaultValue` | `b integer default (new.a + 1)` | rename broke it; drop unguarded | rewritten; drop refused |
| `generatedExpr` | `g integer generated always as (a + 1)` | rename broke it | rewritten (drop was already guarded) |

"Broke it" meant the table could accept no further rows: every insert failed at plan time
with `new.a isn't a column` / `Column not found: a`.

Five changes, all following the shape the CHECK arm already established:

1. **`renameColumnInColumnExpressions`** in `rename-rewriter.ts` — walks a column array and
   rewrites both fields in place through the **seeded** `renameColumnInCheckExpression`
   entry point. The seed does double duty: its implicit unaliased binding to the owning
   table resolves a generated column's *bare* `a`, and its ownership of the `new.` / `old.`
   row-image namespace resolves a default's `new.a`. Case folding and the shadowing edge
   come along for free because the same walk decides all three kinds.
2. **The `table.columns` arm** of `rewriteTableForColumnRename` — branches on
   `isRenamedTable` exactly as the checks/indexes loops do (seeded helper for the owning
   table, `rewriteOtherTableColumnExpressions` → unseeded `renameColumnInAst` otherwise),
   folding into the same `changed` flag.
3. **`cloneTableRewritableAsts`** now spine-clones `columns[].defaultValue` /
   `[].generatedExpr`, so the pre-flight persistability probe can no longer mutate the live
   catalog and leave a vetoed statement with half-renamed defaults.
4. **`assertNoColumnDefaultNamesColumn`** in `drop-column-guards.ts`, called **first** in
   `runDropColumn` (narrowest blast radius). Message:
   `Cannot drop column 'a' from 'T': it is referenced by the DEFAULT of column 'b'`.
5. **The store module's in-hook arm** — `renameColumnChange`'s `rewriteColumn(from, to)`
   closure now also rewrites `updatedColumns`, so the DDL bundle is never persisted naming
   the pre-rename column.

## Two decisions worth a reviewer's eye

**No per-column shallow copy in the rewrite arm.** The checks and indexes loops do
`{ ...cc }` for changed items; the columns arm does not. The rewrite is in place and a
`ColumnSchema`'s own fields are untouched, so a fresh column object would only make the
catalog's array stop being identical to the one the module's rename hook just built and
handed back. Flipping `changed` is what re-registers the table and fires `table_modified`,
which is all the sibling copies achieve either. If a reviewer disagrees, changing it is
one line — but check the memory module's `adoptSchemaOnOpenLayers` identity discipline first.

**The generated-column DROP guard was left where it is.** `runDropColumn` already refuses
off `generatedColumnDependencies` (a resolved column-index map). That is a second mechanism
for the same policy as the new expression-probe guard, but the existing one predates this
work and its map is load-bearing for evaluation ordering, so unifying them was out of scope.
Documented at the new guard's doc comment.

## The open question, settled

The ticket asked whether the differ emits a redundant `ALTER COLUMN … SET DEFAULT`
alongside a `RENAME COLUMN`. **It does, and it is harmless** — the ticket's guess that the
fix would make it disappear was wrong, because the diff compares declared-vs-actual
*before* the rename is applied and `computeColumnAttributeChange` has no inverse-reconcile
for defaults. Measured output for a rename-hint diff:

```
ALTER TABLE dcol RENAME COLUMN a TO z
ALTER TABLE dcol ALTER COLUMN b SET DEFAULT new.z + 1
```

The rename lands first, so the second statement re-sets the column to exactly what the
propagation already produced. What the fix *does* buy is **convergence**: the follow-up
diff is empty, where before the live default would have kept reading `new.a` and churned.
Recorded as a `NOTE:` at `schema-differ.ts` `computeColumnAttributeChange`; no follow-up
ticket filed, per the ticket's instruction.

# How to exercise it

## Rename — the core arms

```sql
create table D (id integer primary key, a integer, b integer default (new.a + 1));
insert into D (id, a) values (1, 5);          -- b = 6
alter table D rename column a to z;
insert into D (id, z) values (2, 7);          -- b = 8   (was: "new.a isn't a column")

create table G (id integer primary key, a integer, g integer generated always as (a + 1));
alter table G rename column a to z;
insert into G (id, z) values (2, 7);          -- g = 8   (was: "Column not found: a")
```

Also covered: `NEW.A` case folding; a default installed by `alter column … set default`;
a default and a generated expr on the same table following one rename.

## Rename — the scope edges (each must NOT over- or under-rewrite)

- A default's subquery reading a like-named column on **another** table
  (`w integer default ((select min(v) from u))`, renaming *this* table's `v`) — must **not**
  rewrite. Inner `v` binds to `u`.
- A default on **another** table reaching the renamed column through a subquery
  (`c integer default ((select max(a) from T))`) — **must** rewrite, or that table becomes
  uninsertable.
- `create table "new" (…)` + `default ((select max("new".a) from "new"))` — must **not**
  rewrite; `new` is not a reserved word here.

## Drop

```sql
create table D2 (id integer primary key, a integer, b integer default (new.a + 1));
alter table D2 drop column a;
-- ERR: Cannot drop column 'a' from 'D2': it is referenced by the DEFAULT of column 'b'
```

Must still be **allowed**: dropping the column that owns a default naming only *itself*;
dropping over a default whose only same-named match is inside a subquery on another table;
dropping over the `"new"`-named-table shadowing shape.

## Store leg

`packages/quereus-store/test/rename-column-default-reopen.spec.ts` — in-memory
`KVStoreProvider`, `whenCatalogPersisted` → `close` → fresh `Database` + `rehydrateCatalog`.
The default must still compute after the reopen.

# Validation run

All four commands, all green, zero failures:

- `yarn test` — 8696 passing / 13 pending (quereus) + every other package green
- `yarn test:store` — 8688 passing / 21 pending
- `yarn typecheck` — clean
- `yarn lint` — clean

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.

**Sabotage-verified, not just green.** Each new test group was confirmed load-bearing by
temporarily breaking the thing it pins and watching the suite fail:

- 41.3 §29 expected value corrupted → `41.3-alter-rename-propagation.sqllogic:1006 row 0 mismatch`
- 41.10.2 §15 expected error text corrupted → `41.10.2:482` assertion failure
- store arm disabled in `store-module-alter.ts` → the reopen spec's
  "no bundle ever names the old column" assertion fails

# Known gaps — please probe these

**The memory module confirmed to need no arm, but only indirectly.** The ticket asked to
verify rather than assume. `MemoryTableManager.renameColumn` was read (nothing in
`handleColumnRename`'s rebuild compiles a default or generated expression — both are
compiled by the engine at INSERT plan time) and the memory-backed sqllogic arms all pass.
That is *evidence*, not a direct probe: no test isolates the memory hook the way the store
spec's put-recorder isolates the store hook. If a reviewer wants certainty here, the shape
to copy is the store spec's tap.

**The store spec's reopen half does not discriminate the in-hook arm.** This surprised me
and is worth restating: with the store arm disabled, the reopen still succeeds, because the
engine's post-hook `table_modified` makes the store re-persist a corrected bundle before the
statement returns. The in-hook rewrite buys only the **crash window** between the two puts —
which is exactly what the neighbouring CHECK/index arms exist for. The spec therefore taps
the catalog store's `put` and asserts no bundle *ever* names the old column; that assertion
is the one that fails without the arm. Reviewers who assume the reopen assertion covers the
arm will draw the wrong conclusion.

**Generated columns still vanish across a store reopen.** Unchanged by this work and
separately filed as `bug-store-reopen-loses-computed-columns` — `formatColumnDef` never
emits the `generated always as` clause. The store arm covers `generatedExpr` anyway, which
is correct-but-inert until that lands. This is why the store spec asserts on the default arm
only.

**Table-qualified generated expressions were deliberately avoided in tests.** `generated
always as (T.a + 1)` fails on insert with or without a rename — `bug-generated-column-own-
table-qualified-reference-unusable`. Any reviewer adding a case there will hit that, not
this ticket's bug.

**Cross-schema scope, unchanged.** The rename propagation still only walks the renamed
object's own schema, carrying the same documented gap as the CHECK arm
(`bug-rename-not-propagated-across-schemas`). Not widened here.

**Unmeasured:** the drop guard adds one spine-clone + one scope walk per column carrying a
default, on DDL only. Not benchmarked — the same shape and scale as the CHECK guard next to
it, which carries its own `NOTE:` about when that would matter.

**Drive-by:** `buildConstraintsFromColumn`'s inline `import('...').ColumnSchema` type was
replaced with a top-level `import type`, since I needed that import anyway and AGENTS.md
forbids inline `import()` outside dynamic loads.
