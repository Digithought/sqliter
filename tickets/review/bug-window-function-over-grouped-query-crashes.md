---
description: Asking for a row number or running total alongside a grouped summary used to crash, and mixing `select *` with a window column silently lost the star's columns. Both are fixed, illegal window specifications now fail with a clear message instead of an internal error, and an unaliased window column finally gets a sensible name.
files:
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt — builds the GROUP BY coverage test and threads it into the window phase
  - packages/quereus/src/planner/building/select-window.ts          # buildWindowPhase — plan-time validation, unaliased-name fallback, two NOTE tripwires
  - packages/quereus/src/planner/building/select-aggregates.ts      # GroupByCoverage / buildGroupByCoverage / assertGroupByCoverage / collectAggregateFunctionExprs
  - packages/quereus/src/planner/building/function-call.ts          # findMatchingAggregate extracted from buildFunctionCall
  - packages/quereus/src/planner/building/select-modifiers.ts       # applyOrderBy alignment-guard comment
  - packages/quereus/test/logic/07.5-window.sqllogic                # grouped+window, star+window, error and unaliased-name coverage (values)
  - packages/quereus/test/plan/grouped-projection-shape.spec.ts     # window output column names + order
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # positional ORDER BY over a star-bearing window query
  - docs/sql-select.md                                              # § 3.3 GROUP BY behavior bullets
difficulty: medium
---

# Window functions in grouped queries, and `*` in any window query

## What shipped

Two crashes and three follow-on items, all at one site: the window phase's
select-list handling.

### The core planner change (landed at the fix stage, verified here unchanged)

The window phase's final projection is now the query's **one** select-list
projection, and it no longer re-derives that list from the AST.

```
  Aggregate  →  [HAVING Filter]  →  Window  →  Project(select list)
```

`buildWindowPhase` takes a `readonly Projection[]` (stars already expanded, in
written order, window functions still present as raw `WindowFunctionCallNode`
subtrees) and rewrites each entry — swapping every window-function descendant for
the `ArrayIndexNode` that points at its computed window-output column, leaving
everything else untouched. `buildSelectStmt` supplies that list: for a grouped
query it is `buildFinalAggregateProjections`' output (no longer wrapped in its own
`ProjectNode` when window functions are present), for an ungrouped query the
`projections` array it already assembles.

This kills both original defects. Two projection walks no longer leave a raw
window-function expression underneath the node that computes window values (which
had no emitter — `No emitter registered for WindowFunctionCall`), and a `*` entry
is now an ordinary projection rather than something the walk skipped.

### Plan-time validation for window specifications (new)

Fixing the crash exposed an internal error one layer down. In a grouped query a
window specification and a window function's arguments are built against the
aggregate-output scope, whose parent is still the pre-aggregate select scope — so
a reference to a **non-grouped** column resolved to a base-table attribute the
aggregate row does not carry, and the query died at runtime with `No row context
found for column b`.

`validateAggregateProjections`' GROUP BY coverage predicate is now shared rather
than duplicated. `select-aggregates.ts` exports:

- `GroupByCoverage` — attribute ids plus canonical-AST fingerprints;
- `buildGroupByCoverage(groupByExpressions, groupedOutputAttributes?)`;
- `assertGroupByCoverage(node, coverage)` — throws the standard message.

Both the select-list check and the HAVING check now go through those, and
`buildSelectStmt` builds a coverage object (group-key attribute ids **plus** the
AggregateNode's output attribute ids, since a reference here can resolve to
either) and hands it to `buildWindowPhase`, which applies it to every partition
expression, order-by expression and function argument before constructing the
`WindowNode`. Only for a grouped query — an ungrouped window query is unaffected.

### Aggregate-in-window-specification rejection (reworded, still unsupported)

`select a, row_number() over (order by count(*)) rn from t group by a` still does
not work, but it now says so by name instead of reporting the generic `Aggregate
function count not allowed in this context`. `findMatchingAggregate` was extracted
from `buildFunctionCall` so the window phase can ask the same question the builder
answers — an aggregate the SELECT list already computes (`select a, count(*) c,
row_number() over (order by count(*) desc) rn …`) is fine and reads the computed
column; one that appears only in the window specification raises the named
limitation. A `NOTE:` at the site points at `collectOrderByAggregates` as the shape
a future fix would take.

### Unaliased window column names

