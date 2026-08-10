---
description: The "as of" join finds the nearest earlier or later row by comparing the match column as plain text, so a duration column would be matched in the wrong order — unverified, but the code says so and there is no test either way.
files:
  - packages/quereus/src/runtime/emit/asof-scan.ts   # match/partition comparators and the existing NOTE
  - packages/quereus/src/planner/rules/join/rule-asof-strategy-select.ts
  - packages/quereus/src/util/comparison.ts          # createSemanticValueComparator / semanticOrderingsAgree
difficulty: medium
repro: static
severity: wrong-result
likelihood: contrived
tradeoffs: Unreproduced and only reachable with a TIMESPAN or JSON match column, while every canonical AS OF column type (DATE/DATETIME) already orders correctly as text - so a maintainer may prefer to refuse those types and document the restriction.
---

# "As of" join compares its match column as text, ignoring types that order by meaning

## Background

A few column types define their own order that is not the order of the stored text —
`docs/types.md` § "Semantic ordering" is the reference. `TIMESPAN` orders by elapsed time
(`'PT90M'` is less than `'PT2H'`, though the text sorts the other way) and `JSON` orders
by document structure. Everywhere else in the engine — `ORDER BY`, `<`/`>`/`=`, index and
primary-key order, `GROUP BY`, `DISTINCT`, window ordering, and (after ticket
`mixed-type-equi-join-key-drops-semantic-matches`) equi-join keys — those types are
compared through their own rule.

The "as of" join is the remaining hole. It picks, for each left row, the nearest right row
at or before (or after) the left row's match value, so it is entirely built on ordering.
It compares the match column, and the partition columns it groups by, with the plain
storage-class-and-collation comparison.

`runtime/emit/asof-scan.ts` says so in its own words:

> NOTE: AS OF match/partition compares are storage-class + collation, not
> semantic-ordering-aware. Correct for the canonical AS OF column types (DATE/DATETIME —
> canonical ISO text order IS their semantic order). A TIMESPAN or JSON match column would
> order by text here, disagreeing with `<`/ORDER BY.

## Status: not reproduced

This ticket is filed from reading the code, not from a failing query — nobody has written
an "as of" join over a duration or JSON match column and checked. **First task is to
confirm or refute it** with a small test; if the behavior turns out to be fine, close the
ticket and replace the NOTE with what was measured.

## Two distinct problems, if confirmed

1. **Both sides declare the same semantic-ordering type.** The comparator should be that
   type's own, exactly as merge join and the hash join already do for their keys. Should
   be a contained change.
2. **The two sides declare different types** — one duration, one plain text. Then the two
   inputs are physically sorted in *different* orders, and no single comparator can walk
   them together. The equi-join fix handles the equivalent case by refusing the fast
   algorithm and letting the general comparison evaluate the condition, but "as of" has no
   such fallback — every strategy for it needs ordered inputs. So the choice is to sort
   one side into the other's order, or to reject the query with a clear message. That is a
   design decision, not a mechanical fix.

Whoever picks this up should also check whether the strategy-selection rule
(`rule-asof-strategy-select`) needs to participate: it validates physical input ordering,
and that ordering property records only column and direction, not which comparison rule
produced it.
