---
description: The two main source files of the persistent storage package have grown to roughly 3,300 and 4,400 lines each — five times bigger than anything else in that package — which makes every change to storage slow to read and slow to review.
files:
  - packages/quereus-store/src/common/store-module.ts   # ~4,400 lines
  - packages/quereus-store/src/common/store-table.ts    # ~3,300 lines
difficulty: medium
---

# Split the two oversized store source files

`packages/quereus-store/src/common/` holds nine other source files; the largest of them is
629 lines. Against that, these two are outliers:

| file | lines |
|---|---|
| `store-module.ts` | ~4,400 |
| `store-table.ts` | ~3,300 |
| next largest in the package (`encoding.ts`) | 629 |

Both keep growing a few hundred lines per feature — the `IN`-list index-seek work added
~290 lines across the pair — and each addition is cohesive on its own while making the
host file harder to navigate.

## Candidate seams

These are starting suggestions, not a design. Whoever picks this up should confirm the
groupings against the current code before committing to them.

**`store-table.ts`** — the read path is the clearest cluster: turning a pushed predicate
into a byte window and iterating it (`analyzePKAccess`, `analyzeIndexAccess`,
`buildIndexRangeBounds`, `scanIndex`, `scanPKRange`, the multi-seek decode/window/scan
group, `matchesFilters` and its collation resolution). That is close to a thousand lines
that talk to the rest of the class through a small surface, and could plausibly become a
`table-scan.ts` alongside the write path and the lifecycle/DDL code that would remain.

**`store-module.ts`** — access planning (`computeBestAccessPlan`, `tryIndexAccessPlan`,
the seek-role helpers, the collation-safety predicates) is one job; catalog persistence
and rehydration is another; constraint enforcement is a third.

## Why it matters

The project's guidance asks for small single-purpose files and decomposed sub-functions.
Every ticket touching storage pays the reading cost, and reviewers pay it twice.

## Expectations

- No behavior change: pure move-and-reorganize.
- `yarn build`, `yarn test`, `yarn lint`, `yarn typecheck` green with **no** edits to
  existing test assertions.
- Public exports of `@quereus/store` unchanged.
- Doc comments travel with the code they explain; cross-file `{@link}` references stay
  resolvable.
- Split the two files as separate pieces of work — do not bundle them into one change.
