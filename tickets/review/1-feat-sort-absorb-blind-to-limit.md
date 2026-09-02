---
description: Review the change that lets a plan-time LIMIT reach the storage module, so an ungrouped MIN/MAX over an indexed column is priced as the one row it reads rather than as an ordered read of the whole table.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts        # RowsWanted, truncationIsSafe, the two-phase probe
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts  # the one caller that passes a bound
  - packages/quereus/src/vtab/best-access-plan.ts                            # the tightened `limit` contract
  - packages/quereus-store/src/common/store-module-access-plan.ts            # rowsToProduce, applied to seek arms / ordering walk / full scan
  - packages/quereus-store/test/plan-time-limit.spec.ts                      # new, cost-profile-parameterized
  - docs/module-authoring.md
---

# Review: plan-time LIMIT reaching the module

Implements `feat-sort-absorb-blind-to-limit`. GitHub #31 is the live report; the engine
half of GitHub #30's theme (the store's real per-row cost not reaching the planner) is a
separate ticket and deliberately untouched here.

## What was built

An ungrouped `min(c)` / `max(c)` is rewritten by `ruleMinMaxIndexBoundary` into an ordered
read with a `LimitOffset(1)` on top. It probes the module first, through
`trySortAbsorbViaIndexOrdering`, to ask whether the access path can serve the ordering —
and that probe carried no limit, so the module answered "what does an ordered read of the
whole table cost?". A backend whose random row reads are expensive answers, correctly,
that scanning and sorting is cheaper, and the boundary read is priced out.

Four changes:

1. **`trySortAbsorbViaIndexOrdering` takes an optional `RowsWanted`.** The minmax rule
   passes `{ limit: 1, offset: 0 }` — it synthesizes the `LimitOffset` itself, so it knows
   the bound before it probes. `ruleGrowRetrieve`'s own Sort call site passes nothing and
   is unchanged.
2. **A truncation-safety rule, and a tightened contract.** `request.limit` is a licence to
   stop early, not a hint — `offset`'s own doc comment invites a module to stamp
   `scan-side limit = limit + offset`. It is now populated only when every conjunct of
   every `FilterNode` below the Sort is covered, by node identity, by a constraint the
   access plan reported handled. `truncationIsSafe` does that check.
3. **Probe with the bound, then validate.** Probing limit-free first cannot work: that is
   exactly the probe that fails today (the store vetoes its ordered arm on whole-table
   pricing and answers with an unordered scan, so `orderingMatches` fails and the rule
   returns null). So the bound goes in, and the plan that comes back is accepted only if
   it both satisfies the ordering and is truncation-safe under its own `handledFilters`;
   otherwise it is discarded and re-probed without. At most two probes, one when no bound
   is passed.
4. **The store consumes it, on all three sites.** `rowsToProduce` gates on the same two
   conditions and is applied to the single-window seek arms, the ordering walk, and the
   full scan. Repricing only the seeks would have been a bias, not a fix.

## What to attack

- **`truncationIsSafe` is the correctness surface.** Everything else is pricing; this is
  the one place a bug returns a wrong answer rather than a slow plan. It matches
  `PredicateConstraint.sourceExpression` against `splitConjuncts` output by object
  identity. Identity holds because `extractConstraintsForTable` extracts from the same
  node objects the walk later visits — **verify that assumption**, and verify it survives
  a constraint that is synthesized rather than lifted (OR_RANGE was the case I expected to
  fail closed; confirm it does).
- **The walk descends into every child, including a subquery's Filter.** Deliberately
  over-conservative — a subquery Filter is not between the scan and the limit at all — but
  confirm the conservatism is only ever a decline, never an accept.
- **`rowsToProduce` sets `plan.rows`, not only `plan.cost`.** That cardinality propagates
  upward through the Retrieve. Intended (a `LimitOffset` does sit above), but check
  nothing downstream reads a small `rows` as a claim about the table.
- **`BestAccessPlanResult.rows === 0`** is documented as an unsatisfiability *claim* that
  folds the access into an empty relation. `rowsToProduce` floors at 1, so a `limit 0`
  cannot manufacture that fold — confirm, and confirm `limit: 0` is handled sanely
  end to end.
- **The pre-existing latent hazard was left in place.** `buildRequest`'s `LimitOffset` arm
  still sets `request.limit` and assembles its residual afterwards with no link between
  the two. That arm is unreached (the `Literal(null)` OFFSET refusal keeps it so), which
  is why it was not touched — but it is now inconsistent with the contract this change
  documents. Decide whether that is a `NOTE:` or a fix.
- **Docs.** `docs/module-authoring.md` gained the contract. `docs/optimizer.md` (~line 398)
  and `docs/plugins.md` (~1409) also print `BestAccessPlanRequest` and were **not**
  updated — check whether they should be, or whether one canonical statement is right.

## Testing

`packages/quereus-store/test/plan-time-limit.spec.ts`, 10 cases, cost-profile-parameterized
because **this class is invisible at the memory backend's cost profile by construction**:
at a cheap `pointRead` the ordered plan wins even priced whole-table, so no memory-backend
test can fail on it. That was a stated requirement on the ticket, not a preference.

Verified the end-to-end case genuinely pins the fix: with the `rowsWanted` argument removed
the plan stops using `ix_bc` and the test fails; restored, it passes.

Covered: the veto flip at `pointRead = 3.0`; the parity profile picking the same plan
either way; `limit + offset` as the bound; the limit declined when a filter is left in the
residual; declined when the plan does not provide the ordering; the full scan repriced
symmetrically; and — the wrong-answer guard — a NULLable `min` column whose first
boundary row is NULL still answering with the minimum rather than NULL.

`yarn lint`, `yarn typecheck`, `node scripts/check-docs.mjs` all clean.

## Known gaps — treat these as starting points, not as the finish line

- ~~`yarn test:store` was not run.~~ Run after the handoff was drafted: **10276 passing,
  exit 0**, against the LevelDB store module. Closed, not outstanding.
- **No engine-side unit test for `truncationIsSafe` in isolation.** It is exercised only
  through the store spec's end-to-end cases. A direct test over a Filter whose conjunct is
  unclaimed would be worth having, and would pin the identity assumption above.
- **Only the `eq` arm is covered.** `range` and `prefixRange` go through the same
  `seekingArm(pointRead, producedRows)` path but no case drives them under a limit.
- **`min` only.** `max` needs a DESC index to reach the boundary read at all, and no case
  covers `max` under the new pricing.
- **The general case is not fixed and is not meant to be.** A limit the *user* wrote still
  never reaches the module — it sits above the Sort. Filed as
  `feat-sort-absorb-blind-to-limit-general`, which carries the two remaining routes.
