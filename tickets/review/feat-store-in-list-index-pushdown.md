---
description: When a query matches an indexed column against a list of values, the persistent storage backend now uses the index (one seek per distinct list value) instead of reading the whole table. Implemented and tested; ready for adversarial review.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/test/pushdown.spec.ts, packages/quereus-store/README.md
difficulty: hard
---

## What was built

`where v in (1, 2, 3)` on a store-backed table with a secondary index on `v` now plans an
`INDEXSEEK` (the engine's multi-seek, `plan=5`) instead of a full scan + residual filter.
Both halves from the original spec landed together:

**Plan side — `StoreModule` (`store-module.ts`):**
- `tryIndexAccessPlan` treats a well-formed `IN` (non-empty array value) as an equality
  when building the leading-prefix seek columns; `inCount` = cross-product of per-column
  list sizes. The FIRST role-filling filter per column decides, matching the engine
  rule's own pick (helper `equalitySeekCardinality` encodes the shared shape gate).
- `EQ_OPS` split: PK arms keep `=`-only (`equalityRoles` now takes an explicit ops
  parameter); the index arm uses the new `EQ_OR_IN_OPS`. PK IN is deferred — see
  `backlog/feat-store-pk-in-list-multiseek` (already filed, with the isolation-merge
  reasoning).
- Declines to the pre-existing cost-only plan (residual retained, correct-but-unaccelerated)
  when `inCount > 1000` (`MAX_MULTI_SEEK_KEYS`) or a seek column's logical type has
  semantic ordering (TIMESPAN/JSON — byte windows would under-fetch with no residual left).
- Cost for `inCount > 1`: `inCount * 0.5 + min(estimatedRows, inCount * perKeyRows) * 0.3`,
  `isSet` false, no ordering advertised. The `inCount === 1` path is byte-identical to before.

**Runtime side — `StoreTable` (`store-table.ts`):**
- `query()` dispatches a decoded `plan=5` idxStr to `scanMultiSeek` FIRST, ahead of
  `analyzePKAccess` (which would otherwise match the first of the N EQ constraints and
  answer a one-value point lookup).
- `scanMultiSeek`: decode N tuples of width W from `constraints`/`args`; drop NULL-bearing
  tuples; one `buildIndexPrefixBounds` window per distinct K-encoded prefix; windows sorted
  ascending by encoded bytes and scanned lazily via `scanIndex` (so index-key emission
  order — which the isolation overlay merge requires — and `limit` early-exit both hold).
- A `_primary_` branch (`scanMultiSeekPrimary`) resolves full-PK tuples as deduplicated,
  key-ordered point reads; unreachable from this module's own plans today, commented as such.
- Malformed multi-seek FilterInfos throw `StatusCode.INTERNAL` rather than falling through
  (fall-through would AND N mutually-exclusive equalities → silent zero rows).

## Deviations from the ticket spec (deliberate — review these first)

1. **Window dedup became window MERGE with an OR residual.** The spec said "dedup tuples by
   window hex, per-tuple residual". That combination loses rows when the table key
   collation K is strictly coarser than the column's comparison collation C (the one such
   pairing the plan admits: K=NOCASE over a BINARY column): `v in ('a', 'A')` produces ONE
   K-window but two C-distinct residuals, and keeping only one drops the other value's row.
   Implemented instead: K-equal tuples share one window and a row is yielded when it
   matches ANY member tuple's constraints (`MultiSeekWindowContext.extraTuples`). Pinned by
   the test "BINARY column under the NOCASE key collation".
2. **`seen`-set add timing.** Checked before the data-store read (as specified), but ADDED
   only on a yield — adding at visit time would let a stale index entry that fails its
   residual poison the set and suppress the row's live entry in a later window.
3. **Unbounded-window subsumption.** A window with no finite upper bound (all-0xff prefix)
   contains every later-sorting window outright, so later windows fold their tuples into it
   instead of re-scanning an overlapping range out of order. The spec's seen-set alone
   would have kept results correct but not emission order. Near-unreachable in practice
   (NULL tuples are dropped before encoding), so this is defensive.
4. **`scanIndex` gained one optional context object** (`MultiSeekWindowContext`: seen +
   pre-resolved collations + merged-tuple residuals) rather than a bare `seen` parameter.
   Existing callers unchanged.
5. **Runtime semantic-ordering guard added** (throws INTERNAL): the spec only required the
   plan-side decline, but a multi-seek reaching the runtime on a TIMESPAN/JSON seek column
   would silently under-fetch, so it is treated as malformed.

## Validation performed

- `yarn build` — clean.
- `yarn workspace @quereus/store test` — 1106 passing, 0 failing.
- `yarn test` — all workspaces green.
- `yarn test:store` — 7544 logic tests passing against the LevelDB store backend (this
  sweep exercises the FK RESTRICT batched-IN shape and the isolation layer over live
  multi-seeks).
- `yarn typecheck`, `yarn lint` — clean.

New tests in `pushdown.spec.ts` (`IN-list multi-seek` describe blocks): plan shape
(INDEXSEEK for single/composite, decline for over-cap and TIMESPAN), exact-row results for
basic/duplicate/NULL/all-NULL-param/empty/param-bound/single-element lists, NOCASE
case-variants, BINARY-under-NOCASE-K merge, DESC index, IN×IN / IN×EQ / EQ×IN
cross-products, param cross-product with a NULL component, memory-module oracle
cross-check, read-your-own-writes, ORDER BY over an unsorted list, and a
counting-data-store narrowing proof (0 data-store iterations, ~3 gets for 3 matches over
100 rows — a scan would iterate 100).

## Known gaps / notes for the reviewer

- No isolation-layer-specific unit test drives a multi-seek through
  `quereus-isolation` directly; coverage is via the `yarn test:store` sweep plus the
  window-ordering design. A targeted test (uncommitted overlay row interleaved between two
  seek windows, asserting merged order) would strengthen this.
- The cost-only decline paths (over-cap, semantic ordering) reuse the pre-existing
  `eqMatch`-shaped cost-only advertisement, which prices slightly below a full scan without
  performing a seek — same pre-existing property as the collation decline; not new debt.
- `a in (1,2) and b > 5` on index `(a, b)` claims only the IN on `a`; the trailing range
  stays a residual (the engine rule has no multi-value prefix-range seek — same limitation
  the memory module documents). Correct, just not maximally narrow.
- The narrowing test asserts `getCount` within 1–6 rather than exactly 3, to stay robust to
  incidental reads; if that ever masks a regression, tighten it.
