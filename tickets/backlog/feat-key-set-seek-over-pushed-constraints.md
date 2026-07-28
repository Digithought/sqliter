---
description: The subquery-driven index lookup currently gives up whenever the same query also filters the table by another indexed column, falling back to reading the whole table. Let the two filters work together instead.
prereq: feat-key-set-semi-join
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
---

## The gap

`feat-key-set-semi-join` only fires when the table access it targets is a plain full scan
with nothing pushed into it. So:

```sql
delete from big where id in (select id from small)                -- accelerated
delete from big where status = 'x' and id in (select id from small)
```

The second query is *not* accelerated when `status` is indexed, because the planner has
already turned the scan into a `status` index seek and marked the `status` predicate as
handled — meaning the residual `Filter` that would otherwise re-check it was dropped.
Replacing that access path with the key-set multi-seek would silently lose the `status`
filter, so the rule declines and the query reads the whole table.

(When `status` is *not* indexed the predicate survives as a `Filter` above the leaf, the
rule's peel descends through it, and the acceleration does happen. So the gap is specific
to "another indexed column is also filtered".)

## What good would look like

Either of:

- **Merge**: build a `FilterInfo` that carries both the runtime key set and the
  already-pushed constraints, so the module seeks on the key set and still enforces the
  other predicate. Needs a decision about which index wins when both columns are indexed,
  and the module has to be asked about the combination rather than the key set alone.
- **Re-residualize**: keep the key-set seek and re-apply the displaced predicate as a
  `Filter` above the node. Simpler and always correct, but it means undoing a pushdown the
  planner already made, and it is only a win when the key set is much more selective than
  the other predicate.

The second is probably the right first move; the cost comparison is the interesting part.

## Why it is not urgent

The declined case still runs correctly at the hash-semi-join floor — one full pass over the
table, not a quadratic one. This is a missed speed-up, not a defect.
