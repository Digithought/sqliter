---
description: Renaming a column covered by a plain UNIQUE constraint used to break the link between the constraint and the hidden helper structure enforcing it; the helper now follows the column, and the rename is refused outright when the new helper name is already an index on the table.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts              # assertRenamedColumnBackingNamesFree (new) + its call in runRenameColumn
  - packages/quereus/src/vtab/memory/layer/manager.ts             # implicitIndexNameOver (new module fn), planImplicitCoveringIndexRenames + applyImplicitCoveringStructureRenames (new methods), renameColumn
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic   # new section 9f
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts    # 2 new memory tests
  - packages/quereus-store/test/index-persistence.spec.ts         # 2 new store tests
  - docs/sql-ddl.md                                               # §6.3 guarded-path list + new RENAME COLUMN bullet
  - docs/sql-alter.md                                             # RENAME COLUMN section
difficulty: medium
repro: verified
---

## What was wrong

A `UNIQUE (a)` constraint with no name of its own is enforced by a secondary index the
user never asked for and never sees. Its name is `_uc_a` — literally `_uc_` plus the
covered columns' names joined by `_`. That name is **recomputed from the table's
current column names every time anyone needs it**; it is never recorded. So
`alter table t rename column a to z` moves the name to `_uc_z`, and two things broke.

**Arm 1 — the memory backend lost the constraint↔structure link on ANY rename.** No
collision needed. `MemoryTableManager.renameColumn` rewrote each index's column
*references* but never the index **entry's own name**, so the materialized index stayed
`_uc_a` while every consumer computed `_uc_z`. The structure stopped being recognized
as hidden: it appeared in `schema()` and `index_info('t')` as if the user had created
it, and `drop index _uc_a` succeeded and deleted it — taking the constraint's
enforcement structure with it, silently.

**Arm 2 — the collision case was durable data loss on the store backend.** With an
existing `create index _uc_z on t (b)`, the rename was accepted. The rewritten catalog
entry dropped the user's `CREATE INDEX` line (the catalog builder skips whatever is
reported as a hidden backing structure — which was now the user's index), and the
constraint's entries were built into `main.t_idx__uc_z`, the store already holding the
user index's entries keyed on column `b`. After close → reopen the index was gone and
the UNIQUE accepted duplicates.

## What changed

**Arm 1 — `MemoryTableManager` keeps the derived name in sync.**
`planImplicitCoveringIndexRenames(updatedCols, renamedColIndex)` returns one
`{oldName, newName}` per *unnamed*, non-`derivedFromIndex` UNIQUE covering the renamed
column, skipping any whose `_uc_*` entry is not present (its structure is a reused user
index, which keeps its own name). `renameColumn` applies those to the new index list
alongside the existing column-reference rewrite; `applyImplicitCoveringStructureRenames`
re-keys the `implicitCoveringStructures` map **after** the schema swap succeeds, so a
failed rename leaves the map agreeing with the restored schema. `handleColumnRename`
already rebuilds every secondary index from the new schema, so no extra rebuild was
added. A **case-only** column rename still produces a rename here (the map is keyed by
the exact derived string, so `_uc_a` vs `_uc_A` would desync it); it cannot collide,
since an index named `_uc_A` could never have been created alongside `_uc_a`.

**Arm 2 — the engine refuses a rename onto a taken name.**
`assertRenamedColumnBackingNamesFree` in `runRenameColumn` calls the existing
`assertUniqueConstraintIndexNameFree` once per affected unnamed constraint, before
`module.alterTable` (so a refused statement reaches no persistence side effect). Skipped
entirely for a case-only rename — the derived name folds onto the constraint's OWN
structure, which memory materializes as a real index entry. Same message family as the
four already-guarded declaration paths.

**DRY:** `manager.ts` had two spellings of the `_uc_<cols>` rule; both now go through a
single module-level `implicitIndexNameOver(uc, columns)`, which takes an explicit column
list because the rename needs the name under the POST-rename columns.

## Use cases to exercise

Everything below was run and passes on **both** backends unless noted.

**No collision — the structure follows the column**

```sql
create table t (id integer primary key, a text, b text, unique (a));
insert into t values (1, 'x', 'p'), (2, 'y', 'q');
alter table t rename column a to z;
```
- `select name from schema() where type='index' and tbl_name='t'` → empty
- `select * from index_info('t')` → empty
- `drop index _uc_a` → `no such index`; `drop index _uc_z` → `no such index`
- `insert into t values (3, 'x', 'r')` → UNIQUE violation
- memory only: `db._findTable('t').indexes` is `['_uc_z']`, keyed on column index 1
- store only: physical store moves `main.t_idx__uc_a` → `main.t_idx__uc_z`, entries
  intact; still hidden and still enforcing after `closeAll()` → `reopen()`

