---
description: The 4,400-line file holding the persistent-storage module class was broken into eleven focused files; nothing about how it behaves was meant to change.
files:
  - packages/quereus-store/src/common/store-module.ts              # 622 lines — lifecycle, capabilities, backing host
  - packages/quereus-store/src/common/store-module-base.ts         # 435 — module state, store handles, coordinator
  - packages/quereus-store/src/common/store-module-catalog.ts      # 416 — catalog store I/O
  - packages/quereus-store/src/common/store-module-schema-sync.ts  # 486 — rehydrate + engine schema-change subscription
  - packages/quereus-store/src/common/store-module-index.ts        # 469 — create/drop index
  - packages/quereus-store/src/common/store-module-index-build.ts  # 322 — index population + UNIQUE probes (free fns)
  - packages/quereus-store/src/common/store-module-alter-column.ts # 472 — ALTER COLUMN
  - packages/quereus-store/src/common/store-module-alter.ts        # 601 — ALTER TABLE, other arms
  - packages/quereus-store/src/common/store-module-rename.ts       # 288 — RENAME TABLE
  - packages/quereus-store/src/common/store-module-access-plan.ts  # 494 — access planning (free fns)
  - packages/quereus-store/src/common/store-module-schema-rewrite.ts # 149 — pure schema rewrites (free fns)
  - packages/quereus-store/src/common/index.ts                     # package export surface
  - docs/store.md                                                  # package tree + layering note
difficulty: medium
---

# Review: split of `store-module.ts`

Second half of `debt-store-source-files-too-large`, mirroring the `store-table.ts` split
that landed as `debt-store-split-table-file`. Pure move-and-reorganize: no behavior change
was intended, and no test assertion was edited.

`store-module.ts` went from 4,442 lines to 622. Nothing is above ~620.

## What was built

`StoreModule` is now the top of an eight-file inheritance chain, one job per layer:

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

Three groups read no module state and came out as **free functions** instead of layers —
the better outcome the ticket asked for where it works:

- `store-module-access-plan.ts` — `computeBestAccessPlan`, `tryIndexAccessPlan`,
  `buildPkOrderingAdvertisement`, and the seek-role / operator-group helpers above them.
  The one thing the planner read off the module was the table's configured key collation;
  that is now a parameter, resolved by `StoreModule.getBestAccessPlan` and passed down.
- `store-module-index-build.ts` — `buildIndexEntries`, `validateUniqueOverExistingRows`,
  `validateUniqueIndexOverRows` and their dedupe helpers.
- `store-module-schema-rewrite.ts` — `reconcilePkCollations` and the self-foreign-key
  retargeting used by rename / alter-column.

The import graph is strictly acyclic and verified: `store-module-base.ts` and the three
free-function files are leaves; every layer imports only the layer below it.

Package exports are unchanged. `common/index.ts` now names three source files instead of
one, but exports the same five symbols (`StoreModule`, `StoreModuleConfig`,
`RehydrationResult`, `RehydrationError`, `LensDeploymentListener`).

## Verification that it is a pure move

A checker compared the multiset of source lines in `git show HEAD:store-module.ts` against
the concatenation of all eleven post-change files. Three normalizations were applied to
both sides, each uniform and mechanical:

- **leading whitespace / blank lines** — three groups moved from class methods to free
  functions and lost one indentation level, so an exact-whitespace comparison is impossible
  for this split (the previous split had no de-methodization and could compare verbatim);
- **`private` → `protected`** — members reached from another layer of the chain;
- **import statements** — every new file needs its own block.

Additionally, a doc reference to a member was compared **by member name only**: the split
necessarily changes the qualifier, and whether the reference can stay a real `{@link}`
depends on what the owning file imports. That every surviving link still resolves was
checked separately (see below).

**Result: 0 lines present only in the original, 0 non-comment lines present only in the
split, after a hand-enumerated allowlist of 29 removed / 62 added distinct lines.** 19
purely-additive documentation lines (the per-file headers and the layering notes) are
reported separately rather than allowlisted, on the principle that prose *appearing* is
safe and visible in the diff while prose *disappearing* is what must never happen silently
— that direction is still reported as unexplained.

The allowlisted deviations, in full:

1. The class declaration (`export class StoreModule extends StoreModuleRename implements …`).
2. Visibility widening on the members and fields reached from another layer.
3. `export` added to the free functions and to `DEFAULT_MAX_BATCH_BYTES`, which a sibling
   file now imports.
4. Call sites that lost their `this.` receiver when a method became a free function.
5. `computeBestAccessPlan` gains a `tableKeyCollation` parameter; the one line that
   resolved it (and its comment) moved up into `StoreModule.getBestAccessPlan`.
6. `collectOccupiedStoreNames` became a free function taking `(tables, db, schemaName,
   owner)`. See "Judgement calls" below.
7. Doc-link retargets (see below).

## Judgement calls worth a second opinion

- **`collectOccupiedStoreNames` is now a free function with an `owner: object` parameter.**
  Its ownership test is `t.vtabModule !== this`, and inside `StoreModuleBase` that no longer
  compiles: TypeScript reports the two types as non-overlapping, because the base layer is
  not itself a `VirtualTableModule` (the concrete `StoreModule` at the top of the chain is).
  The alternatives were an `as unknown` cast or an abstract declaration reaching upward.
  Passing the owning module in keeps a real type and reads honestly — the enumeration
  genuinely needs no other module state — but the identity check is now typed `object`
  rather than the module interface, which is weaker than it was. Worth a look.
