---
description: The code that decides how to cheaply keep a materialized view up to date inspects the view query's plan and only recognises the cheap strategy while the WHERE clause sits in one particular spot — so a recent optimizer improvement that relocates the WHERE has to be switched off during that inspection. Teach the inspection to recognise the relocated WHERE so the switch-off can be removed.
files:
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts   # ANALYSIS_DISABLED_RULES — the switch-off
  - packages/quereus/src/core/database-materialized-views-analysis.ts        # bodyWhereReferencesLookup (~line 351)
  - packages/quereus/src/planner/analysis/coverage-prover.ts                 # resolveFullScanTableRef (~652), walkToConstrainedBase (~413), proveOneToOneJoin (~473)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts        # "join-residual partial-WHERE plan selection" guards the outcome
  - docs/mv-maintenance.md                                                   # § 'join-residual' — documents the suppression
difficulty: hard
---

# Materialized-view maintenance analysis is pinned to a pre-pushdown plan shape

## What is going on

A materialized view is a query whose answer is stored. When a source table changes, the
engine has to update that stored answer. It picks a *strategy* for doing so, and the good
strategies only touch the few rows affected by the change; the fallback ("full rebuild")
re-runs the entire view query on every write.

The strategy is chosen by **inspecting the shape of the view query's optimized plan**. Two
of those inspections assume the query's `WHERE` clause appears as a distinct filtering step
sitting at or above the join:

- `bodyWhereReferencesLookup` asks "does the `WHERE` mention the looked-up table?", and finds
  the `WHERE` by looking for filter steps at or above the join. It cannot see a condition
  that has been absorbed into a table-access step further down.
- The join coverage prover's `resolveFullScanTableRef` requires the looked-up side of the
  join to still expose that table's **complete** row set, so it refuses the moment a filter
  appears on that side.

`join-predicate-pushdown` (landed by `feat-filter-pushdown-through-join`) moves a `WHERE`
condition that mentions only one of the joined tables down onto that table's side of the
join — exactly the relocation both inspections cannot follow. The consequence is not a wrong
answer: every affected view silently falls back to the full-rebuild strategy, so each write
re-runs the whole view query.

## What ships today

`buildMaintenancePlan` and `compileLookupMembershipResidual` build their inspection plan with
that one optimizer rule disabled (`ANALYSIS_DISABLED_RULES`). That restores the previous
strategy choice and is correct — the plans that actually run are compiled separately through
the full optimizer and do keep the pushdown. It is a workaround, not a fix, and it carries
two liabilities:

1. **It is a standing coupling.** Any future optimizer rule that relocates a view body's
   `WHERE` relative to its join breaks the same two inspections and must be added to the same
   list. The failure is silent — results stay correct, maintenance just gets slow.
2. **The blind spot is unrepaired and now untestable.** With the rule disabled for this path,
   `bodyWhereReferencesLookup` never meets a relocated condition, so nothing exercises (or
   fixes) its inability to look inside a table-access pipeline.

## What to build

Make the two inspections read the view body's `WHERE` regardless of where the optimizer put
it, then delete `ANALYSIS_DISABLED_RULES` and its call-site arguments (and the
`optimizeForAnalysis` `disabledRules` parameter, if nothing else wants it).

Two halves, and they are not equally easy:

- **`bodyWhereReferencesLookup`** — mechanical. It needs to collect conditions from the
  table-access pipeline on each side of the join as well as from filter steps above it.
- **The coverage prover's lookup-side strictness** — a soundness question, and the reason
  this is filed rather than fixed. `resolveFullScanTableRef` refusing a filtered lookup side
  is deliberate for its original caller. But the sibling descent `walkToConstrainedBase`
  already treats a filter on the *driving* side as transparent, so the two sides are held to
  different standards. Whoever picks this up must decide, with an argument, whether the
  `proveOneToOneJoin` caller may treat a lookup-side filter as transparent too — and if it
  may not, this ticket reduces to its first half plus a different way of classifying the
  body (e.g. classify from the view's original SQL statement rather than from a plan shape).

## Expected behaviour when done

- A materialized view whose body is a 1:1 join with a `WHERE` on either side still selects
  the bounded-delta (`join-residual`) strategy, with no optimizer rule suppressed anywhere in
  the analysis path.
- The existing guard — `maintenance-equivalence.spec.ts` § "join-residual partial-WHERE plan
  selection" — passes unchanged, and gains a companion asserting the same selection for a
  body whose `WHERE` names the lookup table.

## How it was found

Review of `feat-filter-pushdown-through-join`. The implementer flagged the workaround and
asked for a second opinion; the reviewer agreed the workaround was the right call for that
ticket's scope and filed the real fix here.