`select row_number() over (order by v) from t` used to produce a column named
`[2]` (the substituted `ArrayIndexNode`'s own name). The rewrite now carries the
authored expression across as a fallback alias, so it is named
`row_number() over (order by v)` — the same rule every other unaliased select-list
column follows.

## Use cases to exercise

Setup used throughout:

```sql
create table wg (a text, b text);              -- no PK, so the FD GROUP BY reduction can't fire
insert into wg values ('x','1'),('y','2'),('x','3');
create table sw (v integer primary key, g text);
insert into sw values (1,'a'),(2,'b');
```

**Grouped + window — the window runs over the GROUPED rows.** All of these
previously threw `No emitter registered for WindowFunctionCall`:

| query | expected |
|---|---|
| `select a, row_number() over (order by a) rn from wg group by a` | `x,1` / `y,2` — numbers the two GROUPS, not the three rows |
| `select a, count(*) c, row_number() over (order by a) rn from wg group by a` | `x,2,1` / `y,1,2` |
| `select a, 1000 - row_number() over (order by a) adj from wg group by a` | `x,999` / `y,998` |
| `select a, row_number() over (order by a) rn from wg group by a having count(*) > 1` | `x,1` — HAVING filters groups first, so rn restarts |
| `select a, row_number() over (order by a) rn from wg group by a order by rn desc` | `y,2` / `x,1` |
| `select a, count(*) over () g from wg group by a` | `x,2` / `y,2` — counts GROUPS |
| `select *, row_number() over (order by a, b) rn from wg group by a, b` | three groups, `rn` 1..3, columns `a,b,rn` |
| `select a, count(*) c, row_number() over (order by count(*) desc) rn from wg group by a` | `x,2,1` / `y,1,2` — the repeated aggregate reads the computed column |

**Star + window — column identity and order.** Previously the star's columns
silently vanished from the output:

| query | expected columns |
|---|---|
| `select *, row_number() over (order by v) w from sw` | `v, g, w` |
| `select row_number() over (order by v) w, * from sw` | `w, v, g` |
| `select v, row_number() over (order by v) w, * from sw` | `v, w, v:1, g` |
| `select sw.*, row_number() over (order by v) w from sw` | `v, g, w` |
| `select *, row_number() over (order by v) w from sw order by 3 desc` | sorted by the window column, descending |
| `select distinct row_number() over (order by v) w from sw` | works |
| `select row_number() over (order by v) from sw` | one column named `row_number() over (order by v)` |

**Errors that must be plan-time and legible:**

```sql
select a, row_number() over (order by b) rn from wg group by a;
-- Column 'b' must appear in the GROUP BY clause or be used in an aggregate function
select a, count(*) over (partition by b) c from wg group by a;
-- same
select a, sum(b) over () s from wg group by a;
-- same (the rule covers a window function's arguments too)
select a, row_number() over (order by count(*)) rn from wg group by a;
-- Aggregate function count in a window function's ORDER BY is only supported
-- when the same aggregate also appears in the SELECT list
```

## Validation performed

- `yarn workspace @quereus/quereus run lint` (eslint + `tsconfig.test.json` type
  pass) — exit 0, no output.
- `yarn test` (all workspaces) — **0 failing**. quereus 8686 passing (baseline
  8681 + the 5 new `it`s in `grouped-projection-shape.spec.ts`); every other
  package matches the pre-change counts (119, 376, 113, 63, 17, 28, 1362, 725, 85,
  31, 59, 68, 34, 134, 22).
- Working tree touches only the nine files listed above.

New assertions live in `07.5-window.sqllogic` (values; ~130 added lines across a
grouped-window section and a star-window section) and
`grouped-projection-shape.spec.ts` (column names and order — `.sqllogic` row
objects compare key-order-insensitively, so ordering has to be pinned there; this
follows the split `07.3.2-grouped-select-list-shape.sqllogic` documents in its
header). `28.2-orderby-expression-extras.sqllogic` had its stale comment rewritten
and gained the positive `order by 4` case in both directions alongside the
retained out-of-range assertion.

## Known gaps — please probe these

- **The coverage check is gated on `group by` being present.** An *aggregate
  without GROUP BY* plus a window function (`select count(*) c, row_number() over
  (order by v) w from sw`) is not checked and can still reach the runtime with a
  base-table reference the aggregate row never had. That query is illegal SQL
  anyway, but the failure mode is likely still an internal error rather than a
  plan-time message. The gate was deliberate — the standard message names the
  GROUP BY clause, which would read oddly for a query that has none — but the
  behavior is untested either way.
- **`findMatchingAggregate`'s argument comparison is shallow** and always was: it
  compares column names and literal values, and treats any other argument shape as
  matching. It now also gates the new rejection, so a window specification's
  `sum(x + 1)` would be considered "already in the SELECT list" by a select-list
  `sum(y + 1)`. Pre-existing looseness given a new consumer; worth deciding whether
  that matters.
- **The aggregate rejection is not gated on the query being grouped.** An ungrouped
  window query with an uncollected aggregate in its OVER clause now raises the new
  `UNSUPPORTED` message where it previously raised `ERROR` / "not allowed in this
  context". Intentional (the message is strictly more informative) but it is a
  status-code change on a path outside the ticket's stated scope.
- **Unaliased window column names are lowercased**, because `expressionToString`
  folds identifiers and function names: `SELECT ROW_NUMBER() OVER (ORDER BY V)`
  yields `row_number() over (order by v)`. Consistent with the existing `count(*)`
  naming, but nothing pins the case-folding as intended.
- **Only `yarn test` was run, not `yarn test:store`.** The LevelDB store path was
  not exercised; nothing in the diff is storage-specific, but the grouped/window
  plans do differ between modules elsewhere in the corpus.
- The star-plus-window queries lean on `ProjectNode`'s duplicate-output-name
  disambiguation (`v:1`) feeding the window output scope's symbol registration. It
  works, and is asserted, but the interaction was not investigated beyond that.

## Tripwires parked (not tickets)

- `groupWindowFunctionsBySpec` and `compareWindowSpecs` in `select-window.ts` both
  carry a `NOTE:` explaining that they compare `JSON.stringify` over raw AST
  fragments *including* source-location data — so two textually identical
  `over (…)` clauses never compare equal and the "one WindowNode per distinct
  spec" grouping never actually groups. That accident is load-bearing:
  `findWindowColumnIndex` matches by function name + spec only, so two same-named
  functions genuinely sharing a WindowNode would both resolve to the first one's
  column. Anyone who makes those comparisons structural must teach
  `findWindowColumnIndex` to match by node identity or position first.
- `rejectUncollectedAggregates` in `select-window.ts` carries a `NOTE:` pointing at
  `collectOrderByAggregates` as the shape a fix for window-spec aggregates would
  take.
- `applyOrderBy`'s alignment-guard comment in `select-modifiers.ts` was rewritten:
  it used to claim the guard was a no-op once the window path stopped dropping
  stars. Only the grouped path (which can legitimately skip its final projection
  when the AggregateNode's output already IS the select list) still fails the
  check, so the guard stays and the comment now names only that shape.
