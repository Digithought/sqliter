---
description: The code that picks how to run a join has grown into one very long function, and each new way of running a join has to be pasted in three separate places, so it is easy to add a fourth spot and forget one.
prereq: feat-index-nested-loop-batched-seeks
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts
  - docs/optimizer-joins.md
tradeoffs: A reader comparing join strategies wants all of them visible side by side in one place, and splitting the function across helpers can make that harder rather than easier — a maintainer may reasonably prefer the long-but-linear form until it actually causes a bug.
---

# The join-strategy comparison repeats itself once per strategy

## What it looks like today

`ruleJoinPhysicalSelection` is one function running lines 150–443 of
`rule-join-physical-selection.ts` — 294 lines, of which about 145 are code
(measured with `awk 'NR>=147 && NR<=443' <file> | grep -vcE '^\s*(//|\*|/\*|\*/)?\s*$|^\s*(//|\*|/\*)'`).
It does, in one straight line: guard the node, pull the equality pairs out of
the ON condition, estimate both sides' row counts, work out each strategy's
storage-delay charge, build up to four candidate strategies, take an early exit
for one special join shape, compare everything, and then construct whichever of
three different plan shapes won.

Adding a strategy means touching three separate spots that must stay in step:

- a `const <name>Cost = …` line that folds in that strategy's own charges,
- an `if (<name>Cost < bestCost) { bestAlgo = …; bestCost = … }` block whose
  position in the sequence silently decides who wins an exact tie,
- an entry in the debug log's format string and its parallel argument array.

The format string and the argument array are two separate literals that have to
be kept in the same order by hand.

## Why now

Five strategies are in there already. The in-flight ticket
`feat-index-nested-loop-batched-seeks` adds a sixth. This review found a real
mis-pricing in the charge lines, and the reason it was hard to see is that each
strategy's charge is a free-standing expression rather than a field of a thing
that names what it is.

## What "done" looks like

Each candidate strategy becomes one value carrying its own name, its cost, and
how to build the winning plan — and the comparison becomes a single pass over
those values. The tie-break rule (first-listed wins an exact tie, which today
keeps the un-mirrored orientation and the plain nested loop) must be preserved
exactly and stated where the list is built, because it is load-bearing: the
golden plan sweep depends on ties resolving the way they do now. The debug line
should derive from the same list rather than from a hand-kept parallel array.

No plan should change. This is a shape change only.
