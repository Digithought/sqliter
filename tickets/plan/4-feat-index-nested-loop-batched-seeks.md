---
description: For storage that lives across a network, doing one lookup per row means one round trip per row; design a way to overlap those lookups so a batch costs about as much as a single trip.
prereq: feat-index-nested-loop-seek-side-election
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts             # where the seek candidate is built
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # the latency-charging asymmetry NOTE lives here
  - packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts     # the shipped batched-outer flip
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts       # the shipped cluster-formation rule
  - packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts            # branch modes; requires >= 1 branch
  - packages/quereus/src/runtime/emit/fanout-lookup-join.ts                  # serial and batched drivers
  - packages/quereus/src/planner/optimizer-tuning.ts                         # parallel.* thresholds
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts             # the one-call-many-keys shape, for comparison
  - packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts          # the synthetic-latency test-module pattern
difficulty: hard
---

# Batching the per-row seek for high-latency storage

## The problem

The index-nested-loop join issues one index seek per outer row. On an in-process table
that is the right shape. On storage reached over a network — the IndexedDB and
sync-backed plugins, or any module declaring a non-zero `expectedLatencyMs` — it is one
round trip per outer row, and a plain scan of the whole inner table can finish first
even though it reads far more rows.

The shipped rule handles this only by **pricing** it: `indexNestedLoopJoinCost` folds
per-seek latency into the cost, so a high-latency inner side makes index-nested-loop lose
to a hash join. Correct, but blunt — it abandons the strategy rather than making it cheap.

Scale note, from the downstream report this came from: for their query shape the engine-only
cost was about 200 ms at 20,000 rows against about 2,560 ms through IndexedDB. The engine
half is real but is the smaller half; the plugin's one-row-per-cursor-request reads dominate.
Weigh that when deciding how much machinery this deserves.

## Why this needs its own design pass rather than an implement ticket

Three things are unresolved, and two of them can only be settled by reading emitter code
that no part of the index-nested-loop feature currently touches.

### Blocker first: today the seek never even fires under latency

`rule-join-physical-selection` charges the inner side's `expectedLatencyMs` once to hash
and once to merge, per-seek to index-nested-loop, and **not at all** to the plain nested
loop — even though the plain nested loop re-opens the inner side per outer row and pays
exactly the same latency. So the moment a module reports non-zero latency, plain nested
loop can beat the strictly cheaper index-nested-loop, and there is no seek left to batch.
This is already recorded as a `NOTE:` at the comparison site, with the intended fix
(charge plain nested loop `outerRows * latency`). **Any batching work has to land that fix
first, or it cannot be observed.** Decide during design whether it is arm one of this
ticket or a separate small ticket that precedes it.

### Option 1 — reuse the fan-out lookup join's batched driver

`FanOutLookupJoinNode` already drives per-outer-row lookup branches, and
`rule-fanout-batched-outer` already flips such a node from `serial` to `batched`
(pipelining lookups across outer rows, with a read-ahead window, a shared in-flight
budget, a reorder buffer that restores outer order, and an `EagerPrefetchNode` wrapped
around the outer for context isolation). If the index-nested-loop rewrite produced a
one-branch `FanOutLookupJoinNode` instead of keeping the logical `JoinNode`, batching
would come for free.

What was verified while planning:

- The node itself accepts a single branch (`branches.length < 1` is the only guard). The
  `minBranches: 2` threshold belongs to `rule-fanout-lookup-join`'s *formation* decision,
  not to the node.
- `rule-fanout-batched-outer`'s gates would pass for this shape: one branch is under
  `outerBatchConcurrency` (16); the latency gate wants the slowest branch at or above
  `batchedOuterThresholdMs` (25), which is the case by hypothesis; the cardinality gate
  wants at least `batchedOuterMinRows` (256) outer rows.
- Output layout matches: fan-out emits outer attributes followed by branch attributes,
  which is the join's `[...leftRow, ...rightRow]`.

What the design pass must settle:

