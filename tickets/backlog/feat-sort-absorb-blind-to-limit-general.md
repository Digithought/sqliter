---
description: A user-written "order by ... limit n" still tells the storage backend nothing about the limit, because the rule that asks the backend can only see downward from the sort and the limit sits above it. Only the engine-synthesized MIN/MAX case was fixed.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts  # trySortAbsorbViaIndexOrdering — now takes `rowsWanted`, but ruleGrowRetrieve's own Sort call site has nothing to pass
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # the one caller that CAN pass it, and does
  - packages/quereus/src/vtab/best-access-plan.ts  # BestAccessPlanRequest.limit / .offset and the truncation contract
tradeoffs: Reaching a LIMIT that sits above a Sort means either walking upward from a rule that looks only downward, or introducing a fused sort-and-limit plan node. Both are real structural changes, and the payoff is confined to backends whose point reads are expensive — on a cheap-pointRead backend the ordered plan already wins without knowing the limit.
---

# `order by n limit 1` still reaches the module without its limit

## What was fixed, and what was not

`feat-sort-absorb-blind-to-limit` established the mechanism and the plumbing:
`trySortAbsorbViaIndexOrdering` now accepts an optional `rowsWanted`, populates
`BestAccessPlanRequest.limit` / `.offset` when it can prove truncation is safe, and the
store prices its seek arms, its ordering walk and its full scan against that bound
whenever the plan provides the required ordering.

It fixed exactly one caller: `ruleMinMaxIndexBoundary`, which synthesizes its own
`LimitOffset(1)` and therefore *knows* the limit before it probes.

A limit the **user** wrote is still invisible. `ruleGrowRetrieve` reaches
`trySortAbsorbViaIndexOrdering` from the `SortNode` itself, and the `LimitOffsetNode` sits
above that Sort. The rule walks only downward — through Project and Filter to the
Retrieve — so it has nothing to pass, and passes nothing.

So `select * from t where entity_id = ? order by date limit 10` is still priced as
`order by date`: the module is asked what a whole-table ordered read costs, and a backend
with an expensive `pointRead` still answers "cheaper to scan and sort".

## Why this is now smaller than it was

The hard half is already done and is not up for redesign:

- the truncation-safety rule (every conjunct of every Filter below the Sort must be
  covered by a constraint the plan reported handled) and its helper;
- the two-phase probe-then-validate flow;
- the tightened `request.limit` contract;
- the store's limit-aware pricing on all three sites, gated on providing the ordering;
- the cost-profile-parameterized test harness that makes any of this observable at all.

What remains is only **getting the number to the call site**. The two routes named on the
original ticket are unchanged:

- teach the rule to look *upward* through the Sort for a `LimitOffsetNode` with constant
  limit and offset — no rule in `rule-grow-retrieve.ts` does that today;
- or introduce a fused sort-and-limit plan node, so the limit is part of the node the rule
  already matches on.

The second is the larger change and the one that also removes the `Literal(null)` OFFSET
refusal dance in `buildRequest`. The first is cheaper and strictly additive.

## Testing

Same constraint as the parent ticket, for the same reason: **invisible on the memory
backend by construction.** At a cheap `pointRead` the ordered plan wins even priced
whole-table, so a memory-backend test cannot fail on this. Extend the
cost-profile-parameterized cases added for the parent rather than writing plain plan tests.

## Related

- `feat-sort-absorb-blind-to-limit` — the parent; carries the design, the soundness rule
  and the GitHub #31 evidence.
- GitHub issue #31 — the reporter's `MIN` case is covered by the parent. Their broader
  `order by … limit` shapes on the IndexedDB backend are covered by this one.
