---
description: The 4,400-line file holding the persistent-storage module class was broken into eleven focused files; behavior is unchanged, and the review confirmed the move was mechanical and fixed a handful of stale comments left behind.
files:
  - packages/quereus-store/src/common/store-module.ts              # 622 lines — lifecycle, capabilities, backing host
  - packages/quereus-store/src/common/store-module-base.ts         # 435 — module state, store handles, coordinator
  - packages/quereus-store/src/common/store-module-catalog.ts      # 416 — catalog store I/O
  - packages/quereus-store/src/common/store-module-schema-sync.ts  # 486 — rehydrate + engine schema-change subscription
  - packages/quereus-store/src/common/store-module-index.ts        # 469 — create/drop index
  - packages/quereus-store/src/common/store-module-index-build.ts  # 326 — index population + UNIQUE probes (free fns)
  - packages/quereus-store/src/common/store-module-alter-column.ts # 472 — ALTER COLUMN
  - packages/quereus-store/src/common/store-module-alter.ts        # 601 — ALTER TABLE, other arms
  - packages/quereus-store/src/common/store-module-rename.ts       # 288 — RENAME TABLE
  - packages/quereus-store/src/common/store-module-access-plan.ts  # 494 — access planning (free fns)
  - packages/quereus-store/src/common/store-module-schema-rewrite.ts # 149 — pure schema rewrites (free fns)
  - packages/quereus-store/src/common/index.ts                     # package export surface
  - docs/store.md                                                  # package tree + layering note
difficulty: medium
---

# Complete: split of `store-module.ts`

Second half of `debt-store-source-files-too-large`, mirroring the `store-table.ts` split
that landed as `debt-store-split-table-file`. Pure move-and-reorganize: no behavior change
intended, no test assertion edited.

`store-module.ts` went from 4,442 lines to 622. No file is above ~620.

## What shipped

`StoreModule` is the top of an eight-file inheritance chain, one job per layer:

```
StoreModuleBase          store-module-base.ts          provider/store handles, the module's
                                                        StoreTable map, the shared coordinator,
                                                        the catalog-write queue, name collisions
  └ StoreModuleCatalog   store-module-catalog.ts       catalog entries for tables/views/MVs,
                                                        clean-shutdown marker, stale-MV set
    └ StoreModuleSchemaSync
                         store-module-schema-sync.ts   rehydrate at open, lazy table reconnect,
                                                        engine schema-change subscription
      └ StoreModuleIndex store-module-index.ts         create/drop index, `_uc_*` reconcile
        └ StoreModuleAlterColumn
                         store-module-alter-column.ts  alter column (value rewrites, re-keys)
          └ StoreModuleAlter
                         store-module-alter.ts         alter table: every other arm
            └ StoreModuleRename
                         store-module-rename.ts        two-phase rename table
              └ StoreModule
                         store-module.ts               create/connect/destroy, capabilities,
                                                        backing host, closeAll
```

Three groups read no module state and came out as free functions instead of layers:
`store-module-access-plan.ts` (which access path to advertise),
`store-module-index-build.ts` (index population + UNIQUE probes over a row stream), and
`store-module-schema-rewrite.ts` (pure schema-to-schema rewrites).

The one signature that changed shape: `computeBestAccessPlan` now takes the table's
configured key collation as a parameter; `StoreModule.getBestAccessPlan` resolves it and
passes it down. `collectOccupiedStoreNames` became a free function taking
`(tables, db, schemaName, owner)`.

Package exports unchanged: `common/index.ts` names three source files instead of one but
exports the same five symbols.

## Review findings

### Checked, clean

- **Line preservation.** Independently re-ran the multiset comparison of the pre-split file
  against the concatenation of all eleven new files (normalizing leading whitespace,
  blank lines, import blocks, and `private`→`protected`). Every residual line on both sides
  is accounted for by de-methodization, the class/layer declarations, the doc-link
  retargets, or the `tableKeyCollation` parameter. No unexplained deletion.
- **Reordering within a file — the implement ticket's largest stated gap, now closed.**
  Checked every consecutive line-pair in the split files against the pre-split file's
  adjacency set, restricted to pairs where *both* lines existed before (so new headers and
  retargeted comments do not mask a reorder). 59 seams, every one an import block, a new
  file-header boundary, or the known `tableKeyCollation` parameter insertion. Zero
  statements moved within their block.
- **Verbatim check of the highest-risk group.** Diffed the access-planning body
  (`computeBestAccessPlan` / `tryIndexAccessPlan` / `buildPkOrderingAdvertisement`) against
  the original line-for-line after removing one indent level: identical apart from the
  signature change and the `this.` receivers. This is the group where a subtle move error
  would silently return wrong rows, so it was worth proving rather than inferring.
