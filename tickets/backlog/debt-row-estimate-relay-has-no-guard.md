description: Three tickets in a row have fixed the same kind of bug by hand — a plan step that knows roughly how many rows it will produce, but forgets to tell the steps above it — and a few steps still have the bug. Nothing in the build catches it, so the next new plan step can reintroduce it silently.
files:
  - packages/quereus/src/planner/util/row-estimates.ts             # physicalSourceRows / the composition helpers
  - packages/quereus/src/planner/nodes/plan-node.ts                # the estimatedRows getter and computePhysical contract
  - packages/quereus/src/planner/nodes/view-mutation-node.ts       # fixed in review of 5.3 — the pattern to follow
  - packages/quereus/src/planner/nodes/sequencing-node.ts          # hole: getter relays, no computePhysical at all
  - packages/quereus/src/planner/nodes/sequence-node.ts            # hole: computePhysical() takes no args, cannot relay
  - packages/quereus/src/planner/nodes/block.ts                    # hole: getter sums relations, no computePhysical
  - packages/quereus/test/optimizer/set-op-row-estimates.spec.ts   # where a guard would naturally live
difficulty: medium
tradeoffs: A maintainer could reasonably say the remaining three nodes are rare enough in real plans that the hand-patching has already bought most of the value, and that a guard test which enumerates node classes is itself maintenance.
----

# One rule, checked once, instead of one fix per node

## What keeps going wrong

Every plan step can say roughly how many rows it will produce. It says this twice,
in two different places:

- a **logical** answer, available while the query is still being shaped;
- a **physical** answer, computed after the optimizer has chosen how to read the
  tables — this is the one that has real numbers in it, because that is where a
  table's measured row count enters the plan.

A step that only answers the logical question, and forgets to answer the physical
one, silently erases the number for **everything above it in the plan**. Sorting,
buffer sizing and join ordering above that point then fall back to a fixed guess.

Three tickets have now fixed instances of this by hand, node by node:
`debt-join-rows-from-physical-children` (the single-source operators and joins),
`unknown-row-count-stops-pretending-to-be-zero`, and
`row-estimates-survive-set-operations-and-writes` (set operations, common table
expressions, and the insert/update/delete pipeline). The review of the last of
these found two more holes that the ticket had not listed, one of which was inside
the ticket's own stated scope. That is the shape of a missing invariant, not of
three unrelated bugs.

## Still open

Measured by reading each file for a logical row-count answer with no matching
physical one (`grep -c "get estimatedRows"` non-zero and `grep -c "estimatedRows:"`
zero across `packages/quereus/src/planner/nodes/*.ts`):

| node | what it does | why it matters |
|---|---|---|
| `SequencingNode` | adds a row-number column on the window-function path | pass-through; loses the count for any window query that needs it |
| `SequenceNode` | runs side-effect statements before a main relation | its `computePhysical()` is declared with no parameters, so it *cannot* see its children's numbers |
| `BlockNode` | a multi-statement block | its logical answer sums its relations; nothing physical |

`RecursiveCTENode` deliberately answers neither — a recursive query's size is not a
function of its parts — and that is correct, so any guard must allow a node to opt
out on purpose rather than assuming every node must answer.

## What would retire the class

A single test that walks the plan-node classes and asserts the rule directly:
**if a node answers the logical question by relaying or composing its children's
answers, it must also answer the physical one when its children have answers.**
Deliberate abstainers (`RecursiveCTENode`) and deliberate constants (`SinkNode`,
which always reports the one changes-count row) declare themselves rather than
being special-cased in the test. With that in place, the three nodes above are
fixed once and a newly written node cannot reopen the hole without the test saying
so.

Fixing the three nodes without the guard is the smaller version of this ticket and
is worth doing on its own — but it is the fourth round of hand-patching, and the
fifth will follow.
