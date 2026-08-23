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
