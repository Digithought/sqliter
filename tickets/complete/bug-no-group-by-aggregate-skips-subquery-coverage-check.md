---
description: A query that totals something without grouping it now reports a clear, actionable error when its filtering or trimming clauses reference a column the totalled row does not carry — previously it either answered wrongly or died with an internal message.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts     # the coverage/redirect context split, buildHavingFilter, assertGroupedPlanCoverage doc
  - packages/quereus/src/planner/building/select.ts                # coverage binding, window-phase tripwire NOTE, finished-plan guard
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic      # negative + positive cases for the ungrouped shape
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # whole-list ORDER BY placement cases
  - packages/quereus/test/plan/ungrouped-aggregate-sort-placement.spec.ts  # new: pins the sort/aggregate seam
  - docs/sql-select.md                                             # §3.3, §3.5, §3.6
  - docs/runtime.md                                                # the boundary-check half of the invariant
---

# Complete: whole-plan coverage check now runs for an aggregate query with no `group by`

## What shipped

An aggregate query's clauses that sit *above* the aggregation — `having`, `order by`
(when forced up there), `limit`, `offset` — can read only what an aggregated row
carries. The whole-plan check that enforces this (`assertGroupedPlanCoverage`) is the
only one of the checks that sees inside subqueries, and it was guarded on a value built
only for a query **with** `group by`. A `group by`-less aggregate query — which still
has exactly one implicit group — therefore never reached it.

The implement stage split that one value in two: `groupedCoverageContext` ("what does an
aggregated row of this query carry?", built for every aggregate query) and
`groupedRedirectContext` ("are there grouping keys to rewrite onto?", still gated on
`group by`). Every pre-existing consumer keeps the gated one, so nothing about grouped
queries changed. `buildHavingFilter`'s local re-derivation of the same context was
deleted in favour of the passed-in one.

Six query shapes that previously answered wrongly or died at runtime with
`No row context found for column …` now report `Column '…' must appear in the GROUP BY
clause or be used in an aggregate function` at plan time. One user-visible behaviour
change: for a no-`group by` aggregate query, `order by` placement is decided for the
whole list, so `select count(*) as c from t order by c, id` is now an error.

## Review findings

### Verified independently

The six rejections and all documented positives were re-run against the current build
rather than taken from the handoff, plus shapes the handoff did not cover: `update` /
`delete` with a correlated ungrouped-aggregate subquery, `insert … select` with an
illegal `limit`, `exists` (rather than scalar) subqueries in `having`, aggregates over a
CTE reference and over a join, `distinct` above the implicit group, an ungrouped
aggregate subquery whose `limit` correlates *out* to the enclosing query, compound
(`union all`) and `values`-fed aggregates, and `order by` ordinals. Every rejection is
the intended one and no legal shape is over-rejected.

Two gaps the handoff listed as unprobed were probed and are fine:

- **Materialized-view bodies.** `create materialized view … as select count(*) as c from
  wg limit b` is rejected at create time, exactly like the plain-view case. Now pinned in
  `07.3`.
- **Window functions above an ungrouped aggregate.** Confirmed unreachable: every
  spelling is rejected first by "Cannot mix aggregate and non-aggregate columns in SELECT
  list without GROUP BY". Recorded as a tripwire rather than left as an untested corner
  (see below).

### Fixed in this pass (minor)

- **A guard that could re-introduce the same silent skip.** The finished-plan check was
  written `if (groupedCoverageContext && aggregateResult.aggregateNode)` — the same shape
  of guard (keyed on a context that may be absent) whose wrong choice caused this bug.
  Inverted to key on the AggregateNode, with a missing context raising an internal error
  instead of skipping the check. `select.ts`.
- **A stale comment introduced by the change.** The `groupedRedirectContext` binding in
  `select.ts` still claimed responsibility for the boundary check it no longer feeds.
  Rewritten; the duplicated "one implicit group" explanation in the adjacent NOTE was
  trimmed to one statement rather than repeated in four places.
- **The performance tripwire's scope.** The existing `NOTE:` above
  `assertGroupedPlanCoverage` said "per grouped query" and "revisit if preparing grouped
  queries shows up as slow". Ungrouped aggregate queries now pay that walk plus the
  `collectDefinedAttrIds` pass that builds their context, so the NOTE says so rather than
  relying on a reader to extend it mentally.
- **Docs that the change should have touched.** `docs/runtime.md` still described the
  boundary check as walking "a grouped query's plan"; corrected, with the no-`group by`
  case and the below-the-aggregate input sort spelled out. `docs/sql-select.md` §3.3
  listed the post-grouping restriction's clauses without `limit`/`offset` (both of which
  the check now covers) and without the implicit-single-group case; §3.6 documented
  `limit`/`offset` as plain expressions with no mention of the restriction at all. Both
  fixed. `yarn docs:check` passes.

