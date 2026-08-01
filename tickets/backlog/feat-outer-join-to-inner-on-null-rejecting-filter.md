---
description: An outer join followed by a condition that can never be true for the padded-with-nulls rows is really an inner join, but the planner still runs it as an outer join and does the padding work for nothing.
files:
  - packages/quereus/src/planner/nodes/join-node.ts                                # JoinNode.joinType
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts   # the rule this unlocks work for
prereq: feat-filter-pushdown-through-join
difficulty: medium
---

# Convert an outer join to an inner join when a filter above it rejects nulls

## What this is about

```sql
select … from a left join b on a.k = b.k where b.status = 'open'
```

A `left join` keeps every `a` row, padding `b`'s columns with nulls when nothing matched.
But `b.status = 'open'` is never true when `b.status` is null, so every padded row is thrown
away immediately afterwards. The query means an inner join, and running it as one is both
cheaper and unlocks other optimizations.

A condition with this property — false (or unknown, which SQL treats as "not true" in a
`WHERE`) whenever the columns it reads are null — is conventionally called **null-rejecting**.
Simple comparisons (`=`, `<`, `>`, `like`, …) are null-rejecting; `is null`, `coalesce(...)`,
and `is not distinct from` are not.

## Why it is worth doing

Two payoffs:

1. **Directly** — the join no longer has to produce and then discard padded rows, and the
   planner gets a wider choice of join algorithms and join orders for an inner join.
2. **Indirectly** — the sibling rule `feat-filter-pushdown-through-join` may only push a
   conjunct to a side that is never null-padded. Converting the join first turns *both* sides
   into pushable ones, so the very conjunct that triggered the conversion can then be pushed
   into the table it constrains. That combination is what turns the example above into an
   index seek on `b`.

## What a solution needs to decide

- Which expression shapes count as null-rejecting, and how conservatively to classify. Getting
  this wrong in the permissive direction deletes rows.
- Whether one null-rejecting conjunct on the null-padded side is enough (it is), and how to
  handle a conjunct that mixes both sides.
- `full join` reduces stepwise: a null-rejecting condition on one side turns it into the outer
  join preserving the other, and one on each side turns it into an inner join.
- Where the check lives, so both this rule and any future consumer share one definition of
  "null-rejecting" rather than two that drift.

## Testing expectation

Every case needs a data set that actually contains an unmatched row, so a wrong conversion
shows up as a row-count difference rather than passing by luck.
