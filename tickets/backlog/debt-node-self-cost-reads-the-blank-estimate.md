description: Every plan step estimates its own cost from a table-size number that is not available yet, so it silently uses a placeholder instead. The optimizer's cost comparisons are therefore much blunter than they look — a join between a ten-row table and a two-thousand-row table is costed identically to one between two ten-row tables.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts             # `estimatedCost` is a constructor value; `getTotalCost()` sums it
  - packages/quereus/src/planner/nodes/join-node.ts             # ~139 — the measured instance
  - packages/quereus/src/planner/nodes/bloom-join-node.ts       # ~46
  - packages/quereus/src/planner/nodes/merge-join-node.ts       # ~45
  - packages/quereus/src/planner/nodes/asof-scan-node.ts        # ~93
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts # ~134
  - packages/quereus/src/planner/nodes/sort.ts                  # ~49
  - packages/quereus/src/planner/nodes/filter.ts                # ~51
  - packages/quereus/src/planner/nodes/distinct-node.ts         # ~23
  - packages/quereus/src/planner/nodes/aggregate-node.ts        # ~129
  - packages/quereus/src/planner/nodes/hash-aggregate.ts        # ~36
  - packages/quereus/src/planner/nodes/stream-aggregate.ts      # ~36
  - packages/quereus/src/planner/util/row-estimates.ts          # physicalSourceRows — the read these sites want
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts # the consumer this blunts
difficulty: hard
tradeoffs: Fixing it means changing how a node's self-cost is produced (it is a plain readonly number set in the constructor today), which touches every node class and every cost expectation pinned in the plan tests; a maintainer could reasonably say the physical selection rules — which compute their own costs from real numbers — already carry the decisions that matter, and that only QuickPick's tour comparison is affected.

# A node's self-cost is fixed before the numbers it needs exist

## What a plan step's cost is made of

Each plan step carries a **self-cost**: roughly "what this step costs on top of
what its inputs cost". `getTotalCost()` adds a step's self-cost to the totals of
everything below it, and several optimizer decisions compare those totals.

A step's self-cost is set once, in its constructor, from its inputs' row counts.
But a row count has two spellings in this codebase:

- the **logical** one (`estimatedRows`), available before optimization;
- the **physical** one (`physical.estimatedRows`), folded bottom-up during the
  Physical pass and the only one a table-backed input ever fills in.

Constructors can only read the logical one — physical properties do not exist yet
when a node is constructed. And the logical one is blank for every table-backed
input: the optimizer replaces the table subtree with an access node
(`SeqScan` / `IndexScan` / `IndexSeek`, wrapped in `Alias` / `Retrieve`) and none
of those declares the logical getter. So the constructor falls through to its
hardcoded default, every time.

## What that costs, measured

`JoinNode`'s constructor:

```ts
const leftRows = left.estimatedRows ?? 100;
const rightRows = right.estimatedRows ?? 100;
const joinCost = leftRows * rightRows;
```

For any join whose two sides are table-backed this is `100 * 100 = 10000`,
whatever the tables actually hold.

Measured on the memory backend (400-row `txn`, 800-row `entry`, 40-row `cat`, all
`ANALYZE`d, three-way join): the plan's `getTotalCost()` came to 20406, of which
20000 was the two joins' self-cost — a number that would not move if the tables
held ten rows or ten million. The same query planned with a hash join above
instead reported 10526, and the whole 10000 difference was one node's constant.
Two plans were compared on a number neither of them earned.

The same read appears in at least twelve node constructors (list above); the
default varies (`?? 100`, `?? 1000`, `?? 1`) but the outcome does not.

## Why this is worth a ticket rather than a comment

The rule that most depends on these totals is
`rule-quickpick-enumeration`: its greedy tours score candidate join orders with
`getTotalCost()`. Every candidate ordering of N relations contains N-1 joins, so
every candidate carries the same flat `10000 * (N-1)`, and the orderings separate
only on their leaves. The enumeration still works — leaf costs and any physical
join nodes below do vary — but the join-shaped part of its signal is inert.

This is a *class*, not an instance: the next node that costs itself from
`source.estimatedRows` inherits the same blank. That is why the ticket asks for a
representation change rather than twelve edits.

## Shape of the fix

The honest fix is to stop treating self-cost as a constructor-time constant.
Sketch, not a design:

- `estimatedCost` becomes derived rather than stored — computed on demand from
  the node's own `physical` properties (which are themselves lazy and cached), so
  a node costs itself from `physicalSourceRows(child.physical, child)` exactly the
  way `computePhysical` already does. Note the ordering constraint: `physical` is
  a lazy bottom-up fold, so a cost read must not be taken while that fold is in
  progress.
- Nodes with a genuinely constant self-cost keep passing a number; the base class
  keeps the current field as the fallback.

Either way the guard belongs with the change: **one general test that a node's
self-cost responds to its children's physical row counts** — build the same node
over a 10-row input and over a 10,000-row input and assert the two self-costs
differ. That single test covers the whole class and catches the next node to
reintroduce it.

## Not in scope

- The row-estimate *relay* (a node forgetting to stamp `estimatedRows` into
  `computePhysical`) is a different site, tracked by
  `debt-row-estimate-relay-has-no-guard`. This ticket is about the **cost**
  number, which is stored, not relayed.
- `rule-join-physical-selection` computes its candidates' costs from its own
  formulas over `physicalSourceRows`, not from `getTotalCost()`, so its decisions
  are not affected.

## Review arm (from `5.4-join-ordering-reads-the-estimate-that-exists`): QuickPick cannot adopt *any* plan today

The section above says the enumeration "still works — leaf costs and any physical
join nodes below do vary — but the join-shaped part of its signal is inert". That
understates it, and the sharper statement changes how this ticket should be
prioritized: **`rule-quickpick-enumeration` can never replace a plan at all.**

Why. The rule scores each candidate ordering with `getTotalCost()` and adopts one
only when `bestCost < baselineCost * 0.9`. A candidate ordering is built from the
*same set* of already-optimized leaf subtrees as every other candidate and as the
baseline — `buildLeftDeepPlan` reuses `graph.relations[i]` verbatim — so the leaf
costs contribute an identical constant to all of them. The only other contributors
are the N-1 `JoinNode` self-costs, which this ticket's defect pins at a flat 10000
each, and the join-condition scalar nodes, which differ by at most a fraction.
Every candidate therefore scores within a rounding error of the baseline, and a
10% win is unreachable.

Measured (memory backend, three-table chain `dimc` 500 / `fact` 3000 / `dimb` 50,
all `ANALYZE`d): the rule reported `{"tours":100,"bestCost":23553.05}`, which is
exactly `3000 + 500 + 50` of leaves plus `2 x 10000` of join constants plus 3.05
of condition nodes — i.e. the baseline it had to beat by 10%. Independently, a
four-table star join (3000-row fact, 5/50/500-row dimensions) planned in the order
the tables were *written* under both spellings, with the 5-row dimension never
promoted to the front: no adoption in either.

Consequence for triage: `5.4-join-ordering-reads-the-estimate-that-exists` made
`quickPickBaseOrder` read real row counts, but that base order is unobservable in
any plan until this ticket lands. The general test this ticket already asks for
(a node's self-cost responds to its children's physical row counts) is the right
guard; worth adding a second one alongside it — **that QuickPick adopts a
different order for a join graph where one ordering is genuinely cheaper** — since
that is the property the whole rule exists to provide and nothing pins it today.