**Collision — refused**

```sql
create table t (id integer primary key, a text, b text, unique (a));
create index _uc_z on t (b);
alter table t rename column a to z;
-- error: ... its backing index '_uc_z' would collide with existing index '_uc_z'
--        on the same table. Rename the constraint or the index.
```
- column keeps the name `a`; `_uc_z` is still listed, still resolves rows by `b`, still
  droppable; constraint still rejects duplicates on `a`
- store only: no catalog write drops the `CREATE INDEX` line, `catalogEntry('t')` still
  declares it, its store size is unchanged, and all of that survives reopen

**Shapes that must NOT change**
- multi-column `unique (a, b)` → `_uc_a_b` becomes `_uc_z_b`, still hidden, still enforcing
- case-only rename `a` → `A` succeeds (must not read the constraint's own structure as
  a collision)
- an **exposed** structure (`unique (a) with tags ("quereus.expose_implicit_index" = true)`)
  stays visible and moves to the new derived name — `index_info` reports `_uc_z`, not `_uc_a`
- named `constraint u1 unique (a)` — structure takes the constraint's name, so neither
  arm touches it; a rename onto a name that would have collided for the unnamed case
  is accepted and the unrelated index is untouched

## Validation run

- `yarn test` — all workspaces green (quereus 8164 passing, store 1225, sync 639, …), no failures
- `10.5.7-implicit-unique-index-lifecycle.sqllogic` under memory **and** `QUEREUS_TEST_STORE=true` — pass
- store-mode logic sweep `--grep "alter|rename|unique|index|constraint"` — 82 passing, 3 pending
- `yarn workspace @quereus/store run test` — 35 passing in `index-persistence.spec.ts`, suite green
- `yarn lint` in `packages/quereus` (eslint + the test-file `tsc` pass) — clean
- `tsc -b tsconfig.build.json` — clean
- `yarn docs:check` — red, but only for `docs/schema.md` and `docs/sync.md`, neither of
  which this ticket touches. Pre-existing and already owned by
  `tickets/backlog/debt-doc-size-ratchet-red-at-head.md`. `docs/sql-ddl.md` and
  `docs/sql-alter.md` (the two edited here) are both under their recorded maximums.

## Known gaps / things to poke at

- **The guard is name-only, so it can refuse a legal rename.** When a constraint is
  realized by a REUSED same-column-set index it has no `_uc_*` structure to move, yet a
  pre-existing index at the post-rename derived name still triggers the refusal.
  Deliberate — both backends decide reuse internally and at different times, so a
  reuse-aware check would make them disagree on which renames are legal — and recorded
  as a `NOTE:` at `alter-table.ts`'s `assertRenamedColumnBackingNamesFree`. Not covered
  by a test; reaching the reuse state takes a reconnect/rehydrate with both an index and
  a matching constraint on the table. Worth a reviewer's eye on whether the tradeoff is
  the right one.
- **`getImplicitCoveringStructure` still misresolves for a reused-index constraint.**
  Pre-existing and untouched: `ensureUniqueConstraintIndexes` keys
  `implicitCoveringStructures` by the REUSED index's name, while the lookup derives
  `_uc_<cols>` — so it misses and falls to the column-set fallback. Overlaps
  `tickets/backlog/debt-memory-unique-index-reuse-after-create-index.md`, which owns the
  same reuse logic. Not in this ticket's scope; flagging so it is not mistaken for new.
- **Two different unnamed UNIQUEs deriving one post-rename name** is not handled here —
  that shape only exists via duplicate unnamed UNIQUEs, owned by
  `tickets/implement/2-bug-duplicate-unnamed-unique-constraint.md`.
- **Tests are a floor.** The sqllogic section covers both backends behaviourally; the
  two spec files cover the backend-specific internals (`tableSchema.indexes` on memory,
  physical stores + catalog bundles on store). Not covered: a rename inside an open
  transaction with staged rows against a table carrying an unnamed UNIQUE (the
  `adoptSchemaOnOpenLayers` path — reasoned through, since `renameColumn` already
  rebuilds every `IndexSchema` object and `adoptSchema` adds the new key and drops the
  old, but not pinned by an assertion); and a rename covered by an unnamed UNIQUE
  carrying a partial predicate (only reachable via `create unique index … where`, which
  produces a `derivedFromIndex` constraint this change deliberately skips).
