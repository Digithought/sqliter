---
description: The persistent storage backend already keeps a running count of how many rows each table holds, but never tells the query planner — so the planner costs every stored table as if it had exactly 1000 rows, no matter how big or small it really is.
files:
  - packages/quereus-store/src/common/store-table.ts        # getEstimatedRowCount — the count that already exists
  - packages/quereus/src/runtime/emit/analyze.ts            # ANALYZE: calls vtab.getStatistics() when the table has one
  - packages/quereus/src/planner/stats/catalog-stats.ts     # where a collected count would be read back from
  - packages/quereus-store/test/pushdown.spec.ts            # where a regression test would sit
difficulty: medium
---

# Let the planner learn how many rows a stored table actually holds

## What's missing

`StoreTable` maintains a row count as rows are written, persists it, and exposes it as
`getEstimatedRowCount()`. **Nothing in the engine ever calls it.**

The engine's route for learning a table's size is the optional `getStatistics()` method on a
virtual table, which `ANALYZE` calls and caches on the table's schema entry. `StoreTable`
does not implement that method, so:

- `ANALYZE` collects nothing for a store-backed table,
- the table's schema entry keeps a row estimate of `0`,
- and every cost question about that table falls through to the planner's fixed default
  guess of **1000 rows**.

Reproduced while verifying `feat-key-set-seek-store-isolation`: after inserting 200 rows
into a store table and running `ANALYZE`, the schema entry still reported `0` rows and no
statistics object at all.

## Why it matters

Every cost decision that depends on how big a stored table is is being made against a
constant. Concretely observed:

- The rule that decides whether `where col in (select …)` should look up individual keys or
  read the whole table computes a break-even key count from the storage backend's own cost
  numbers. Because the backend is asked to price a 1000-row table regardless, the break-even
  always lands at the engine's 1000-key ceiling — i.e. "always look up keys". On a genuinely
  small table that is more work than a full read; on a genuinely large one it is far too
  conservative. Neither is a wrong *answer* — the engine re-checks every row it gets back —
  only wasted work.
- The same fixed guess feeds join ordering, caching thresholds, and sort costs for every
  stored table.

This is not specific to any one feature; it is the whole cost model running on a placeholder.

## What good looks like

A store-backed table reports its real row count to the planner, so that after `ANALYZE`
(and ideally without needing one) plan costs reflect the table's actual size. The count
already exists and is already persisted — what is missing is the seam between it and the
planner.

## Related

- `backlog/debt-access-node-catalog-cardinality` — the engine half of the same gap: even
  when a table *does* carry collected statistics, a full-scan access node still reports the
  static schema estimate rather than the collected count. Both need to land for a stored
  table's size to actually reach a cost calculation; fixing only this one leaves the number
  collected but unread.
- `backlog/bug-store-index-choice-ignores-cost` — index choice inside the backend is
  first-match rather than cheapest, so the backend's own cost numbers are partly unused too.

## Expected fallout

Golden EXPLAIN plans and any test that pins a cost-driven plan shape over a store table may
shift once real counts arrive. Budget for regenerating them and sanity-checking the new
numbers, exactly as `debt-access-node-catalog-cardinality` describes.
