description: A WHERE clause that tests a column against a related subquery used to fail at runtime whenever the subquery selected a computed value or used DISTINCT, LIMIT, or UNION. The engine fix landed earlier; this stage adds the regression tests and doc updates that lock it in.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts   # fix (pre-existing, unmodified this stage)
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                    # new plan-shape assertions added
  - packages/quereus/test/logic/07.8.1-correlated-in-decorrelation-gates.sqllogic # new sqllogic file (result-correctness)
  - docs/optimizer-rules.md                                                      # ruleSubqueryDecorrelation bullet updated
difficulty: easy
---

# Lock in the correlated-`IN` decorrelation shape gates — review

## What this stage did

The engine fix (three gates in `extractInCorrelation` inside
`rule-subquery-decorrelation.ts`, plus a cosmetic AST fix for the join
condition's inner column reference) was already landed by a prior fix-stage
agent before this ticket reached `implement/`. This stage's job was purely to
add the regression corpus and doc updates the original ticket called for —
**no engine code was touched**.

### 1. Plan-shape assertions — `packages/quereus/test/plan/subquery-decorrelation.spec.ts`

Added to the `'correlated IN decorrelated into semi-join'` describe block:
- `renders the join condition as \`a.x = x\`, not the nonsense \`a.x = a.x\`` —
  pins the cosmetic fix. Verified empirically (see below) that the join
  condition's `BinaryOp` node appears as a **child plan-tree row** of the
  semi-join row (`query_plan()`'s `parent_id` links them), with its own
  `detail` text — that's where `a.x = x` actually renders, not in the join
  node's own `toString()` (which just says `SEMI MERGE JOIN on [<attrId>=<attrId>]`
  / `SEMI HASH JOIN on […]` and never touches expression text).

Added a new describe block, `'correlated IN inner-shape gates
(bug-in-decorrelation-inner-shape-unchecked)'`, pinning the **decline** side
(no semi join, `In` node retained) for:
- computed inner projection (`b.x + 0`) — fresh attribute id, gate 2
- `DISTINCT` above the correlated filter — gate 3 (external-reference backstop)
- `LIMIT` above the correlated filter — gate 1
- `UNION` above the correlated filter — gate 3
- `ORDER BY` above the correlated filter — gate 3

...and the **fire** side (still exactly one semi join) for the two cases the
ticket explicitly wanted *not* broken by an overly broad decline:
- an uncorrelated `LIMIT` *inside* a derived table, below the correlated filter
- a bare pass-through derived table (`select * from b`) wrapping the correlated
  filter

All of the above were verified with throwaway probe scripts against the real
plan tree before being written as assertions (not guessed) — see the "Gaps"
section for what that means for confidence level.

### 2. Result-correctness — new file `packages/quereus/test/logic/07.8.1-correlated-in-decorrelation-gates.sqllogic`

Kept as a **sibling** file rather than appended to
`07.8-correlated-subquery-edges.sqllogic` (that file is generic
"correlated subquery edge cases"; this corpus is specifically about the
decorrelation inner-shape gates, and the existing `07.7.x` directory
convention already splits out rule-specific regression files this way).

Schema: `a(id integer primary key, x integer null)`, `b(id integer primary key,
x integer null)`, matching the ticket's own plan-shape example tables. Data is
constructed so results **differ visibly** between the naive and correct
evaluation wherever possible (e.g. `id=8` has outer `x=0` and matching inner
`b.x=NULL` — `COALESCE(b.x,0)` must include it, bare `b.x` must not; the UNION
cases append a constant `40` that only a genuinely per-row IN evaluation picks
up for `id=4`, which has no matching `b` row at all).

Covers every shape from the original ticket's TODO list: computed projection
(bare, and with a residual inner-only predicate), `COALESCE`, `DISTINCT`,
`LIMIT` / `LIMIT ... OFFSET 0`, `UNION` / `UNION ALL`, `ORDER BY`, an
uncorrelated derived table nested inside the subquery (still decorrelates —
correctness, not just "doesn't throw"), two correlated `IN` conjuncts in one
`WHERE` (exercises the rule's internal per-conjunct loop), `NOT IN`, and
`NOT EXISTS` over `DISTINCT`/`LIMIT` inner shapes.

Every expected result in this file was computed by hand from SQL's
three-valued NULL semantics, then run against the actual engine and corrected
where my arithmetic was wrong (it was, twice — see "Gaps"). It is **not** a
captured-then-pinned snapshot of whatever the engine produced.

### 3. Docs — `docs/optimizer-rules.md`, `ruleSubqueryDecorrelation` bullet

Added a paragraph naming and explaining the three gates (LIMIT/OFFSET decline,
join-key-exposure check, post-build external-reference backstop), and stating
explicitly that a decline is always safe (the `InNode` stays on `emitIn`).

## Validation performed

- `yarn workspace @quereus/quereus run test` — full suite green: **8065
  passing** (up from the pre-existing 8056; the 9 new tests are the 7 new
  `subquery-decorrelation.spec.ts` cases + the 1 new sqllogic file, which
  reports as a single mocha `it`, plus the 1 sqllogic-block wraps many
  `select` statements internally under one `it`). 13 pending (pre-existing,
  unrelated — store-only tests skipped in memory mode).
- `yarn workspace @quereus/quereus run lint` — clean (eslint + the test-file
  `tsc --noEmit` pass).
- Every new plan-shape assertion and every sqllogic expected-result was
  verified against the live engine via scratch probe scripts before being
  committed to the actual test files (scratch files were deleted afterward,
  not left in the tree).

## Gaps / things the reviewer should know

- **I did not re-run the fix-stage agent's 19-shape rule-on-vs-rule-off sweep.**
  The prior stage's ticket body states this was already done and all 19
  shapes agreed; I did not have a reason to distrust that, and duplicating it
  was out of scope for a test-and-docs stage. If the reviewer wants extra
  confidence, re-running that sweep (`disabledRules: new Set(['subquery-decorrelation'])`)
  against the new sqllogic file's 15 queries would be a cheap independent
  check — I did not do it.
- **The `a.x = x` plan-shape assertion relies on `query_plan()`'s row
  hierarchy** (child `BinaryOp` row's `parent_id` pointing at the join row),
  which is a debug/introspection surface (`query_plan()` table-valued
  function), not the primary EXPLAIN text rendering path most users would see
  interactively. I did not check whether `EXPLAIN <query>` (the SQL statement,
  as opposed to `SELECT ... FROM query_plan(...)`) renders the same condition
  text the same way — if there's a separate formatting path for `EXPLAIN`
  proper, it wasn't touched by the fix and wasn't checked by me either.
- **No new engine code was written or changed in this stage.** If the
  reviewer's adversarial pass finds a hole in one of the three gates that the
  new tests don't already cover, that would be a real finding against the
  *fix*, not against this stage's tests — worth flagging clearly which is
  which.
- I did not attempt to construct an inner shape that passes gates 1 and 2 but
  still fails gate 3 in some way *not* already covered (DISTINCT / UNION /
  ORDER BY) — e.g. a CTE reference, or a window function, as the original
  ticket's notes mention CTE bodies as a preserved-verbatim case for the
  *uncorrelated* IN arm specifically. I didn't test a CTE inside a
  *correlated* IN subquery's root. If that's a realistic shape, it might be
  worth a follow-up sqllogic case — I'm flagging it here rather than filing a
  ticket since I have no evidence it's actually broken, only that it's
  untested.

## Review findings

(none yet — this section is for the review stage to fill in)
