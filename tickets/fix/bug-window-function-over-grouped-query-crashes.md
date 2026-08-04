---
description: Asking for a running total or row number alongside a grouped summary crashes the engine with an internal error instead of returning rows.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildFinalAggregateProjections — rebuilds every select-list item, window ones included
  - packages/quereus/src/planner/building/select-window.ts       # buildWindowPhase / buildWindowProjections — the phase that is supposed to own window items
  - packages/quereus/src/planner/building/select.ts              # runs the aggregate phase, then the window phase, over the same select list
  - packages/quereus/src/runtime/emit/window.ts                  # emitWindow, where the failure surfaces
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic  # nearest existing grouped-shape coverage
difficulty: medium
repro: verified
---

# A window function in a grouped query fails with an internal error

## What happens

Put a window function (`row_number()`, `sum(...) over (...)`, …) in the select
list of a query that also has `GROUP BY`, and the query dies while being turned
into runnable instructions:

```
QuereusError: No emitter registered for WindowFunctionCall
```

Against `create table nk (a text, b text)` with a few rows:

| query | result |
|---|---|
| `select a, row_number() over (order by a) rn from nk group by a` | internal error |
| `select a, count(*) c, row_number() over (order by a) rn from nk group by a` | internal error |
| `select a, row_number() over (order by a) rn from nk` (no `GROUP BY`) | works |

So it is specifically the combination of grouping and a window function. This is
long-standing, not a regression: it reproduces identically at `63d99922`, the
commit before `bug-grouped-aggregate-only-select-returns-extra-column` landed.
No test covers it, which is why the suite is green.

## Where it comes from

A `SELECT` with both `GROUP BY` and window functions runs two projection-building
phases over the same select list, in this order:

1. the aggregate phase's `buildFinalAggregateProjections`, which walks
   `stmt.columns` and rebuilds **every** entry against the grouped output;
2. `buildWindowPhase`, which adds the node that actually computes window results
   and then builds its own projection that rewrites each window item into a
   reference to the computed column.

Phase 1 does not know that window items are phase 2's business. It rebuilds
`row_number() over (order by a)` into a plain window-function expression and
leaves it sitting in the projection *underneath* the node that computes window
results. Nothing ever rewrites that copy, and a raw window-function expression
has no runtime implementation of its own — only the window node materializes
window values — so instruction generation hits an unhandled node and throws.

The one place that has to change is phase 1's select-list walk: a window item
must not become an ordinary rebuilt expression in the grouped projection. What it
*should* become instead — passed through untouched for phase 2 to rewrite,
excluded so phase 2's projection is the only one, or something else — is the
design question, because phase 2 currently builds its projections by re-reading
`stmt.columns` too, and the two phases both claim to produce the query's final
column list.

## Expected behavior

- A window function in a grouped select list returns rows. The window runs over
  the grouped result rows (one row per group), which is what standard SQL and
  SQLite do — `select a, row_number() over (order by a) from nk group by a`
  numbers the groups, not the underlying rows.
- The output columns are exactly the select list, in select-list order — the same
  guarantee `07.3.2-grouped-select-list-shape.sqllogic` pins for grouped queries
  without window functions.
- Mixing a window function with a real aggregate over the same grouping
  (`select a, count(*) c, row_number() over (order by a) rn ... group by a`)
  works too.
- If some combination is genuinely out of scope, it raises a clear
  "not supported" message naming the unsupported construct — never an internal
  "no emitter registered" error, which reads as an engine bug to a user.

## Use cases

Ranking or numbering grouped summaries is an ordinary reporting shape: "rank each
category by its total", "number the groups in order", "running total across group
subtotals". Today every one of those crashes.

## Second arm: `*` disappears from any window query

Same function, second defect — found while working
`fix/1-bug-star-in-select-list-ignores-its-position`, filed here because
`buildWindowProjections` is this ticket's site and both arms are the same
underlying problem: the window phase's select-list walk is incomplete.

`buildWindowProjections` (`select-window.ts`) loops over `stmt.columns` and only
handles `column.type === 'column'`. A `*` entry is skipped outright, so its
columns never reach the projection and are simply absent from the result. No
`GROUP BY` needed — this is every window query with a star in the list.

Against `create table gk (v integer primary key, g text)` with two rows:

| query | expected columns | actual columns |
|---|---|---|
| `select *, row_number() over (order by v) w from gk` | `v, g, w` | `w` |
| `select row_number() over (order by v) w, * from gk` | `w, v, g` | `w` |
| `select v, row_number() over (order by v) w, * from gk` | `v, w, v:1, g` | `v, w` |

Verified by hand at the current HEAD; pre-existing, and unaffected by the
star-ordering fix (the window path builds its own projections and never reads
the list that fix reorders). No test covers it — `test/fuzz.spec.ts` generates
`select *, <window fn> as w from <tbl>` but does not assert the column set, and
`01.1-select-projection-extras.sqllogic:97` only pairs a window function with a
*named* column.

Whatever design settles the crash arm above — which phase owns the final column
list — has to expand stars in that walk too, and in written select-list order,
matching the guarantee the non-window paths now hold.

**Knock-on: `order by <position of the window column>` also crashes while the
star arm is open.** `applyOrderBy` binds a positional ORDER BY to the Nth output
attribute only when the final relation publishes one attribute per select-list
column. A star-bearing window query fails that check (4 select-list columns, 1
published attribute), so the ordinal falls back to re-planning the authored
expression — which for the window column means a fresh `WindowFunctionCall` in
the sort key and the same `No emitter registered for WindowFunctionCall` error:

```sql
create table gk (v integer primary key, g text);
select *, row_number() over (order by v) w from gk order by 4;  -- internal error
```

Fixing the star arm fixes this automatically (the counts line up, and the ordinal
binds to the computed output column, as it already does for a window query with
no star). Worth re-running the positional-reference block in
`test/logic/28.2-orderby-expression-extras.sqllogic` when this lands — it pins
the fallback's out-of-range message for exactly this shape.

## Not in scope

Window functions without `GROUP BY` already work — apart from the star-dropping
arm above — and are not otherwise being changed. The separate performance concern
about partitioned windows always buffering is
`backlog/feat-window-streaming-partitioned` — unrelated.
