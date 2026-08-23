---
description: When storage is slow to answer, the planner only counts that delay for some of the join strategies it compares, so it can pick a slower plan believing it is cheaper.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts   # the cost block and the two NOTEs being resolved
  - packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts  # gate to extract as a shared predicate
  - packages/quereus/src/planner/nodes/plan-node.ts                           # PhysicalProperties.expectedLatencyMs (first-row latency)
  - packages/quereus/src/planner/cost/index.ts                                # indexNestedLoopJoinCost already charges per-seek latency
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts                 # where the plan-shape assertions go
  - packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts           # HighLatencyMemoryModule fixture pattern to copy
  - docs/optimizer-costing.md
  - docs/optimizer-joins.md
difficulty: medium
---

# Charge every join strategy the storage delay it actually pays

## Background a newcomer needs

A virtual-table module may declare `expectedLatencyMs` — how long it takes to
produce the *first row* of an iterator opened against one of its tables. Every
in-tree module declares 0 (they are in-process); a network-backed module (the
IndexedDB plugin, the sync-backed plugin) would declare a real number.

`ruleJoinPhysicalSelection` compares five ways to run a join and picks the
cheapest:

| candidate | how often it opens the inner side |
| --- | --- |
| plain nested loop | once per outer row (unless the inner gets cached — see below) |
| hash join | once |
| merge join | once |
| index-nested-loop | once per outer row (one seek per row) |
| index-nested-loop, sides swapped | once per row of the *other* side |

Today the rule charges `expectedLatencyMs` **once** to hash and merge,
**per seek** to the two index-nested-loop orientations, and **not at all** to
the plain nested loop. Both gaps are recorded as `NOTE:` comments at the
comparison site; this ticket resolves them. Both are inert in-tree (every
shipped module reports 0), so no existing plan changes.

## The two defects

**Arm 1 — plain nested loop is charged nothing.** A plain nested loop re-opens
the inner pipeline once per outer row, paying the same first-row latency each
time, but its cost formula (`nestedLoopJoinCost`) has no latency term. So the
moment a module reports a non-zero latency, plain nested loop can beat a
strictly cheaper index-nested-loop that *is* charged.

The complication is `ruleNestedLoopRightCache`, which runs later in the same
pass and wraps a pure, uncorrelated, small-enough inner side in a `CacheNode` —
turning N re-opens into one open plus N buffer replays. When that rule will
fire, the plain nested loop really does pay the latency only **once**, and
charging it per outer row is a large over-charge. Worked example with
`expectedLatencyMs = 25`, 20,000 outer rows and a 10-row inner: the cached plan
costs about 40,000 engine units, an unconditional per-row charge prices it at
about 540,000, and the index-nested-loop it would then lose to costs about
536,000 — a 13x worse plan chosen on a wrong number. So the charge must be
conditional on whether the cache rule would fire.

**Arm 2 — the orientation charge is hard-coded to the right side.** Hash and
merge are charged `node.right`'s latency; the swapped index-nested-loop seeks
the *left* input and is charged the left's latency per seek, while nothing
charges the left's latency to hash or merge. A high-latency left against a
zero-latency right therefore lets the swapped orientation look cheaper than
hash by dodging a charge hash never paid either. Each candidate must be charged
its own inner side's latency.

## What to build

Both arms land in the same ~40-line cost block in
`rule-join-physical-selection.ts`; they are one change, not two.

### Extract the cache-rule gate

`ruleNestedLoopRightCache` currently interleaves its gates with its rewrite.
Split it: an exported predicate that answers "would this join's right side be
Cache-wrapped?", and a rule body that calls the predicate and then builds the
`CacheNode`. Suggested surface:

```ts
// rule-nested-loop-right-cache.ts
export function canCacheNestedLoopRight(node: JoinNode, context: OptContext): boolean;
```

It carries the existing gates verbatim: the driver gate (`right`/`full`
excluded), already-cached, purity, determinism, correlation, the CTE-safety
gate, and the `join.maxRightRowsForCaching` size gate over `estimateRightRows`.
The rule keeps its logging and its `withChildren` rebuild.

This is the single source of truth for the question; `ruleJoinPhysicalSelection`
must not restate any of those gates.

### Charge each candidate its own opens

Let `leftLatency = node.left.physical.expectedLatencyMs ?? 0` and
`rightLatency = node.right.physical.expectedLatencyMs ?? 0`. Every candidate
opens its outer side once and its inner side either once or per outer row:

