description: A grouped query that sorts by the column it grouped on used to fail with an internal error whenever that column only appeared in the output wrapped in an expression; the fix, its tests, and a follow-on column-duplication bug found during review are all resolved.
files:
  - packages/quereus/src/planner/building/select.ts                        # branch keys off "did grouping run"; star expansions now kept per select-list star
  - packages/quereus/src/planner/building/select-aggregates.ts             # forced final projection + SELECT * expansion
  - packages/quereus/test/logic/07.3.1-group-by-order-by-key.sqllogic      # result coverage
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts            # plan-shape + column-order coverage
  - docs/sql-select.md                                                     # GROUP BY output ordering; ORDER BY over grouping keys
difficulty: medium

# `order by <group key>` in a `group by` query with no aggregate functions

## The bug

`select cast(v as text) x from t group by v order by v` threw
`QuereusError: No row context found for column v`. Three things had to combine:
a `group by`, an `order by` naming a grouping key as a **bare column**, and a
select list with **no aggregate function at all**.

The planner chose its final-projection path from "does the select list contain
an aggregate" rather than "did a grouping phase run", so such a query took
*both* paths and ended up with a second, stale projection whose column
references still pointed at pre-aggregate attributes. A bare-column `order by`
then placed a blocking `Sort` *underneath* that stale projection; the source row
context was gone by the time it ran and resolution failed. Adding `count(*)` or
sorting by the output alias hid it.

## What shipped

- **Planner fix** (commit `6f915362`): branch on
  `hasGrouping = Boolean(aggregateResult.aggregateScope)`, force a final
  projection for a grouped-but-aggregate-free select list, and teach
  `buildFinalAggregateProjections` to expand `select *`.
- **Tests** (commit `36cf15d4`): `test/logic/07.3.1-group-by-order-by-key.sqllogic`
  (28 result assertions) and `test/plan/grouped-projection-shape.spec.ts`
  (11 plan-shape / column-order assertions).
- **Docs**: `docs/sql-select.md` — §3.3 GROUP BY gained two behavior bullets
  (an aggregate-free `group by` is legal; output column order follows the select
  list, not the group by list); §3.5 ORDER BY states that any expression legal
  in `group by` is sortable regardless of how the select list projects it.
- **This review pass**: fixed a column-duplication regression the fix
  introduced (below), plus its coverage and a sharper column-order test.

## Review findings

### Read first, then the handoff

The implement diff was read cold before the handoff summary, then probed
against two throwaway git worktrees — one at `b06d2bfb` (pre-fix) and one at
`36cf15d4` (post-implement) — so every "is this new?" question was answered by
running the same queries against both rather than by reasoning. Both worktrees
have been removed.

### Major — found and fixed in this pass

**A select list with more than one star duplicated its columns.** The new star
expansion in `buildFinalAggregateProjections` iterated the *whole* flattened
star-projection list once for *each* star in the select list, so N stars emitted
the full set N times.

```sql
select gk.*, gj.* from gk join gj on gk.v = gj.k
group by gk.v, gk.g, gj.k, gj.w;
-- before: v, g, k, w, v:1, g:1, k:1, w:1   (8 columns)
-- after:  v, g, k, w                       (4 columns)
```

Confirmed a regression, not pre-existing: the same query returns 4 columns at
`b06d2bfb` and 8 at `36cf15d4`. Real SQL — a join projecting both sides' stars
under a `group by` is an ordinary shape.

Fixed by keying star expansions to the select-list entry that produced them
(`Map<AST.ResultColumn, Projection[]>` threaded from `buildSelectStmt`) instead
of flattening them into one list. Covered by a new case in each of the two test
files; both fail at `36cf15d4` and pass now.

**A star column that is not a grouping key was dropped silently.** The same code
did `if (gbIdx === undefined) continue`, quietly deleting an output column.
`validateAggregateProjections` already rejects every such select list, so this
was reachable only if the two ever disagreed — and it would have surfaced as
missing columns, not an error. It now throws `StatusCode.INTERNAL` naming the
column. The whole suite still passes, so nothing was relying on the silent drop.
The `isColumnReference` guard in the same spot was likewise a silent skip;
`buildStarProjections` only ever emits column references, so it folded into the
same check (`starGroupKeyIndex`).

### Major — found, pre-existing, filed

