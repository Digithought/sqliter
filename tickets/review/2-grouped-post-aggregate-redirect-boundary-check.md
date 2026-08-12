---
description: A summary query's grouping columns are now translated into the summarised row's columns in one shared place instead of three, and a build-time check catches any part of the planner that forgets — the mistake that caused two shipped bugs. One deliberate strictness change rides along and needs a reviewer's eye.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # redirectPostAggregate (choke point), assertGroupedPlanCoverage (boundary check), buildHavingFilter redirect, context built in buildAggregatePhase
  - packages/quereus/src/planner/building/select.ts               # context consumed from buildAggregatePhase; preWindowSort + early ORDER BY wired; check called at end with the strict-decision NOTE
  - packages/quereus/src/planner/building/select-window.ts        # redirect via choke point; inline per-expression assert removed (superseded by the plan-level check)
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy — positional tail replaced by OrderByOptions; redirect via choke point
  - packages/quereus/test/logic/07.5-window.sqllogic              # new/updated pins: HAVING spellings, preWindowSort, early ORDER BY, strict rejections
  - docs/runtime.md                                               # § Corollary rewritten: what is enforced, where, and that there is no escape hatch
  - docs/window-functions.md                                      # grouped-window section updated to the two shared passes
---

# Review: grouped post-aggregate redirect choke point + plan-time boundary check

## What shipped

A GROUPED query builds several expressions that run **above** the AggregateNode (whose
rows carry only grouping keys and aggregate results): the rebuilt SELECT list, window
specifications and function arguments, the HAVING predicate, and post-aggregate sort
keys. Each builder used to have to remember, on its own, to rewrite grouping-key
spellings that bound to base-table attributes (`wg.a` against `group by a`); two
forgot and shipped as user-visible bugs. Two changes remove the class:

**Arm 1 — one choke point.** `redirectPostAggregate(expr, context, scope)`
(`select-aggregates.ts`) is now the ONE entry point to the rewrite; `redirectToGroupKeys`
and its gate `referencesAggregateInput` are no longer exported. All six sites go through
it: the SELECT-list rebuild, window specs/args, ORDER BY (`applyOrderBy`), HAVING,
the `preWindowSort` keys, and the early ORDER BY placement. The
`GroupedRedirectContext` is built inside `buildAggregatePhase` the moment the
AggregateNode exists and returned to `buildSelectStmt`, so no post-aggregate site can
run before it exists (`buildGroupedRedirectContext` is unexported too).

**Arm 2 — boundary check over the finished plan.** `assertGroupedPlanCoverage(root,
aggregateNode, context)` runs once at the end of `buildSelectStmt` for every grouped
query: walks the plan from the root, stops at the AggregateNode, and rejects any
remaining reference to a pre-grouping attribute with the user-facing "must appear in
the GROUP BY clause or be used in an aggregate function" message and source location.
Subquery-aware: a subquery's own columns and correlated references to an enclosing
query pass; a correlated reference to THIS query's ungrouped column is rejected. The
window phase's inline per-expression assert (`assertGroupedWindowCoverage`) was
removed as superseded — same message, now raised at end-of-build instead of mid-build.

**Arm 1a.** `applyOrderBy`'s nine positional parameters became
`(input, stmt, selectContext, options: OrderByOptions)`; all three call sites in
`select.ts` updated.

## The deliberate behaviour change (review this)

**The strict option was taken**, per the ticket's recommendation, and is the one thing
here that changes what users can run. Queries that genuinely read an ungrouped column
above the aggregate are now **rejected at plan time** where they previously ran and
read an arbitrary representative row per group:

- `select a from wg group by a order by b` — previously sorted by an arbitrary row's
  `b`, windowed twin previously died at run time with an internal error;
- `select a, (select count(*) from wg t where t.b = wg.b) c from wg group by a` —
  correlated subquery reading an ungrouped column, in the select list, HAVING, or
  ORDER BY.

Rationale and revisit condition are in the NOTE at the `assertGroupedPlanCoverage`
call (`select.ts`, end of `buildSelectStmt`): the permissive behaviour was a
wrong-result bug, no test asserted it (ticket's measurement: zero hand-written cases,
18 fuzz-generated keys all inside error-tolerant harnesses), and rejection matches
what the SELECT list and HAVING already do. The weaker buffering-only alternative is
described there too. **If a human wants zero behaviour change, that NOTE and the
`-- error:` pins in 07.5-window.sqllogic are the complete list of what to flip.**

## Behaviour kept (verified by pins)

- `having wg.a = 'x'`, `having upper(wg.a) = 'X'`, computed key `having a || '!' = 'x!'`
  — correct rows, windowed and unwindowed (HAVING's predicate now lands on aggregate
  OUTPUT attributes instead of leaning on the representative-row adjacency accident).
- HAVING's own rejection still fires with its existing message
  (`HAVING references non-grouped column 'b'`), windowed and not.
- All 40+ existing ORDER-BY/SELECT-list spelling pins unchanged.
- The alias-shadow protection stands: the redirect is still gated per expression, so
  `select upper(a) as a … group by a order by a` sorts by the projected value.

## How to validate

From `packages/quereus`:

```bash
node test-runner.mjs --grep "07.5-window"   # the pinned file (fast)
yarn test                                    # full suite: 9541 passing, 0 failing, 25 pending (~2 min)
yarn lint                                    # clean
npx tsc --noEmit -p tsconfig.json            # clean
```

## Known gaps and honest flags for the reviewer

- **The plan-level check is a new walk over every grouped query's finished plan, once
  per prepare.** Cheap per node (set lookups, no fingerprint rendering), but unmeasured;
  the neighbouring NOTE on `redirectNode`'s cost is the precedent if prepare time ever
  shows up.
- **preWindowSort ordering oddity, pre-existing:** a sort placed below the window phase
  is re-ordered by the window's own ORDER BY, so `… group by a, b order by wg.b` with a
  window function returns rows in window order, not `b` order. Pinned with a comment
  saying exactly that; fixing it is not this ticket and no ticket claims it yet.
- **HAVING pushdown interaction not separately probed.** The HAVING FilterNode's
  predicate now references aggregate-output attributes, so an optimizer rule can no
  longer see it as pushable below the aggregate. Nothing in the 9541-test suite
  (including plan/optimizer specs) moved, but no test targets that interaction directly.
- **Error timing moved** for ungrouped window-spec references: end-of-build instead of
  mid-window-phase. Message and location identical; only relevant to tooling that cares
  which sub-build throws.
- `buildGroupByCoverage` / `assertGroupByCoverage` / `GroupByCoverage` / `indexGroupKeys`
  remain exported from `select-aggregates.ts` with no external importers — left alone to
  avoid churn; fold into `backlog/debt-oversized-source-files`'s split when that runs
  (the file is 1,616 lines now; the choke point added ~30 net).
- The fuzz harness (`test/fuzz.spec.ts`) tolerates any `QuereusError`, so the strict
  rejection is invisible to it by design — the sqllogic `-- error:` pins are the only
  guard on the new rejections.
