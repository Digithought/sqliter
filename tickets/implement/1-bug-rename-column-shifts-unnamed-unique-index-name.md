---
description: Renaming a column that a plain UNIQUE constraint covers breaks the link between the constraint and the hidden helper structure that enforces it — the helper starts showing up in schema listings as if the user had created it and can be deleted by anyone, and if the new name happens to match an existing index, that index is silently erased from the saved schema and the constraint quietly stops catching duplicates after the database is reopened.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts              # runRenameColumn ~327-434 — unguarded engine site
  - packages/quereus/src/vtab/memory/layer/manager.ts             # renameColumn ~2116-2215; renameConstraint ~2856-2915 is the pattern to copy; ensureUniqueConstraintIndexes ~246; implicitIndexNameFor ~312; implicitCoveringStructures ~180
  - packages/quereus/src/vtab/memory/layer/base.ts                # handleColumnRename ~439 — check whether it already re-keys secondaries
  - packages/quereus/src/schema/catalog.ts                        # implicitIndexName ~392, implicitIndexNameForColumns ~409, assertUniqueConstraintIndexNameFree ~456
  - packages/quereus-store/src/common/store-module-index.ts       # reconcileImplicitUniqueIndexStores ~386 — store side already handles the rename
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus-store/test/index-persistence.spec.ts         # persistent provider + open()/reopen()/catalogEntry()/indexStoreSize()
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts    # indexNames() helper reads db._findTable(t).indexes
  - docs/sql-ddl.md                                               # §6.3 ~735-746 — list of guarded UNIQUE-declaration paths
  - docs/sql-alter.md                                             # RENAME COLUMN / covering-structure notes ~47-51
difficulty: medium
repro: verified
---

## Background — how a plain UNIQUE's hidden structure is named

`unique (a)` with no name of its own is enforced by an automatically built secondary
index the user never asked for and never sees. Its name is `_uc_<column names>` —
`_uc_a` for a constraint over column `a`. That name is **recomputed from the table's
current column names every time it is needed** (`implicitIndexName` in
`packages/quereus/src/schema/catalog.ts`); it is never recorded at declaration time.

So renaming a column moves the name: after `rename column a to z`, the same
constraint is considered to be backed by `_uc_z`. Two separate things break.

## What was measured (current tree, both backends)

Every line below was run directly against the two modules this pass; nothing here
is inferred.

### Defect 1 — memory backend loses the constraint↔structure link on ANY rename

No name collision is needed. This is the bigger and more common half, and the
fix-stage ticket did not have it.

```sql
create table t (id integer primary key, a text, b text, unique (a));
insert into t values (1, 'x', 'p'), (2, 'y', 'q');
alter table t rename column a to z;
```

`MemoryTableManager.renameColumn` rewrites the column list and each index's column
*references*, but never renames the index **entry** itself, so the materialized
index stays `_uc_a` while the engine's exposure map
(`implicitCoveringIndexExposure`) now computes `_uc_z`. The structure is no longer
recognized as hidden:

| statement | expected | measured after the rename |
| --- | --- | --- |
| `select name from schema() where type = 'index'` | empty (nothing user-visible) | `_uc_a` |
| `select * from index_info('t')` | empty | one row, `index_name = _uc_a` |
| `drop index _uc_a` | `no such index` (it is a backing structure) | **succeeds**, deleting the structure |

After that DROP the constraint has no covering structure at all; enforcement still
rejects duplicates (`MemoryTableManager` falls back to a column-set scan of
`schema.indexes`, and the constraint list is what enforces), so nothing signals the
loss. `getImplicitCoveringStructure(uc)` also stops resolving — it computes
`_uc_z` against the `implicitCoveringStructures` map still keyed `_uc_a` — which
drops the by-name resolution at `manager.ts:1251-1276` onto its "defensive"
column-set fallback. That fallback returns the FIRST same-column-set index, which
the comment there says is exactly what mis-enforces collation when several
differently-collated indexes cover one column set.

Reproduced identically for a multi-column constraint (`unique (a, b)` → `_uc_a_b`
leaks and drops) and for the reuse shape (`create index ix_c on t4 (c)` then
`alter table t4 add unique (c)`, which materializes `_uc_c` alongside `ix_c`;
after `rename column c to d`, `schema()` lists both `ix_c` and `_uc_c`).

A **named** UNIQUE (`constraint u1 unique (a)`) is unaffected — measured as a
control: its structure takes the constraint's name, and the rename does not touch
it.

