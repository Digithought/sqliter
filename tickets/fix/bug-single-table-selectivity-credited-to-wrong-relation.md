description: When a WHERE clause sits on top of something that reshapes its input — a recursive query, or a grouped aggregate — the planner still estimates how many rows survive using the statistics of the original table underneath, which describe a different set of rows.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/util/column-origins.ts
difficulty: medium
----

## What happens

`rule-filter-selectivity` decides which table's statistics describe a filter's input by calling
`extractTableSchema` (`planner/util/key-utils.ts`). That helper walks down from the filter
through **any** node that has exactly one relational child, and returns the first base table it
finds:

```ts
const relations = node.getRelations?.() ?? [];
if (relations.length === 1) return extractTableSchema(relations[0]);
```

The intent is to see through pass-through wrappers — a projection, a sort, a retrieve. But the
condition is "one relational child", not "does not reshape its input", so it also walks through
operators whose output rows are *not* the base table's rows:

- **a recursive CTE** — `getRelations()` returns only the base case, so the walk lands on
  whatever table seeds the recursion and credits its statistics to the full recursive result.
- **an aggregate** — one input relation, but the output is one row per group. A `having`
  predicate is estimated as a fraction of the *ungrouped* table.

The estimate is then a fraction of the wrong population. It is never *unsound* — nothing
produces wrong query results — but it can be off by whatever ratio separates the two row sets,
which for a recursive CTE is unbounded.

## Why this is filed now

The `feat-join-filter-selectivity` work added a sibling path for filters over joins, and its
attribution helper (`collectColumnOrigins`, `planner/util/column-origins.ts`) already refuses to
attribute through row-merging operators for exactly this reason — it stops at a set operation
and at a recursive CTE rather than crediting one branch's statistics to the merged relation. The
older single-relation path has no equivalent guard, so the two paths now disagree about the same
question. Whichever answer is right, they should agree.

## Expected

A filter should only be estimated against a base table's statistics when the rows reaching it
really are that table's rows. Concretely, `extractTableSchema` (or the selectivity rule's use of
it) should decline for an operator that changes the row population rather than walking through
it. Declining leaves `DEFAULT_FILTER_SELECTIVITY` (0.5) in place, which is what these shapes
effectively deserve until there is a real model for them.

Worth checking as part of the fix: `extractTableSchema` has other callers (key/constraint
analysis) which may want the *permissive* walk. If so the selectivity rule needs its own
stricter variant rather than a change in shared behaviour.

## Out of scope

Actually modelling aggregate output cardinality, or recursive-CTE cardinality, is a much larger
piece of work. This ticket is only about not reporting a confident number derived from the wrong
relation.
