---
description: Asking for a running total or row number alongside a grouped summary crashes the engine, and a query that mixes `select *` with a row-number column silently loses the star's columns. Both come from the same place and both are fixed by one change; the core change is already in the working tree and needs validation, error messages, tests, and docs.
files:
  - packages/quereus/src/planner/building/select.ts                # buildSelectStmt — orders the aggregate and window phases; hands the select list to the window phase
  - packages/quereus/src/planner/building/select-window.ts         # buildWindowPhase / buildWindowProjections — now rewrites a supplied projection list instead of re-walking stmt.columns
  - packages/quereus/src/planner/building/select-aggregates.ts     # buildFinalAggregateProjections (grouped select list); validateAggregateProjections (the GROUP BY coverage check that must also see window specs)
  - packages/quereus/src/planner/building/select-modifiers.ts      # applyOrderBy — the "alignment guard" comment that names this bug
  - packages/quereus/test/logic/07.5-window.sqllogic               # main window coverage
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic  # grouped select-list shape guarantee
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic:302  # positional ORDER BY over a star-bearing window query
  - docs/sql-select.md                                             # § 3.3 GROUP BY — behavior bullets
difficulty: medium
repro: verified
---

# Window functions in grouped queries, and `*` in any window query

## Status: core patch already applied

The planner change described under *The fix* below is **already present in the
working tree** (and therefore in the commit that produced this ticket). It was
written and validated during the fix stage:

- both crash arms and the star arm now return correct rows (see the verified
  table below),
- `yarn test` is fully green with it (8681 + 376 + 113 + 63 + 17 + 28 + 1362 +
  725 + 85 + 31 + 34 + 134 + 22 passing, 0 failing),
- `yarn workspace @quereus/quereus run lint` (eslint + `tsconfig.test.json`
  type pass) exits 0.

**Do not redo it.** Read the two changed files, confirm the shape matches what is
described here, and then do the remaining work: the newly-surfaced error
messages, the unaliased-column name, the tests, and the docs/comment updates.

## What was wrong

Two defects, one site: the window phase's select-list walk.

**Arm 1 — grouped + window crashed.** A `SELECT` with both `GROUP BY` and a
window function ran two projection-building walks over the same select list:
`buildFinalAggregateProjections` (which rebuilds *every* select-list entry
against the grouped output, window entries included) and then
`buildWindowProjections` (which built its own projection above the `WindowNode`).
The first walk left a raw `WindowFunctionCall` expression sitting in a projection
*underneath* the node that computes window values. Nothing ever rewrote that
copy, and a bare window-function expression has no emitter of its own, so
instruction generation threw `No emitter registered for WindowFunctionCall`.

**Arm 2 — `*` vanished from any window query.** `buildWindowProjections` looped
over `stmt.columns` and handled only `column.type === 'column'`. A `*` entry was
skipped outright, so its columns never reached the projection.

## The fix

Make the window phase's final projection the query's **one** select-list
projection, and stop it from re-deriving that list from the AST.

Node order for a grouped, windowed query is now:

```
  Aggregate  →  [HAVING Filter]  →  Window  →  Project(select list)
```

`WindowNode` preserves its source's attributes and appends one column per window
function, so column references built against the aggregate-output scope still
resolve at the projection above it. That is what makes a single projection
possible.

Concretely:

- `buildWindowPhase` takes a `readonly Projection[]` (the select list, stars
  already expanded, in written order, window entries still present as raw
  `WindowFunctionCallNode` subtrees) in place of the `AST.SelectStmt` it used to
  take. `buildWindowProjections` maps over that list and runs each entry's node
  through the existing `rewriteWindowFunctions`, which swaps every
  window-function descendant for the `ArrayIndexNode` pointing at its computed
  window-output column. Non-window entries pass through untouched — no rebuild,
  and stars are just ordinary entries, so arm 2 disappears.
- `buildSelectStmt` supplies that list. For a grouped query it is
  `buildFinalAggregateProjections`' output, which is no longer wrapped in its own
  `ProjectNode` when window functions are present — it is handed to the window
  phase instead (`windowSelectProjections`). For an ungrouped query it is the
  `projections` array `buildSelectStmt` already assembles in written select-list
  order. A window function in the select list now also forces the grouped
  projection list to be built (`needsFinalProjection || hasWindowFunctions`), so
  the shape holds even when the `AggregateNode`'s own output would have been
  accepted as the result shape.

### Verified behavior with the patch

Against `create table nk (a text, b text)` with `('x','1'),('y','2'),('x','3')`
and `create table gk (v integer primary key, g text)` with `(1,'a'),(2,'b')`:

