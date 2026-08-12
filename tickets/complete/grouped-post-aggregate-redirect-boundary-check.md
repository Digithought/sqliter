description: A summary query's grouping columns are now translated into the summarised row's columns in one shared place instead of three, and a build-time check catches any part of the planner that forgets — the mistake that caused two shipped bugs. Queries that read a column the summary does not carry are now rejected instead of quietly reading an arbitrary row.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # redirectPostAggregate (choke point), assertGroupedPlanCoverage (boundary check), buildHavingFilter redirect, context built in buildAggregatePhase
  - packages/quereus/src/planner/building/select.ts               # context consumed from buildAggregatePhase; preWindowSort + early ORDER BY wired; check called at end with the strict-decision NOTE
  - packages/quereus/src/planner/building/select-window.ts         # redirect via choke point; inline per-expression assert removed
  - packages/quereus/src/planner/building/select-modifiers.ts      # applyOrderBy — positional tail replaced by OrderByOptions; redirect via choke point
  - packages/quereus/test/logic/07.5-window.sqllogic               # pins: HAVING spellings, preWindowSort, early ORDER BY, strict rejections, computed-key qualifier narrowing, correlated EXISTS/IN
  - docs/runtime.md                                                # § Corollary rewritten: what is enforced, where
  - docs/window-functions.md                                       # grouped-window section: the two shared passes
  - docs/sql-select.md                                             # §3.3/§3.5 — the user-facing statement of the new strictness (added in review)
----

# Grouped post-aggregate redirect choke point + plan-time boundary check

## What shipped

A GROUPED query builds several expressions that run **above** the AggregateNode, whose
rows carry only grouping keys and aggregate results: the rebuilt SELECT list, window
specifications and function arguments, the HAVING predicate, and post-aggregate sort
keys. Each builder used to have to remember, on its own, to rewrite grouping-key
spellings that bound to base-table attributes (`wg.a` against `group by a`); two forgot
and shipped as user-visible bugs.

**Arm 1 — one choke point.** `redirectPostAggregate(expr, context, scope)`
(`select-aggregates.ts`) is the ONE entry point to the rewrite; `redirectToGroupKeys`,
`referencesAggregateInput` and `buildGroupedRedirectContext` are no longer exported. All
six sites go through it: the SELECT-list rebuild, window specs/args, ORDER BY
(`applyOrderBy`), HAVING, the `preWindowSort` keys, and the early ORDER BY placement.
The `GroupedRedirectContext` is built inside `buildAggregatePhase` the moment the
AggregateNode exists, so no post-aggregate site can run before it.

**Arm 2 — boundary check over the finished plan.** `assertGroupedPlanCoverage(root,
aggregateNode, context)` runs once at the end of `buildSelectStmt` for every grouped
query: walks the plan from the root, stops at the AggregateNode, and rejects any
remaining reference to a pre-grouping attribute with the user-facing "must appear in the
GROUP BY clause or be used in an aggregate function" message and source location.
Subquery-aware: a subquery's own columns and correlated references to an enclosing query
pass; a correlated reference to THIS query's ungrouped column is rejected. The window
phase's inline per-expression assert was removed as superseded.