- **Branch mode.** `rule-fanout-batched-outer` explicitly refuses `cross` and `cross-left`
  branches (their batched mode is owned elsewhere). So only a provably at-most-one seek
  qualifies — a unique or primary-key seek. Work out how to prove that from the access
  plan the module returned (unique index, or `rows <= 1`), and accept that a non-unique
  secondary-index seek is out of scope until cross-mode batching lands.
- **Where the ON condition goes.** Index-nested-loop deliberately retains the ON condition
  on the join as an over-fetch safety net. A fan-out branch has no residual slot, so it
  would have to become a `Filter` inside the branch child. Confirm that a filter inside the
  branch does not disturb the at-most-one claim (it cannot add rows) and that the emitter's
  NULL-pad path still behaves for `atMostOne-left`.
- **Which join types.** Fan-out has no semi or anti mode and no existence-flag support, so
  `semi`, `anti` and `exists … as` joins keep the serial `JoinNode`. Only `inner` →
  `atMostOne-inner` and `left` → `atMostOne-left`.
- **Who decides.** Gate-based, in the spirit of the other parallel rules (inert when
  latency is 0), or cost-based with a batched cost formula. Gate-based is the cheaper and
  more consistent answer; say so explicitly if that is the choice.

### Option 2 — a dedicated batched nested-loop driver

A new physical node and emitter that buffers a window of outer rows and runs their inner
pipelines concurrently. This is what option 1 gets for free, so it is only worth it if
option 1 turns out to be blocked — for instance if the fan-out branch contract cannot
carry a correlated `IndexSeek` whose provenance is not FK→PK. The
`rule-fanout-batched-outer` header documents the hazards any such driver has to handle
(shared `RuntimeContext` mutation during a concurrent pump, strict-fork violations under
nesting); re-deriving them in a second driver is the expensive part.

### Not the answer: one call with many keys

`KeySetSemiJoinNode` hands a module a whole set of seek keys in one call via the
`runtimeSet` field on a predicate constraint — which is the *ideal* number of round trips,
one per batch rather than one per row. But it is a semi-join shape: it restricts which
inner rows are read and then probes, so recovering a general inner join from it means
either reading the outer twice or materializing it. For `where x in (select …)` that path
already exists and already fires (`rule-key-set-seek`). Record why it does not generalize
rather than leaving the next reader to rediscover it.

## How to measure it

No shipped module declares a non-zero `expectedLatencyMs`, so this is inert in-tree by
construction and cannot be timed against the memory or store modules. The existing
convention is a synthetic module in the spec file that declares
`readonly expectedLatencyMs = 25` — see `test/optimizer/parallel-fanout-batched.spec.ts`,
`parallel-eager-prefetch-probe.spec.ts`, `parallel-async-gather.spec.ts`. Decide whether
plan-shape assertions against such a module are sufficient evidence, or whether the design
also needs a module that actually *sleeps* so the wall-clock win is demonstrated once.
Note that `bench/` suites run in CI-adjacent territory; a benchmark that only moves for a
non-existent module class is probably not worth adding.

## What this plan pass should produce

One implement ticket if option 1 holds up, sized to a single agent run — plus, if the
latency-charging fix is separated out, a small ticket ahead of it. If option 1 turns out
to be blocked, an implement ticket for the narrowed scope you *can* defend, and an honest
statement of what is left.

## TODO

- Read `runtime/emit/fanout-lookup-join.ts` (both drivers) and
  `nodes/fanout-lookup-join-node.ts` in full; establish whether a branch child may be a
  correlated `IndexSeek` with no FK→PK provenance.
- Settle the at-most-one proof from a `BestAccessPlanResult`.
- Settle where the retained ON condition lives.
- Settle gate-based versus cost-based selection, and write the gates out.
- Decide the ordering of the latency-charging fix relative to the batching work.
- Confirm the batched driver's output-order guarantee (the node's doc says both modes emit
  in outer order) still holds for a single-branch cluster.
- Emit the implement ticket(s) with an `## Edge cases & interactions` section covering at
  minimum: zero-match outer rows under `atMostOne-left`, an outer smaller than the
  read-ahead window, a non-`concurrencySafe` inner module, nesting inside another fan-out,
  and the interaction with `feat-index-nested-loop-over-pushed-constraints`'s reattached
  `Filter` sitting inside what would become the branch child.
