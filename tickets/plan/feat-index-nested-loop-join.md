---
description: When a query joins a small set of rows against a large table on a column that already has an index, the engine still reads the whole large table instead of doing a handful of quick index lookups. Adding that lookup-driven join strategy would make such queries much faster than they are even after the current join fix.
files:
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # where a new algorithm choice would slot in
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts       # the one existing correlated-inner-seek node, and why it does not cover this
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts     # constraints → IndexSeekNode, seek keys may be dynamic bindings
  - packages/quereus/src/planner/nodes/retrieve-node.ts                      # the bindings surface a correlated seek key would use
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts  # how a Filter becomes pushed-down constraints today
  - packages/quereus/src/runtime/emit/join.ts                                # nested-loop drivers
difficulty: hard
---

# Index-nested-loop join: seek the inner side per outer row

## What is missing

Quereus has no join strategy that uses an index on the inner (right) side of a join. Every
join algorithm it can pick reads the inner side **in full**: a hash join builds over every
inner row, a nested loop rescans (or caches and replays) every inner row. So a query that
joins 50 outer rows against a 100 000-row table still touches all 100 000 rows, even when the
join column is indexed and a direct `where join_key = ?` on that same index answers in
constant time.

An index-nested-loop join drives from the outer side and performs one index seek per outer
row: cost goes from "read the whole inner table" to "50 seeks". For a small outer against a
large indexed inner it is the strictly better plan, and it is the plan an external user
explicitly asked for after measuring joins on the IndexedDB store
(`.tmp/quereus-join-perf.md`).

## Why it does not already happen

The machinery for a *bound* seek exists but is never wired to an ordinary join:

- `rule-predicate-pushdown` turns a `Filter` sitting on a `Retrieve` into pushed-down
  constraints, and `rule-select-access-path` turns those into an `IndexSeekNode` whose seek
  keys are allowed to be dynamic bindings (correlated values or parameters) rather than
  literals. That is exactly the shape an index-nested-loop join needs on its inner side.
- But a join's equality lives on `JoinNode.condition`, never as a `Filter` on the inner
  subtree, and predicate pushdown explicitly does not cross a join. So no rule ever presents
  the inner side with `inner.key = <outer value>`.
- `FanOutLookupJoinNode` is the one node that does seek a correlated inner, but it is gated on
  `expectedLatencyMs > 0` (zero for every in-process virtual table, so it is inert locally)
  plus a specific foreign-key-to-primary-key alignment shape underneath a projection. It does
  not cover a general `t.id = e.txn_id` join.

## What a solution needs to decide

This is a design task, not a mechanical change — promote to `plan/` rather than straight to
`implement/`. The open questions:

- **Rewrite shape.** Does the outer join key become a binding on the inner `RetrieveNode`
  (reusing the existing dynamic-seek-key path), or does a new physical join node own the
  correlation explicitly? The former reuses more; the latter is easier to cost and explain.
- **Costing.** Choosing index-nested-loop over hash needs a believable estimate of the outer
  cardinality and of the inner index's selectivity. Base-table cardinality is currently
  unknown-defaults-to-100 in several places (see `backlog/debt-access-node-catalog-cardinality`
  and `plan/feat-conjunction-and-join-selectivity`), so the cost inputs this decision depends on
  are themselves weak. Decide whether this feature blocks on better statistics or ships with a
  conservative shape-based heuristic (e.g. only when the outer is provably small).
- **Which side drives.** The rule must consider both orientations, and interact sanely with
  join-order enumeration (`rule-quickpick-enumeration`, `rule-join-greedy-commute`).
- **Outer-join semantics.** LEFT joins must still null-pad an outer row whose seek returns
  nothing; SEMI/ANTI can stop at the first hit, which is where this strategy is most valuable.
- **Per-seek overhead.** On a remote or high-latency store, N individual seeks can be worse
  than one scan. `expectedLatencyMs` already exists as the signal `FanOutLookupJoinNode` uses;
  decide whether index-nested-loop should read it too, and whether batching seeks (as
  `rule-fanout-batched-outer` does) belongs in the same design.
- **Collation.** The inner index must be seekable under the join key's *resolved* comparison
  collation, not merely under the column's declared one — the same constraint the store's
  index-access planner already checks (see `backlog/debt-store-index-keys-use-column-collation`).

## Relationship to other tickets

- `implement/join-collation-gate-blocks-hash-join` is the immediate fix for the reported
  regression — it makes hash join fire reliably, which is linear. This ticket is the further
  improvement on top: linear becomes "a few seeks". It is **not** urgent once that lands.
- `backlog/known/2-adaptive-query-optimization` names "index seek on equality match" as its
  Tier 0 floor; this is that floor.
- `plan/feat-uncorrelated-in-semijoin` solves the analogous problem for `IN`-subqueries and
  DML by pushing a key set down to storage, and explicitly leaves the join case here.