The store backend does NOT have this half: it derives the name fresh on every
schema read and `reconcileImplicitUniqueIndexStores` already relocates the physical
store (`main.t_idx__uc_a` → `main.t_idx__uc_z`, measured). `index_info('t')` stays
empty and enforcement survives close → reopen.

### Defect 2 — the collision case, on the store backend, is durable data-integrity loss

```sql
create table t (id integer primary key, a text, b text, unique (a)) using store;
create index _uc_z on t (b);
insert into t values (1, 'x', 'p'), (2, 'y', 'q');
alter table t rename column a to z;   -- accepted, no error, no warning
```

`runRenameColumn` never asks whether the post-rename structure name is free.
`buildCatalogEntry` skips any index reported as a hidden backing structure — which
is now the user's index — so the catalog entry rewritten during the rename loses
its `CREATE INDEX` line:

```
-- before
CREATE TABLE "main"."t" (... "a" TEXT NOT NULL, "b" TEXT NOT NULL, unique (a)) USING store
CREATE INDEX "_uc_z" ON "main"."t" ("b" COLLATE BINARY)
-- after
CREATE TABLE "main"."t" (... "z" TEXT NOT NULL, "b" TEXT NOT NULL, unique (z)) USING store
```

Then `reconcileImplicitUniqueIndexStores` tears down `main.t_idx__uc_a` and builds
the constraint's entries **into `main.t_idx__uc_z`, the store that already holds the
user index's entries keyed on column `b`**. On reopen, `rehydrateCatalog` reports
zero errors, `index_info('t')` is empty (index gone for good) — and:

```
insert into t values (3, 'x', 'r');   -- 'x' already present in z
→ ACCEPTED
```

The UNIQUE constraint silently stops catching duplicates. The fix-stage ticket
called this "plausible, not separately measured"; it is now measured. Same failure
class as `bug-unique-constraint-name-collides-with-index-name`, reached through a
fifth path that ticket did not cover.

