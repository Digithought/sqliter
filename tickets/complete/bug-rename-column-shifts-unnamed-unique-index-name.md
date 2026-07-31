---
description: Renaming a column covered by a plain UNIQUE constraint used to break the link between the constraint and the hidden helper structure enforcing it; the helper now follows the column, and the rename is refused outright when the new helper name is already an index on the table.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts              # assertRenamedColumnBackingNamesFree + its call in runRenameColumn
  - packages/quereus/src/vtab/memory/layer/manager.ts             # implicitIndexNameOver, planImplicitCoveringIndexRenames, applyImplicitCoveringStructureRenames, renameColumn
  - packages/quereus/src/schema/catalog.ts                        # findIndexShadowedByUniqueConstraint — review tripwire NOTE
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic   # section 9f (+2 cases added in review)
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts    # 2 memory tests
  - packages/quereus-store/test/index-persistence.spec.ts         # 2 store tests
  - docs/sql-ddl.md, docs/sql-alter.md, docs/memory-table.md
repro: verified
---

## What was wrong

A `UNIQUE (a)` constraint with no name of its own is enforced by a secondary index the user
never asked for and never sees. Its name is `_uc_a` — `_uc_` plus the covered columns' names
joined by `_` — and it is **recomputed from the table's current column names every time anyone
needs it**, never recorded. So `alter table t rename column a to z` moves the name to `_uc_z`,
and two things broke.

**Arm 1 — the memory backend lost the constraint↔structure link on ANY rename.**
`MemoryTableManager.renameColumn` rewrote each index's column *references* but not the index
**entry's own name**, so the materialized index stayed `_uc_a` while every consumer computed
`_uc_z`. The structure stopped being recognized as hidden: it appeared in `schema()` and
`index_info('t')` as a user index, and `drop index _uc_a` deleted it — taking the constraint's
enforcement structure with it, silently.

**Arm 2 — the collision case was durable data loss on the store backend.** With an existing
`create index _uc_z on t (b)`, the rename was accepted; the rewritten catalog entry dropped the
user's `CREATE INDEX` line and the constraint's entries were built into the store already holding
the user index's entries. After close → reopen the index was gone and the UNIQUE accepted
duplicates.

## What shipped

**Arm 1 — `MemoryTableManager` keeps the derived name in sync.**
`planImplicitCoveringIndexRenames(updatedCols, renamedColIndex)` returns one
`{oldName, newName}` per *unnamed*, non-`derivedFromIndex` UNIQUE covering the renamed column,
skipping any whose `_uc_*` entry is absent (its structure is a reused user index, which keeps its
own name). `renameColumn` applies those to the new index list alongside the existing
column-reference rewrite; `applyImplicitCoveringStructureRenames` re-keys the
`implicitCoveringStructures` map **after** the schema swap succeeds, so a failed rename leaves the
map agreeing with the restored schema. A case-only column rename still produces a rename (the map
is keyed by the exact derived string) and cannot collide.

**Arm 2 — the engine refuses a rename onto a taken name.**
`assertRenamedColumnBackingNamesFree` in `runRenameColumn` calls the existing
`assertUniqueConstraintIndexNameFree` once per affected unnamed constraint, before
`module.alterTable`, so a refused statement reaches no persistence side effect. Skipped for a
case-only rename. Same message family as the four already-guarded declaration paths.

**DRY:** `manager.ts` had two spellings of the `_uc_<cols>` rule; both now go through a single
module-level `implicitIndexNameOver(uc, columns)`, which takes an explicit column list because the
rename needs the name under the post-rename columns.

## Review findings

Read the implement diff first, then the surrounding subsystems (`BaseLayer.rebuildAllSecondaryIndexes`,
`TransactionLayer.adoptSchema`, `dropColumn`'s covering-structure teardown, the store's
`reconcileImplicitUniqueIndexStores`) before the handoff summary.

**Correctness — nothing found.** The guard sits before the first side effect and after only a pure
probe. `adoptSchema`'s add-then-drop-by-name pass moves a layer's `MemoryIndex` to the new key with
no change needed. `BaseLayer.rebuildAllSecondaryIndexes` clears before rebuilding, so no orphan
index lingers under the old name and keeps being maintained on every write. `renameColumn`'s catch
restores the pre-rename schema *before* the map is re-keyed, so a failed rename leaves the two
agreeing. The store arm works by design, not accident: `reconcileImplicitUniqueIndexStores` already
diffs implicit-index stores by derived name and its doc comment already named the column-rename
case. `dropColumn`'s `droppedUcKeys` derives from the live column names, so the fix also repairs
rename-then-drop-column, which previously left an orphan.