**`select v, * from gk` returns columns in the wrong order** — every star is
hoisted ahead of all named columns regardless of where it was written, so the
result is `v, g, v` instead of `v, v, g`. Values are correct; only order is
wrong. Reproduces identically at `b06d2bfb`, lives in the *ungrouped* path this
diff never touches, and is now inconsistent with the grouped path (which walks
`stmt.columns` in order and gets it right). Filed as
`backlog/bug-star-in-select-list-ignores-its-position`, including that
consistency note.

`select count(*) n from t group by g` returning two columns was already filed by
the implement pass as
`backlog/bug-grouped-aggregate-only-select-returns-extra-column`; re-confirmed
here as pre-existing and unrelated to this diff.

### Test coverage

The implementer flagged that the `select *` column-order tests are weaker than
they look — `gk` has a primary key among its grouping keys, so the
functional-dependency GROUP BY reduction rewrites `group by g, v` into
`group by v` + `min(g)` and yields source-column order by accident. Confirmed:
those cases pass with the fix reverted.

Addressed by adding a no-primary-key table (`nk (a text, b text)`) to the plan
spec and asserting `select * from nk group by b, a` returns `a, b`. The FD
reduction cannot fire there, so the aggregate genuinely outputs GROUP BY order
and only the final projection can restore source order. This still does not fail
against the *historical* bug (the pre-fix path also got single-star order right)
— it is a real guard on the new star-expansion code, and the file now says which
of the two it is at the assertion site.

Also checked and found adequate, no changes: HAVING interaction, DISTINCT /
LIMIT / OFFSET stacked above the sort, multiple grouping keys, composition as
derived table / CTE / `in` subquery / scalar subquery / compound-select branch /
materialized-view body, NULL grouping keys with explicit `nulls first` /
`nulls last`, and the non-grouped pre-projection sort path.

### Checked, nothing found

- **Alias, view, CTE and derived-table stars** over a grouped query
  (`select x.* from gk x`, `select * from vv`, `with c as (...) select * from c`,
  `select s.* from (...) s`, `select * from mv`): all correct before and after.
- **Self-join with a qualified grouping key** (`select a.* from gk a join gk b
  ... group by b.v, b.g`): correctly rejected — the star's columns are not the
  grouping keys.
- **Resource cleanup**: the plan spec finalizes each statement in a `finally`
  and closes the database in `afterEach`.
- **Type safety**: no `any` introduced; the new map parameter is a
  `ReadonlyMap` with a defaulted empty value, so the one existing call site is
  the only thing that has to know about it.
- **Source hygiene**: `select-aggregates.ts` is large (~820 lines) but that
  predates this work and is tracked separately by the `debt-*-files-too-large`
  backlog tickets; this diff extracts rather than inlines (`starGroupKeyIndex`
  next to `buildGroupKeyColumnRef`).

### Tripwires

None new. The implement pass parked one `NOTE:` in
`select-aggregates.ts` at the forced `needsFinalProjection` — widening the
`!hasAggregates` guard re-routes grouped materialized-view incremental
maintenance from residual-recompute to full-rebuild — and it is still accurate
and still the right place for it.

### Left alone, deliberately

- **Default NULL placement under `desc`.** The engine sorts NULLs first in both
  directions, unlike SQLite. Pre-existing, acknowledged in
  `10.5.3-desc-index-ordering.sqllogic`, and out of scope; the new NULL cases all
  pass an explicit `nulls first` / `nulls last` rather than pinning the default.
  Nobody has filed the question of whether the default should change.
- **`group by <constant expression>`** (`group by 2-1`) is not recognised as a
  grouping key and fails with a misleading "Cannot mix aggregate and
  non-aggregate columns" error. Confirmed identical at `b06d2bfb`; not filed —
  it is a distinct parser/planner gap with no user report behind it.
- **`group by g collate nocase`** is rejected by `validateAggregateProjections`
  before and after the fix. Out of scope per the implement ticket.

## Verification

- `yarn test` — **8110 passing, 0 failing** across the monorepo (8108 at
  `36cf15d4`; +2 new plan-spec cases, and the new `.sqllogic` case joins the
  existing file). `test/incremental/delta-aggregate.spec.ts`, the guard that
  caught the over-broad first attempt at the original fix, still passes.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `07.3.1-group-by-order-by-key.sqllogic` passes under the **store** backend
  (`QUEREUS_TEST_STORE=true`), including the new join case, so it needs no
  `MEMORY_ONLY_FILES` entry. The plan-shape spec is memory-only by construction
  (it asserts optimizer operator choice), matching the other `test/plan/*.spec.ts`.
- Negative check for this pass's fix: both new assertions fail at `36cf15d4`
  (8 columns instead of 4) and pass on the fixed tree.
