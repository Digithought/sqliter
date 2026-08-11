description: When the persistent storage backend estimates how many rows a query like "column in (a list of values)" will return, it gives up and says "the whole table" once the list has ten or more values, which makes every later cost decision about that query meaningless.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # ARM_SELECTIVITY, tryIndexAccessPlan's multi-seek arm (multiRows), the seek-vs-scan comparison
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts  # interpolateBreakEven / probeModuleCosts — the engine consumer of this estimate
tradeoffs: Nothing is observably wrong today — the estimate only becomes load-bearing once the arm is priced honestly — and a maintainer may reasonably want real per-column statistics (which would make this a non-question) rather than a better guess.
----

# The multi-seek row estimate is a clamp, not an estimate

## What it says today

The store has no per-column statistics, so it estimates rows with fixed fractions of the
table size: an equality on an indexed column is assumed to return 10% of the table, a
range 30%, and so on. For a list lookup (`where col in (v1 … vK)`, served as K index
seeks) it multiplies: K seeks × 10% each, capped at the table.

That cap is reached at K = 10 for any table size, and at K = 2 or 3 for a table of a
handful of rows. From there the answer is a constant — "this query returns every row" —
whatever the values in the list actually match. It is a clamp, not an estimate. (The 10%
figure implies the column holds about ten distinct values; a query naming 25 of them
contradicts that, but the fraction model has no way to say so.)

## Why it matters now

Two consumers read that number:

- The store's own plan cost, which as of `store-index-seek-resolution-cost` charges every
  other seek arm for the work of fetching each matched row from the data store. The
  list-lookup arm was deliberately left OUT of that charge, because charging a per-row cost
  against a clamped row count prices the clamp: it stopped list seeks on small tables
  outright (16 failing tests), and would cap the engine's key-set seeks at roughly 710 keys
  on a table of ANY size.
- The engine's `rule-key-set-seek`, which asks the store what a list seek would cost at 2
  keys and at 1000 keys and interpolates to find the key count where a plain scan wins.
  Both of its probe points ride the same clamp.

So the fixed cost model and the clamped estimate are now load-bearing together, and the
gap between them is why one arm has to be treated as a special case.

## What "done" looks like

Row estimates for a list lookup should grow with the number of values named and stay below
the table size until the values plausibly cover it, and they should agree with what the
same module says about a single-value equality on the same column — today an equality is
assumed to match ten times as large a slice as one member of a list would. Two directions
worth weighing (they are alternatives, not steps):

- Give the module real per-column statistics. That requires the store to KEEP a value
  distribution (it reports only a row count today) and the access-plan request to CARRY it
  (it carries the table size and the predicates, nothing else — so an analyzed table plans
  identically to an un-analyzed one). This is the fix that makes cost decisions per-query
  rather than per-arm, and it also fixes the separate complaint that a predicate matching
  most of a table is still priced at 10%.
- Or switch the shape constants from "a fraction of the table" to "about this many rows per
  matched value" — the assumption SQLite falls back on without statistics. Cheaper, but it
  has to change every arm at once or the arms disagree with each other.

Whichever lands, the special case in the store's seek-versus-scan comparison and the
missing per-row charge on the list-lookup arm should both come back out, and the arithmetic
recorded in the comments at those two sites re-checked.