| query | result |
|---|---|
| `select a, row_number() over (order by a) rn from nk group by a` | `a,rn` = `x,1` / `y,2` |
| `select a, count(*) c, row_number() over (order by a) rn from nk group by a` | `a,c,rn` = `x,2,1` / `y,1,2` |
| `select a, 1000 - row_number() over (order by a) rn from nk group by a` | `x,999` / `y,998` |
| `select a, row_number() over (order by a) rn from nk group by a having count(*) > 1` | `x,1` |
| `select a, row_number() over (order by a) rn from nk group by a order by rn desc` | `y,2` / `x,1` |
| `select a, count(*) over () c from nk group by a` | `x,2` / `y,2` (2 groups) |
| `select *, row_number() over (order by v) w from gk` | columns `v,g,w` |
| `select row_number() over (order by v) w, * from gk` | columns `w,v,g` |
| `select v, row_number() over (order by v) w, * from gk` | columns `v,w,v:1,g` |
| `select gk.*, row_number() over (order by v) w from gk` | columns `v,g,w` |
| `select *, row_number() over (order by v) w from gk order by 3` | sorted by the window column |
| `select distinct row_number() over (order by v) w from gk` | works |

## Remaining work

### Ungrouped column references inside a window specification

Fixing arm 1 exposes a second internal error one layer down. In a grouped query,
a window specification (`partition by` / `order by`) and a window function's
arguments are built against the aggregate-output scope, whose parent is still the
pre-aggregate select scope — so a reference to a **non-grouped** column resolves
to a base-table attribute that the aggregate row does not carry, and the query
dies at runtime:

```sql
select a, row_number() over (order by b) rn from nk group by a;
-- No row context found for column b. The column reference must be evaluated
-- within the context of its source relation.
select a, sum(b) over () s from nk group by a;
-- same
```

Both are illegal SQL for the same reason a bare `b` in the select list is: the
window runs over the grouped rows, where only grouping keys and aggregate
results exist. They must raise the *existing* grouped-query message —

```
Column 'b' must appear in the GROUP BY clause or be used in an aggregate function
```

— at plan time, not an internal row-context error at runtime.

The reason `validateAggregateProjections` (in `select-aggregates.ts`) misses
these is that a `WindowFunctionCallNode` does not expose its window-spec
expressions or its arguments as plan children at the point that validation runs,
so `findUngroupedColumnRef` never sees them. The check therefore has to be
applied where those expressions *are* built — in `buildWindowPhase`, after
`partitionExpressions` / `orderByExpressions` / `functionArguments` exist and
before the `WindowNode` is constructed — reusing the GROUP BY coverage predicate
rather than duplicating it. That means exporting the attribute-id +
AST-fingerprint coverage test from `select-aggregates.ts` (today
`findUngroupedColumnRef` plus the two sets `validateAggregateProjections` builds
from `groupByExpressions`) and calling it from the window phase, which needs the
grouped query's `groupByExpressions` threaded in — they already exist on
`buildAggregatePhase`'s return value and `buildSelectStmt` already holds them.

Related, and **explicitly not in scope**: an aggregate inside a window
specification that is not also in the select list.

```sql
select a, count(*) c, row_number() over (order by count(*) desc) rn from nk group by a;  -- works
select a, row_number() over (order by count(*)) rn from nk group by a;
-- Aggregate function count not allowed in this context
```

Supporting the second form means collecting window-spec aggregates into the
`AggregateNode` the way `collectOrderByAggregates` already does for a top-level
`ORDER BY`. Leave it unsupported — the message is a clear plan-time error, not an
internal one — but make it *name the construct* so it reads as a limitation
rather than a bug, and leave a `NOTE:` at the site pointing at
`collectOrderByAggregates` as the shape a future fix would take.

### Unaliased window column names

Pre-existing, cosmetic, same site, cheap now that the projection carries the
original node:

```sql
select row_number() over (order by v) from gk;   -- column is named '[2]'
```

The name comes from the `ArrayIndexNode` the rewrite substitutes in. An unaliased
window column should keep its authored expression as its name — the same rule
every other unaliased select-list column follows (`select count(*) from t group
by g` yields a column named `count(*)`, pinned in
`07.3.2-grouped-select-list-shape.sqllogic`). The rewrite knows the original
node, so carry a fallback alias derived from it when `projection.alias` is unset.

### Comment and doc updates that are now stale

- `applyOrderBy` in `select-modifiers.ts` carries an "alignment guard" whose
  comment says the window path drops `*` entries and that "the guard is a no-op
  once those shapes are fixed". Half of that is now false — the window path does
  publish one attribute per select-list column. The guard must **stay** (the
  grouped path can still legitimately skip its final projection when the
  aggregate output already *is* the select list); rewrite the comment so it names
  only the shape that still fails the check.
