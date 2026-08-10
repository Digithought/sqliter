---
description: |
  Done + reviewed: when the isolation layer wraps a storage module mid-transaction and a query
  scans by a secondary index the underlying module named itself (a synthetic name the overlay
  never declared), the read used to crash with "Secondary index not found". The merged read now
  full-scans the overlay, filters and sorts the delta itself, and never asks the overlay to
  resolve the foreign index name.
files:
  - packages/quereus-isolation/src/isolated-table.ts        # mergedSecondaryIndexQuery rewrite; buildConstraintMatcher / buildMultiRangeWindowMatcher / constraintCollation / buildDescriptorComparators
  - packages/quereus-isolation/test/isolation-layer.spec.ts # describe "underlying-minted secondary index names" — 4 regression tests (3 from implement + 1 multiRangeSeek added in review)
  - docs/design-isolation-layer.md                          # Read Operations, Secondary Index Handling, and Index Scan Merge sections updated
---

# Complete: isolation overlay no longer asked to resolve underlying-minted index names

## What shipped

`IsolatedTable.mergedSecondaryIndexQuery` previously made two overlay queries — a full scan for
modified PKs, then a second query re-issuing the caller's index-named FilterInfo. When the index
name was one the underlying module minted itself (lamina mints `_compound_v_0`-style names per
plan), the overlay's private MemoryTable could not resolve it and threw
`Secondary index '_compound_v_0' not found`. Now:

- **One overlay full scan** collects modified PKs AND the non-tombstone data rows; the crash-site
  index-named overlay query is gone.
- The isolation layer **window-filters the overlay rows itself** (`buildConstraintMatcher`),
  unconditionally, interpreting the pushed constraints by plan kind (eqSeek/rangeSeek/prefixRangeSeek/
  multiSeek via a generic per-column matcher; multiRangeSeek's OR-of-ranges decoded from the idxStr
  `rangeOps` params exactly as the memory module's scan-plan builder does; scan and uninterpreted
  ops → no filter, over-yield only).
- The isolation layer **sorts** the collected rows by the merge's `(indexKey, PK)` sort key before
  merging, decoupling correctness from the overlay's PK-order emission.
- **Descriptor-derived merge comparators** (`buildDescriptorComparators`) honor a synthetic index's
  DESC / collated key columns when the underlying exposes no `getIndexComparator`.

Primary-key paths and declared-secondary paths are untouched.

## Validation

- `yarn build` — green.
- `yarn workspace @quereus/isolation test` — **249 passing** (245 pre-ticket, +3 implement, +1 review).
- `npx tsc -p tsconfig.test.json --noEmit` (packages/quereus-isolation) — clean.

Cross-repo: lamina can un-skip
`packages/lamina-quereus-test/src/isolation-overlay-underlying-index-names.test.ts` and close its
`tickets/blocked/quereus-isolation-overlay-cannot-serve-underlying-index-names.md`.

## Review findings

Adversarial pass over the implement diff (commit `ab67e516`). Reviewed for correctness, DRY,
modularity, type safety, resource cleanup, error handling, test coverage, doc accuracy, and source
hygiene.

**Correctness — confirmed sound.** Traced every plan kind through the window matcher:
- multiRangeSeek decode (`buildMultiRangeWindowMatcher`) matches `scan-plan.ts` line-for-line
  (rangeCount / rangeOps split, lower-then-upper arg order, OR-of-ranges semantics).
- EQ IN-set / range-AND / cross-column-AND interpretation matches how the planner
  (`rule-select-access-path.ts`) encodes pushed constraints — never over-restrictive, so no row
  loss; the documented `v=1 AND v=2` over-yield is unreachable from the planner and caught by any
  residual Filter.
- **NULL / IS-NULL:** confirmed `ISNULL` (71), `IS` (72), `NE`, `LIKE`, `MATCH` all fall to the
  matcher's `default` (uninterpreted → ignored → over-yield), NOT treated as EQ — so a `v IS NULL`
  query does **not** drop legitimate null-v overlay rows. The only NULL drop is a NULL *row value*
  under a genuine EQ/range bound, which correctly mirrors an index seek.
- Merge tie-break is safe: sort key includes PK, and PK sets are disjoint (modified PKs excluded
  from the underlying stream), so cross-stream sort-key ties cannot occur.

**Minor findings — fixed inline this pass:**
- *Test coverage gap.* The most intricate new path — `buildMultiRangeWindowMatcher`, the OR-of-ranges
  case the implementer explicitly flagged as "a naive conjunctive read would have DROPPED valid rows"
  — had **zero** tests (implement covered eqSeek, full-scan order, and DESC only). Added a
  regression: `multi-range OR window over the synthetic name`, staging one overlay row between two
  ranges that must be dropped and one inside each range that must survive — fails under naive-AND
  logic, passes under the shipped OR logic. (+1 test → 249.)
- *Stale doc.* `docs/design-isolation-layer.md` § "Index Scan Merge" still described the OLD
  two-index-scan approach ("Execute index scan on overlay table"), directly contradicting the fix.
  The implementer updated the neighboring Read Operations / Secondary Index Handling sections but
  missed this one. Rewrote it to the full-scan → window-filter → sort → merge flow.

**Major findings:** none. No new tickets filed.

**Conditional / speculative (tripwires):**
- Full-scan-per-merged-read cost. Already parked by the implementer as a `NOTE:` at the scan site
  (`isolated-table.ts`, step 1 of `mergedSecondaryIndexQuery`): fine while overlays hold one
  transaction's writes; retarget to a key-column-matched overlay index if it ever shows up hot. No
  action.
- `argvMap`-only constraint encodings and descending scan codes (`plan=1/4`, `ordCons=DESC`) remain
  unmodelled — over-yield-only, and no producer in this repo emits them. Documented in the implement
  handoff; no code guard warranted. No action.

**Source hygiene:** functions are small and single-purpose; new helpers well-named with concise doc
comments. Pre-existing unused-parameter warnings (`tombstoneIndex`, `_exhaustive`) predate this
ticket and were left alone (out of scope).

**Pre-existing failures:** none surfaced; the isolation suite is fully green.
