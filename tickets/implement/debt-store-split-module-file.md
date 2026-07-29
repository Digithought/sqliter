---
description: The remaining oversized file in the persistent-storage package is about 4,400 lines and needs to be broken into focused files, the same way its sibling file already was.
files:
  - packages/quereus-store/src/common/store-module.ts            # ~4,440 lines, the file to split
  - packages/quereus-store/src/common/store-table.ts             # worked example of the split already done
  - packages/quereus-store/src/common/store-table-base.ts        # ditto
  - packages/quereus-store/src/common/store-table-scan.ts        # ditto
  - packages/quereus-store/src/common/store-table-constraints.ts # ditto
  - packages/quereus-store/src/common/pk-key-resolution.ts       # helpers already lifted out of store-table.ts
  - packages/quereus-store/src/common/implicit-unique-index.ts   # ditto
  - packages/quereus-store/src/common/index.ts                   # package export surface
  - docs/store.md                                                # package tree + layering note to extend
difficulty: medium
---

# Split `store-module.ts`

Second half of `debt-store-source-files-too-large`. The first half — `store-table.ts`,
3,448 lines — has landed; see `tickets/review/debt-store-split-table-file` and the
resulting files listed above for the shape that was chosen and why.

`store-module.ts` is now the only outlier left in `packages/quereus-store/src/common/`:

| file | lines |
|---|---|
| `store-module.ts` | ~4,440 |
| next largest in the package | ~934 |

Of that, `class StoreModule` occupies lines ~346–4,197 — roughly 3,850 lines in one class
with 80 members. The rest is ~250 lines of module-scope helpers before the class and
~240 lines of free functions after it.

## Expectations

- No behavior change: pure move-and-reorganize.
- `yarn build`, `yarn test`, `yarn lint`, `yarn typecheck` green with **no** edits to
  existing test assertions. `yarn test:store` too — this is storage code.
- Public exports of `@quereus/store` unchanged. `StoreModule`, `StoreModuleConfig`,
  `RehydrationResult`, `RehydrationError`, and `LensDeploymentListener` are all re-exported
  from `common/index.ts`; keep every one of those names exported from the package even if
  its defining file changes.
- Doc comments travel with the code they explain; cross-file `{@link}` references stay
  resolvable, or are converted to backticked prose naming the owning class when the target
  is unreachable without an import cycle.
- No file left much above ~900 lines.

## The approach that worked for `store-table.ts`

`StoreTable` was split into an inheritance chain of four `abstract`-then-concrete classes,
one per file, each layer adding one job to the one below, plus two files of free functions
lifted from module scope. The reason was that virtually every method reads a handful of
`protected` instance fields; turning them into free functions would have meant widening
that state to `public` or threading a wide context object through every call site, and
neither is a pure move.

`StoreModule` has the same property — its methods read `provider`, `stores`, `tables`,
`moduleCoordinator`, `eventEmitter`, `persistQueue`, `atomicProvider`, and friends — so the
same technique is the obvious starting point. **Confirm it against the code before
committing to it**: `StoreModule` has more genuinely-standalone helper logic than
`StoreTable` did (access planning in particular reads almost nothing off `this`), so parts
of it may extract cleanly as free functions, which is the better outcome where it works.

The layering rule that fell out of the first split is worth keeping: **a layer may call
downward, never upward.** In `store-table.ts` one method violated a naive read/write split
and had to be moved down a layer; expect at least one such surprise here too. Find them by
attempting the split and reading the compiler errors — a base class cannot see a subclass
member, so the compiler reports every upward call.

## Candidate seams

Starting suggestions, not a design. Line ranges are approximate and will drift; the member
names are the durable part.

**Access planning** — `getBestAccessPlan`, `computeBestAccessPlan`, `tryIndexAccessPlan`,
`buildPkOrderingAdvertisement`, plus the module-scope seek-role helpers above the class
(`SeekRole`, `claimFirstPerRole`, `rangeRoles`, `equalityRoles`, and the `EQ_OPS` /
`RANGE_OPS` / `MAX_MULTI_SEEK_KEYS` / `INDEX_SEEK_COST` constants). ~500 lines, and the
group that talks to the rest of the class through the narrowest surface — a good first cut.
Note it is the mirror of `store-table-scan.ts`: the planner decides which access path to
advertise, the scan layer then executes it, and several soundness predicates are
deliberately duplicated between the two. Whatever file this lands in should say so.

