---
description: A grouped query that named two or more grouping columns could hand its columns back in the wrong order; the optimizer now puts them back in the order the query asked for.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts  # the fix — order-restoring cap + header comment
  - packages/quereus/src/planner/building/select-aggregates.ts                       # doc-comment forward-reference dropped
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts                      # column-name coverage + two-Project stack assertion
  - packages/quereus/test/logic/07.3.2-grouped-select-list-shape.sqllogic            # value coverage + `insert … select` positional case
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts           # rule-level cap present/absent cases
  - docs/materialized-views.md                                                       # § forgo guard bullet rewritten
difficulty: medium
---

# Review: select-list column order restored after GROUP BY FD simplification

## What was wrong

`select g, v, count(*) as c from pk group by g, v` returned its columns as
`v, g, c`. `docs/sql-select.md` § 3.3 promises select-list order.

`ruleGroupByFdSimplification` drops a grouping column that the surviving
grouping columns functionally determine (`v` is the primary key, so it
determines `g`) and re-emits the dropped one as a picker `min(g)` aggregate. An
aggregate node's output layout is fixed — grouping keys first, then aggregate
results — so a dropped key necessarily leaves its key slot and lands in the
aggregate block, behind the surviving keys. Attribute ids survive the move, so
everything that binds by id was fine; the statement result binds by **position**
when the aggregate is the query root with no projection above it.

## What changed

One site: the rule's return. When (and only when) the new layout permutes the
output attribute order, the new aggregate is wrapped in a `ProjectNode` that
re-emits the same attribute ids in their original order. Order-preserving drops
(the dropped keys were already a suffix of the grouping list) return the bare
aggregate exactly as before, so the common `group by <pk>, <other>` shape gains
nothing.

Two implementation choices worth a reviewer's eye:

- **`preserveInputColumns` is `true`**, not the `false` the fix ticket's
  prototype used. With `predefinedAttributes` supplied the flag cannot change
  this node's attributes either way, so both are correct today. `true` was
  chosen because every projection in the cap is a bare column reference
  republishing its source attribute id — that *is* "preserve input columns" —
  and because it stays correct if a later rebuild ever drops
  `predefinedAttributes`, where `false` would mint fresh ids and break binding.
  Reasoning is in a comment at the site.
- **`ColumnReferenceNode.columnIndex`** is set to the attribute's index in the
  new aggregate's output. It is advisory (`runtime/emit/column-reference.ts`
  resolves by attribute id through the row descriptor) but is set correctly.

Also: the rule's header comment no longer advertises "positions may shift,
attribute IDs do not" as the contract, and the `aggregateOutputIsSelectList`
doc-comment in `select-aggregates.ts` no longer forward-references this ticket.

## How to exercise it

The three repro shapes, all previously wrong, on memory tables
(`pk (v integer primary key, g text)`, `nk (a text, b text)`,
`nj (a text, c text)`):

| query | now returns |
|---|---|
| `select g, v, count(*) as c from pk group by g, v` | `g, v, c` |
| `select a, b, count(*) as c from nk where a = b group by a, b` | `a, b, c` |
| `select nk.a, nk.b, nj.a, nj.c, count(*) as c from nk join nj on nk.a = nj.a group by nk.a, nk.b, nj.a, nj.c` | `a, b, a:1, c, c:1` |

The three drivers are distinct and all three are covered: a primary key, a
`where a = b` equivalence class, and a join equality.

An alias in the select list (`select g as gg, …`) always hid the bug, because
the alias forces a projection above the aggregate. The repro shapes above are
exactly the ones where the select list already agrees with the *pre-rewrite*
aggregate output, so no builder projection is forced and the aggregate is the
query root.

Fastest way to see the fix bite: `insert into sink select g, v, count(*) from
src group by g, v` with `src (v integer primary key, g text)` and
`sink (g text, v integer, c integer)`. Insert-select binds by position, so
before the fix this raised `Type conversion failed for column 'v': Cannot
convert 'a' to INTEGER`. That case is now pinned in the `.sqllogic` file.

## Tests added / changed