**Test coverage — two gaps, both fixed in this pass.** The implementer's tests are behaviourally
solid on both backends but left two interactions unpinned; both are now in
`10.5.7-implicit-unique-index-lifecycle.sqllogic` §9f and pass under memory and `--store`:
- *Rename inside an open transaction with staged rows* — the `adoptSchemaOnOpenLayers` path the
  handoff explicitly flagged as reasoned-through but unasserted. Now asserts the staged row stays
  visible to the relocated structure, enforcement never lapses, and `COMMIT` keeps the staged write.
- *`DROP COLUMN` after a rename* — `dropColumn` matches the structure by the derived key, so a
  multi-column unnamed UNIQUE would previously have been torn down under the wrong key and survived
  as an orphan. Multi-column on purpose: a single-column structure collapses to zero key columns and
  is dropped by the shift helper regardless, so only this shape proves the key was re-derived.

**Docs — one stale file, fixed in this pass.** `docs/sql-ddl.md` §6.3 and `docs/sql-alter.md` were
updated by the implementer and read accurately. `docs/memory-table.md`'s "`RENAME COLUMN` adopts the
renamed schema on the open layers" paragraph was not: it described only the `IndexSchema` rebuild and
predated the entry *name* moving. Extended with the name-move clause; the file is still under its
doc-size ratchet.

**Tripwire (recorded, not ticketed).** The guard's *input* is backend-dependent even though the check
is not. A colliding **user index** is in `tableSchema.indexes` on every backend, so the collision this
exists to catch is refused identically everywhere. Another **constraint's** backing structure is not —
memory materializes one into `.indexes`, store does not. Verified with a throwaway logic file:
`create table t (id integer primary key, a text, b text, unique (a), constraint _uc_z unique (b));
alter table t rename column a to z` is refused under memory and accepted under store (with no
observable enforcement loss in the probe). Only reachable when a user writes the engine's reserved
`_uc_` prefix into a constraint name, and pre-existing across all five callers of
`assertUniqueConstraintIndexNameFree` rather than introduced here. Parked as a `NOTE:` on
`findIndexShadowedByUniqueConstraint` in `packages/quereus/src/schema/catalog.ts`.

**No new tickets filed**, and that is deliberate rather than an empty check:
- The name-only guard's *false refusal* when a constraint is realized by a reused same-column-set
  index (the handoff's headline open question) is the right call — both backends decide reuse
  internally and at different times, so a reuse-aware check would make them disagree on which renames
  are legal. Already documented at the site with the escape hatch (rename the index first) and the
  path to change it if it ever bites.
- `getImplicitCoveringStructure` misresolving for a reused-index constraint is pre-existing and owned
  by `tickets/backlog/debt-memory-unique-index-reuse-after-create-index.md`.
- Two different unnamed UNIQUEs deriving one post-rename name is owned by
  `tickets/implement/2-bug-duplicate-unnamed-unique-constraint.md`.
- Source size: `manager.ts` 3886 lines, `alter-table.ts` 2341 (`wc -l`). Both already claimed by
  `tickets/backlog/debt-emit-source-files-too-large.md`; no duplicate filed.

**Style / hygiene — no findings.** No `any`, no eaten exceptions, unused args prefixed, `_uc_` rule
spelled once per package. Comment density is high but matches the surrounding functions in both files.

## Validation

- `yarn lint` (quereus: eslint + the test-file `tsc` pass) — clean
- `yarn test` — all workspaces green, zero failures
- `10.5.7-implicit-unique-index-lifecycle.sqllogic` under memory **and** `--store` — pass
- store-mode logic sweep `--grep "alter|rename|unique|index|constraint"` — 1269 passing, 5 pending
- `yarn docs:check` — red on `docs/schema.md` and `docs/sync.md` only, neither touched here;
  pre-existing and owned by `tickets/backlog/debt-doc-size-ratchet-red-at-head.md`. All three docs
  edited across implement + review are under their ratchets.
