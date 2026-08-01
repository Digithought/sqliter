---
description: The engine's new index-lookup join strategy only ever looks up the second of the two joined tables, so a query that lists the big indexed table first misses the speedup unless an earlier heuristic happens to have swapped the two.
prereq: feat-index-nested-loop-join
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
---

# Choosing which side an index-nested-loop join drives from

The index-nested-loop join added by `feat-index-nested-loop-join` only ever seeks the
**right** input. That is a deliberate v1 restriction: the nested-loop runtime drives
from the left for every join type the rule admits, and swapping the two inputs inside a
physical-selection rule would reshuffle the output row layout that the emitter's
`[...leftRow, ...rightRow]` depends on.

In practice the restriction is usually harmless, because `rule-join-greedy-commute`
runs earlier and puts the smaller input on the left — which lands the large indexed
table on the right. But that heuristic decides on row-count estimates alone. It knows
nothing about which side has a usable index, so it can commute a join into exactly the
orientation that loses the seek.

Two things could improve this, and they are not the same size:

- **Cheap:** have the physical-selection rule ask the *left* side whether it could seek
  too, and prefer the orientation that can, for `inner` joins only (the one join type
  where commuting is unconditionally sound). Requires proving the row-layout rebuild is
  safe, which is the real work.
- **Proper:** teach join-order enumeration (`rule-quickpick-enumeration`,
  `rule-join-greedy-commute`) that an indexed side is a cheaper *inner*, so the order it
  picks accounts for the seek instead of being corrected afterwards.

Worth doing once there is a measured query where the wrong orientation is chosen —
until then the greedy-commute heuristic covers the common shape.
