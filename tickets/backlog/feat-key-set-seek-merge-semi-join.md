---
description: When a query filters a table by a set of values on its primary key, the engine currently walks both tables in key order and merges them; instead it could collect the set first and look up just those rows, reading far less of the big table.
prereq: feat-key-set-semi-join
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
difficulty: hard
---

# Extend the key-set seek rewrite to merge semi joins

`rule-key-set-seek` anchors on the physical hash semi join only. But the most
common `IN`-subquery shape — `delete from big where id in (select id from small)`,
where the join key is the primary key — never becomes a hash join on the memory
or store backends: both sides advertise a monotonic walk on the key, so
`monotonic-merge-join` (or ordering-based selection) turns it into a **merge**
semi join first. The merge join still reads every row of `big`; a key-set
multi-seek would read only the matching rows.

## Why this was split out

Extending the anchor is not a copy-paste of the hash arm:

- A merge semi join **propagates the probe side's ordering** upward
  (`analyzeJoinKeyCoverage`), so plans above it may have had a Sort elided on
  the strength of the join's output order. `KeySetSemiJoinNode` deliberately
  claims no ordering — replacing a merge join with it can strand such a plan
  without its Sort. The hash-join anchor is immune (a hash join claims no
  ordering), which is why the first ticket stopped there.
- When the seek index IS the index both sides walk (the PK case), a pushed
  multi-seek with ascending sorted keys emits in exactly the merge join's
  output order — so the node could legitimately claim the ordering in that
  configuration. That equivalence (seek index = walk index, ascending keys,
  forward direction) is the load-bearing argument this ticket must pin down
  before the rewrite is sound.
- Cost: a merge join is already O(N + K) with no hash build; the win here is
  only the reduced target read volume, so the break-even may differ from the
  hash case.

## Expected behaviour

- `delete from big where id in (select id from small)` (PK key, memory or
  store backend) reads only the matching rows of `big` when the set is small.
- Every gate the hash arm applies (types, collation cover, semantic ordering,
  pristine leaf, uncorrelated deterministic key source) applies here too.
- Any ordering consumer above the join keeps getting correctly ordered rows —
  including plans where a Sort was elided against the merge join's output
  order.
- Note: the store module currently declines runtime-set `IN` on its primary
  key (`backlog/feat-store-pk-in-list-multiseek`); the PK case on the store
  backend needs that ticket to land before this one can fire there.
