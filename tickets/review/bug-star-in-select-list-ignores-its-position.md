description: A query that mixed `*` with named columns used to put the star's columns first no matter where it was written; the fix (already landed) and its tests are done — this ticket is the review pass.
files:
  - packages/quereus/src/planner/building/select.ts                 # projection list assembled in written order (landed in commit e81e6b7f)
  - packages/quereus/src/planner/building/select-projections.ts     # analyzeSelectColumns publishes projectionsByColumn (landed)
  - packages/quereus/src/planner/building/select-aggregates.ts      # stale comment fix (landed)
  - packages/quereus/test/logic/01.1-select-projection-extras.sqllogic   # NEW ungrouped star-position cases
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic # NEW grouped/ungrouped agreement case
  - packages/quereus/test/plan/select-list-order.spec.ts            # NEW — asserts column *order* directly (sqllogic can't)
  - docs/sql-select.md                                              # NEW §2.1 bullet on select-list output ordering
difficulty: easy
repro: verified
---

# `*` in a select list must stay where it was written

## What was wrong, and the fix

A select list may mix `*` (or `table.*`) with explicitly named columns.
Output columns should appear in the order they were written — SQLite and
PostgreSQL both do this. Quereus instead always emitted every star's columns
**first**, ahead of all named columns, regardless of where the star sat in
the list. Values were always correct; only column position was wrong.

`buildSelectStmt` (`packages/quereus/src/planner/building/select.ts`) used to
build its projection list in two passes: collect star expansions in one
loop, then bulk-append every non-star projection. That lost the written
interleaving. The fix (landed in commit `e81e6b7f`, before this ticket
started) makes `analyzeSelectColumns` publish its per-column results keyed
by AST result column (`projectionsByColumn`), so `buildSelectStmt` walks
`stmt.columns` once, expanding each star in place and pulling each named
column from the map.

A quieter second symptom fell out of the same cause: `order by <ordinal>`
resolves its position against the *written* select list
(`buildSelectListAsts`), which was always correct — but the *displayed*
output column at that same position used to be a different column (because
of the reordering bug), so what a user saw at position N and what "ORDER BY
N" sorted by could visibly disagree. Fixed by the same change (both now
walk written order).

## What this ticket added: tests + one doc line

The fix itself was already in place; this ticket's job (per its TODO list)
was test coverage and documentation. All added, all verified.

### `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic`

Six new cases, table `t1(a integer primary key, b text)`, next to the
existing `select *, *` / `select *, 'lit' as marker` cases:

- `select a, * from t1` — named column before the star.
- `select b as a, * from t1` — **the one case that actually distinguishes
  written order from star-first via `deep.equal`.** Most star/named
  reorderings are invisible to a row-value comparison because the duplicate
  occurrences of a name share the same underlying value (e.g. `a` and its
  star-expanded duplicate `a:1` are both literally column `a`). Aliasing a
  *different* column onto the star's name makes the two occurrences carry
  different values, so which one gets the bare name and which gets `:1`
  is only correct if assembly order matches written order.
- `select a, *, b from t1` — star between two named columns.
- `select upper(b) u, * from t1` — star after a computed column.
- Two more added to the existing self-join section (after the second row is
  inserted): `select A.a as la, B.* from t1 as A cross join t1 as B order by
  la, B.a` (qualified star after a named column).

### `packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic`

Added a grouped/ungrouped agreement pair on table `nk(a text, b text)`
(no primary key, so the FD-driven GROUP BY reduction can't rewrite the
keys out from under it): `select b, a, * from nk order by a` vs `select b,
a, * from nk group by a, b order by a` — same mixed select list, same
output shape and values with and without `group by`. Confirms
`buildFinalAggregateProjections` (grouped path, walks `stmt.columns`
itself) and the ungrouped path assemble star position identically.

### `packages/quereus/test/plan/select-list-order.spec.ts` (new file, not in the original TODO)

**Important gap this closes:** the `.sqllogic` harness compares rows via
`chai`'s `deep.equal` on JS objects, which is key-order-insensitive — it
cannot observe a reordering unless (like the `b as a` case above) the
duplicate names happen to carry different values. Most of the sqllogic
cases added above would have passed on the *old, buggy* code too, because
the row values were always right. This new file asserts column order
directly via `stmt.getColumnNames()` (mirroring the existing pattern in
`test/plan/grouped-projection-shape.spec.ts`'s `describe('output column
order', ...)` block, written for the sibling ticket
`bug-grouped-aggregate-only-select-returns-extra-column`). Five cases,
including one that would have failed against the pre-fix code:
`SELECT a, * FROM t1` → asserts `['a', 'a:1', 'b']`, plus a star-first
control case that was already correct (`SELECT *, a AS last FROM t1` →
`['a', 'b', 'last']`) to confirm the fix didn't flip that direction.

### `docs/sql-select.md`

Added one bullet to §2.1's `select_expr` option list stating the ordering
rule and cross-referencing §3.3 (which already documented the grouped half:
"Output column order follows the select list, not the group by list").

## Verification

- `node test-runner.mjs` (from `packages/quereus`): **8644 passing, 13
  pending, 0 failing** (was 8639 passing before this ticket's test
  additions — the +5 is the five new `it` blocks in
  `select-list-order.spec.ts`; the sqllogic files each run as one `it` per
  file regardless of how many `→` assertions they contain).
- `yarn workspace @quereus/quereus run test:plans`: 335 passing, including
  the new plan-shape file.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p
  tsconfig.test.json --noEmit`): clean, no output.
- `yarn lint` (repo-wide fan-out): clean.

## Known gaps / things the reviewer should look at

- The two-star / self-join / union / grouped-variant / qualified-star hand
  checks mentioned in the original ticket ("checked by hand against a
  scratch harness") were done by the *previous* agent before this ticket
  started, not re-verified here beyond what's now in the automated suite
  above. I did not independently re-run that scratch harness.
- I did not add a plan-spec order test for the grouped/ungrouped agreement
  case (only a sqllogic value-pinning pair) — `nk`'s two rows have distinct
  `a` values so no name collision occurs there either, meaning that sqllogic
  pair *also* wouldn't have failed pre-fix on its own. If a reviewer wants
  the same "would actually have caught the bug" bar applied to the grouped
  path, a `getColumnNames()`-based assertion analogous to
  `select-list-order.spec.ts` (but going through `GROUP BY`) would need a
  colliding-alias case there too. I judged the existing
  `grouped-projection-shape.spec.ts` column-order suite (which already
  covers star position under GROUP BY via `SELECT *, *` etc.) as adequate
  coverage for the grouped side and didn't duplicate it.
- Not in scope (per the original ticket, still true): which columns a star
  expands to, and how they're named, are unchanged. The window-function
  `*`-dropped-entirely bug is tracked separately on
  `fix/bug-window-function-over-grouped-query-crashes` and is untouched by
  this work.

## Not in scope

Same as the original ticket: star expansion contents/naming unchanged; the
window-function `*` bug is a separate, already-filed issue.