```
plain nested loop  += leftLatency + (canCacheNestedLoopRight(node, context)
                                       ? rightLatency
                                       : leftRows * rightLatency)
hash               += leftLatency + rightLatency
merge              += leftLatency + rightLatency
index-nl           += leftLatency          // per-seek term already inside indexNestedLoopJoinCost
index-nl mirrored  += rightLatency         // per-seek term already inside, keyed on leftLatency
```

The mirrored candidate is already fed `leftLatency` as its per-seek latency
inside `tryIndexNestedLoop` (its inner side *is* `node.left`) — confirm that
rather than assume it, and delete the second `NOTE:` once it holds.

Delete the `rightLatencyMs` local and both resolved `NOTE:` blocks. Leave one
short comment stating the rule: *every candidate is charged one open of its
outer side plus however many opens of its inner side it performs.*

### Known imprecision to record, not fix

`canCacheNestedLoopRight` predicts a rule that has not run yet. One case it
predicts wrong: an impure right side that `mutating-subquery-cache` (which also
runs after physical selection) will wrap. The purity gate answers "not
cacheable", so the plain nested loop is over-charged there. It is unreachable in
practice — index-nested-loop declines an impure inner outright and the hash
side-swap refuses too, so the over-charge has no cheaper rival to hand the win
to. Record it as a `NOTE:` at the call site rather than as a ticket.

## Edge cases & interactions

- **Zero latency everywhere (the whole in-tree suite).** Every added term is 0.
  The full golden-plan sweep must be byte-identical — this is the primary
  regression guard.
- **`exists … as` existence joins.** Hash and merge are unavailable (they drop
  the appended flag column), so the early return compares only plain nested loop
  against index-nested-loop. This is the *one* shape where arm 1 decides the
  plan outright; both the cacheable and non-cacheable branches need a test.
- **Cacheable vs non-cacheable inner.** Drive both: a small pure inner (cache
  fires, latency charged once) and an inner over
  `tuning.join.maxRightRowsForCaching` (cache declines, charged per outer row).
- **A `right` or `full` join.** `canCacheNestedLoopRight` returns false for
  them, but `ruleJoinPhysicalSelection` already returns null before the cost
  block for those types — confirm no path reaches the predicate with them.
- **Correlated inner side.** `readsColumnsOf(node.right, node.left)` returns
  early before the cost block, so the rule's own index-nested-loop output is
  never re-priced. Do not disturb that early return.
- **Both sides high-latency.** Every candidate gains a term; assert the
  *ordering* of candidates rather than absolute costs.
- **Un-analyzed row counts.** `leftRows`/`rightRows` collapse 0 to the 100-row
  default. With latency present, a 100-row default outer multiplies the plain-NL
  charge by 100 — check that a table with no statistics does not flip a plan
  that a real count would not have flipped.
- **`estimateRightRows` walks the whole right subtree** on every physical
  selection of a join, where before it ran only when the cache rule fired.
  Keep it off the hot path by short-circuiting: skip the predicate call entirely
  when `rightLatency === 0`.

## Tests

In `test/optimizer/index-nested-loop.spec.ts` (or a sibling spec), using the
`HighLatencyMemoryModule` fixture pattern from
`test/optimizer/parallel-fanout-batched.spec.ts` (`readonly expectedLatencyMs = 25`):

- `exists … as` join, high-latency small pure inner: plan keeps the plain nested
  loop and a `CacheNode` over the inner (latency charged once).
- `exists … as` join, high-latency inner too large to cache: plan switches to
  the index-nested-loop (per-outer-row charge now applies).
- High-latency LEFT input, zero-latency right, inner join with an index on the
  left's join column: the swapped index-nested-loop no longer wins over hash;
  assert the chosen physical node.
- Zero-latency control for each of the above: same plan as before the change.
- The full `yarn test` golden-plan sweep unchanged.

## TODO

- Extract `canCacheNestedLoopRight` from `ruleNestedLoopRightCache`; rule body
  becomes gate-call plus rewrite.
- Rewrite the latency charging in `ruleJoinPhysicalSelection` per the table
  above; short-circuit the predicate when `rightLatency === 0`.
- Verify the mirrored candidate is fed `leftLatency` as its per-seek latency.
- Delete both resolved `NOTE:` blocks; add the one-line rule comment and the
  impure-right `NOTE:`.
- Add the plan-shape tests above.
- Update `docs/optimizer-costing.md` (how latency enters join costs) and
  `docs/optimizer-joins.md` (the per-candidate charge table).
- Run `yarn build`, `yarn lint`, `yarn test`.
