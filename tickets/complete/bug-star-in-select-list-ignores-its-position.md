description: A query that mixed `*` with named columns used to put the star's columns first no matter where it was written; it now keeps written order, with tests and docs — done and reviewed.
files:
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/select-projections.ts
  - packages/quereus/src/planner/building/select-aggregates.ts
  - packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic
  - packages/quereus/test/plan/select-list-order.spec.ts
  - docs/sql-select.md
repro: verified
---

# `*` in a select list stays where it was written

## What shipped

Output columns now follow the written select-list order, with each `*` /
`table.*` expanded in place — matching SQLite and PostgreSQL. Values were
always correct; only column position was wrong.

`buildSelectStmt` used to assemble its projection list in two passes (all star
expansions, then all named columns), which lost the written interleaving.
`analyzeSelectColumns` now publishes its per-column results keyed by AST result
column (`projectionsByColumn`), and `buildSelectStmt` walks `stmt.columns` once,
expanding each star in place and pulling each named column from that map. The
grouped path (`buildFinalAggregateProjections`) already walked `stmt.columns`
itself, so both paths now agree.

Landed across commits `e81e6b7f` (source fix) and `ed1cbb85` (tests + doc), plus
the review-pass edits described below.

Coverage: `test/logic/01.1-select-projection-extras.sqllogic` (six value cases,
including `select b as a, *` where the alias collision makes order observable in
the values), `test/logic/07.3.2-grouped-select-list-shape.sqllogic`
(grouped/ungrouped agreement pair), and `test/plan/select-list-order.spec.ts`
(column *order* asserted directly via `getColumnNames()` — the sqllogic harness
compares rows with key-order-insensitive `deep.equal` and cannot see a
reordering on its own). `docs/sql-select.md` §2.1 states the ordering rule and
cross-references §3.3.

## Review findings

### Checked

- Read the source diff (`e81e6b7f`) and the test/doc diff (`ed1cbb85`) before
  the handoff summary. Verified `projectionsByColumn` is keyed by AST identity,
  that aggregate result columns are legitimately absent from the map (routed to
  the aggregate phase), and that the window path never consumed the assembled
  `projections` list, so it is untouched by the reordering.
- Ran behavior probes on the current tree (scratch spec, since removed) across:
  grouped vs ungrouped with a colliding alias, star inside a view, subquery, and
  CTE, `select distinct` with a mixed list, two stars with a named column
  between them, and a star after a computed column. All produced written order.
- Docs: read `docs/sql-select.md` §2.1 and §3.3 — the new bullet is accurate,
  the §3.3 anchor resolves, and no other doc claims stars come first.
- `node test-runner.mjs`: **8647 passing, 13 pending, 0 failing**.
  `test:plans`: 338 passing. `yarn lint` (repo-wide) and
  `yarn workspace @quereus/quereus run typecheck`: clean.

### Fixed in this pass (minor)

- `analyzeSelectColumns` still returned a flat `projections` array that no
  caller read after the fix — two sources of truth for the same data. Removed
  it (and the `addProjection` helper it existed for); the function now returns
  only `projectionsByColumn`, with a comment saying why it is a map.
- Closed the coverage gap the implementer flagged: added grouped-path column-
  order assertions to `select-list-order.spec.ts`, including the
  colliding-alias case (`select b as a, * … group by a, b`) that the grouped
  sqllogic pair could not distinguish, plus a two-stars-around-a-named-column
  case. Verified these pass and that the grouped and ungrouped paths return
  identical column names.

### Filed as a new ticket (major)

- `fix/bug-order-by-ordinal-resolves-to-shadowing-alias` — `order by <number>`
  binds to the *name* of the expression at that output position and re-resolves
  it in a scope where select-list aliases shadow base columns, so
  `select b as a, a as z from nk order by 2` sorts by `b` instead of by `z`.
  Wrong row order, no error. Verified on the current tree, and independent of
  `*` (reproduces with a purely named select list), so not a regression from
  this work — the ordinal→AST→re-resolve mechanism was always name-based. Noted
  in `select-list-order.spec.ts` next to the ORDER-BY-ordinal case, which pins
  output shape only, not which column is sorted on.

### Considered and not filed

- Star expansion *contents* and naming (`a` vs `a:1` disambiguation) are
  unchanged by this work and out of scope, as the original ticket stated.
- The window-function path drops `*` entirely; already tracked on
  `fix/bug-window-function-over-grouped-query-crashes` and untouched here.
- No tripwires recorded — the change removes code rather than adding a
  conditional cost, and the per-column map is bounded by the select list.
