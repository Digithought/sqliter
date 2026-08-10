---
description: |
  A query that filters on an indexed column and also matches against a list produced by a
  self-contained sub-query used to crash the planner. Fixed so such a sub-query's own table
  stays readable; reviewed and hardened.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/test/vtab/test-index-subquery-residual-module.ts
  - packages/quereus/test/vtab/grow-retrieve-noncorrelated-subquery-residual.spec.ts
  - docs/optimizer-retrieve.md
difficulty: medium
---

# Complete: rule-grow-retrieve subquery-residual carve-out

## What shipped

`rule-grow-retrieve`'s index-style fallback used to keep a residual predicate above the grown
`Retrieve` only when it held a **correlated** subquery. A self-contained
`IN (SELECT …)` / `EXISTS` / scalar subquery got stashed on `moduleCtx.residualPredicate`;
`rule-select-access-path` rebuilt it into a `Filter` only AFTER the bottom-up physical pass had
already covered that region, so the subquery's own inner `Retrieve` was never physicalized and
`runtime/emit/retrieve.ts` threw at execution:

```
QuereusError: RetrieveNode for table '…' was not rewritten to a physical access node.
```

The implement stage replaced the correlation-aware `predicateContainsCorrelatedSubquery` walker
with `predicateContainsSubquery` (matched `ExistsNode` / `ScalarSubqueryNode` / `InNode` with a
`source`), keeping any subquery-bearing residual inside the tree the physical pass walks.

## Review findings

Adversarial pass over the implement diff (`d03d80d0`). Read the code diff first, then the handoff.

**Aspects checked:** walker completeness, correctness of the carve-out gate (`isIndexStyleContext`),
DRY/robustness of the detection, test coverage (happy/edge/negation/sanity), source hygiene, docs
currency, lint, full suite.

- **Walker completeness (MAJOR concern → fixed inline).** The implement walker enumerated three
  subquery node classes. Any future subquery-bearing node (`ANY`/`ALL`/row-subquery, or a
  `NOT IN` shape) that isn't one of those three would fall back into the same buried-residual trap
  the ticket exists to close — the implementer flagged this as the #1 thing to scrutinize.
  Generalized `predicateContainsSubquery` to a **structural** check: recurse `getChildren()` and
  return true if any descendant `isRelationalNode`. A subquery is the only way a
  `RelationalPlanNode` hangs beneath a scalar residual, so this is exactly "contains a subquery"
  and is robust to new node types. Dropped the now-unused `ExistsNode`/`InNode`/`ScalarSubqueryNode`
  imports. (`packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts:608`)

- **`NOT IN` coverage gap (MINOR → fixed inline).** The implementer noted `NOT IN (subquery)` was
  untested. Confirmed it lowers to `UnaryOp(NOT, InNode(source))` (`parser.ts:1552`); the structural
  walker catches it via the `InNode`'s relational child. Added a regression case
  (`id = 10 and id not in (select val from other)` → `[10]`) to lock the behavior.

- **Carve-out gate (checked, no change).** The lift is gated on `isIndexStyleContext(moduleCtx)`, so
  query-based (`supports()`) modules are untouched — a non-correlated residual that a query module
  can serve is not force-lifted. Confirmed by reading the gate; matches the handoff claim.

- **Test-module fidelity (checked, no change).** `TestIndexSubqueryModule` claims only the PK `=` it
  can enforce and applies exactly the seek bounds handed down; honest stand-in for a real backend
  whose advertised access path triggers the grow rule. The in-tree memory backend never reaches the
  rule, so this bespoke module is genuinely required.

- **Docs (updated).** Reworded the `docs/optimizer-retrieve.md` carve-out bullet to describe the
  detection as structural (relational-descendant) rather than an enumerated three-form list, and
  added `NOT IN` to the examples.

- **Source hygiene, error handling, resource cleanup:** clean. Walker is a small pure function;
  spec uses `beforeEach`/`afterEach` store clear + `db.close()`. No `any`, no eaten exceptions.

- **Empty categories:** no security surface (planner-internal), no performance regression (walker is
  a bounded WHERE-fragment walk, same order as before), no concurrency surface.

**Validation:** `yarn lint` clean (eslint + `tsc` on src and test). Full quereus suite **6982
passing, 13 pending, 0 failing** with the structural walker. Filtered regression run (6 cases incl.
new `NOT IN`) green. Memory suite stays green (rule only reachable under an advertised access path).

## Tripwires parked

- **NOTE (code, existing invariant):** the structural walker relies on `getChildren()` surfacing
  every subquery-bearing branch of the residual. This is a general optimizer invariant (traversal,
  rewrite, and binding-collection all depend on it) — a node that hid a relational child from
  `getChildren()` would break far more than this walker. No walker-specific action; recorded here so
  a future reader knows the dependency is intentional and load-bearing across the optimizer, not just
  local.
- No code comment was added for walker depth: residual predicates are small WHERE fragments today;
  only a concern if they ever get very deep. No action now.

## Cross-repo follow-up (informational)

On landing, lamina's `13.1-cte-multiple-recursive.sqllogic` conformance file is expected to advance
and lamina drops its ledger line for
`quereus-grow-retrieve-buries-noncorrelated-subquery-residual`. Lamina-side bookkeeping; nothing to
do in this repo.

## Offshoot tickets (filed by implement, unrelated to this fix)

The implement commit also filed three unrelated tickets surfaced while reproducing:
`debt-sqllogic-create-index-lamina-sl7-corpus-fallout` (backlog),
`isolation-overlay-cannot-serve-underlying-index-names` (fix),
`mv-reshape-loosens-not-null-on-ordering-seeded-backing-pk` (fix). Out of scope for this review;
left as filed.
