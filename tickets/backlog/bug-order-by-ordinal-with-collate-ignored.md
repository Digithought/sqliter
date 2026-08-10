---
description: Adding a text-comparison rule to a sort that refers to a column by its number — like "sort by column 2, ignoring letter case" — silently stops sorting altogether instead of sorting that column.
files:
  - packages/quereus/src/planner/building/select-ordinal.ts   # extractOrdinalValue — decides what counts as a column number
  - packages/quereus/src/planner/building/select-modifiers.ts # applyOrderBy — where an ORDER BY term becomes a sort key
  - packages/quereus/src/planner/building/select-compound.ts  # applyOuterOrderBy — the union/intersect/except form
  - packages/quereus/src/planner/building/select-aggregates.ts # GROUP BY / pre-aggregate sort call sites
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # where the positional-reference coverage lives
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: A legal but uncommon spelling with an obvious workaround (name the column), so a maintainer may prefer to reject the combination rather than teach the ordinal extractor to see through a collation.
---

# `order by 2 collate nocase` does not sort

## What happens

A number in `order by` / `group by` means "the Nth column of the select list".
Attaching a collation to that number — a normal way to ask for a case-insensitive
sort — makes the engine stop treating it as a column number. It becomes the
constant `2`, every row gets the same sort key, and the rows come back in
whatever order the source produced them. No error, no warning.

```sql
create table t (a text primary key, b text);
insert into t values ('x','1'), ('w','9');

select b as a, a as z from t order by 2;                 -- sorts by z: 'w' row first
select b as a, a as z from t order by 2 collate nocase;  -- no sorting at all
```

Verified by hand against `Database.eval` at the current HEAD. The same applies to
`group by 1 collate nocase`, which silently groups by a constant instead of by
the first select-list column.

## Where it comes from

One place decides whether an `order by` / `group by` term is a column number:
`extractOrdinalValue` in `select-ordinal.ts`. It accepts a bare integer literal
and an integer with a leading `+` or `-`, and nothing else. A `collate` wrapper
around the literal is a different expression shape, so the term falls through to
ordinary expression building and is planned as a constant.

Fixing the recognition alone is not enough: once the number is recognized as a
position, the collation the user asked for still has to reach the resulting sort
key, otherwise the query would silently sort with the column's own collation
instead of the requested one — the same class of silent-wrong-answer as today.

## Expected behavior

- `order by N collate C` sorts by select-list column N, comparing with collation
  `C` — i.e. exactly what `order by <the Nth column's name> collate C` does.
- `group by N collate C` groups by select-list column N under collation `C`.
- The same holds for the `union` / `intersect` / `except` form, where the number
  addresses the compound's Nth output column.
- Out-of-range positions still fail at prepare time with the existing message.

## Open question for whoever picks this up

Confirm what SQLite does before settling the spec — its ORDER BY resolver strips
a `COLLATE` wrapper before testing whether a term is a positional integer, which
would make the expected behavior above the SQLite-compatible one, but that was
read from its resolver rather than run. If SQLite genuinely treats the term as a
constant, the right fix is a clear error rather than a silent no-op sort.
