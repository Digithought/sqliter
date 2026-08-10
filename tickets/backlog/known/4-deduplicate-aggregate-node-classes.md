description: Extract shared logic from AggregateNode, HashAggregateNode, and StreamAggregateNode into a common base or utility
difficulty: easy
prereq: none
files:
  packages/quereus/src/planner/nodes/aggregate-node.ts
  packages/quereus/src/planner/nodes/hash-aggregate.ts
  packages/quereus/src/planner/nodes/stream-aggregate.ts
----
## Problem

The three aggregate node classes share extensive duplicated code:

- `getGroupByColumnName()` — identical across all three
- `withChildren()` — near-identical structure (validation, destructuring, change detection, reconstruction)
- `getLogicalAttributes()` — identical group-by/aggregate serialization and uniqueKeys computation
- `buildAttributes()` — same core pattern (group-by attrs, then aggregate attrs); physical nodes add source attrs
- `getType()` — same column-building logic; physical nodes merge source columns
- `getChildren()` / `getRelations()` — identical one-liners
- `estimatedRows` — same structure, different divisor constants

## Proposal

Extract shared logic into a utility module or abstract base class. Key considerations:

- `AggregateNode` is a logical node (no source attribute pass-through), while `HashAggregateNode` and `StreamAggregateNode` are physical nodes that merge source attributes. A base class should accommodate this distinction via a template method or flag.
- `getGroupByColumnName` is a pure utility — extract to a standalone function.
- `withChildren` validation and reconstruction logic can share a helper.
- `getLogicalAttributes` serialization is identical — extract to shared function.

Severity: smell — the code works but is fragile and hard to maintain.
Source: review of aggregate/window plan nodes.
