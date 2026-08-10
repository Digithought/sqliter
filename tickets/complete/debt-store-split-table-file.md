---
description: The biggest source file in the persistent-storage package was cut from about 3,400 lines into six focused files, with no change to what the code does; the review confirmed the move was clean and fixed a set of stale comments pointing at the old file.
files:
  - packages/quereus-store/src/common/store-table.ts             # 3448 -> 645 lines
  - packages/quereus-store/src/common/store-table-base.ts        # new, 899
  - packages/quereus-store/src/common/store-table-scan.ts        # new, 934
  - packages/quereus-store/src/common/store-table-constraints.ts # new, 718
  - packages/quereus-store/src/common/pk-key-resolution.ts       # new, 262
  - packages/quereus-store/src/common/implicit-unique-index.ts   # new, 164
  - packages/quereus-store/src/common/index.ts                   # re-export sources repointed
  - packages/quereus-store/src/common/store-module.ts            # one import line repointed
  - docs/store.md                                                # package tree, layering note, size tripwire
  - docs/invariants.md                                           # MV-019 code pointer
  - docs/mv-constraints.md                                       # store-parity pointer (review fix)
difficulty: medium
---

# Split of `store-table.ts` — complete

`StoreTable` was one class of ~2,800 lines in a ~3,400-line file. It is now the same class
expressed as a four-link inheritance chain, one file per link, plus two files of free
functions lifted out of module scope:

```
StoreTableBase          store-table-base.ts         state, store/coordinator/stats handles,
                                                    transaction lifecycle, effective-row reads
  └ StoreTableScan      store-table-scan.ts         query(): predicate -> byte window -> rows
    └ StoreTableConstraints
                        store-table-constraints.ts  secondary-index maintenance,
                                                    UNIQUE conflict detection, REPLACE eviction
      └ StoreTable      store-table.ts              update(), external row writes,
                                                    bulk row rewrites for ALTER

pk-key-resolution.ts        per-column KEY collation / key transform / order-safety predicates
implicit-unique-index.ts    the hidden `_uc_*` index materialized per plain UNIQUE constraint
```

Only `StoreTable` is exported from the chain; the three intermediate classes are `abstract`
and exist solely to divide the file. `StoreTable` still extends `VirtualTable`
transitively, so every `instanceof` and every structural use is unchanged.

This was the first half of `debt-store-source-files-too-large`. The second half
(`store-module.ts`, ~4,400 lines) is queued separately as `debt-store-split-module-file`;
the source ticket asked for the two files to be split as separate pieces of work.

## Review findings

### Verified — the core claim holds

The claim under review was "nothing moved that shouldn't have, and nothing changed."
Re-derived independently rather than taken from the handoff:

- **Pure move.** Compared the sorted line multiset of the pre-change `store-table.ts` at
  `a4592096~1` against the concatenation of all six post-change files, in both directions.
  Confirmed: **no executable line was added**. Every added line is a class declaration, an
  import, a doc-comment scaffold line, or one of the four intentional signature edits
  (three `private` → `protected`, one `function` → `export function`). Every "missing"
  line is one of those same edits or a retargeted doc-comment line.
- **The layering rule is compiler-enforced.** The chain declares **no** `abstract`
  members, so a layer physically cannot call upward — a base class cannot name a subclass
  member. The handoff's claim that this is guard enough is correct; a test would add
  nothing.
- **No accidental override.** Zero duplicate method names across the four files, so
  splitting one class into four introduced no shadowing.
- **Construction order is safe.** This is the one silent-break vector a pure line move
  still has: a field moved into a subclass now initializes *after* the base constructor
  body, not before. There is exactly one constructor (in the base), and only two subclass
  fields carry initializers (the two `WeakMap` predicate caches in `StoreTableConstraints`).
  The base constructor cannot reference them, so the reordering is unobservable. Clean.
