---
description: Asking for a row number or running total alongside a grouped summary used to crash, and mixing `select *` with a window column silently lost the star's columns. Both are fixed, illegal window specifications now fail with a clear message, and an unaliased window column gets a sensible name. Review found and filed three further defects in the same area.
files:
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/select-window.ts
  - packages/quereus/src/planner/building/select-aggregates.ts
  - packages/quereus/src/planner/building/function-call.ts
  - packages/quereus/src/planner/building/select-modifiers.ts
  - packages/quereus/test/logic/07.5-window.sqllogic
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts
  - docs/sql-select.md
  - docs/window-functions.md
---

# Window functions in grouped queries, and `*` in any window query

## What shipped

The window phase's final projection is now the query's **one** select-list
projection; it is no longer re-derived from the AST.

```
  Aggregate  →  [HAVING Filter]  →  Window  →  Project(select list)
```

`buildWindowPhase` takes a `readonly Projection[]` (stars already expanded, in
written order, window functions still present as raw `WindowFunctionCallNode`
subtrees) and rewrites each entry, swapping every window-function descendant for
the `ArrayIndexNode` pointing at its computed window-output column and leaving
everything else untouched. `buildSelectStmt` supplies that list — for a grouped
query, `buildFinalAggregateProjections`' output (no longer wrapped in its own
`ProjectNode` when window functions are present); for an ungrouped query, the
`projections` array it already assembles.

That fixes both original defects: no second projection walk leaves a raw window
expression below the node that computes window values (`No emitter registered for
WindowFunctionCall`), and a `*` entry is an ordinary projection rather than
something the walk skipped.

Three follow-on items landed with it:

- **Plan-time validation of window specifications in a grouped query.** The GROUP
  BY coverage predicate is now shared instead of duplicated: `select-aggregates.ts`
  exports `GroupByCoverage`, `buildGroupByCoverage` and `assertGroupByCoverage`,
  used by the select-list check, the HAVING check and now the window phase (applied
  to every partition expression, order-by expression and function argument). An
  ungrouped column in an `OVER (…)` clause now fails with the standard message
  instead of an internal runtime error.
- **Aggregate-in-window-specification rejection.** `findMatchingAggregate` was
  extracted from `buildFunctionCall` so the window phase can ask the same question
  the builder answers. An aggregate the SELECT list already computes reads the
  computed column; one that appears only in the window specification now raises a
  named limitation instead of the generic "not allowed in this context".
- **Unaliased window column names.** `select row_number() over (order by v) from t`
  is named after the authored expression rather than the substituted array index
  (`[2]`).

## Review findings

Reviewed the full fix + implement diff (`1acc955^..e35bbfb`) against the current
sources, then probed ~50 grouped/window/star query shapes against HEAD in a scratch
mocha spec (deleted afterwards).

### Fixed in this pass (minor)

- **`docs/window-functions.md` documented an optimization that does not run.** Its
  "Window Specification Grouping" section claimed the planner merges window
  functions with identical specifications into one `WindowNode` — single sort pass,
  shared partition processing. The implement stage had already discovered in code
  (and left two `NOTE:`s about) that the grouping key is `JSON.stringify` over raw
  AST fragments *including* source-location data, so identical clauses never key
  equal and nothing ever groups. The doc now says so and points at the `NOTE:`s.
  Its Planner Layer section also still named `select.ts` for work that lives in
  `select-window.ts` and said nothing about grouped queries; both corrected.
- **`rejectUncollectedAggregates`' `arguments` arm is unreachable.** Its doc comment
  claimed it covers a window function's arguments. It cannot fire: `expression.ts`'s
  `windowFunction` case builds each argument once for type inference, from
  `analyzeSelectColumns`, against the pre-aggregate context with aggregates
  disallowed — so `sum(count(*)) over ()` dies there first. Added a `NOTE:` saying
  the arm is inert today and what makes it live. (The underlying limitation is filed
  — see below.) The *non-aggregate* argument check next to it is reachable and is
  asserted (`select a, sum(b) over () from wg group by a`).
- **Test coverage gaps.** Added to `07.5-window.sqllogic`: two window functions with
  different specifications in one grouped query; two textually identical ones; an
  aggregate named by its SELECT-list alias inside the window specification; a
  qualified grouping key in the specification when the GROUP BY is itself qualified;
  a grouped+window query consumed as a CTE. All pass.

### Filed as tickets (major)