**ALTER TABLE** — `alterTable` and its twelve helpers (`alterAddColumn`, `alterDropColumn`,
`alterRenameColumn`, `alterPrimaryKeyChange`, `alterAddConstraint`, `alterDropConstraint`,
`alterRenameConstraint`, `alterColumnChange`, `alterColumnSetNotNull`,
`alterColumnSetDataType`, `alterColumnSetCollation`, `reconcileImplicitUniqueIndexStores`,
`materializedIndexNames`, `tearDownImplicitUniqueIndexStore`), plus the schema-rewriting
free functions at the tail of the file (`reconcilePkCollations`, `buildColumnRemap`,
`isSelfForeignKey`, `retargetSelfForeignKeys`, `renameColumnInSelfForeignKeys`) and the
`AlterColumnAttrChange` type. ~1,150 lines — the single biggest cluster, and on its own
still larger than the target, so it likely wants a further cut (the schema-rewriting free
functions are a natural separate file).

**Catalog persistence and rehydration** — `buildCatalogEntry`, `encodeCatalogDDL`,
`saveTableDDL`, `loadAllDDL`, `loadCatalogEntries`, `rehydrateCatalog`,
`consumeCleanShutdownMarker`, `removeTableDDL`, `saveViewDDL`, `removeViewDDL`,
`saveMaterializedViewDDL`, `removeMaterializedViewDDL`, `assertCatalogObjectPersistable`,
`persistObjectCatalogEntryIfChanged`, `enqueuePersist`, `persistCatalogIfChanged`,
`whenCatalogPersisted`, plus the module-scope `CatalogEntry` type, `viewCatalogEntry`,
`maintainedViewCatalogEntry`, and `assertPersistableDdlText`. ~800 lines.

**Index build and rebuild** — `createIndex`, `dropIndex`, `buildIndexEntries`,
`rebuildSecondaryIndexes`, `validateUniqueOverExistingRows`, `validateUniqueIndexOverRows`,
plus the free functions `indexDedupeNormalizers`, `dedupeRowSignature`,
`assertNoDuplicateRows`, `rowsFromEntries`, `convertRowsAtIndex`. ~750 lines.

**Engine schema subscription and stale-materialized-view tracking** —
`ensureSchemaSubscription`, `onEngineSchemaChange`, `dispatchSchemaChange`,
`computeStaleMvSet`, `persistStaleMvSetIfChanged`, `writeDurableStaleMvSet`,
`readDurableStaleMvSet`, `refreshConnectedMaterializedView`. ~250 lines.

What would remain in `store-module.ts` is the module's own lifecycle and identity:
construction, `getCapabilities`, `create` / `connect` / `destroy` / `reclaimDetachedTable`
/ `tearDownTableStorage` / `getOrReconnectTable`, store-name collision checking, the store
and coordinator accessors, `closeAll`, `getTable`, and the backing-host / lens-deployment
hooks. ~1,000 lines, so it may want one more cut of its own.

## Verifying it is a pure move

The first split used a script that compared the multiset of source lines in the pre-change
file (from `git show HEAD:<path>`) against the concatenation of every post-change file, and
required the difference to be empty except for a short, hand-enumerated list of intentional
edits (visibility widening, a doc-link retarget). Reproduce that check — it is what makes
a 4,000-line reorganization reviewable at all, and the handoff should state its result.

Import lists can be pruned mechanically: give each new file the original's full import
block, then loop on `yarn workspace @quereus/store run typecheck` and delete whatever
`noUnusedLocals` reports (TS6133 / TS6192). Watch for one trap — a symbol referenced only
from a doc comment gets pruned this way, silently breaking that `{@link}`. Audit doc links
as a separate pass afterwards.

## TODO

- Read `store-module.ts` and confirm (or replace) the seams above against the real code.
- Decide per group: subclass layer vs. free functions. Prefer free functions where the code
  does not read instance state; that is the better result and access planning is the most
  likely candidate.
- Split, one group at a time, running `yarn workspace @quereus/store run typecheck` between
  each.
- Repoint `common/index.ts` and any intra-package imports; keep the package's exported names
  identical.
- Run the line-preservation check and enumerate every intentional deviation.
- Audit `{@link}` targets in every new file.
- Extend the `docs/store.md` package tree and the layering note added by the first split.
- Validate: `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn test:store`.
