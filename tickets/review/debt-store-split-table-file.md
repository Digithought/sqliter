---
description: The biggest source file in the persistent-storage package was cut from about 3,400 lines into six focused files, with no change to what the code does.
files:
  - packages/quereus-store/src/common/store-table.ts            # 3448 -> 646 lines
  - packages/quereus-store/src/common/store-table-base.ts       # new, 893
  - packages/quereus-store/src/common/store-table-scan.ts       # new, 934
  - packages/quereus-store/src/common/store-table-constraints.ts # new, 718
  - packages/quereus-store/src/common/pk-key-resolution.ts      # new, 262
  - packages/quereus-store/src/common/implicit-unique-index.ts  # new, 164
  - packages/quereus-store/src/common/index.ts                  # re-export sources repointed
  - packages/quereus-store/src/common/store-module.ts           # one import line repointed
  - docs/store.md                                               # package tree + layering note
  - docs/invariants.md                                          # MV-019 code pointer
difficulty: medium
---

# Review: split of `store-table.ts`

This is the first half of `debt-store-source-files-too-large`. The second half
(`store-module.ts`, still ~4,400 lines) is queued separately as
`debt-store-split-module-file` — the source ticket asked for the two files to be split as
separate pieces of work rather than one bundled change.

## What changed

`StoreTable` was one class of ~2,800 lines sitting in a ~3,400-line file. It is now the
same class expressed as a four-link inheritance chain, one file per link, plus two files
of free functions lifted out of the module scope:

```
StoreTableBase          store-table-base.ts         state, store/coordinator/stats handles,
                                                    transaction lifecycle, effective-row reads
  └ StoreTableScan      store-table-scan.ts         query(): predicate -> byte window -> rows
    └ StoreTableConstraints
                        store-table-constraints.ts  secondary-index maintenance,
                                                    UNIQUE conflict detection, REPLACE eviction
      └ StoreTable      store-table.ts              update(), external row writes,
                                                    bulk row rewrites for ALTER
```

```
pk-key-resolution.ts        per-column KEY collation / key transform / order-safety predicates
implicit-unique-index.ts    the hidden `_uc_*` index materialized per plain UNIQUE constraint
```

Only `StoreTable` is exported from the chain; the three intermediate classes are `abstract`
and exist solely to divide the file. `StoreTable` still extends `VirtualTable`
transitively, so every `instanceof` and every structural use is unchanged.

## Why inheritance rather than free functions

Nearly every method in the read and write paths reads five to ten `protected` instance
fields (`encodeOptions`, `pkDirections`, `pkKeyCollations`, `pkKeyTransforms`,
`collationResolver`, `coordinator`, `materializedSchema`, …). Extracting them as free
functions would have meant either widening all of that state to `public` (it would leak
into the published `.d.ts`) or threading a wide context object through every call site —
both of which rewrite call sites, and the source ticket asked for a pure move with no
behavior change. Subclassing moves the text and nothing else.

The layering rule is: **a layer may call downward, never upward.** One method violated a
naive read/write split — `checkUniqueConstraints` calls `deleteRowAt` for a REPLACE
eviction, and `deleteRowAt` calls `updateSecondaryIndexes`. Rather than leave a dangling
upward call, `updateSecondaryIndexes` and `deleteRowAt` were moved down into the
constraints layer with the UNIQUE code, which is why that file covers index maintenance as
well as UNIQUE enforcement (they are the same job — index upkeep is *how* UNIQUE is
enforced).

## Verification that this is a pure move

A script compared the multiset of source lines in the pre-change `store-table.ts` (git
HEAD) against the concatenation of all six post-change files. **Zero** original lines are
missing except the following, each an intentional, individually-reviewable edit:

- `private materializedSchema` → `protected` (subclasses read it)
- `private async readLiveRowByPk` → `protected` (the scan layer calls it)
- `private async deleteRowAt` → `protected` (`update()` in the final layer calls it)
- `function resolvePkSemanticEquality` → `export function` (crosses a file boundary now)
- 23 doc-comment lines whose `{@link}` target moved to another file (see below)

