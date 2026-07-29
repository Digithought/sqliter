<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-29T07:21:31.226Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\debt-share-drop-column-renumbering.review.2026-07-29T07-21-31-226Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Two storage backends each kept their own copy of the bookkeeping for renumbering a table's positional fields when a column is dropped, and the copies had already drifted apart once and caused a bug; this folds them into one shared routine.
files:
  - packages/quereus/src/schema/table.ts                    # new shiftSchemaIndicesForDrop (~line 491)
  - packages/quereus/src/index.ts                            # export added (line 193)
  - packages/quereus/src/vtab/memory/layer/manager.ts        # dropColumn (~2039-2121) now calls the shared helper
  - packages/quereus-store/src/common/store-module.ts        # alterDropColumn (~1790-1855) now calls the shared helper
difficulty: easy
---

# Shared DROP COLUMN index-renumbering — implementation summary

## What changed

Added `shiftSchemaIndicesForDrop(schema: TableSchema, colIndex: number)` to
`packages/quereus/src/schema/table.ts` (exported from the package root alongside the other
shared schema helpers like `appendIndexToTableSchema`, `buildColumnIndexMap`). It is the DROP
COLUMN mirror of the existing `shiftSchemaIndicesForInsert` (which stays where it is, in
`vtab/memory/layer/manager.ts`, since it has no second caller).

Given the pre-drop schema and the index of the column being removed, it returns the renumbered
position-bearing fields:

- `columns` — the column list with the dropped slot removed.
- `primaryKeyDefinition` — PK entries naming the dropped column removed, survivors shifted.
- `indexes` — index entries naming the dropped column pruned column-by-column (shifted), any
  index left with zero columns dropped entirely. Always a (possibly empty) frozen array, matching
  the pre-existing behavior of both backends (never `undefined`).
- `uniqueConstraints` — UNIQUE constraints naming the dropped column removed outright (not
  narrowed), survivors shifted; `undefined` when none remain (matches prior behavior).
- `foreignKeys` — same removed-outright-then-shift treatment for this table's own FK child
  columns; `undefined` when none remain.
- `removedUniqueConstraints` — the UNIQUE constraints that got removed outright, **pre-shift**
  (original column indices), so a caller that materializes a physical structure per UNIQUE
  constraint can tear down exactly the ones this drop removes. This field intentionally carries
  no naming-convention logic (`uc.name ?? '_uc_<cols>'`) — that stays caller-side, since it's
  backend-specific and already existed independently in both places.

`columnIndexMap` is NOT part of the return value — every caller already rebuilds it from the new
`columns` array via `buildColumnIndexMap`, and keeping that one call site per caller matches
every other schema-mutation site in the codebase.

Both `MemoryTableManager.dropColumn` (`packages/quereus/src/vtab/memory/layer/manager.ts`) and
`StoreModule.alterDropColumn` (`packages/quereus-store/src/common/store-module.ts`) now call
this helper instead of carrying their own copy of the shift/prune logic. What's left in each is
genuinely backend-specific:

- **Memory**: still computes `droppedUcKeys` (via its own `implicitIndexNameFor`) from the
  helper's `removedUniqueConstraints`, to name-exclude the dropped constraint's auto-built
  covering index from the `indexes` array (memory's `.indexes` materializes those; the shared
  helper's own index handling is purely positional and doesn't know about that convention), and
  to clean up `implicitCoveringStructures`. Also still sets the dead-but-harmless `primaryKey`
  field (not a `TableSchema` field; pre-existing, documented as unread — left untouched to keep
  this a behavior-preserving refactor).
- **Store**: doesn't need `removedUniqueConstraints` at all — its engine-facing `.indexes` never
  carries the hidden `_uc_*` covering index for a plain UNIQUE, and
  `reconcileImplicitUniqueIndexStores` (a separate, pre-existing generic mechanism) tears down
  that physical store by diffing the old/new constraint sets after every ALTER arm, not just DROP
  COLUMN.

**Ordering note for reviewers**: the memory module used to exclude the dropped covering index
*by name* BEFORE positionally pruning/shifting the remaining indexes; it now does the by-name
exclusion AFTER calling the shared helper (which does the positional pass over the *original*
`indexes` array). This reorder is safe: a covering index tied to a fully-removed UNIQUE
constraint necessarily has a column entry at the dropped position, so it survives the positional
pass in some (possibly still non-empty) shifted form regardless, and is excluded by name
afterward all the same — the two filters operate on independent dimensions (which indexes
survive vs. how each survivor's own columns are renumbered) so composing them in either order
gives an identical result. Verified via full test parity (see below), not just reasoning.

## Testing performed

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file `tsc` pass) — clean.
- `yarn workspace @quereus/store run build` — clean.
- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn test` (packages/quereus, memory-backed): **7729 passing, 13 pending** — same count as an
  unmodified baseline run.
- `yarn test:store` (packages/quereus logic tests replayed against the LevelDB store module):
  **7722 passing, 20 pending** — same count as baseline.
- `yarn workspace @quereus/store run test` (the store package's own Vitest suite, including
  reopen/rehydrate specs): **1156 passing**.

All four suites were run twice (before and after a small cleanup pass that dropped two redundant
`Object.freeze()` calls on already-frozen helper output) with identical pass/pending counts both
times.

## Use cases exercised by the existing guard suite (not new — this is a refactor)

- `test/memory-vtable.spec.ts` — "should prevent dropping primary key columns" and the general
  DROP COLUMN specs (drops a plain column, verifies schema shape).
- The `41.x` ALTER logic tests (`.sqllogic`, run under both `yarn test` and `yarn test:store`) —
  DROP COLUMN interacting with secondary indexes, UNIQUE constraints (including the ADD COLUMN +
  inline-UNIQUE revert path), and foreign keys (both this table's own FK columns and the
  previously-buggy dangling-child-index case from `bug-drop-column-leaves-fk-child-index-dangling`).
- Store reopen specs — DROP COLUMN followed by a close/reopen round-trip, exercising
  `saveTableDDL`/`generateTableDDL` over the renumbered schema and confirming `_uc_*` store
  teardown/rebuild still happens correctly via `reconcileImplicitUniqueIndexStores`.

## Known gaps / things the reviewer should look at fresh

- No new tests were added — this ticket is explicitly a behavior-preserving consolidation, and
  the existing `41.x` ALTER suite plus store reopen specs are named in the ticket as the guard.
  I relied on identical pass counts across full-suite runs rather than writing a new test that
  pins the shared helper's contract in isolation. If the reviewer wants tighter coverage, a small
  unit test directly against `shiftSchemaIndicesForDrop` (a pure function, easy to test without
  spinning up a table) would be cheap insurance against future regressions in either caller.
- I did not attempt to also consolidate the `_uc_<cols>` implicit-index-naming convention that
  both `MemoryTableManager.implicitIndexNameFor` and the store's `implicitUniqueIndexNameMap` /
  `implicitUniqueIndexName` still duplicate. That convention is used far beyond DROP COLUMN (ADD
  CONSTRAINT, DROP CONSTRAINT, RENAME CONSTRAINT, etc. in both files), so unifying it is a
  larger, separately-scoped change — out of scope for this ticket, which was specifically about
  the position-renumbering logic. Noting it here in case it's worth its own ticket later.
