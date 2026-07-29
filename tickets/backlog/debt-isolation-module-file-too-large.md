---
description: Two source files in the transaction-isolation package are still around 1,800 and 2,100 lines each; keep splitting them so each file does one job. Part of this was already done — the ALTER TABLE half of the first file has moved out.
files:
  - packages/quereus-isolation/src/isolated-table.ts     # 2,077 lines — the bigger remaining candidate
  - packages/quereus-isolation/src/isolation-module.ts   # 1,825 lines — down from ~2,845; still mixes several jobs
  - packages/quereus-isolation/src/alter-migration.ts    # 1,078 lines — the piece already split out, for reference
---

# Keep splitting the oversized isolation-layer files

## What already landed

The `ALTER TABLE` overlay-migration machinery — deriving the per-change-type constants,
dry-run validating a connection's staged rows against a pending change, and reshaping the
overlay forward — moved out of `isolation-module.ts` into `alter-migration.ts` (ticket
`debt-isolation-module-alter-migration-extract`). That took `isolation-module.ts` from
~2,845 lines to 1,825. **Do not redo that work.**

## What is left

Two candidates, and they are separate splits — do not bundle them.

**`isolated-table.ts` (2,077 lines)** is now the largest file in the package and has had no
split at all. It is the per-connection table handle: merged reads, write routing into the
overlay, cross-layer PK/UNIQUE conflict detection, key ordering and collation resolution,
savepoint bookkeeping. Several of those are separable subjects.

**`isolation-module.ts` (1,825 lines)** still holds module lifecycle and bookkeeping
(create/connect/destroy, the per-connection overlay registry, commit and rollback,
savepoint tracking, renames) alongside the secondary-index DDL forwarding and the
overlay-schema construction helpers. Those last two are plausible next seams, but the file
is no longer the emergency it was — judge whether the churn is worth it before splitting
again.

## Why it matters

The project's own guidance asks for small single-purpose files and decomposed sub-functions.
At this size a file is expensive to read, expensive to review, and every ticket that touches
the isolation layer pays for it.

## Expectations

- No behavior change. `yarn build`, `yarn test`, `yarn lint`, `yarn typecheck` green, with
  **no** edits to existing test assertions.
- Public exports of `@quereus/isolation` unchanged.
- The long explanatory doc comments move with the code they explain; cross-references
  between the split files stay resolvable.