### Tests added in this pass

- `packages/quereus/test/plan/ungrouped-aggregate-sort-placement.spec.ts` (new, 3 cases)
  closes the handoff's "no plan-shape test" gap: the pre-aggregate `SortNode` is a
  descendant of the aggregate for both a plain and a correlated-subquery sort key, and
  `limit` sits above the aggregate while that sort stays below it. The extension is legal
  *by plan shape*, not by a special case in the check, and this is what says so. Note the
  sort keys are expressions on purpose — a bare-column key is satisfied by the scan's
  index order and leaves no `SORT` node to assert on, which is why the first draft of
  this test failed.
- `07.3-group-by-extras.sqllogic`: materialized-view body (the unprobed gap), `exists`
  spelling of the correlated-subquery rejection, an ungrouped aggregate subquery whose
  `limit` correlates out to the enclosing query (the over-rejection risk that newly
  covering `limit` introduces), and the `union all` / `values` shapes the handoff had
  probed by hand but not pinned.

### Filed as a new ticket (major)

- **`tickets/fix/bug-having-without-aggregates-silently-dropped.md`** — found while
  reading `buildAggregatePhase`'s guards, adjacent to but not caused by this change.
  `shouldPushHavingBelowAggregate` is computed from `stmt.having && !hasAggregates &&
  !hasGroupBy`, but the early return two lines below fires on `!hasAggregates &&
  !hasGroupBy`, so the branch it guards is unreachable. `select-aggregates.ts` is the only
  builder that reads `stmt.having`, so `select a from wg having a = 'x'` returns every row
  with the predicate silently discarded (verified). Long-standing, not introduced here.
  The ticket asks for a clause-canary test over the whole class ("a clause the parser
  accepted never reached the plan") rather than a single-case regression, and flags that
  the intended semantics — SQLite's implicit-single-group reading versus the dead
  branch's own where-like intent — must be decided before the fix.

### Recorded as tripwires, not tickets

- **Window function above an ungrouped aggregate.** Fine now (unreachable), only matters
  if the "cannot mix aggregate and non-aggregate columns" check is ever loosened, at which
  point a `WindowNode` could land above an ungrouped aggregate and fall under the coverage
  walk untested. `NOTE:` at the `buildWindowPhase` call in `select.ts`.
- **Cost of the extra walk for ungrouped aggregate queries.** Folded into the existing
  `NOTE:` above `assertGroupedPlanCoverage` (see above) rather than duplicated at a second
  site.

### Considered and not changed

- **The error message names the `group by` clause for a query that has none.** The
  handoff flagged this as possibly odd. It is the standard SQL wording, it matches what
  the grouped form emits for the identical mistake, and the fix ticket specified it —
  changing it would give one user error two messages. Documented instead:
  `docs/sql-select.md` §3.3 now says outright that the message names a clause the query
  need not have.
- **`buildHavingFilter` now takes eight positional parameters**, two of them adjacent and
  of the same type. Genuine signature smell, but the dangerous swap does not compile (the
  coverage parameter is required and the redirect one is optional), and reshaping it
  would be churn beyond this fix. Left alone.
- **`select-aggregates.ts` size** — 1,668 lines (`wc -l`), up 23 from the 1,645 recorded
  before this change. Already claimed by `tickets/backlog/debt-oversized-source-files.md`,
  which names this file with proposed seams; per the "Nth instance is evidence" rule the
  measurement there was updated instead of filing again.
- **The strictness of the check itself** — rejecting queries SQLite tolerates
  (`select count(*) as c from t order by c, id`) — carries an accepted-tradeoff `NOTE:` at
  the `assertGroupedPlanCoverage` call site with an explicit revisit condition (SQLite
  bare-column `order by` tolerance becoming a compatibility requirement). That has not
  tripped, so it was not re-litigated.

### Empty categories

No findings on resource cleanup (the change allocates two `Map`s and a `Set` per
aggregate query at plan time and holds nothing beyond the plan), on error handling
beyond the message wording above (every new rejection goes through the existing
`QuereusError` path with line/column from the offending expression), or on type safety
(no `any`, no new casts; the one `undefined`-typed value is now the exception path
rather than the guard).

## Validation at hand-off

- `yarn workspace @quereus/quereus test` → **10194 passing, 25 pending, 0 failing**
  (10191 before this pass, plus the 3 new plan-shape cases).
- `yarn test` (every workspace) → all green.
- `yarn lint` (all workspaces; the quereus one type-checks test files too) → clean.
- `yarn docs:check` → "Docs OK".
- The `bench-calibration.spec.ts` flake the implement stage reported in
  `tickets/.pre-existing-error.md` was fixed by the runner's triage pass (commit
  `ab5b6b3dd`) and did not recur in either full run here.
