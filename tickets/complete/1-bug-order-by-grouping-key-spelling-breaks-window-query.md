---
description: A summary query that also uses a window function used to fail with a confusing internal error when its sort clause named one of the summary's own grouping columns with a table name in front of it; every legal spelling now sorts correctly.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts    # referencesAggregateInput + the extracted isPreGroupingReference
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyOrderBy — groupedRedirect parameter + the gated rewrite
  - packages/quereus/src/planner/building/select.ts               # the aggregate/window applyOrderBy call site (~line 406)
  - packages/quereus/test/logic/07.5-window.sqllogic              # ORDER BY section (~line 1358), 40 pinned queries
  - docs/runtime.md                                               # § Corollary: a published source row reaches only the adjacent consumer
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

Three changes:

- **`select-aggregates.ts`** — new exported `referencesAggregateInput(node, context)`:
  true when ANY column reference in the subtree is a pre-grouping attribute of this query
  and is absent from the aggregate's output. Sits beside `readsOnlyAggregateInput`, which
  asks the opposite question (does the WHOLE subtree read only pre-grouping columns) and
  guards the fingerprint rule inside a subquery.
- **`select-modifiers.ts`** — `applyOrderBy` takes a trailing optional
  `groupedRedirect?: GroupedRedirectContext` and, per sort key, runs `redirectToGroupKeys`
  **only when `referencesAggregateInput` says there is something to redirect**.
- **`select.ts`** — the aggregate/window `applyOrderBy` call (the one guarded by
  `if (!orderByAppliedEarly)`) passes `groupedRedirectContext`. No other call site does.

**The gate is load-bearing.** `redirectToGroupKeys` matches a subtree by AST text, so
under `group by a` an ungated pass would also fingerprint a plain `order by a` — which
already bound correctly to the projection's output attribute — and rewrite it onto the
AggregateNode's attribute. The clearest case the gate protects is an alias that shadows a
grouping key: `select upper(a) as a … group by a order by a` must sort by the projected
`upper(a)`, and does (verified, review probe).

## How to exercise it

`test/logic/07.5-window.sqllogic` fixture: `wg (a text, b text)` holding
`('x','1'),('y','2'),('x','3')`. Each of these died before the fix and returns rows now:

```sql
select a, row_number() over (order by a) as rn from wg group by a order by wg.a;
select a, row_number() over (order by a) as rn from wg group by a order by upper(wg.a);
select wg.a, count(*) c, row_number() over (order by a) rn from wg group by a order by wg.a desc;
select a || '!' k, row_number() over (order by a || '!') rn from wg group by a || '!' order by a || '!';
```

Run the file alone, from `packages/quereus`:

```bash
node test-runner.mjs --grep "07.5-window"
```

## Coverage

A `====`-delimited section in `07.5-window.sqllogic` (~line 1358) replacing the stale
block whose comment said this case still failed. 40 queries, each windowed case paired
with its non-window twin so the two cannot drift:

- qualified key, ascending and `desc`; FROM-alias qualifier (`w.a` against `from wg w`)
- grouping key under a scalar function (`order by upper(wg.a)`), both directions
- the same wrong spelling in BOTH the select list and the ORDER BY
- computed key repeated verbatim (`order by a || '!'` against `group by a || '!'`), and
  nested inside a bigger sort expression
- alias form (`select a as k … order by wg.a desc`); alongside an aggregate
- mixed sort (`order by rn desc, wg.a`); correlated subquery as the sort key; two
  grouping keys sorting on the second; HAVING plus a redirected ORDER BY
- the grouping key ABSENT from the select list, with a non-column sort expression — the
  shape where the redirect is the only thing that can bind the key (added in review)
- DISTINCT between the projection and the sort (added in review)
- regression pins: `order by a`, `order by k`, `order by rn`, `order by 1`
- the currently-accepted **ungrouped** `order by b`, pinned with today's rows

Assertions verified to actually run: flipping one expected row made the file fail with
`Actual: {"a":"y","c":1} / Expected: {"a":"x","c":9}`, then reverted. The sqllogic harness
is one mocha `it()` per file, so the suite's total test count does not move when queries
are added — "9541 passing" is not evidence about this file.

## Validation

- `yarn test` in `packages/quereus`: **9541 passing, 25 pending, 0 failing** (~3 min),
  re-run after the review's edits.
- `yarn lint` in `packages/quereus`: clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- Not run: `yarn test:store`, other workspaces. Nothing outside
  `packages/quereus/src/planner/building` changed.

## Review findings

Read the implement diff first, then probed the built plan's behaviour with ~30 ad-hoc
queries against a scratch harness before reading the handoff's claims.

### Fixed in this pass

