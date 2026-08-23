---
description: The engine can overlap slow storage lookups across many rows only when each lookup returns at most one match; when a lookup can return several matches it falls back to doing them one at a time.
files:
  - packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts   # the refusal: `node.branches.some(b => isCrossBranchMode(b.mode))`
  - packages/quereus/src/runtime/emit/fanout-lookup-join.ts                # runFanOutLookupJoinBatched already handles many-row branches
  - packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts          # the `cross` / `cross-left` branch modes
  - packages/quereus/src/planner/optimizer-tuning.ts                       # maxCrossBranchRows / maxCrossProduct / maxOuterReadAhead
tradeoffs: The buffering cost is the reason it was deferred — a many-match lookup already buffers all its rows per outer row, and overlapping rows multiplies that by the read-ahead window (up to 64), so a lift needs its own memory bound and the shapes that benefit may be rare enough not to justify one.
---

# Overlap slow lookups even when a lookup can match several rows

## What is going on

The fan-out lookup join drives per-outer-row lookups. Each lookup branch is
either *at-most-one* (a key lookup — zero or one matching row) or *many-match*
(called `cross` internally — a data-driven one-to-many match, like "every line
item of this order").

Its `batched` outer mode overlaps lookups across many outer rows, which is what
makes a network-backed storage module usable: a batch of lookups costs roughly
one round trip instead of one each. The rule that turns batching on,
`ruleFanOutBatchedOuter`, **refuses any cluster containing a many-match branch**,
with a comment saying that case is owned by another ticket. That other ticket
does not appear to exist on the board.

The runtime does not have this limitation. `runFanOutLookupJoinBatched` buffers
each branch's rows and composes the product exactly as the one-at-a-time driver
does; many-match branches flow through it unchanged. The refusal is a scope
boundary, not a correctness one.

## Why it matters

Two shapes are blocked by it:

- A fan-out cluster formed by `rule-fanout-lookup-join` that mixes key lookups
  with many-match lookups stays one-at-a-time even when every branch is slow.
- An index-nested-loop join whose inner side is a *non-unique* index (the
  ordinary "fetch this order's line items" join) cannot be batched at all. The
  ticket that added batching for index-nested-loop joins
  (`feat-index-nested-loop-batched-seeks`) had to restrict itself to unique and
  primary-key lookups for exactly this reason — a many-match branch is the
  natural, proof-free way to express a lookup join, and it is unavailable.

## What a solution has to answer

- **A memory bound.** The one-at-a-time driver already buffers all of one outer
  row's matches. Batching multiplies that by the read-ahead window (clamped to
  `maxOuterReadAhead`, default 64). `tuning.parallel.maxCrossBranchRows` (10,000)
  and `maxCrossProduct` (1e6) already bound formation; the question is whether a
  batched cluster needs a tighter window, a row-count-aware read-ahead, or a
  separate cap.
- **Whether the read-ahead should shrink** when a many-match branch is present,
  rather than being an all-or-nothing gate.
- **Output order.** The batched driver's reorder buffer already emits all of one
  outer row's product rows contiguously before the next row's; confirm that
  holds for a many-match branch under out-of-order completion.

## Not in scope

This is about the *rule's* refusal, not the driver. If the driver turns out to
need changes, that is a finding worth recording, not an assumption to start from.
