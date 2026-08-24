---
description: The planner assumes reading a whole table from slow storage costs one network delay, but some storage answers one row per request, so those plans are priced far cheaper than they run.
files:
  - packages/quereus/src/vtab/module.ts                                      # expectedLatencyMs — the only latency a module can declare
  - packages/quereus/src/planner/nodes/plan-node.ts                          # PhysicalProperties.expectedLatencyMs, defined as first-row latency
  - packages/quereus/src/planner/nodes/reference.ts                          # where a leaf picks the module's declared value up
  - packages/quereus/src/planner/cost/index.ts                               # the join cost functions that consume it
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # where scan-once and seek-per-row plans are compared
  - docs/optimizer-costing.md
  - docs/module-authoring.md
tradeoffs: A second latency knob is one more thing every module author has to reason about and every cost formula has to thread, and the only plans it changes are ones no in-tree module can produce — so a maintainer may reasonably want a real remote plugin declaring it before adding the surface.
---

# A storage module cannot say that reading each row costs a round trip

## The gap

A virtual-table module can declare `expectedLatencyMs` — one number, documented
as *first-row* latency: how long it takes an iterator opened against one of its
tables to produce its first row. That is the only latency the engine knows about.

Every cost formula that consumes it therefore charges a full table scan **one**
latency. For storage that streams a whole table in a single response, that is
right. For storage that answers one row per request — an IndexedDB cursor is the
concrete case that prompted this — reading 100,000 rows costs 100,000 round
trips, and the planner prices it as one.

## What it costs in practice

The engine compares a hash join (scan the inner side once, build a hash table)
against an index-nested-loop join (one keyed lookup per outer row). Under the
current model the hash join pays the latency once and the seek plan pays it per
row, so hash wins nearly every shape where both are available. On per-row storage
the truth is often the reverse: the hash join's "one scan" is thousands of round
trips and the seek plan's per-row cost is what the batched fan-out driver is
already able to overlap.

The report that surfaced this measured, for one query shape, roughly 200 ms of
engine time at 20,000 rows against roughly 2,560 ms through IndexedDB. The engine
half is real but is the smaller half; the plugin's one-row-per-request reads
dominate, and nothing in the cost model can express that.

## What a solution would need

- **A way for a module to say it.** Whether that is a second field beside
  `expectedLatencyMs` (a per-row or per-batch latency), a shape on the access
  plan the module returns (so it can differ per index and per query), or a
  declared read granularity, is the open question.
- **Which formulas consume it.** Scan cost, join costs, and anything that
  currently treats "open the inner side once" as cheap.
- **Keeping it a heuristic.** `expectedLatencyMs` is explicitly documented as a
  hint that correctness must never depend on; a second knob must inherit that.
- **Staying inert in-tree.** Every shipped module is in-process; whatever lands
  must leave the golden-plan sweep untouched.

## Not this ticket

Making the seek path cheaper once it is chosen — that is
`feat-index-nested-loop-batched-seeks`, which is about overlapping the lookups.
This ticket is about the engine being able to *know* that a scan is expensive in
the first place.

## Evidence — this gap actively blocks IndexedDB from declaring any latency

Added 2026-08-24 while investigating `fix/1-bug-store-module-never-declares-latency`
(now `implement/1-store-module-latency-hint-wiring`), which set out to declare a
measured `expectedLatencyMs` on the IndexedDB provider and concluded it must not,
*because of this gap*. That makes the missing scan-side knob not merely a
refinement but the thing preventing the existing knob from being used at all on
the backend it was pointed at.

The mechanism, from the measurements in
`packages/quereus-plugin-indexeddb/bench/README.md`:

- IndexedDB's real first-row latency is **0.3-2.3 ms** (arm B's smallest whole
  round trip, 0.4 ms at 20k rows and 2.0-2.5 ms at 100k, minus the row payload at
  the measured full-scan rate). That is 10-80x below every threshold that turns
  the parallel machinery on — `batchedOuterThresholdMs`, `gatherThresholdMs` and
  `prefetchProbeThresholdMs` all default to 25 ms
  (`packages/quereus/src/planner/optimizer-tuning.ts:284`). So an honest
  declaration cannot enable batched seeks, gathers, or prefetch on this backend.
- The one shared formula it *does* reach is `indexNestedLoopJoinCost`
  (`packages/quereus/src/planner/cost/index.ts:164-172`), which charges it per
  outer row to the **seek** plan. Hash join reads the field nowhere and pays zero.
  So the only effect of an honest declaration is to make index-nested-loop look
  worse against hash join — and on IndexedDB the hash join's single inner scan is
  the catastrophic arm (bench arm C: 93-1,180 ms, against 0.4-512 ms for the index
  arms), precisely because it is thousands of round trips priced as one.

So the sign is backwards: telling the planner the truth about IndexedDB's
first-row latency, with the scan side's per-row latency still unmodeled, makes
its plans worse. Whatever lands here should be re-derived jointly with a
first-row number for IndexedDB, not after it.

One further constraint this investigation surfaced, for whoever designs the
second knob: `expectedLatencyMs` is already read on two incompatible scales — the
25 ms gates treat it as literal wall-clock, while `indexNestedLoopJoinCost` adds
it to unitless cost constants under the "one unit of `expectedLatencyMs` is one
engine cost unit" convention (`docs/optimizer-costing.md:78`), where one unit is
one scanned row (`SEQ_SCAN_PER_ROW = 1.0`). Those agree only when a scanned row
costs about 1 ms; on IndexedDB it costs 0.0047-0.011 ms, a ~100x disagreement.
The convention holds for the 25-100 ms network backends it was designed for and
breaks for sub-millisecond ones. A second knob that inherits the same convention
inherits the same break.