- `28.2-orderby-expression-extras.sqllogic:302` has a comment saying "A window
  query containing `*` cannot bind by output position (the window projection
  drops the star columns — fix/bug-window-function-over-grouped-query-crashes)".
  The assertion itself still holds (`order by 5` over a 4-column select list is
  out of range either way), but the reason is now wrong. Rewrite it, and add the
  positive case next to it: `order by 4` binds the window column and sorts by it
  (verified: `select *, row_number() over (order by a) as w from ow order by 4`
  returns `id` 3,2,1 — and `order by 4 desc` returns 1,2,3).
- `docs/sql-select.md` § 3.3 GROUP BY behavior bullets say nothing about window
  functions. Add one: a window function in a grouped select list runs over the
  **grouped result rows** (one row per group), so `select a, row_number() over
  (order by a) from t group by a` numbers the groups, not the underlying rows;
  and its window specification and arguments are subject to the same GROUP BY
  restriction as the rest of the select list.

## Not in scope

- Window functions without `GROUP BY`, beyond the star arm and the unaliased-name
  arm above.
- `backlog/feat-window-streaming-partitioned` — the separate performance concern
  that partitioned windows always buffer.
- Aggregates inside a window specification that are absent from the select list
  (see above).

## Tripwires noticed while working this — park as `NOTE:` comments, do not file

- `compareWindowSpecs` / `groupWindowFunctionsBySpec` in `select-window.ts`
  compare and key window specifications with `JSON.stringify` over raw AST
  fragments, which include each fragment's source-location (`loc`) data. Two
  textually identical `over (...)` clauses at different source positions
  therefore never compare equal, so the "share one `WindowNode` per distinct
  window spec" grouping never actually groups anything and every window function
  gets its own `WindowNode`. That accident is currently load-bearing:
  `findWindowColumnIndex` matches a window function by name + spec only, so two
  same-named functions genuinely sharing a spec would both resolve to the first
  one's output column. Verified working today —
  `select sum(v) over (order by v) a, sum(v*10) over (order by v) b from gk`
  returns `a` = 1,3,6 and `b` = 10,30,60 — precisely because the specs don't
  compare equal. If anyone ever strips `loc` from those comparisons (or teaches
  them to compare structurally), the grouping starts working and the
  column-index matching breaks; it would need to match by node identity or
  position instead. Note this at both sites.

## TODO

Phase 1 — verify the applied patch

- Read `select.ts` and `select-window.ts`; confirm the single-projection shape
  described under *The fix*, and that nothing else in the tree was touched.
- Re-run `yarn test` and `yarn workspace @quereus/quereus run lint` to confirm
  the baseline is still green before adding to it.

Phase 2 — plan-time validation for window specifications

- Export the GROUP BY coverage check from `select-aggregates.ts` so it can be
  reused (attribute-id set + AST-fingerprint set built from `groupByExpressions`,
  applied via `findUngroupedColumnRef`). Keep `validateAggregateProjections` on
  the same helper — do not duplicate the predicate.
- Thread the grouped query's `groupByExpressions` into `buildWindowPhase` and run
  the check over `partitionExpressions`, `orderByExpressions`, and every entry of
  `functionArguments` before constructing the `WindowNode`. Only when the query
  is grouped; an ungrouped window query is unaffected.
- Reword the aggregate-in-window-spec rejection so it names the unsupported
  construct, and add the `NOTE:` pointing at `collectOrderByAggregates`.

Phase 3 — unaliased window column name

- Carry a fallback output name from the original select-list node when the
  rewrite replaces it with an `ArrayIndexNode` and no alias was authored.

Phase 4 — tests

- Grouped + window coverage in `07.5-window.sqllogic` (or a new sibling if that
  file is already long): bare `row_number()` over groups; window alongside a real
  aggregate; window wrapped in arithmetic; window with `having`; `order by` a
  window alias; `count(*) over ()` over groups; `limit` over the lot; grouped
  `select *` plus a window column.
- Star + window coverage: `select *, <win> …`, `<win>, * …`, `v, <win>, * …`
  (asserting the `v:1` disambiguated duplicate), and `t.*, <win> …`. Column
  *order* matters here — check how `07.3.2-grouped-select-list-shape.sqllogic`
  routes order-sensitive assertions (its header notes row objects compare
  key-order-insensitively in `.sqllogic`, with name/order pinned in
  `test/plan/grouped-projection-shape.spec.ts`) and follow the same split.
- Error coverage: `order by <ungrouped col>` and `sum(<ungrouped col>) over ()`
  inside a grouped window query both raise the GROUP BY message; the
  aggregate-not-in-select-list form raises its named-limitation message.
- Unaliased window column name.
- `28.2-orderby-expression-extras.sqllogic`: fix the stale comment, keep the
  out-of-range assertion, add the `order by 4` positive case (both directions).

Phase 5 — docs and comments

- `docs/sql-select.md` § 3.3 bullet.
- `applyOrderBy`'s alignment-guard comment.
- The two `NOTE:` tripwires in `select-window.ts`.
- Re-run `yarn test` and `yarn workspace @quereus/quereus run lint`.
