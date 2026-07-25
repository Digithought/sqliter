description: When a WHERE clause combines a cheap test with an expensive one using AND, run the cheap test first so the expensive one is skipped for rows the cheap test already rules out.
files: packages/quereus/src/planner/rules/predicate/, packages/quereus/src/planner/nodes/filter-node.ts, packages/quereus/test/logic/07.7-and-or-short-circuit.sqllogic
difficulty: hard

## Background

Quereus recently gained AND/OR short-circuit deferral for logical operators that
survive to runtime as a single scalar binary op (SELECT list, ON clause, CASE, a
nested/non-top-level AND, or any OR). See the completed ticket
`feat-and-or-short-circuit`.

That optimization does **not** reach a *top-level* `AND` in a `WHERE` clause,
because the optimizer decomposes a top-level conjunction (`where cheap and
expensive`) into **separate `filter` nodes** — one per conjunct — before emit.
There is no `AND` binary op left for the runtime short-circuit to act on. Which
conjunct runs first is then decided by optimizer **filter ordering**, an entirely
separate concern.

## The problem

Consider:

```sql
select * from t where k = 2 and (select expensive() ...) = 1;
```

A user reasonably expects the cheap `k = 2` conjunct to eliminate most rows first,
so the expensive subquery conjunct only runs for the few survivors. In at least one
observed plan, the subquery `filter` ran for **every** row regardless — the cheap
sibling conjunct did not get ordered ahead of it. The engine has no cost-based
ordering of independent WHERE conjuncts, so the expensive predicate can execute far
more often than necessary.

This is the single most likely place a user's "my `where cheap and (select
expensive)` is slow" expectation goes unmet, even after the logical short-circuit
work landed — the two are orthogonal and this path was explicitly out of scope
there.

## What we want

The optimizer should order independent (non-index-driving) residual filter
conjuncts by estimated cost, cheapest first, so a low-cost conjunct that eliminates
rows runs before a high-cost one (subquery, volatile UDF, heavy arithmetic). A
predicate that a virtual table / index can push down or drive access with should
still win over a pure residual filter, as today — this is about ordering the
*leftover* residual conjuncts among themselves.

## Notes / constraints

- Cost estimates for a subquery-bearing conjunct must reflect that it is expensive;
  a naive per-node self-cost that ignores the subquery would defeat the point.
- Ordering must not reorder across anything that changes semantics (it should not,
  since 3VL AND is commutative and independent filters are conjunctive, but verify
  against NULL/short-circuit-in-subquery interactions and any side-effecting UDFs
  whose evaluation count is now observably different).
- Determinism: two conjuncts of equal estimated cost should keep a stable order so
  plans stay reproducible across runs.
- Add end-to-end coverage proving a cheap conjunct filters before an expensive
  subquery conjunct (evaluation-count assertion via a counting UDF, mirroring
  `test/and-or-short-circuit.spec.ts`).
