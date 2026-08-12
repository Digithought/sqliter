---
description: A summary query that also uses a window function used to fail with a confusing internal error when its sort clause named one of the summary's own grouping columns with a table name in front of it; every legal spelling now sorts correctly.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # new exported `referencesAggregateInput` (beside `readsOnlyAggregateInput`)
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy — new `groupedRedirect` parameter + the gated rewrite
  - packages/quereus/src/planner/building/select.ts               # the aggregate/window applyOrderBy call site (~line 406)
  - packages/quereus/test/logic/07.5-window.sqllogic              # new ORDER BY section (~line 1358), 36 pinned queries
  - docs/runtime.md                                               # § Corollary: a published source row reaches only the adjacent consumer
difficulty: medium
---

# Redirect a grouped query's ORDER BY keys onto the aggregate's own output columns

## What shipped

A GROUPED query's post-aggregate ORDER BY built its sort keys against a scope that falls
through to the **pre-aggregate** select scope, so any spelling of a grouping key that the
projection output scope does not publish (`order by wg.a` against `group by a`,
`order by upper(wg.a)`, a computed key written out again) bound to a base-table attribute
the AggregateNode's output row never carries. Without a window function the sort read the
right value off the representative source row `emit/aggregate.ts` publishes around each
yield; with a WindowNode in between — it drains its whole source first — that context is
gone and the query died with:

```
No row context found for column a. The column reference must be evaluated within the
context of its source relation.
```

Three changes, exactly as the implement ticket's validated prototype specified:

- **`select-aggregates.ts`** — new exported `referencesAggregateInput(node, context)`:
  true when ANY column reference in the subtree is a pre-grouping attribute of this query
  and is absent from the aggregate's output. Documented against its neighbour
  `readsOnlyAggregateInput`, which asks the opposite question (does the WHOLE subtree read
  only pre-grouping columns) and serves a different purpose (guarding the fingerprint rule
  inside a subquery).
- **`select-modifiers.ts`** — `applyOrderBy` takes a trailing optional
  `groupedRedirect?: GroupedRedirectContext` and, per sort key, runs `redirectToGroupKeys`
  **only when `referencesAggregateInput` says there is something to redirect**.
- **`select.ts`** — the aggregate/window `applyOrderBy` call (the one guarded by
  `if (!orderByAppliedEarly)`) passes `groupedRedirectContext`. No other call site does.

**The gate is the load-bearing part.** `redirectToGroupKeys` matches a subtree by AST
text, so under `group by a` an ungated pass would also fingerprint a plain `order by a` —
which already bound correctly to the window projection's output attribute — and rewrite it
onto the AggregateNode's attribute, breaking a query that worked before. The gate is what
keeps that from happening, and it is also what leaves the currently-accepted ungrouped
`order by b` untouched.

## How to exercise it

`test/logic/07.5-window.sqllogic` fixture: `wg (a text, b text)` holding
`('x','1'),('y','2'),('x','3')`. Each of these dies at HEAD~1 with the "No row context"
error and returns rows now:

```sql
select a, row_number() over (order by a) as rn from wg group by a order by wg.a;
select a, row_number() over (order by a) as rn from wg group by a order by upper(wg.a);
select wg.a, count(*) c, row_number() over (order by a) rn from wg group by a order by wg.a desc;
select a || '!' k, row_number() over (order by a || '!') rn from wg group by a || '!' order by a || '!';
```

Run the file alone:

```bash
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "07.5-window"
```

## Coverage added

A new `====`-delimited section in `07.5-window.sqllogic` replacing the stale block whose
comment said this case still failed (~line 1358). 36 queries, each windowed case paired
with its non-window twin so the two cannot drift:

- qualified key, ascending and `desc`; FROM-alias qualifier (`w.a` against `from wg w`)
- grouping key under a scalar function (`order by upper(wg.a)`), both directions
- the same wrong spelling in BOTH the select list and the ORDER BY, so the select-list
  redirect and the ORDER BY redirect run on one query
- computed key repeated verbatim (`order by a || '!'` against `group by a || '!'`), and
  nested inside a bigger sort expression (`order by upper(a || '!')`)
- alias form (`select a as k … order by wg.a desc`)
- alongside an aggregate in the select list
- mixed sort: window output column + redirected key (`order by rn desc, wg.a`)
- correlated subquery as the sort key
  (`order by (select count(*) from wg t where t.a = wg.a)`)
- two grouping keys, sorting on the qualified spelling of the second (`order by wg.b desc`)
- HAVING (no redirect, own hybrid scope) plus a redirected ORDER BY on one query
- **regression pins** that must keep their current results: `order by a`, `order by k`,
  `order by rn`, `order by 1`
- the currently-accepted **ungrouped** `order by b`, pinned with today's rows

I verified the new assertions actually run: flipping one expected row made the file fail
with `Actual: {"a":"y","c":1} / Expected: {"a":"x","c":2}`, then reverted. (The sqllogic
harness is one mocha `it()` per file, so the suite's total test count does not move when
queries are added — worth knowing before reading "9541 passing" as evidence of anything.)

## Validation run

- `yarn test` in `packages/quereus`: **9541 passing, 25 pending, 0 failing** (~4 min).
  Same count as the pre-change baseline, for the per-file reason above.
- `yarn lint` in `packages/quereus`: clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn typecheck` in `packages/quereus`: clean.
- Not run: `yarn test:store`, and the other workspaces' tests. Nothing outside
  `packages/quereus/src/planner/building` changed.

## Known gaps — treat these as the starting point, not the finish line

- **Three sibling sites still bind grouping keys to base attributes** and are correct only
  by accident of where their node sits: HAVING (`buildHavingFilter`), the `preWindowSort`
  keys (`select.ts` ~line 331), and the early ORDER BY placement (`select.ts` ~line 241,
  which runs before `groupedRedirectContext` exists). All three are already the subject of
  `implement/2-grouped-post-aggregate-redirect-boundary-check`, which routes every
  post-aggregate site through one choke point and adds a finished-plan assertion. Deliberately
  untouched here; no new NOTE was added at those sites because an open ticket names them.
- **`order by <ungrouped column>` is still accepted** and sorts by an arbitrary
  representative row's value, windowed or not. Unchanged by this fix and pinned with
  today's rows; making it an error is ticket 2's decision, and the pin forces that change
  to be explicit.
- **The redirect's text-matching limitation is inherited, not fixed.** Rule 1 of
  `redirectToGroupKeys` matches by AST fingerprint, so a subtree of ENCLOSING-query
  references that happens to spell this query's grouping key identically could be rewritten
  wrongly. Same residue the select list already carries; the existing NOTE on
  `redirectToGroupKeys` states it. No new test probes that shape.
- **Cost not measured.** The gate walks each sort key's subtree once per prepare of a
  grouped query, and a redirected key walks it again. Grouped queries already pay a walk of
  their whole select list (see the existing NOTE on `redirectNode`); this adds a strictly
  smaller one. Not profiled.
- **`select-aggregates.ts` grew ~25 lines** and remains listed in
  `backlog/debt-oversized-source-files` (now 1,524 lines, measured with
  `wc -l packages/quereus/src/planner/building/select-aggregates.ts`).
- `docs/runtime.md` § *Corollary* now names `applyOrderBy` alongside
  `buildFinalAggregateProjections`, and states plainly that HAVING is the remaining clause
  relying on adjacency. `docs/window-functions.md` was left alone — its redirect discussion
  is scoped to the window phase's own two passes, which did not change.