- **`fix/bug-window-spec-reads-base-table-column`** — legal grouped+window queries
  still die with the internal `No row context found for column a`, in two shapes the
  implemented guard lets through: a grouping key named with its table qualifier
  inside `OVER (…)` when the GROUP BY wrote it bare (`group by a` +
  `over (order by wg.a)`, and the table-alias form), and a non-bare grouping key
  (`group by a || '!'` + `over (order by a || '!')`). Root cause is one site: the
  window phase builds its specification expressions with no equivalent of
  `buildFinalAggregateProjections`' group-key redirect, while `buildGroupByCoverage`
  deliberately admits base-table attribute ids (correct for the select-list caller,
  wrong for a `WindowNode`, which can only read the aggregate's output row). Not a
  regression — every grouped+window query failed before this ticket.
- **`fix/bug-aggregate-reuse-matching-ignores-arguments`** — `findMatchingAggregate`
  compares arguments only when both sides are bare columns or both are literals and
  treats every other shape as matching, so `order by sum(a+0)` silently binds to a
  select-list `sum(b+0)` and returns wrong rows with no error. Confirmed in `HAVING`,
  top-level `ORDER BY` and a window specification. Pre-existing (the implement stage
  flagged it as a known gap and did not introduce it), but it is now also the gate
  on the new rejection, and it produces wrong answers rather than errors.
- **`backlog/feat-aggregate-inside-window-function-argument`** — `select a, count(*)
  c, sum(count(*)) over () t from wg group by a` (running total of per-group counts,
  accepted by PostgreSQL and SQLite) fails with the generic "Aggregate function count
  not allowed in this context". Pre-existing limitation, same site as the dead arm
  above.

### Checked, no defect found

- **The handoff's first "known gap" does not exist.** It supposed an *aggregate
  without GROUP BY* plus a window function would reach the runtime with a base-table
  reference. It does not: `select count(*) c, row_number() over (order by v) w from
  sw` is rejected earlier with `Cannot mix aggregate and non-aggregate columns in
  SELECT list without GROUP BY`. The deliberate `groupByExpressions.length > 0` gate
  on the coverage object is therefore harmless.
- **Star handling.** All seven star shapes in the handoff verified, plus qualified
  star, `distinct` + star + window, and positional `order by` over a star-bearing
  window query. Column identity, order and the `v:1` disambiguation are right, and
  are pinned in `grouped-projection-shape.spec.ts` (row objects compare
  key-order-insensitively in `.sqllogic`, so ordering has to live there).
- **Composition.** Grouped+window verified inside a view, a CTE, a scalar subquery,
  a `union all` leg, and over a join; with `having`, `distinct`, `limit`, alias
  `order by` and positional `order by`. All correct.
- **Window-column resolution despite the never-grouping grouping.** Two identical
  and two differing window specifications in one query each resolve to their own
  output column — the `loc`-bearing comparison the `NOTE:`s describe is what makes
  that work, and it is now asserted rather than merely commented.
- **Unaliased window column case-folding.** The handoff said names come out fully
  lowercased; they are actually mixed — `SELECT ROW_NUMBER() OVER (ORDER BY V)`
  yields `row_number() over (order by V)`, because `expressionToString` folds
  function names but preserves identifiers. Consistent with existing `count(*)`
  naming; cosmetic, no change made.
- **A select-list alias inside `OVER (…)`** (`select a k, row_number() over (order by
  k) …`) fails with `Column not found: k`. That matches PostgreSQL, which does not
  expose output names to a window ORDER BY. Correct as-is.
- `preserveInputColumns` is not threaded into the window phase's `ProjectNode`
  (it defaults to `true`), matching the pre-existing ungrouped window path. It only
  affects attribute-id preservation, not output shape, and every composition case
  above is correct — no change made.

### Tripwires parked

Three `NOTE:`s from the implement stage were checked and left in place — the two in
`select-window.ts` on the `loc`-bearing spec comparison (load-bearing: making it
structural without teaching `findWindowColumnIndex` to match by identity collapses
two same-named functions onto one column) and the one pointing at
`collectOrderByAggregates` as the shape a window-spec aggregate fix would take. One
`NOTE:` added, on `rejectUncollectedAggregates`' inert `arguments` arm (above). The
`docs/window-functions.md` correction is where the never-grouping behavior is now
recorded architecturally.

## Validation

- `yarn workspace @quereus/quereus run lint` (eslint + `tsconfig.test.json` type
  pass) — exit 0, no output.
- `yarn test` (all workspaces) — **0 failing**; quereus 8686 passing, every other
  package at its pre-change count (376, 113, 63, 17, 28, 1362, 725, 85, 31, 59, 68,
  34, 134, 22).
- `yarn docs:check` — 2 failures, both pre-existing and already tracked by
  `plan/1-debt-docs-size-ratchet-red-again` (`docs/schema.md`, `docs/sync.md` over
  their size ratchets). `docs/window-functions.md` is not among them.
- `yarn test:store` was **not** run, in either stage. Nothing in the diff is
  storage-specific, but the LevelDB store path remains unexercised for these plans.
