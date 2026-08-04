description: Sorting by column number (`order by 2`) can sort by the wrong column when an earlier column in the select list was given a name that matches the name of the column being pointed at.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts        # resolveOrdinalReference returns an AST expression that is re-resolved by name
  - packages/quereus/src/planner/building/select-modifiers.ts      # applyOrderBy: rebuilds that expression against a scope where select-list aliases shadow base columns
  - packages/quereus/src/planner/building/select-aggregates.ts     # same resolveOrdinalReference use on the grouped ORDER BY path
  - packages/quereus/test/logic/                                   # regression case belongs alongside the existing ordinal ORDER BY cases
difficulty: medium
repro: verified

# `order by <number>` picks the wrong column when a select-list alias shadows the target column's name

## Behavior

`order by 2` must sort by the second **output** column. Quereus instead
resolves the ordinal to the *text* of the expression that produced that output
column and rebuilds it — and rebuilding happens in a scope where select-list
aliases are visible and shadow base-table columns. So when an earlier result
column was aliased to the same name as the column the ordinal points at, the
sort silently uses the earlier column instead.

Observed (table `nk(a text, b text)` with rows `('x','1')` and `('w','9')`,
verified against the current tree via a scratch mocha spec):

```sql
select b as a, a as z from nk order by 2;
-- expected (SQLite / PostgreSQL): sort by z (= a) -> 'w' row first
-- actual:                          sort by the aliased first column (= b) -> 'x' row first
```

The same happens with a star: `select b as a, * from nk order by 2` sorts by
the aliased `b`, not by the star's `a` at output position 2.

No error is raised — the rows just come back in the wrong order, which makes
this hard to notice.

## Root cause

`resolveOrdinalReference` (`select-ordinal.ts`) maps the ordinal to an entry of
`buildSelectListAsts`, i.e. back to an **AST expression**, and the caller
(`applyOrderBy` in `select-modifiers.ts`, and the grouped ORDER BY path in
`select-aggregates.ts`) then calls `buildExpression` on it. For a star-expanded
entry that AST is a synthesized bare column reference by name; for a written
column it is the authored expression. Either way, name resolution runs again in
a scope that also registers the select list's output aliases, and an alias with
the same name wins.

The compound (set-operation) sibling in the same file,
`resolveCompoundOrdinalColumn`, already does the right thing: it maps the
ordinal directly onto the Nth **output column/attribute** and returns a
`ColumnReferenceNode`, with no name re-resolution. The single-select path
should reach the same guarantee — an ordinal should bind to an output position,
never to a name.

## Scope

- Bug is independent of `*`: it reproduces with a purely named select list, so
  it is not a regression from `bug-star-in-select-list-ignores-its-position`
  (that ticket fixed star *position*; ordinal binding was always name-based).
- `group by <number>` uses the same `resolveOrdinalReference`. A probe there
  produced a "must appear in the GROUP BY clause" error rather than a wrong
  answer, and whether that error is correct under Quereus's grouping rules was
  not settled — decide as part of this work rather than assuming it is broken.
- Whatever the fix, `order by <number>` must keep working when the ordinal
  points at an expression rather than a plain column (`select a+1 from t order
  by 1`), and must keep its existing out-of-range error.