On the memory backend the same collision inverts visibility instead: `schema()`
lists `_uc_a` (the constraint's structure) and not the user's `_uc_z`;
`drop index _uc_z` answers `no such index: _uc_z`, so the user's index becomes
permanently undroppable.

## Root cause

One site, two arms:

- The name is derived from live column names, and **`MemoryTableManager.renameColumn`
  does not re-derive its materialized index entry or its covering-structure map key**
  when those column names change (defect 1).
- **`runRenameColumn` performs no name-availability check** before dispatching to the
  module, so the post-rename derived name may already be taken (defect 2).

Recording the name at declaration time instead (the alternative the fix ticket
raised) was rejected on measurement: the store persists a table as DDL text
(`... unique (z)) USING store`), so a recorded name has nowhere to live short of
changing the constraint's serialized form, and reopen would recompute it from
columns anyway. Guarding the rename keeps the rule identical to the four
declaration paths already guarded by `assertUniqueConstraintIndexNameFree`, at the
cost that a legal column rename can be refused because of an unrelated index's name
— stated in the error message, and escapable by renaming that index first.

## Expected behavior

After `alter table t rename column a to z` on **both** backends:

- With no collision: the constraint's structure follows the column. `schema()` and
  `index_info('t')` list nothing for it, `drop index _uc_a` and `drop index _uc_z`
  both answer `no such index`, and the constraint keeps rejecting duplicates.
- With an index `_uc_z` already on the table: the rename is **refused** with a
  `CONSTRAINT`-class error naming both objects (same wording family as
  `assertUniqueConstraintIndexNameFree`'s existing message), the column keeps its old
  name, `_uc_z` is still the user's index — listed, droppable, still in the persisted
  catalog entry after close → reopen with its entries intact — and the constraint
  still enforces over the old column.
- A case-only rename (`a` → `A`) still succeeds: the constraint's own structure must
  not be mistaken for a collision (`runRenameConstraint` gates its check on
  `oldLower !== newLower` for exactly this reason).
- A named UNIQUE constraint is untouched by both arms.

## TODO

**Arm 1 — memory backend keeps the structure's name in sync**

- In `MemoryTableManager.renameColumn` (`manager.ts:2116`), after `updatedCols` /
  `updatedIndexes` are built and before `baseLayer.updateSchema`, rename the
  materialized entry of every non-derived **unnamed** UNIQUE constraint that covers
  the renamed column: old name = `_uc_<old column names>`, new name =
  `_uc_<new column names>`, matched case-insensitively like every other index-name
  comparison. Leave named constraints and `derivedFromIndex` ones alone. A constraint
  whose structure is a reused user index (no `_uc_*` entry present) has nothing to
  rename — skip silently.
- Re-key `implicitCoveringStructures` for each renamed entry (`renameConstraint` at
  `manager.ts:2883-2902` is the shape to copy: delete old key, set new key with
  `indexName` updated).
- Check `MemoryTableLayer.handleColumnRename` (`base.ts:439`): if it does not already
  rebuild/re-key the base layer's secondary-index map under the new index names, add
  the `rebuildAllSecondaryIndexes()` call `renameConstraint` makes after a rename.
  Do not add a redundant rebuild if the column-rename path already does one.
- Keep the `_uc_<cols>` spelling DRY — `manager.ts` already has `implicitIndexNameFor`;
  do not add a fourth spelling of the rule.

**Arm 2 — engine refuses a rename whose derived name is taken**

- In `runRenameColumn` (`alter-table.ts:327`), before the `module.alterTable`
  dispatch (alongside the existing `assertRenameDependentsPersistable` pre-flight, so
  a refused statement reaches no persistence side effect), iterate the table's
  non-derived unnamed UNIQUE constraints that include the renamed column and call
  `assertUniqueConstraintIndexNameFree(tableSchema, undefined, <post-rename column
  names>, \`rename column '<old>' to '<new>' on table '<t>'\`)`.
- Skip the whole check when `oldName.toLowerCase() === newName.toLowerCase()` (a
  case-only rename would otherwise match the constraint's own materialized structure
  on the memory backend).
- The check is name-only against `tableSchema.indexes`, so on the memory backend the
  constraint's own `_uc_<old>` entry cannot self-match the `_uc_<new>` name being
  asked about. Two *different* unnamed constraints deriving one post-rename name is
  only reachable via duplicate unnamed UNIQUEs — that is
  `bug-duplicate-unnamed-unique-constraint`; do not try to solve it here.

**Tests**

- `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` (runs on both
  backends): new sections for the rename — no-collision case pins `schema()` /
  `index_info()` empty after the rename, both `drop index _uc_<old>` and
  `drop index _uc_<new>` answering `no such index`, and a duplicate insert still
  rejected; collision case pins the refusal message and that the user's index is
  still listed and droppable and the column keeps its old name; case-only rename
  still succeeds; named-UNIQUE control unchanged.
- `packages/quereus-store/test/index-persistence.spec.ts`: a test mirroring the
  existing last one (`a UNIQUE constraint colliding with an index name is refused…`)
  for the rename path — `traceCatalogWrites()` shows no bundle without the
  `CREATE INDEX` line, `catalogEntry('t')` still declares the index after the refusal,
  `indexStoreSize('t','_uc_z')` unchanged, and after `closeAll()` → `reopen()` the
  index is in `index_info` and a duplicate on the constrained column is still
  rejected. Add the no-collision rename leg too: `index_info` empty, physical store
  moved to `main.t_idx__uc_<new>`, duplicate rejected before and after reopen.
- `test/alter-drop-rename-constraint.spec.ts` reads `db._findTable(t)?.indexes`
  directly (`indexNames()`); add the memory-side rename assertion there —
  `['_uc_z']`, not `['_uc_a']` — since that is the array arm 1 changes.
- Run: `yarn test`, then the two `.sqllogic` legs (`node --import
  ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  packages/quereus/test/logic.spec.ts --grep "10.5.7" --reporter spec`, and the same
  with `QUEREUS_TEST_STORE=true`), plus
  `yarn workspace @quereus/store run test`. Type-check with `yarn lint` in
  `packages/quereus` (it runs the test-file `tsc` pass).

**Docs**

- `docs/sql-ddl.md` §6.3 (~line 746) lists every path that declares or renames a
  UNIQUE constraint and reaches the name guard — add `ALTER TABLE … RENAME COLUMN`
  (the derived `_uc_<cols>` name moves with the column).
- `docs/sql-alter.md`: note under RENAME COLUMN that renaming a column covered by an
  unnamed UNIQUE moves its covering structure's name, and that the statement is
  refused when that name is already an index on the table.

**Related, do not fold in**

- `tickets/review/bug-hidden-implicit-index-leaks-into-introspection.md` closed the
  same *symptom* (hidden structure visible in `schema()` / `index_info()`) at the
  read paths in `func/builtins/schema.ts`. Its filter is correct; it is defeated here
  because the name it filters on has drifted. No change needed there.
- `tickets/backlog/debt-memory-unique-index-reuse-after-create-index.md` touches the
  same reuse logic — check it before editing `ensureUniqueConstraintIndexes`.
