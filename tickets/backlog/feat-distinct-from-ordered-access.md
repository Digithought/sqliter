---
description: Asking for the distinct values of an indexed column reads every row and de-duplicates them, even though the index already holds those values grouped together — twenty-eight answers recovered by reading twenty thousand rows.
files:
  - packages/quereus/src/planner/rules/distinct/                       # where a rule would live
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # trySortAbsorbViaIndexOrdering — the probe that gets a Retrieve into ordered mode
  - packages/quereus/src/planner/nodes/distinct-node.ts                # the logical DISTINCT node
  - packages/quereus/src/vtab/memory/module.ts                         # indexSatisfiesOrdering — the ordering claim a rule would consume
severity: cosmetic
likelihood: normal-use
tradeoffs: The answer is already correct and the de-duplication itself is not the expensive part — the read is — so the payoff depends on the access path being able to skip ahead rather than merely stream in order, which is a module capability that does not exist yet; a maintainer may prefer to wait until something else needs that capability too.
---

# Recover DISTINCT values from an ordered index walk

## What happens now

```
select distinct c from t
  DISTINCT
    PROJECT
      INDEXSCAN t USING _primary_       <- every row, then a hash de-duplication
```

Verified at HEAD on the memory backend, with an index on `c` present and unused. The
reporting user behind `feat-minmax-index-boundary` has the same shape in their
workload: 28 distinct values recovered by scanning 20,000 rows.

## What it could do

If the rows arrive ordered by `c`, duplicates are adjacent, and DISTINCT becomes a
streaming "emit a row only when it differs from the previous one" — no hash table, and
the plan keeps its ordering for anything above it. That much is a fairly direct
analogue of what `feat-minmax-index-boundary` does for `min`/`max`: get the Retrieve
into ordered mode via the existing sort-absorption probe, then exploit the order.

The larger win needs one more thing: skipping from one distinct value straight to the
next instead of walking every duplicate. That is a module capability
("reposition to the next distinct value of this key column") that neither backend
advertises, and it is the same primitive `feat-grouped-minmax-index-boundary` wants.
If both get picked up, design the capability once.

## First question for whoever picks this up

Check whether `distinct-elimination` (Structural pass) or the physical DISTINCT
selection already has a path to an ordered access that just is not being taken here —
the streaming half may be closer than it looks. That check should come before any
design work.