- **`store-module-alter-column.ts` is its own layer** rather than part of
  `store-module-alter.ts`, purely on size (the two together would be ~1,070 lines).
  `alterColumnChange` is the only class member in it; the three per-attribute sub-branches
  below it are pure and became file-local free functions.
- **`rehydrateCatalog` lives in `store-module-schema-sync.ts`, not the catalog layer.** It
  calls `ensureSchemaSubscription`, which needs the catalog primitives, so the catalog layer
  must sit below the subscription layer, and rehydration above both. Reasonable, but it does
  mean "read the catalog back" is not in the file named `catalog`.
- **`getBackingHost` / `getTableForExternalWrite` / `resolveOwnedTable` stayed in
  `store-module.ts`** while `getOrReconnectTable` (which they call) sits two layers down in
  `store-module-schema-sync.ts`, because the index and alter layers also need it. The doc
  comments that describe them as a pair are now split across two files.

## Doc links

Every `{@link}` target in the eleven files was audited mechanically: the head of each
reference must be declared in the file or imported into it, since import pruning otherwise
drops a symbol referenced only from a doc comment. 30 links needed retargeting and now
follow the convention the `store-table.ts` split established:

- same-file target → a real `{@link foo}` (the qualifier was just dropped);
- cross-file target that cannot be imported without a cycle, or without an import existing
  solely for the comment → backticked prose naming the owning class,
  e.g. `` `StoreModuleBase.ddlCommitPendingOps` ``.

The audit passes with zero unresolvable targets. Note this is a *structural* check — it
proves the named symbol is reachable from that file, not that the prose still describes the
right thing. Spot-checking a few for meaning is a reasonable use of review time.

## What to test / poke at

Nothing about behavior changed, so the value is in confirming that. Highest-yield areas,
roughly in order of how much moved:

- **`alter table`, every arm.** ADD/DROP/RENAME COLUMN, PRIMARY KEY change, ADD/DROP/RENAME
  CONSTRAINT, and all four ALTER COLUMN attributes (SET NOT NULL, SET DATA TYPE, SET DEFAULT,
  SET COLLATE) — including the ones that rewrite stored values or re-key the primary key,
  and the interaction with an implicit `_uc_*` index over the altered column.
- **`create index` / `drop index`** over a column carrying a plain UNIQUE constraint — the
  reuse/teardown transition of the hidden `_uc_*` store.
- **Access planning.** The collation-cover guards are the load-bearing part and they moved
  wholesale: a primary-key point and range seek, a secondary-index prefix seek, an `IN`-list
  multi-seek, the multi-seek cap, and the decline paths (partial index, semantic-ordering
  column, collation that may under-fetch). A plan that wrongly claims a filter drops the
  residual `Filter` and returns wrong rows, so this is where a subtle move error would hurt
  most and where a `select` still returning the right rows is the real assertion.
- **Reopen paths.** Rehydration of tables, indexes, views and materialized views; the
  clean-shutdown marker; the durable stale-materialized-view set on an atomic provider.
- **`rename table`,** including the two-phase drain and a self-referencing foreign key.
- **Physical store-name collisions** — the `collectOccupiedStoreNames` signature change is
  the one place a signature moved, so the create / create-index / rename guards against a
  sibling table literally named `t_idx_<x>` deserve a direct look.

## Validation run

All from the repo root, all green:

| command | result |
|---|---|
| `yarn build` | pass |
| `yarn typecheck` | pass |
| `yarn lint` | pass |
| `yarn test` | 7,765 + 2,584 passing across all workspaces, 0 failing |
| `yarn test:store` | 7,758 passing, 20 pending, 0 failing |

No test file was edited except two comments naming the old file path.

## Known gaps — treat these as the floor, not the ceiling

- **The line-preservation check cannot see reordering within a file.** It compares multisets,
  so a statement moved to a different position inside the same method would pass. The move
  was script-driven from whole declaration blocks (doc comment + body), which makes that
  unlikely, but it is not proven.
- **It also cannot see a block landing in the wrong file** — only that every line landed
  *somewhere*. The compiler catches most of that (a method in the wrong layer fails to
  resolve its callees), but a free function moved to an odd file would compile fine.
- **No new tests were written.** This ticket added zero coverage; it relies entirely on the
  existing suites, which is the right call for a pure move but means any behavior change too
  subtle for them to catch is unguarded. If reviewing turns up a seam that felt under-tested
  *before* the split, that is a separate finding worth filing rather than something this
  ticket regressed.
- **`yarn test:store` was run once, at the end.** It was not run between individual group
  moves; only `yarn workspace @quereus/store run typecheck` was.
- **Doc prose was not re-read end to end.** Comments travelled with their code verbatim, so
  a comment that said "see the method below" and whose neighbour moved to another file may
  now point at nothing. The `{@link}` audit catches the linked ones; plain-prose references
  ("the block above", "the method below") were not systematically checked.
- **Stale file-path references elsewhere in the repo were fixed opportunistically, not
  exhaustively** — `docs/store.md`, `docs/sync.md`, `packages/quereus/src/schema/table.ts`,
  two store test comments and one `.sqllogic` comment. `docs/review.html` is a generated
  artifact with line numbers into the old file and was left alone.

## Tripwires recorded

- `docs/store.md` gained a note: no `StoreModule` layer is above ~620 lines today, and
  `store-module-alter.ts` is the one most likely to grow since every new ALTER arm lands
  there. If it passes ~900 the natural next seam is the three constraint arms.
- `store-module-base.ts` documents, at `collectOccupiedStoreNames`, why the owning module is
  a parameter rather than `this`.
