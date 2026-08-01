---
description: Against a remote or high-latency storage backend, doing one index lookup per row means one network round trip per row; collecting a batch of rows and asking for all their keys at once would cut that to one round trip per batch.
prereq: feat-index-nested-loop-join
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts
  - packages/quereus/src/planner/rules/parallel/rule-fanout-batched-outer.ts
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts
  - packages/quereus/src/vtab/best-access-plan.ts
---

# Batch the seeks of an index-nested-loop join

The index-nested-loop join performs one index seek per outer row. On an in-process
table that is the right shape. On a store reached over a network — the IndexedDB and
sync-backed plugins, or any module declaring a non-zero `expectedLatencyMs` — it means
one round trip per outer row, and a plain scan of the whole inner table can beat it
even though it reads far more rows.

The v1 rule handles this only by *pricing* it: per-seek latency is folded into the cost
so a high-latency inner side makes index-nested-loop lose to a hash join. That is
correct but blunt — it gives up the strategy entirely instead of making it cheap.

The engine already has both halves of the better answer:

- `rule-fanout-batched-outer` buffers a window of outer rows and issues their work
  concurrently, gated on the slowest branch's declared latency.
- `KeySetSemiJoinNode` passes a whole set of seek keys to a module in one call, via the
  `runtimeSet` field on a predicate constraint that modules already understand.

Combining them: buffer N outer rows, issue one multi-key seek for their join keys, then
match the returned rows back to the buffered outer rows. Cost drops from N round trips
to one per batch.

The awkward part is order and semantics, not mechanism. A batched seek returns rows in
seek-key order, so the join has to re-associate each returned row with its outer row and
still emit in outer order; LEFT joins must null-pad outer rows whose keys came back
empty; and the batch window is memory the streaming per-row version does not use.

Worth doing when there is a measured remote-store join where the current rule's latency
pricing has pushed it back to a full scan.
