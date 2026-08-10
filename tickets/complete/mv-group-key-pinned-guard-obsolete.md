---
description: Retired a materialized-view rewrite guard that used to skip an optimization for certain grouped queries only because of a since-fixed bug in the normal (non-view) query path.
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts  # guard block, `'group-key-pinned'` reason, and `clausePinsOrEquatesGroupCol` all removed
  - packages/quereus/test/query-rewrite-aggregate.spec.ts           # agreement harness + three base-vs-view tests (~line 92, ~line 340)
  - packages/quereus/test/query-rewrite-equivalence.spec.ts         # pinned/equated queries added to the fuzz corpus (~line 153)
  - docs/optimizer-rule-families.md                                 # § Aggregate-rollup arm — guard bullet removed
  - docs/materialized-views.md                                      # § Aggregate rollup — "Forgo guard" block removed
difficulty: easy
---

# Complete: retire the `group-key-pinned` forgo guard

## What was wrong

The materialized-view (MV) query-rewrite matcher had a guard,
`group-key-pinned`, that refused to answer a grouped query from a covering MV
whenever the query grouped on ≥2 columns and its `where` pinned (`g = 1`) or
equated (`g1 = g2`) one of them. The guard existed only to dodge a bug in the
normal (base-table) query path: `rule-groupby-fd-simplification` used to drop a
functionally-determined grouping column and re-emit it at a shifted output
position, so the base path and the MV-rewrite path disagreed on column order for
that shape.

`bug-grouped-key-reorder-survives-to-output` (landed; see
`tickets/complete/1-bug-grouped-key-reorder-survives-to-output.md`) fixed the
base path — the rule now caps a permuting rewrite with an order-restoring
`Project`, so both paths deliver select-list column order by construction. The
guard therefore only cost coverage: real queries of this shape fell back to a
base-table scan when the MV could have served them.

## What shipped

- Removed the guard block in `matchAggregateFragmentToMv`, the
  `'group-key-pinned'` member of `RewriteFailureReason`, and
  `clausePinsOrEquatesGroupCol` (the guard was its only caller).
- Test coverage for every shape the guard used to refuse, each asserting the
  matcher now matches **and** that the executed rewrite agrees with the base
  recompute on column names/order and on row values positionally:
  - exact-key + literal pin (`where d = 1 group by d, r`),
  - exact-key + column equate (`where d = r group by d, r`),
  - rollup + pin (2-key query over a 3-key MV, query key ⊊ MV key).
- The equivalence fuzz harness (`query-rewrite-equivalence.spec.ts`) corpus
  gained a pinned and an equated multi-key query, so the shape is now exercised
  across 40 randomized data sets rather than one hand-picked fixture; the pinned
  query is also in `AGG_MUST_REWRITE`, so the harness stays non-vacuous for it.
- `docs/optimizer-rule-families.md` and `docs/materialized-views.md` updated to
  drop the retired guard.

## Validation

From the repo root: `yarn build` clean, `yarn workspace @quereus/quereus run
lint` clean (silent success), `yarn test` **0 failing** across all workspaces
(8662 in `packages/quereus`, 13 pre-existing pending; other workspaces unchanged
from the prior clean run).

`yarn docs:check` reports the same two overages as at HEAD (`docs/schema.md`,
`docs/sync.md`) — already tracked in `tickets/.pre-existing-known.md` under
`debt-docs-size-ratchet-red-again`, not re-reported. Neither doc touched here is
in that list, and both only shrank.

## Review findings

**Checked:** the implement diff read fresh before the handoff summary; the guard
removal's soundness position in `matchAggregateFragmentToMv` (it sat after every
other check, immediately before the exact-key output-map assembly, so removing
it only *admits* more matches and cannot perturb another `fail(...)` path);
orphaned code after the deletion (`GuardClause`, `clauseColumns`, `queryClauses`
all still have live callers — nothing dangling); repo-wide grep for lingering
`group-key-pinned` / `clausePinsOrEquatesGroupCol` references in source and docs
(none); both touched doc files read in full against the new reality.

**Found and fixed in this pass (minor):**

- **The agreement test was vacuous.** It compared a rewrite-on run against a
  rewrite-off run but never asserted the rewrite *fired* — so a cost decline or
  any future gate regression would silently reduce the ticket's central piece of
  evidence to two identical base recomputes that always agree. The sibling UDAF
  test 60 lines below carries exactly this guard, with the comment "else this
  vacuously compares two base recomputes"; the new test omitted it. Added a
  `serializePlanTree` assertion that the plan scans the MV backing, and confirmed
  it passes (the rewrite does fire).
- **Two shapes the guard actually blocked were untested.** The handoff flagged
  them as optional hardening; they are the direct blast radius of the change, so
  they were closed rather than deferred: the `eq-column` equate shape
  (`where d = r group by d, r`) and rollup + pin (query key ⊊ MV key, which the
  removed guard also refused since it read the *query* group set). Both match and
  agree with the base recompute — confirming the removal is sound beyond the one
  hand-picked exact-key fixture.
- **Fuzz corpus gap.** The property-based equivalence harness had no pinned or
  equated multi-key query, so the randomized-data coverage never touched what
  this ticket unblocked. Added both, plus the pinned one to the non-vacuity list.
- **DRY.** The end-to-end run/compare was hand-rolled inline in the single test;
  extracted `readPositional` + `expectBaseViewAgreement` so all three agreement
  tests share one harness that also carries the non-vacuity assertion.
- **Doc hygiene.** `docs/optimizer-rule-families.md` narrated the *history* of the
  retired guard ("it existed only to dodge …, retiring it is <slug>") inside a
  timeless architecture doc. Rewritten to state the current invariant — no forgo
  guard remains on that shape, and both paths deliver select-list column order.

**Filed as tickets:** none. Every finding was minor and fixed in this pass; no
defect survived that needed a follow-up ticket.

**Tripwires recorded:** none. Nothing in this change is of the "fine now, only
matters if X grows" kind — the change removes code and widens coverage rather
than adding a bounded mechanism.