- **Public API unchanged.** `index.ts` exports the same names from new sources; every
  external consumer (`@quereus/sync`'s store adapter, `backing-host.ts`, `store-module.ts`)
  reaches them through the package index, not through file paths.
- **Helper placement.** The two remaining module-scope functions (`keyWithinBounds`,
  `resolvePkDefaultConflict`) are each used only within their own file.

### Minor — found and fixed in this pass

**Stale cross-file pointers.** The implement pass updated `docs/store.md` and
`docs/invariants.md`, but not the comments *elsewhere in the repo* that name
`store-table.ts` as the home of code that moved out of it. Eight sites repointed:

| site | now names |
|---|---|
| `packages/quereus/src/vtab/table.ts:63` | `store-table-base.ts` (connection naming) |
| `packages/quereus/src/schema/unique-enforcement.ts:5` | `store-table-constraints.ts` |
| `packages/quereus/src/core/database.ts:2450` | `store-table-constraints.ts` (REPLACE eviction) |
| `packages/quereus/test/vtab/idx-str.spec.ts:15` | `store-table-scan.ts` (`idxStr` parsing) |
| `packages/quereus-store/src/common/encoding.ts:59` | `pk-key-resolution.ts` |
| `packages/quereus-store/src/common/json-key.ts:60` | `pk-key-resolution.ts` |
| `packages/quereus-store/src/common/json-key.ts:108` | `pk-key-resolution.ts` |
| `docs/mv-constraints.md:123` | `store-table-constraints.ts` |

**One missed upward doc link.** `store-table-base.ts:773` carried `{@link query}`, but
`query()` lives in `store-table-scan.ts` — a *subclass*. A base class cannot resolve a
subclass member, so this link was dead. Converted to backticked ``StoreTableScan.query``,
matching how the same pass handled every other downward link (including one 100 lines
earlier in the same file). The handoff flagged its doc-link audit as the weaker of its two
checks; that was an accurate self-assessment, and this was the one escape. A full audit of
every `{@link}` target in all six new files against what each file declares or imports
found no others. The single remaining unresolvable link (`{@link DataChangeEvent}`) was
already broken at HEAD and is out of scope.

**One stale self-reference.** `store-table-scan.ts:778` said "this file's UNIQUE checks";
UNIQUE moved to `store-table-constraints.ts`. Reworded.

### Major — filed as a new ticket

`tickets/backlog/debt-store-table-update-method-too-large.md` — `StoreTable.update()` is
~315 lines: one `switch` with three fat inline arms (insert ~125, update ~130, delete ~45).
That is roughly half of the 645-line file and the largest method in the package, and the
insert and update arms duplicate logic (the conflict-resolution lookup appears verbatim in
both). This is pre-existing debt that the refactor did not introduce and correctly did not
touch — a pure move must not restructure method bodies. But with the surrounding 2,800
lines gone it is now the dominant blob in what remains, so it is worth its own ticket
rather than a note.

### Tripwires — conditional, deliberately not filed as tickets

- **Layer file sizes.** `store-table-scan.ts` is 934 lines and `store-table-base.ts` 899 —
  both above the 629-line file that was previously the package's largest non-outlier. Not a
  miss: the source ticket explicitly scoped the read path at "close to a thousand lines",
  so this landed where it was aimed. Parked as a bullet in `docs/store.md` naming the next
  seam for each file (the scan layer's multi-seek group; the base's statistics block) if
  either crosses ~1,000.
- **Emitted declaration surface.** `@quereus/store` now emits `StoreTableBase` /
  `StoreTableScan` / `StoreTableConstraints` declarations. This is a TypeScript
  *requirement*, not API intent — `StoreTable extends` them, and TS4020 forbids emitting a
  declaration whose base class is not nameable. They are not re-exported from the package
  index. Parked as a `NOTE:` at the `StoreTableBase` declaration so a future API-surface
  extractor is told to treat them as internal rather than prompt a re-export.

### Checked, no action taken

- **Layer placement of the ALTER helpers.** The handoff called this its most debatable
  call: `hasAnyRows` / `iterateEffectiveValuesAtIndex` / `rowsWithNullAtIndex` sit in the
  base, while `mapRowsAtIndex` / `rekeyRows` / `migrateRows` sit in `store-table.ts`. All
  six are called only from `store-module.ts`, so cohesion does argue for grouping them.
  But the split follows each layer's stated charter — the base owns effective-row *reads*,
  `StoreTable` owns row *writes* — so it is principled and documented rather than
  accidental. Relocating working code for taste alone adds risk to a zero-behavior-change
  refactor with no offsetting gain. Left as is.
- **Visibility widening.** The three `private` → `protected` members are each read by
  exactly the layer that needed them: `materializedSchema` by the scan and constraints
  layers, `readLiveRowByPk` by the scan layer, `deleteRowAt` by `update()`. None could
  have stayed private without moving its caller back into the base, which would undo the
  split. Correct as done.
- **No new tests.** The right call here, not a gap. This is a move with no new behavior;
  the existing suites already exercise every arm (PK point/range, index seek, multi-seek,
  partial indexes, UNIQUE with and without index reuse, REPLACE eviction, ALTER paths) on
  both the memory and LevelDB backends, and they pass unchanged. A test asserting that
  moved code still works adds maintenance cost without new coverage, and the layering rule
  it might guard is already a compile error.
- **File headers.** Read all six. Each states its layer's job and its position in the
  chain accurately. No action.

## Validation

Run at the final state, after the review fixes:

| command | result |
|---|---|
| `yarn build` | clean |
| `yarn typecheck` | clean |
| `yarn lint` | clean (only `packages/quereus` has a real lint; other packages are no-ops by design) |
| `yarn test` | 13 mocha suites + 3 vitest suites, **0 failing** (7765, 1176, 594, 342, 134, 113, 96, 68, 63, 52, 34, 31, 28, 22, 17, 10 passing; 13 pending) |
| `yarn test:store` | 7758 passing, 20 pending, **0 failing** |

No test file assertion was edited. The only test-file change in this ticket is a stale
comment pointer in `idx-str.spec.ts`. No pre-existing failures surfaced.

## Follow-up

- `debt-store-split-module-file` (in `tickets/implement/`) — `store-module.ts`, the
  remaining ~4,400-line file.
- `debt-store-table-update-method-too-large` (in `tickets/backlog/`) — filed by this
  review, above.