Zero blank-line delta. No line of executable code was retyped.

## Doc links

`{@link X}` targets that left a file were retargeted, not dropped:

- Links pointing *up* the chain (a scan doc referencing `iterateEffective` on the base)
  were left alone — they resolve through inheritance.
- Links pointing *down* the chain (a base doc referencing `keysEqual`) and links from the
  two leaf helper files (which cannot import the class without a cycle) were converted to
  backticked prose naming the owning class, e.g. ``​`StoreTableConstraints.keysEqual`​``.
  This matches the file's existing idiom for cross-module references such as
  ``​`StoreModule.buildIndexEntries`​``.
- `{@link StoreTable.scanIndex}` inside `store-table-scan.ts` became
  `{@link StoreTableScan.scanIndex}` — still a live link.

One pre-existing unresolvable link, `{@link DataChangeEvent}` in
`applyExternalRowChanges`, was left as-is (it was already unresolvable at HEAD).

## Validation run

| command | result |
|---|---|
| `yarn build` | clean |
| `yarn typecheck` | clean |
| `yarn lint` | clean (only `packages/quereus` has a real lint; store package is a no-op by design) |
| `yarn test` | 7765 + 342 + 113 + 63 + 17 + 28 + 1176 + 594 + 52 + 31 + 34 + 134 + 22 + 68 passing, 0 failing |
| `yarn test:store` | 7758 passing, 20 pending, 0 failing |

No test file was edited, and no assertion was touched.

## What a reviewer should look at

**The claim to check is "nothing moved that shouldn't have."** The mechanical verification
above covers *line preservation*; it cannot prove the *placement* is right. Specifically:

- **Layer placement.** Is each method in the layer whose job it does? The debatable ones:
  - `hasAnyRows` / `iterateEffectiveValuesAtIndex` / `rowsWithNullAtIndex` are in the base
    (read-only introspection used by ALTER), while `mapRowsAtIndex` / `rekeyRows` /
    `migrateRows` are in `store-table.ts` (they rewrite rows). That line is a judgment
    call.
  - `store-table-constraints.ts` does two named jobs (index maintenance, UNIQUE). The
    header argues they are one job; disagree if you think they aren't.
- **Visibility widening.** Three members went `private` → `protected`. Confirm none of
  them should instead have stayed private with the caller moved.
- **Import pruning was automated** (a loop over `tsc --noUnusedLocals` output), so each new
  file's import list is minimal by construction — but a symbol referenced *only* from a doc
  comment would have been pruned. The doc-link audit above was a separate pass and is the
  weaker of the two checks; spot-check a few doc comments in the new files.
- **`store-table-scan.ts` is still 934 lines** and `store-table-base.ts` 893 — both above
  the 629-line file that was previously the package's largest non-outlier. Whether that is
  small enough is a call worth making now rather than after the module split.

### Known gaps

- **No new tests were added.** This is a move refactor with no new behavior, and the
  existing suites (which exercise every arm — PK point/range, index seek, multi-seek,
  partial indexes, UNIQUE with and without index reuse, REPLACE eviction, ALTER paths)
  pass unchanged on both the memory and LevelDB backends. If a reviewer wants a guard
  against future accidental relayering, there is none — nothing enforces the
  "call downward only" rule mechanically; it holds today because the compiler rejects an
  upward call (a base class cannot see a subclass member), which is arguably guard enough.
- **TypeDoc output was not rendered**, so "links stay resolvable" was verified by static
  scope analysis (is the target declared or imported in the file?) rather than by building
  docs. No TypeDoc build exists in this repo to run.
- **The `.d.ts` surface changed shape** even though the exported *names* did not:
  `@quereus/store` now emits `StoreTableBase` / `StoreTableScan` / `StoreTableConstraints`
  declarations because `StoreTable extends` them. They are not exported from the package
  index, but they are reachable in the emitted declaration files. If that matters for API
  surface hygiene, say so.

## Follow-up

`debt-store-split-module-file` (in `tickets/implement/`) covers `store-module.ts`, the
remaining ~4,400-line file.