- `test/plan/grouped-projection-shape.spec.ts` — new `nj` fixture; a
  `keeps SELECT-list order when the FD simplification drops a grouping key` case
  asserting `getColumnNames()` for all three repro queries. The pre-existing
  *"projects a grouped select list even when it needs no expression rewriting"*
  case now pins the two-Project stack (cap directly on the aggregate,
  select-list projection above it) rather than asserting a single Project — that
  is the intended shape, explained in the test's comment.
- `test/optimizer/rule-groupby-fd-simplification.spec.ts` — new
  `order-restoring cap` describe: cap Project present when the drop permutes,
  absent when the dropped key was already a suffix. Both queries agree with the
  pre-rewrite aggregate shape so the builder forces no projection of its own,
  which is what makes the Project count a clean signal. The local `planRows`
  helper now also selects `id` / `parent_id` so the cap's position can be
  asserted.
- `test/logic/07.3.2-grouped-select-list-shape.sqllogic` — value coverage for
  the three repro shapes plus the `insert … select` positional case.

**These tests were verified to actually bite.** With the cap temporarily
disabled, all three files fail (column names `['v','g','c']` vs `['g','v','c']`,
the join case collapsing to three columns, and the insert-select type error);
with it enabled they pass. The temporary switch was removed before the final
run.

## Validation run

From the repo root: `yarn build` clean, `yarn test` **0 failing** (8659 in
`packages/quereus` plus 2865 across the other workspaces), `yarn lint` clean.
No pre-existing failures surfaced.

## Known gaps — please probe these

- **`union` arm not covered.** The defect statement named three positional
  consumers: `row[0]`, `insert into t select …`, and a `union` arm. The first
  two are covered (`getColumnNames()` and the insert-select case); a grouped
  query as a `union` arm is not.
- **`.sqllogic` cannot pin order.** Its row objects compare
  key-order-insensitively, so the new `.sqllogic` cases pin *values per column
  name*, not positions. Since names and values move together under this bug,
  they would not have caught it on their own — the insert-select case is the one
  that does. Positional order lives in the plan spec's `getColumnNames()`
  assertions. If the harness has a positional row-array mode I did not find it.
- **No golden plan covers this shape.** No file under `test/plan/golden/`
  needed regenerating, which means no golden snapshot contains a permuting
  FD-simplified aggregate. A golden for the capped shape would be cheap
  insurance.
- **Downstream matchers audited by test suite only.** The cap inserts a
  `Project` between the aggregate and its parent, which could in principle
  disturb anything pattern-matching "aggregate is the root" or "Project directly
  over Aggregate" — incremental delta-aggregate maintenance
  (`test/incremental/delta-aggregate.spec.ts`), materialized-view body matching,
  projection pruning. All are green, but I relied on the suite rather than
  reading each matcher. The cap only appears when the rewrite fires *and*
  permutes, so a matcher with no such test would not have been exercised.
- **Extra row copy unmeasured.** Recorded as a `NOTE:` tripwire at the cap site
  (collapse a permutation-only Project-over-Project if grouped-plan row-copy
  overhead ever profiles hot; the collapse needs no index rebinding because
  column references resolve by attribute id at runtime). No profile was taken —
  it is one copy on a plan that only exists when the rule fires and permutes.

## Follow-up already on the board

`docs/materialized-views.md` § forgo guard — the *Group-key reorder* bullet is
rewritten to say the base no longer reorders and that the `group-key-pinned`
forgo now only costs coverage, cross-referencing
`mv-group-key-pinned-guard-obsolete` (already sitting in `tickets/implement/`
with this ticket as its prereq) rather than duplicating its plan. The guard
itself, its failure reason, and its test are deliberately **untouched** here —
retiring them needs base-vs-view positional agreement evidence, which is that
ticket's job.

`docs/sql-select.md` § 3.3 line 607 already states the guarantee
unconditionally; confirmed, no wording change needed.

## Review findings

_(reviewer fills this in)_

- Tripwire parked at the cap site in
  `packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts`
  as a `NOTE:` — the stacked Project-over-Project row copy, and how to collapse
  it if it ever profiles hot.
