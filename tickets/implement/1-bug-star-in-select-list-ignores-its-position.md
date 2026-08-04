---
description: When a query asks for a star (`*`) alongside named columns, the star's columns came out first instead of where the star was written. The code fix is already in the working tree and verified; it still needs tests and a line of documentation.
files:
  - packages/quereus/src/planner/building/select.ts                 # projection list now assembled in written order (CHANGED)
  - packages/quereus/src/planner/building/select-projections.ts     # analyzeSelectColumns publishes projectionsByColumn (CHANGED)
  - packages/quereus/src/planner/building/select-aggregates.ts      # stale comment updated (CHANGED)
  - packages/quereus/test/logic/01.1-select-projection-extras.sqllogic   # where the new ungrouped cases belong
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic # where the grouped-agreement case belongs
  - docs/sql-select.md                                              # §2.1 select_expr — output ordering is undocumented
difficulty: easy
repro: verified
---

# `*` in a select list must stay where it was written

## What was wrong

A select list may mix `*` (or `table.*`) with explicitly named columns. Output
columns should appear in the order they were written. They did not: every star
was expanded and its columns emitted **first**, ahead of all named columns,
whatever the written order.

Against `create table gk (v integer primary key, g text)`:

| query | expected | before |
|---|---|---|
| `select v, * from gk` | `v, v:1, g` | `v, g, v:1` |
| `select upper(g) u, * from gk` | `u, v, g` | `v, g, u` |
| `select g, *, v from gk` | `g, v, g:1, v:1` | `v, g, g:1, v:1` |

Only a star that already happened to be first came out right. SQLite and
PostgreSQL both return written order. Values were always correct and duplicate
names were always disambiguated (`v`, `v:1`) — only the *order* was wrong, which
still breaks any caller reading results positionally.

A second, quieter symptom fell out of the same cause: `order by <ordinal>`
resolves its position against the **written** select list
(`buildSelectListAsts`), so `select v, * from gk order by 3` sorted by `g` while
output position 3 held `v:1`. Ordinals and output columns disagreed. They now
agree.

## The cause, and the change already made

`buildSelectStmt` built its projection list in two passes: one loop over the
select list collecting star expansions, then a bulk append of every non-star
projection. The written interleaving was lost before anything downstream saw it.

The fix teaches `analyzeSelectColumns` to publish its per-column results keyed by
the AST result column (`projectionsByColumn`), so `buildSelectStmt` can assemble
the list in one walk of `stmt.columns` — star expanded in place, named column
pulled from the map. Aggregate select-list items produce no projection (they are
routed into the aggregate phase instead) and are simply absent from the map, so
the walk skips them exactly as the old bulk append did.

**This change is already applied in the working tree** — see the three files
marked `CHANGED` above. Nothing about star expansion or column naming changed;
only where the expanded columns land.

Two comments were refreshed alongside it: the assembly-site comment in
`select.ts`, and the note in `aggregateOutputIsSelectList`
(`select-aggregates.ts`) that used to say the assembly appended stars first.

## Why the change is safe

Every other reader of that projection list is order-independent or already
assumed written order:

- `aggregateOutputIsSelectList` drops star entries by object identity and reads
  the rest in select-list order — it was made order-agnostic ahead of this
  change and needs no edit.
- `validateAggregateProjections` and `checkNeedsFinalProjection` inspect entries
  individually.
- `isIdentityProjection` compares positionally against source attributes, but a
  select list that mixes a star with named columns never has the same column
  count as its source, so the identity fast path is unreachable for exactly the
  lists this reorders.
- `buildFinalAggregateProjections` (the grouped path) walks `stmt.columns`
  itself and was always in written order — grouped and ungrouped now agree,
  which is the direction the original ticket asked for.
- The window path builds its own projections from `stmt.columns` and never reads
  this list at all.

## Verification already done

- The 17 shapes in the table above plus qualified stars, two-star lists,
  `distinct`, `union all`, subquery-in-`from`, and grouped variants were checked
  by hand against a scratch harness; all now return written order, and grouped
  and ungrouped agree for the same select list.
- `node test-runner.mjs` in `packages/quereus`: **8639 passing, 13 pending, 0
  failing**. No existing test needed changing — every star-plus-named-column
  case in the corpus happens to write the star first.

## Remaining work

Tests and one documentation line. That is all.

## TODO

- Add ungrouped written-order cases to
  `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic`, next to
  the existing `select *, *` and `select *, 'lit' as marker` cases: a star after a
  named column (`select a, * from t1`), a star between two named columns, a star
  after a computed column (`select upper(b) u, * from t1`), and a qualified star
  after a named column over the existing self-join.
- Add one case pinning that `order by <ordinal>` and output position now agree
  for a mixed list (e.g. `select a, * from t1 order by 3` over two rows, so the
  sort is observable).
- Add a grouped/ungrouped agreement case to
  `packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic`: the
  same mixed select list with and without `group by` returns the same column
  order.
- Document the rule in `docs/sql-select.md` §2.1, on the `select_expr` bullet:
  output columns follow written select-list order, with each `*` / `table.*`
  expanded in place. §3.3 already states the grouped half of this ("Output
  column order follows the select list, not the group by list") — keep the two
  consistent and cross-reference rather than restate.
- Re-run `yarn workspace @quereus/quereus run test` and `yarn lint`.

## Not in scope

Which columns a star expands to, and how they are named, are unchanged.

A separate, pre-existing defect turned up next door and is **not** this ticket:
in a query with a window function, `*` is dropped from the output entirely
(`select *, row_number() over (order by v) w from gk` returns only `w`), because
`buildWindowProjections` in `select-window.ts` skips `column.type === 'all'`. It
is recorded as a second arm on `fix/bug-window-function-over-grouped-query-crashes`,
which already owns that function.
