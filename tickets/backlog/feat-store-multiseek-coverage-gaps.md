description: On the persistent storage backend, a query matching a duration or JSON column against a list of values reads the whole table instead of fetching just the matching rows, which every other column type already gets.
prereq: feat-store-semantic-key-point-seeks
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # tryIndexAccessPlan — the isMultiSeek semantic-ordering decline
  - packages/quereus-store/src/common/store-module.ts               # the access-plan entry point
  - packages/quereus-store/src/common/store-table-scan.ts           # scanMultiSeek / scanMultiSeekPrimary — the two multiSeekMalformed throws
  - packages/quereus-store/src/common/pk-key-resolution.ts          # semanticProbeIsKeyFaithful — the per-value predicate this arm would reuse
tradeoffs: Speed-only against a plan that already returns correct rows, and this is the one multi-seek shape with no safe runtime fallback — so a maintainer may reasonably leave it until a query is measured to be slow.
----

# The shape the store's multi-seek still refuses

The persistent store serves `where col in (a, b, c)` as a **multi-seek**: one deduplicated,
key-ordered byte window per distinct list value, instead of a full table scan.
`feat-store-in-list-index-pushdown` built that for secondary indexes and deliberately left
two shapes out.

The other one — the primary key never planning a multi-seek at all — was promoted to
`implement/feat-store-pk-in-list-multiseek` after a downstream user hit it. This ticket is
what remains.

## A duration or JSON column falls back to a full scan

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

## Related work in flight

Even where a list lookup *does* plan, the store drives one byte window at a time and
resolves each row with its own store read — on IndexedDB, one database transaction per
row. That is `store-index-seek-batched-row-resolution` (in `implement/`). It makes every
multi-seek faster but does not change which shapes plan one, so it neither blocks nor is
blocked by this ticket.
