---
description: When a join's ON clause contains a condition that only mentions one of the two tables, that condition is checked while joining instead of while reading the table, so the table is read in full. Reading it filtered first would be cheaper.
files:
  - packages/quereus/src/planner/rules/predicate/rule-join-predicate-pushdown.ts  # sibling rule; does this for WHERE, not ON
  - packages/quereus/src/planner/nodes/join-node.ts                               # JoinNode.condition
prereq: feat-filter-pushdown-through-join
difficulty: medium
---

# Push single-table ON-clause conjuncts into the joined table

## What this is about

`select … from a join b on a.k = b.k and a.status = 'open'` — the `a.status = 'open'` part of
the ON clause only talks about `a`. It could be applied while reading `a` (potentially via an
index) instead of on every candidate pair the join produces.

The companion ticket `feat-filter-pushdown-through-join` does exactly this for conditions
written in `WHERE`. It deliberately leaves `ON` alone, because the rules for `ON` are
different — and, for outer joins, are the *mirror image* of the WHERE rules:

- **Inner / cross join** — `ON` and `WHERE` mean the same thing, so the WHERE rules apply
  unchanged: a single-side conjunct can go to that side.
- **Outer join** — a single-side `ON` conjunct on the side that gets null-padded **can** be
  pushed into that side (it decides which rows are eligible to match, and non-matching rows
  are null-padded either way). A conjunct on the *preserved* side **cannot** — under `ON` it
  does not remove preserved rows, it only stops them matching, so pushing it would delete
  rows the query keeps.

That inversion relative to the WHERE rule is the whole reason this is a separate ticket: it is
easy to state, easy to get backwards, and each direction needs its own end-to-end test.

## Why it is worth doing

Same payoff as the WHERE case: turn a full table read into an index seek. Common in
view-heavy and generated SQL, where filters often end up spelled in `ON` rather than `WHERE`.

## Where it would live

Most likely as a second arm of the sibling rule (it fires on a `Filter`; this one would need a
`Join` entry point), or as its own rule on `PlanNodeType.Join`. That is a design call for the
planning pass, not settled here.

## Not in scope

Turning an outer join into an inner join because of a null-rejecting condition — that is
`feat-outer-join-to-inner-on-null-rejecting-filter`.
