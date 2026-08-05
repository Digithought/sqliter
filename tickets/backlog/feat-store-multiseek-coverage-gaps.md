description: On the persistent storage backend, a query matching a column against a list of values gets a fast per-value lookup for most columns but still reads the whole table for a primary key, and for duration or JSON columns.
prereq: feat-store-semantic-key-point-seeks
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # tryIndexAccessPlan — the primary-key equality arm (`=` only) and the isMultiSeek semantic-ordering decline
  - packages/quereus-store/src/common/store-module.ts               # the access-plan entry point
  - packages/quereus-store/src/common/store-table.ts                # the multi-seek runtime arm, including its primary-key branch
  - packages/quereus-store/src/common/store-table-scan.ts           # scanMultiSeek / scanMultiSeekPrimary — the two multiSeekMalformed throws
  - packages/quereus-store/src/common/pk-key-resolution.ts          # semanticProbeIsKeyFaithful — the per-value predicate arm B would reuse
  - packages/quereus-isolation/src/merge-iterator.ts                # mergeStreams — the ordering constraint that held arm A back
tradeoffs: Both arms are speed-only against a plan that already returns correct rows, and arm B in particular has no safe runtime fallback — so a maintainer may reasonably leave both until an actual query is measured to be slow.
----

# Two shapes the store's multi-seek still refuses

The persistent store serves `where col in (a, b, c)` as a **multi-seek**: one deduplicated,
key-ordered byte window per distinct list value, instead of a full table scan.
`feat-store-in-list-index-pushdown` built that for secondary indexes and deliberately left
two shapes out. Both live in the same access-plan arm and the same scan functions; whoever
picks one has already read the other.

Arm A is the cheap one and is a reasonable first cut on its own.

## Arm A — the primary key still full-scans

`select … from t where pk in (1, 2, 3)` full-scans on the store. The **runtime half
already exists**: `StoreTable`'s multi-seek arm has a primary-key branch (one point lookup
per tuple, deduplicated and emitted in primary-key order). What is missing is the planner
half — `StoreModule`'s primary-key equality arm still matches only `=`, so it never names a
primary-key multi-seek plan.

*Why it was held back, and why that no longer applies:* when the isolation layer wraps the
store, a primary-key scan is merged row-by-row with the transaction's staged writes by
walking two streams that must be in the same key order (`mergeStreams`,
`packages/quereus-isolation/src/merge-iterator.ts`). A list lookup emits rows in list
order, not key order, and the two sides did not agree — which could surface a stale row
alongside its updated copy, or resurrect a deleted one. That defect was filed as
`bug-isolation-multiseek-merge-order` and has since been fixed.

Re-confirm the merge behaves under an open transaction when this is picked up, but expect
the remaining change to be small: it is the planner half only.

## Arm B — a duration or JSON column falls back to a full scan

For a column whose declared type is `timespan` or `json`, the store declines the multi-seek
plan and reads the whole table, then filters each row.

The decline dates from when the store's key bytes for those types did not match the type's
own notion of equality — `'PT1H'` and `'PT60M'` are the same hour but were two different
keys, so a window per value would have missed rows. `feat-store-semantic-key-range-seeks`
and `feat-store-semantic-key-point-seeks` removed that mismatch for single-value lookups
and ranges. The multi-value case was left out deliberately, because **it is the one shape
that cannot fall back safely.**

Every other read arm in the store can give up at runtime and re-read the table: the scan
layer re-checks each row against every pushed constraint, so a query that skips its byte
window still gets the right answer, just slower. A multi-seek that skips a window simply
never visits those rows — there is nothing left to re-check them. So the per-value
key-faithfulness question (`semanticProbeIsKeyFaithful`) has to be answered before the plan
is chosen, for every value in the list, not discovered mid-scan.

The two `multiSeekMalformed` throws in `scanMultiSeek` / `scanMultiSeekPrimary` are where
today's "this should not have been planned" assertions live.
