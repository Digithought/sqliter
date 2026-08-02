---
description: A query joining a small set of rows against a large indexed table now does one index lookup per row instead of reading the whole large table; review the new join algorithm's gates, cost comparison, and test coverage.
files:
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # NEW — candidate construction (all gates)
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # correlated-side guard + four-way comparison
  - packages/quereus/src/planner/rules/shared/access-leaf.ts                # NEW — peel/rebuild/probe helpers shared with rule-key-set-seek
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts          # refactored onto the shared helpers (no behavior change intended)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts    # selectPhysicalNode exported
  - packages/quereus/src/planner/cost/index.ts                              # indexNestedLoopJoinCost
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts               # NEW — plan shape, idempotence, cost crossover
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic        # NEW — result equality + LATERAL guard regression
  - docs/optimizer-joins.md
  - docs/optimizer-rules.md
  - docs/optimizer.md
difficulty: hard
---

# Index-nested-loop join — implemented; review pass

## What shipped

A fourth physical join algorithm inside `rule-join-physical-selection`. When a
join's inner (right) side peels (through Alias / trivial Project / Filter) to an
unconstrained every-row table walk and the table's module answers an equality
seek on the join key, the walk is replaced by an `IndexSeekNode` whose seek keys
are column references into the outer row. The logical `JoinNode` and its
nested-loop emitter survive — per outer row the emitter installs the left row
slot and re-opens the inner pipeline, so the seek re-resolves by attribute id.
The ON condition is retained as the over-fetch safety net.

Supported: INNER / LEFT / SEMI / ANTI, including `exists … as` existence joins
(a real capability gain — hash/merge decline those). Declines: right/full,
side-effecting right side, pushed constraints / limit / offset on the leaf,
cross-logical-type or semantic-ordering keys, `MISMATCH_UNSAFE` collation cover,
module declining or costing the seek at/above its own scan. The module's own
`getBestAccessPlan` answers (probed twice: with the join constraints, with none)
decide selectivity; engine cost `indexNestedLoopJoinCost` uses `seekPlan.rows`.
Physical leaf construction reuses the exported `selectPhysicalNode` (collation
cover, composite seeks, NULL handling, residual reattachment); anything but an
`IndexSeekNode` coming back declines the candidate — an `EmptyResultNode` is
explicitly never adopted.

The rule now also declines outright when either join input is correlated. That
guard is both the idempotence mechanism (index-NL output has a correlated right
side) and a fix for a live defect: `join lateral (…) on <equality>` at pre-guard
HEAD was converted to a hash join, which drains the right side outside any outer
row's scope — "No row context found" at runtime (finding from the prior run's
probe, recorded in the guard comment; regression pinned in sqllogic, see below).

## IMPORTANT: where the diff lives

The core implementation was written by a prior interrupted run of this ticket
and got swept into commit `e109d7df` — whose message is the UNRELATED
`ticket(review): bug-hidden-implicit-index-leaks-into-introspection`. Review
that commit's planner/cost changes as part of this ticket's diff (the files
listed above), not just this run's commit. This run verified the swept code
(full suite green before touching anything), then added: the optimizer spec, the
sqllogic file, the docs updates, the LATERAL regression, and deleted nine
debug probe scripts (`.inl-probe*.mjs`, `.lateral-probe.mjs`, …) the sweep had
committed at the repo root.

## Validation performed

- `yarn workspace @quereus/quereus run test` — 8355 passing / 0 failing
  (+19 over pre-existing: 18 spec cases + 1 sqllogic file).
- `yarn test` (all workspaces), `yarn typecheck`, `yarn lint`, `yarn build`,
  `node scripts/check-docs.mjs` — all green.
- `yarn test:store` (LevelDB store module — its `getBestAccessPlan` differs, and
  this rule's decision rests on that answer) — 8347 passing / 0 failing.
- No golden plans changed in this run; the one spec adaptation
  (`filter-selectivity.spec.ts`, hash build/probe swap by cardinality) landed
  with the swept commit and was re-derived there, not regenerated.

## Test coverage (starting point, not a finish line)

`test/optimizer/index-nested-loop.spec.ts` — plan signature is "JoinNode whose
right subtree contains an IndexSeek keyed on a left attribute":
fires on secondary-index and PK joins, LEFT, EXISTS/NOT-EXISTS semi/anti,
`exists … as` (flag values asserted end-to-end); no CacheNode above the seek;
rule-level idempotence (direct call on own output ⇒ null, via a stub context —
the guard fires before context use); declines on unindexed key, pushed leaf
constraint, ordered+limited derived table, cross-type key, NOCASE-over-BINARY
collation (and the matching direction fires), right/full. Cost crossover pinned:
(10 × 100k, 1 row/seek) ⇒ index-NL; (100k × 5) ⇒ hash; (100×100, 100 rows/seek)
⇒ not index-NL.

`test/logic/11.3-index-nested-loop-join.sqllogic` — result equality for
INNER / LEFT / SEMI / ANTI, NULL join keys on both sides, `exists … as` flags,
self-join (distinct scan sites), three-way left-deep spine seeking on the
inner-most relation's key, composite key, partial composite (prefix seek + ON
enforcing the uncovered pair), NOCASE/BINARY both directions, and the LATERAL
`on <equality>` guard regression (inner + left variants).

## Known gaps / honest notes for the reviewer

- **`orderingLoadBearing` gate is defensive-only.** No SQL shape reaches a
  join's right leaf with that flag set: a bare derived-table `ORDER BY` is
  pruned before physical selection (test pins that the seek then soundly
  fires), and `ORDER BY … LIMIT` blocks the peel at the LimitOffset instead.
  The gate stays (mirrors rule-key-set-seek, cheap), but no test exercises it
  directly.
- **Side-effect decline (purity gate) is untested.** A side-effecting right
  side that still peels to a bare leaf is hard to construct through SQL —
  `rule-mutating-subquery-cache` (registered earlier in PostOptimization) wraps
  such right sides in a CacheNode, which fails the peel anyway. Confirmed by
  reading registration order, not by a test.
- **Per-seek latency term is untested.** `expectedLatencyMs` is 0 for both
  shipped modules; the asymmetry (hash/merge charged once, index-NL per outer
  row, applied locally in the rule) is documented in code and docs but no test
  drives a nonzero value.
- **The pre-guard LATERAL failure was not independently re-reproduced** in this
  run (the guard is already in the tree; reproducing would mean reverting it).
  Evidence: the prior run's probe finding recorded in the guard comment, plus
  the now-passing regression.
- The store-mode test reporter prints only summary counts, so per-file inclusion
  of the new sqllogic under LevelDB is inferred from the green full-suite run,
  not an individually named line.

## Tripwires already recorded

- Probe volume: one extra pair of uncached `getBestAccessPlan` calls per
  qualifying equi-join — NOTE in `index-nested-loop.ts` header (mirrors
  rule-key-set-seek's; memoize by (table, seek columns) if a third-party module
  with an expensive planner shows up in profiles).

## Parked follow-ups (already filed in backlog/, prereq: this ticket)

- `feat-index-nested-loop-over-pushed-constraints` — fire even when the leaf
  already carries pushed filters.
- `feat-index-nested-loop-commute-drive-side` — teach join ordering about index
  availability; today only the right side is ever seek-rewritten.
- `feat-index-nested-loop-batched-seeks` — batch seeks per outer-row window for
  high-latency backends.