**Arm 1a.** `applyOrderBy`'s nine positional parameters became `(input, stmt,
selectContext, options: OrderByOptions)`; all three call sites updated.

## The deliberate behaviour change

Queries that read an ungrouped column above the aggregate are now **rejected at plan
time** where they previously ran and read an arbitrary representative row per group —
`select a from wg group by a order by b`, and correlated subqueries reading an ungrouped
column from the select list, HAVING or ORDER BY. Rationale and revisit condition are in
the `NOTE:` at the `assertGroupedPlanCoverage` call (`select.ts`). If a human wants zero
behaviour change, that NOTE plus the `-- error:` pins in `07.5-window.sqllogic` are the
complete list of what to flip.

## Behaviour kept (verified by pins)

- `having wg.a = 'x'`, `having upper(wg.a) = 'X'`, computed key `having a || '!' = 'x!'`
  — correct rows, windowed and unwindowed.
- HAVING's own rejection still fires with its existing message, windowed and not.
- All 40+ existing ORDER-BY/SELECT-list spelling pins unchanged.
- Alias shadowing: `select upper(a) as a … group by a order by a` still sorts by the
  projected value (the redirect stays gated per expression).
- ORDER BY / HAVING over an aggregate of an *ungrouped* column stays legal
  (`select grp from aob group by grp order by max(val) desc`) — the aggregate exemption
  in the new walk is covered by existing pins in `07.3-group-by-extras.sqllogic`.

## Review findings

Reviewed the implement diff (`96d6149e`, plus the partial work committed with the resume
note in `5d8082c3`) before the handoff summary; probed the new check with ~45 ad-hoc
queries covering CTEs, derived tables, correlated subqueries in every clause, compound
selects, DISTINCT, positional/alias sort keys, and aggregate-over-ungrouped-column
exemptions.

**Validation run (all from `packages/quereus`)**

- `yarn test` — 9541 passing, 0 failing, 25 pending, before and after the review edits.
- `yarn lint` — clean (eslint + `tsconfig.test.json` pass, no output).
- `npx tsc --noEmit -p tsconfig.json` — clean.
- `node test-runner.mjs --grep "07.5-window"` — passing with the added pins.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

**Fixed in this pass (minor)**

- *Undocumented arm of the behaviour change, plus missing pins.* A **computed** grouping
  key is matched by expression text, so a qualifier the GROUP BY did not use is not
  recognised — `select upper(a) k from wg group by upper(a) order by upper(wg.a)`
  planned and ran before this ticket (off the representative row) and now errors. Real,
  reproduced, and not in the implement handoff's list of what changed. It is at least
  *consistent* now: the select-list spelling of the same query has always been rejected,
  and the windowed spelling was already rejected by the old window-phase assert. Pinned
  in `07.5-window.sqllogic` (both rejections plus windowed/unwindowed controls proving
  the matching spelling still works) and filed as a class fix — see below.
- *User-facing docs did not describe the new strictness.* `docs/runtime.md` and
  `docs/window-functions.md` were updated by the implement pass, but both are internals
  docs; `docs/sql-select.md` — the SQL reference a user actually reads — still described
  ORDER BY without the restriction. Added: §3.3 now states that the GROUP BY restriction
  covers every post-grouping clause including correlated subqueries, and that a
  qualifier difference counts for computed keys but not for bare-column keys; §3.5 now
  states that a grouped query's ORDER BY term must be a grouping key, aggregate, alias
  or ordinal, with no "arbitrary row of the group" tolerance.
- *Missing pins for the other correlated shapes.* Only the scalar-subquery form of the
  new rejection was pinned. Added `-- error:` pins for correlated `exists` in HAVING and
  a correlated `in`, plus controls showing both shapes correlated on the grouping key
  still run.
- *Dead module surface.* `buildGroupByCoverage`, `assertGroupByCoverage`,
  `GroupByCoverage` and `indexGroupKeys` were exported with no importer outside
  `select-aggregates.ts` (the handoff flagged them and deferred them). Unexported — four
  keywords, and it matches this ticket's own "one entry point, everything else private"
  shape rather than waiting on the file split.

**Filed as tickets (major)**

- `backlog/debt-group-key-match-by-attribute-identity` — grouping keys are recognised by
  rendered AST text, which keeps the qualifier. Filed at the class level rather than as
  the ORDER BY instance: the same cause produces the false *rejection* above, the false
  *redirect* residue already recorded in the `NOTE:` on `redirectToGroupKeys`, and the
  aggregate-matching narrowing already pinned in `07.3-group-by-extras.sqllogic`.
  Matching on resolved identity retires all three. No open ticket claimed the site.
- `backlog/bug-having-rejects-correlated-outer-column` — **pre-existing**, found while
  probing: `select w.b, (select count(*) from wg t group by t.a having t.a = w.b) …`
  is rejected as an ungrouped column, though `w.b` belongs to the enclosing query and
  the same correlation in WHERE works. Unchanged by this diff (the redirect's gate is
  false for foreign attribute ids). Filed with the class-level fix named: route HAVING's
  check through `isPreGroupingReference`, the predicate this ticket introduced, which
  draws the "belongs to this query" line correctly.

**Recorded as tripwires, not tickets** (both as `NOTE:` at `assertGroupedPlanCoverage`)

- The walk's stop condition is node **identity**, so it holds only while
  `buildSelectStmt` *wraps* the aggregate. A future post-aggregate step that rebuilds
  the spine through `withChildren` would mint a new AggregateNode, the walk would run
  past it into the aggregate's input, and legal pre-grouping references down there would
  be rejected. Fine today — nothing between `buildAggregatePhase` and the check rebuilds
  the spine.
- Cost of the extra walk. The handoff flagged it as unmeasured; measured end-to-end
  (300 compiles, warmed): a six-column grouped query compiles in ~0.6–0.8 ms against
  ~0.5 ms for a comparable ungrouped one, so the walk is bounded well below surrounding
  planning cost. Not isolated further — that would need instrumentation left in the
  source. Revisit condition recorded.

**Evidence appended to an existing ticket**

- `backlog/debt-oversized-source-files` — `select-aggregates.ts` is now **1,630** lines
  (`wc -l`, 2026-08-12; the ticket recorded 1,486 earlier the same day). Updated that
  ticket's entry rather than filing a size ticket.

**Checked and found nothing**

- *Correctness of the walk's subquery awareness.* Probed CTE bodies reachable from both
  the FROM clause and a window specification, derived tables, uncorrelated subqueries,
  correlations to an enclosing query, and grouped subqueries correlated outward
  (`select w.b, (select count(*) from wg t group by t.a order by w.b limit 1) …`
  plans and runs). No false positives found.
- *The aggregate exemption* in `findUngroupedPostAggregateRef` (this query's own
  aggregates read ungrouped columns by definition) — load-bearing and already covered by
  existing pins (`07.3-group-by-extras.sqllogic` lines 135, 251, 400); they pass.
- *Compound selects, DISTINCT, LIMIT/OFFSET, positional and alias sort keys* — all
  exercised, all unaffected.
- *HAVING pushdown interaction*, which the handoff flagged as unprobed: the HAVING
  predicate now names aggregate-output attributes, so an optimizer rule can no longer
  see it as pushable below the aggregate. Nothing in the suite (including the plan and
  optimizer specs) moved. Left as-is — no test targets it directly, and inventing one
  would pin a plan shape no rule currently produces.
- *Error message and location quality* — the new rejection reports the written spelling
  (`wg.b`, not `b`) with line/column; matches the select-list message exactly.
- *The `OrderByOptions` refactor* — all three call sites pass the options they used to
  pass positionally; the two boolean parameters that motivated the change are now named.
  No behaviour difference found.

**Known gaps carried forward, unchanged**

- `preWindowSort` ordering oddity (a sort below the window phase is re-ordered by the
  window's own ORDER BY) is pre-existing, pinned with a comment saying exactly that, and
  claimed by no ticket. Not this ticket's to fix.
- The fuzz harness tolerates any `QuereusError`, so the new rejections are invisible to
  it by design; the sqllogic `-- error:` pins are the only guard.
- Error *timing* moved for ungrouped window-spec references (end-of-build rather than
  mid-window-phase); message and location identical.