- **DRY — one predicate written twice.** `referencesAggregateInput` and
  `findUngroupedWindowColumnRef` both spelled out
  `aggregateInputAttrIds.has(id) && !outputAttrIds.has(id)`. Extracted as
  `isPreGroupingReference`, documented once at the site: a reference the redirect rewrites
  is by definition one the coverage check would otherwise have rejected, so the two must
  not drift apart. `select-aggregates.ts` net +10 lines (now 1,534,
  `wc -l packages/quereus/src/planner/building/select-aggregates.ts`); still listed in
  `backlog/debt-oversized-source-files`.
- **Wrong mechanism claimed in a test comment.** The ungrouped `order by b` pin said the
  redirect leaves it alone "because nothing matches a grouping key". For the *windowed*
  member of that pair the redirect never runs at all: a bare column name absent from the
  select list is diverted by `select.ts` (~line 331) to a sort placed BELOW the window
  phase, and `preAggregateSort` then skips `applyOrderBy` entirely. Verified by
  instrumenting that branch and observing it fire for `order by b` and not for
  `order by wg.a`. Comment corrected.
- **Same wrong claim in `docs/runtime.md`.** § *Corollary* said "HAVING is the remaining
  clause that still binds a qualified or computed grouping key to a base attribute" — the
  diverted bare-column ORDER BY above is a second such site, and it is still an ORDER BY.
  Rewritten to name both, matching the *Sites* table in
  `implement/2-grouped-post-aggregate-redirect-boundary-check`.
- **Two coverage gaps.** Every one of the implementer's 36 queries selected the grouping
  key, so none exercised (a) a grouping key absent from the select list, where no
  projection output column carries it and the redirect is the sole binding path, or (b) an
  operator between the projection and the sort. Added both pairs (`select count(*) …
  group by a order by upper(wg.a) desc`, and `select distinct … order by wg.a desc`); both
  already returned correct rows, so these are pins, not fixes.

### Filed / appended elsewhere

- **`applyOrderBy` now takes nine positional parameters**, three optional and two bare
  booleans, and its three call sites differ only in their trailing arguments — a
  mis-ordered argument type-checks. Not filed as a new ticket: the site is already claimed
  by `implement/2-grouped-post-aggregate-redirect-boundary-check`, which will add a tenth
  parameter. Appended there as *Arm 1a* — convert the tail to an options object at that
  point.

### Checked, nothing found

- **Correctness of the gate + redirect**, across shapes the implementer did not test:
  `collate nocase` on the redirected key; the source being a CTE reference or a derived
  table; the key under `case`/`coalesce`; `order by max(a)` and `order by max(b)` (ORDER
  BY-only aggregates in a windowed grouped query, which skip the early placement); a
  correlated subquery that IS the whole grouping key, repeated in ORDER BY; `limit`/
  `offset`; the query as a derived table and as a view body. All returned correct rows.
- **The alias-shadowing hazard** the gate exists for: `select upper(a) as a … group by a
  order by a` sorts by the projected value, both windowed and not.
- **Type/collation preservation.** `buildGroupKeyColumnRef` takes the group attribute's
  type, which for a bare-column key is the base column's type and for a computed key is
  the same expression's type, so the sort comparator's collation resolution is unchanged
  by the rewrite.
- **The `!outputAttrIds.has(...)` half of the predicate is unreachable today** —
  `AggregateNode.buildAttributes` mints fresh ids, so the input and output id sets are
  disjoint by construction. Kept as defensive symmetry (it was already written that way in
  `findUngroupedWindowColumnRef`); noted here so a future reader does not mistake it for
  live logic.
- **The fingerprint-text residue is narrower for ORDER BY than for the select list.** A
  sort key composed purely of ENCLOSING-query references cannot reach the redirect at all,
  because the gate requires at least one of THIS query's pre-grouping attributes in the
  subtree. Hitting the residue needs a key that mixes an inner pre-grouping reference with
  an outer reference that fingerprints identically to a grouping key. No change made; the
  existing NOTE on `redirectToGroupKeys` still states the general limitation.

### Tripwires

- The per-key gate walk is itself the bail-out the existing NOTE on `redirectNode` asks
  for ("bail out of the walk for subtrees that contain no `aggregateInputAttrIds`
  reference at all"), applied to sort keys — so the cost concern is already parked at that
  NOTE and no second one was added. Still unmeasured, as the implementer stated.

### Not in scope, already owned

- HAVING, the `preWindowSort` keys, and the early ORDER BY placement still bind grouping
  keys to base attributes; all three are `implement/2-grouped-post-aggregate-redirect-boundary-check`.
- `order by <ungrouped column>` is still accepted and sorts by an arbitrary representative
  row — a *different* arbitrary row on each of the two paths (`order by b desc` returns
  `x,y` windowed and `y,x` unwindowed). Making it an error is ticket 2's decision; the pins
  force that change to be explicit.