- **Import graph.** Confirmed acyclic; each layer imports only the layer below. No
  `store-table*.ts` file imports back into a `store-module*.ts` file.
- **Visibility.** Every `protected` member in the chain is referenced from at least one
  other file — nothing was widened further than the split required. Nothing that was
  `private` became public, and nothing public became `protected`.
- **Export surface.** `common/index.ts` exports the same five symbols as before;
  `DEFAULT_MAX_BATCH_BYTES` is exported between sibling files only, not from the package.
- **Coverage of the one changed signature.** `store-name-collision.spec.ts` has 12 cases
  over the create / create-index / rename guards, including negative controls for a
  memory-backed table and a view named `t_idx_archive` — exactly the `vtabModule !== owner`
  and `isView` filters the `collectOccupiedStoreNames` extraction touches. The weaker
  `owner: object` typing is therefore behaviorally guarded, so it was accepted rather than
  reworked: the only two call sites pass `this`, and typing the parameter as the module
  interface cannot compile from the base layer.
- **Docs.** Re-read `docs/store.md` (package tree + the new layering diagram), `docs/sync.md`,
  and `packages/quereus/src/schema/table.ts`; all three describe the new file layout
  correctly. `docs/review.html` is a generated artifact with line numbers into the old file
  and was deliberately left alone.

### Fixed in this pass (minor)

- `store-module.ts:543` — the collation-lookup block that moved up into
  `getBestAccessPlan` kept the callee's indentation (one tab inside a two-tab method body).
  Re-indented.
- Eleven stale `StoreModule.<method>` doc references in files the split did not touch, all
  naming symbols that are now free functions: `store-table-scan.ts` (×6),
  `pk-key-resolution.ts` (×3), `key-builder.ts`, `store-table-base.ts`,
  `store-table-constraints.ts`. Retargeted to the convention the split established
  (`` `computeBestAccessPlan` (store-module-access-plan.ts) ``). The implement pass audited
  `{@link}` targets only inside the eleven new files, so these sat outside its sweep.
- `packages/quereus-isolation/src/alter-migration.ts` cited "`store-module.ts` `migrateRows`";
  `migrateRows` is a `StoreTable` method. Retargeted to `store-table.ts`.
- `store-module-alter.ts` said `reconcileImplicitUniqueIndexStores` was "(below)"; it is now
  a file away. Dropped the positional word.
- `store-module-access-plan.ts` header credited `getBestAccessPlan` with classifying pushed
  filters; that function now lives in another file and only wraps. Retargeted to
  `computeBestAccessPlan`.

### Major findings

None — no new tickets filed. The move survived every independent check above, and the full
suites pass, so nothing rose to needing separate work.

### Corrections to the implement handoff

- The handoff calls `store-module-index-build.ts` a leaf of the import graph. It is not: it
  imports `DEFAULT_MAX_BATCH_BYTES` from `store-module-base.ts`. The graph is still acyclic
  (the base layer *is* a leaf), so this is a description error, not a defect.

### Tripwires recorded

- `store-module-index-build.ts`, at the `DEFAULT_MAX_BATCH_BYTES` import: that constant is
  the only thing tying these helpers to the module chain. If they ever need to load without
  the chain, move the constant to a constants leaf.
- Carried over from implement: `docs/store.md` notes that no `StoreModule` layer exceeds
  ~620 lines and that `store-module-alter.ts` is the one most likely to grow (every new
  ALTER arm lands there); if it passes ~900 the natural next seam is the three constraint
  arms. `store-module-base.ts` documents why `collectOccupiedStoreNames` takes the owning
  module as a parameter rather than using `this`.

### Not done, and why

- **No new tests.** Correct for a pure move: the value is in confirming nothing changed, and
  the existing store suite already covers every area that moved (ALTER arms, index
  create/drop, access planning, reopen/rehydrate, rename, store-name collisions). Review
  found no seam that felt under-tested *before* the split, so nothing was filed.
- **Prose meaning was spot-checked, not exhaustively re-read.** Positional references
  ("below"/"above") were swept mechanically across all eleven files and the handful pointing
  across a file boundary were fixed; the remaining ~50 all refer within their own file.

## Validation

All from the repo root:

| command | result |
|---|---|
| `yarn build` | pass |
| `yarn typecheck` | pass (re-run after review edits) |
| `yarn lint` | pass (re-run after review edits) |
| `yarn test` | 7,765 + 2,584 passing across all workspaces, 0 failing |
| `yarn test:store` | 7,758 passing, 20 pending, 0 failing |
| `yarn workspace @quereus/store run test` | 1,176 passing, 0 failing (re-run after review edits) |

Review edits were comments, one re-indentation, and one added NOTE — no executable change,
so the full `yarn test` / `yarn test:store` runs were not repeated after them.
