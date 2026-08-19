---
description: When a query joins three or more tables, the database picks the join order by trying candidates until a 100-millisecond timer runs out — so a slow or busy computer can end up running a different plan for the same query than a fast one, and the same query can plan differently twice on one machine.
files:
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts   # the wall-clock-bounded loop
  - packages/quereus/src/planner/optimizer-tuning.ts                        # maxTours / timeLimitMs / enabled defaults
  - docs/quickpick-design.md                                                # documents the time limit as an intended tunable
difficulty: medium
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The time limit exists to stop a pathological join graph from hanging the planner, so removing it trades a bounded worst-case planning latency for reproducibility, and a maintainer who cares more about never stalling than about identical plans may prefer it exactly as it is.
---

# What happens

Quereus chooses the order in which tables are joined by generating candidate orderings one
at a time and keeping the cheapest one it has seen. The loop stops when either 100
candidates have been tried or 100 milliseconds have elapsed, whichever comes first.

The candidates themselves are generated deterministically — candidate number 7 is always
the same candidate. What is *not* deterministic is how many candidates get generated. A
fast, idle machine may get through all 100; a slow or heavily loaded one may stop at 60
and keep the best of those 60. If the better ordering happened to be candidate 80, the two
machines run different plans for the identical query against identical data.

The same reasoning applies to one machine twice: a run competing with a compile or a test
suite can plan differently from a run on an idle box.

This is not a wrong-answer bug. Both plans return the same rows. What is lost is
**reproducibility**: the plan a query gets is a function of how fast the machine was that
day, so `explain` output, plan-shape assertions, and any checked-in expectation about how a
query executes are all conditional on hardware and load.

# When it is reachable

- Only joins of **three or more relations**. The rule returns early below that.
- Enabled by default (`enabled: true`, `minTriggerCost: 0`), so no opt-in is required.
- The time limit only actually binds when 100 candidate orderings cost more than 100 ms to
  evaluate — a large join graph, a slow machine, or a loaded one. On a small three-table
  join on an idle machine all 100 candidates finish comfortably inside the budget and the
  behaviour is stable, which is why this has not been noticed.

Not observed in a failing run; read from the code and the defaults. What would confirm it
directly: run a many-relation join with `timeLimitMs` set very low and again with it set
high, and compare the chosen plan.

# Why it matters now

The benchmark work-counter feature, and the regression gate planned on top of it, are both
built on the premise that a work counter is a property of the query and the data and *not*
of the machine — that is the entire reason counters are compared as exact integers with no
tolerance while timings need a noise floor. A wall-clock-bounded planner is a direct
counterexample to that premise for any query with a three-way join. Today's benchmark
suite has no such query, so its counters really are stable; the premise is unproven rather
than violated. See the review arm on `bench-regression-gate`.

# What "fixed" would mean

The planner's search budget should be expressed in units that do not depend on how fast the
machine is — candidate count, or nodes visited — so that the same query against the same
statistics yields the same plan everywhere. A wall-clock limit can remain as a safety valve
against a genuinely pathological graph, but if it is what stopped the search, that should be
an exceptional, visible event (logged, and ideally surfaced) rather than the ordinary
mechanism by which the search ends.

Worth settling as part of the same change: whether a search that hits the safety valve
should be allowed to serve a plan at all, or whether the planner should instead fall back to
a fixed, deterministic ordering heuristic so that "the plan was chosen under time pressure"
never silently becomes "the plan is whatever the clock allowed".
