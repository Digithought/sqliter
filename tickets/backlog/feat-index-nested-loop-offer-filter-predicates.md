---
description: When a join looks up rows one at a time, the engine tells the storage layer about the join key but not about the other conditions in the query, so a combined index that could answer both at once never gets used.
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts             # offerConstraints / admitLeaf — the walk arm is where the gap is
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                 # peelToSeekableAccessLeaf walks past the Filter that holds the predicates
  - packages/quereus/src/planner/analysis/constraint-extractor.ts            # extractConstraints — turns a predicate into offerable constraints
  - docs/optimizer-joins.md                                                  # § Index-Nested-Loop Join, "Pushed-constraint inner leaves"
tradeoffs: It only pays off when a multi-column index exists that the storage module could not use for the WHERE clause alone but can use once the join key is added — a narrow shape — and it adds a second source of offered predicates to a rule whose correctness argument is precisely about accounting for every predicate it offers.
---

# Offer the join's inner-side WHERE conditions, not only the ones storage already claimed

## What happens today

The index-nested-loop join replaces the inner side's table read with a per-outer-row
lookup on the join key. Before doing so it asks the storage module for a plan, and it
tells the module about two things:

- the join key equality it is about to synthesize, and
- any condition the module had **already** claimed for itself (recorded on the leaf as
  `pushedConstraints`) — this is what the just-landed
  `feat-index-nested-loop-over-pushed-constraints` added.

It does **not** tell the module about conditions that are sitting in a plain `Filter`
above the leaf — the ones the module looked at earlier and declined, or never saw. The
rule walks straight past that `Filter` on its way down to the leaf and leaves it where it
is.

## Why that loses plans

Consider `... join b on b.v = s.k where b.status = 'x'` with a single index on
`(status, v)` and no index on `status` alone. Asked about `status = 'x'` by itself, the
memory module cannot use the two-column index (it has no partial-prefix arm), so it
declines and the predicate stays as a `Filter`. The join rule then offers only
`b.v = s.k`, which that index also cannot answer alone. Result: a full read of `b` per
outer row, or no index-nested-loop at all — even though `(status, v)` answers
`status = 'x' AND v = <outer key>` exactly.

The existing test `lets the module take BOTH when a composite index covers them` only
fires because the fixture *also* creates a single-column `status` index, which gets the
predicate claimed and recorded so the join rule has something to re-offer. Measured during
the review of `feat-index-nested-loop-over-pushed-constraints`: with the single-column
index dropped and only `(status, v)` present, that query plans with **no index seek at
all** — not on the join key either, since `v` is not a prefix of the composite index. Rows
stay correct; the lookup is simply not available.

## What the feature is

Gather the conjuncts of the `Filter`s the leaf peel walks through, extract them into
constraints the same way a `WHERE` clause is extracted, and add them to the list offered
to the module — a third origin alongside the join keys and the already-claimed
predicates.

## The part that needs care

The rule's whole correctness argument is that every predicate it offers lands in exactly
one place: consumed as a lookup key, re-attached by the access-path selector, or
re-applied by the rule as a filter. A newly-offered `Filter` conjunct has a fourth
possible fate that the recorded ones do not — it is *already* applied, in the `Filter` it
came from, which the rule rebuilds above the new leaf either way. So a conjunct the module
now claims must be removed from that rebuilt `Filter`, or it is merely redundant (correct
but wasteful); and one the module declines must be left exactly where it was. Whichever
way that is resolved, it must be resolved deliberately — a rebuilt `Filter` that loses a
conjunct the module did not actually take is a wrong-answer bug.

## Expected behaviour

- A query whose inner side has a multi-column index covering `(filtered column, join key)`
  and no single-column index on the filtered column uses that index for the per-row
  lookup.
- Every shape that fires today keeps firing and returns the same rows.
- A condition the module declines is still evaluated exactly once per candidate row.
