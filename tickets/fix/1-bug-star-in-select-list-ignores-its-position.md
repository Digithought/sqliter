---
description: When a query asks for a star (`*`) alongside named columns, the star's columns always come out first instead of where the star was written, so the result columns are in the wrong order.
files:
  - packages/quereus/src/planner/building/select.ts                 # star projections collected before the named ones
  - packages/quereus/src/planner/building/select-projections.ts     # buildStarProjections
  - docs/sql-select.md                                              # select-list ordering is undocumented
difficulty: medium
repro: verified
---

# `*` in a select list does not stay where it was written

## What happens

A select list may mix `*` (or `table.*`) with explicitly named columns. The
output columns should appear in the order they were written. They do not: every
star is expanded and its columns are emitted first, ahead of all named columns,
whatever the written order.

Against `create table gk (v integer primary key, g text)`:

| query | expected columns | actual columns |
|---|---|---|
| `select v, * from gk` | `v, v, g` | `v, g, v` |
| `select upper(g) u, * from gk` | `u, v, g` | `v, g, u` |
| `select *, v from gk` | `v, g, v` | `v, g, v` (correct) |

Only the case where the star already happens to be first is right. SQLite and
PostgreSQL both return written order.

The values are correct — each output column still carries its own column's
value, and duplicate names are disambiguated (`v`, `v:1`) as usual. Only the
*order* is wrong. That still breaks any caller reading results positionally.

## Where it comes from

`buildSelectStmt` builds its projection list in two passes: one loop over the
select list collecting star expansions, then a second append of every non-star
projection. The written interleaving is lost before anything downstream can see
it.

This is long-standing behavior, not a recent regression — it reproduces
unchanged at `b06d2bfb`.

## One wrinkle worth knowing

A grouped query (`select v, * from gk group by v, g`) does *not* go through that
path. It builds its final projection by walking `stmt.columns` in order, so it
already returns written order — `v, v, g`. The two paths therefore disagree
today for the same select list. Whatever fix lands should make the ungrouped
path match the grouped one, not the reverse.

## Expected behavior

- Output columns follow written select-list order, with each star expanded in
  place.
- Grouped and ungrouped queries agree for the same select list.
- Existing duplicate-name disambiguation (`v`, `v:1`) is unaffected.

## One more reader of that projection list

`aggregateOutputIsSelectList` in
`packages/quereus/src/planner/building/select-aggregates.ts` also reads the list
`buildSelectStmt` assembles, to decide whether a grouped query needs a final
projection at all. It used to assume the same "stars first, named columns after"
layout this ticket is about to change, which would have broken it silently. It no
longer does — it now drops the star entries by object identity and reads the rest
in order — so reordering the list is safe for it. Mentioned so whoever changes
the assembly knows this second reader exists and does not need to be touched.

## Not in scope

Nothing here changes which columns a star expands to, or how they are named —
only where they land.
