---
description: In a persistent table, an "IN" query listing several durations or JSON values falls back to reading the whole table, even though single-value lookups over the same column are fast. Make the multi-value case use the same fast lookups.
prereq: feat-store-semantic-key-point-seeks
files:
  - packages/quereus-store/src/common/store-table-scan.ts          # scanMultiSeek, scanMultiSeekPrimary — the two multiSeekMalformed throws
  - packages/quereus-store/src/common/store-module-access-plan.ts  # tryIndexAccessPlan — the isMultiSeek semantic-ordering cost-only decline
  - packages/quereus-store/src/common/pk-key-resolution.ts         # semanticProbeIsKeyFaithful — the per-value predicate this would reuse
---

# Let an IN-list over a TIMESPAN / JSON column use the store's multi-seek

## What is going on

The persistent store serves `where col in (a, b, c)` as a **multi-seek**: one byte
window per list value, scanned in ascending key order. For a column whose declared type
is `timespan` or `json` it declines that plan and reads the whole table instead, then
filters each row.

The decline dates from when the store's key bytes for those types did not match the
type's own notion of equality — `'PT1H'` and `'PT60M'` are the same hour but were two
different keys, so a window per value would have missed rows. Tickets
`feat-store-semantic-key-range-seeks` and `feat-store-semantic-key-point-seeks` remove
that mismatch for single-value lookups and ranges. The multi-value case was left out
deliberately, because it is the one shape that cannot fall back safely.

## Why it is harder than the single-value case

Every other read arm in the store can give up at runtime and re-read the table: the
scan layer re-checks each row against every pushed constraint, so a query that skips its
byte window still gets the right answer, just slower.

A multi-seek cannot do that. Its N windows collectively *are* the answer — dropping one
loses rows outright — and the "read the whole table instead" fallback would AND the N
list values together (`col = a AND col = b AND col = c`), which matches nothing. That is
why the scan layer currently raises an internal error rather than degrading when such a
plan reaches it.

So re-opening this needs one of:

- a per-value gate applied at **planning** time, where declining still leaves the
  ordinary filter in place — but the planner only sees a literal list's values, not a
  parameter-bound or runtime-valued one; or
- an OR-shaped full-table fallback in the scan layer (iterate the table, keep a row
  matching **any** of the N list tuples) — the scan layer already carries the
  match-any-tuple machinery for merged windows, so this is the more likely shape.

Either way the per-value question is the one `semanticProbeIsKeyFaithful` already
answers: a duration that does not parse, or a JSON value holding a blob, has no faithful
position among the stored keys.

## Why it is worth doing

An `IN` list over a duration or JSON key is the shape a foreign-key check, a
`key-set-seek` rewrite, and a hand-written `where d in (…)` all produce. Today each of
them reads the entire table. The fast path already exists and is already correct for
these types' key bytes — only the fallback story is missing.

## Scope note

Primary-key multi-seek is separately unreachable from this module's own plans (see
backlog `feat-store-pk-in-list-multiseek`); this ticket is about the **secondary-index**
arm. If both land, the two guards in `scanMultiSeekPrimary` and `scanMultiSeek` should
end up stating the same rule.
