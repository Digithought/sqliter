---
description: A grouped query's select list can now write a grouping column with a table name (or an alias, or nested inside a bigger expression) and still get the right value, including when the query also uses a window function — where it previously died with a confusing internal error.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the fix: redirect in buildFinalAggregateProjections; GroupedWindowContext renamed to GroupedRedirectContext
  - packages/quereus/src/planner/building/select.ts              # builds the redirect context for every grouped query and passes it to both consumers
  - packages/quereus/src/planner/building/select-window.ts       # import/type rename only
  - packages/quereus/src/planner/analysis/equi-correlation.ts    # doc reference rename only
  - docs/runtime.md                                              # new subsection under "Invariant: source-attr contexts and child pulls"
  - packages/quereus/test/logic/07.5-window.sqllogic             # "SELECT LIST of a grouped query names a grouping key" section
  - tickets/fix/bug-window-column-read-by-position-hits-wrong-row.md               # pre-existing defect found during implement
  - tickets/fix/bug-order-by-grouping-key-spelling-breaks-window-query.md          # pre-existing defect found during review
---

# Bind a grouped select list's grouping-key reference to the aggregate's own column

## What was wrong

`select wg.a, row_number() over (order by a) as rn from wg group by a` failed at run time
with `QuereusError: No row context found for column a`. The same query without the `wg.`
qualifier worked, and so did the same qualified select list without the window function.

A grouped query's select list is rebuilt against the aggregate output scope, which
registers a grouping key only under the names the query literally wrote. `wg.a` against
`group by a` therefore fell through to the pre-aggregate scope and bound to the
**base-table** column, which the AggregateNode's output row does not carry. The
mis-binding was present for *every* grouped query; it only surfaced as an error when
something buffered between the aggregate and the projection (a window function), because
otherwise the projection could still read the value off the group's representative source
row that `emit/aggregate.ts` publishes around each yield.

## What shipped

**One behavioural change, in `buildFinalAggregateProjections`.** After `buildExpression`
rebuilds a select-list column against the aggregate output scope, the result runs through
`redirectToGroupKeys` — the rewrite the window phase already used — so any subtree that IS
a grouping key becomes a reference to the AggregateNode's own group output column.
`attrId` is derived from the redirected node. The `SELECT *` arm and the
whole-expression fingerprint fast path are untouched. Applied to every grouped query, not
only windowed ones.

**Plumbing.** `select.ts` builds the redirect context whenever the query is grouped and
hands the one object to both `buildFinalAggregateProjections` and `buildWindowPhase`.

**Rename, no behaviour.** `GroupedWindowContext` → `GroupedRedirectContext`,
`buildGroupedWindowContext` → `buildGroupedRedirectContext`.
`assertGroupedWindowCoverage` keeps its name — still window-only.

**Docs.** `docs/runtime.md` § *Corollary: a published source row reaches only the adjacent
consumer*: `emit/aggregate.ts`'s representative-row context is reachable only by an
operator consuming its yield directly, `emit/window.ts`'s buffered path removes it, and
plan-time binding must therefore never depend on it.

**Coverage.** `test/logic/07.5-window.sqllogic`, new section after the CTE cases. Every
windowed case is written beside its non-window twin. Shapes: table-qualified key,
FROM-alias-qualified, explicit alias, alongside an aggregate, qualified window spec; a key
nested in a larger expression (`upper(wg.a)`, `upper(a || '!')`, `wg.a || '?'`);
regressions (bare key, fingerprint fast path, `select *`, `group by 1` ordinal, two
projections onto the same key, HAVING); still-rejected ungrouped column; select-list
subqueries that spell the key but mean their own column, and genuinely correlated ones;
subquery source / CTE / `union all` composition; empty grouped+windowed query; NULL
grouping key; two grouping keys sharing a bare name across a join.

## Review findings

### Verification run (all after the review's own edits)

- `yarn lint` (root, all workspaces; quereus = eslint + `tsc -p tsconfig.test.json`) — clean.
- `yarn test` (root, all workspaces) — **0 failing**; quereus **9541 passing, 25 pending**.
  Re-ran quereus alone after the last edit: same.
- `yarn docs:check` — clean (the implement handoff never mentioned this script; it passes).
- Read the whole implement diff before the handoff summary, plus the surrounding
  `redirectNode` / `readsOnlyAggregateInput` / `assertGroupedWindowCoverage` /
  `applyOrderBy` / `rewriteWindowFunctions` code the diff did not touch.
- Ran ~40 ad-hoc query shapes against a build of the engine, listed below.

### Major — one new ticket filed

**ORDER BY carries the identical defect the SELECT list just shed.**
`tickets/fix/bug-order-by-grouping-key-spelling-breaks-window-query.md`. A grouped,
windowed query whose `ORDER BY` spells a grouping key in a form the projection output
scope does not publish dies with the same `No row context found for column a`:

```sql
select a, row_number() over (order by a) as rn from wg group by a order by wg.a;
select a, row_number() over (order by a) as rn from wg group by a order by upper(wg.a);
select a||'!' k, row_number() over (order by a||'!') rn from wg group by a||'!' order by a||'!';
```

`applyOrderBy` binds against `ShadowScope([projectionScope, selectContext.scope])`; the
bare key, an alias and an ordinal resolve in the projection scope, everything else falls
through to the pre-aggregate scope, and the resulting `SortNode` sits *above* the
WindowNode. **Verified pre-existing, not a regression:** with this ticket's redirect
disabled and the engine rebuilt, all three fail byte-identically.

Filed at the invariant rung rather than as the point fix. This is the third consumer of
one seam (select list, window specs, ORDER BY) and HAVING is a fourth that is correct only
by where it sits, so the ticket asks for one choke point plus a post-build check that no
node above the AggregateNode references an aggregate-input attribute absent from the
aggregate's output — which would have caught this case, the original one, and any future
post-aggregate operator, at plan time with the user-facing GROUP BY message.

### Minor — fixed in this pass

- **The `GroupKeyIndex` was derived twice per grouped query.**
  `buildFinalAggregateProjections` called `indexGroupKeys` itself while `groupedContext`
  already carried an identical index — two copies of one derivation, which is how they
  drift. Now `groupedContext?.groupKeys ?? indexGroupKeys(...)`; only an aggregate query
  with no GROUP BY reaches the fallback, and its expression list is empty.
- **A 19-line comment on a 3-line statement**, restating what the
  `GroupedRedirectContext` interface doc and the new `docs/runtime.md` subsection both
  already say. Trimmed to 13 lines and pointed at the doc section by name.
- **The build-cost `NOTE:` on `redirectNode` was stale**: it still described the cost as a
  window specification's, when every grouped query now walks its whole select list.
  Reworded.
- **Coverage gap the handoff listed as unexamined (its gap 5, HAVING).** Checked, not
  assumed: `having wg.a = 'x'` and `having upper(wg.a) = 'X'` both work windowed and
  unwindowed, because the HAVING filter sits directly on the aggregate's yield, below any
  window phase. Three cases pinned in the sqllogic file with that reason stated, so a
  later change that moves the filter above the window phase fails there instead of at run
  time.
- **The passing ORDER BY spellings** (bare key, alias, ordinal) are now pinned in the same
  file, with a comment naming the new fix ticket for the failing ones.

### Tripwires — recorded at the site, not filed

- **`redirectNode`, select-window interaction.** The select-list caller hands its
  window-function subtrees to the redirect, and `rewriteWindowFunctions` then discards
  every one of them (replaced by an `ArrayIndexNode`). Wasted work, harmless *only*
  because `findWindowColumnIndex` matches on the raw `expression.window` AST, which the
  redirect never touches. `NOTE:` at `redirectNode` says to skip window-function nodes if
  that match ever becomes plan-shape-based; the window phase redirects its own
  specification expressions and never passes one in, so the skip would be safe today.
- **Build cost** (handoff gap 3) stays a tripwire, as the implementer left it — the
  existing `NOTE:` on `redirectNode`, now correctly scoped to every grouped query.

### Checked and clean — nothing to report

- **Duplicate `Projection.attributeId`** (handoff gap 4). Exercised through the consumers
  the handoff did not: subquery source, `select z.a` re-projection, `distinct`, alongside
  an aggregate, distinct aliases, and a join of two grouped subqueries. All correct; the
  shape already existed for bare `select a, a`.
- **Rule-1 text matching** (handoff gap 2). No new exposure found beyond what the doc
  comment already records: the `readsOnlyAggregateInput` guard covers within-query
  collisions and the residue needs an enclosing-query subtree that fingerprints
  identically. Left as documented.
- **Other shapes probed, all correct:** reverse spelling (`group by wg.a` + bare select),
  qualified `partition by`, wrapping the fixed query in an outer filter / `exists`,
  `insert … select` from the fixed shape, aggregate over a qualified column
  (`max(wg.b)`), `case` expressions over the key, `wg.a || wg.b` over a two-key group.
- **Renames left no stale references** — `GroupedWindowContext`,
  `buildGroupedWindowContext` and `windowGroupedContext` appear nowhere in source or docs.
- **Docs.** `docs/runtime.md` is the only doc that described this binding, and the new
  subsection is at the correct nesting level under § *Invariant: source-attr contexts and
  child pulls*. No other `docs/` file describes grouped select-list binding; the
  grouping-key material elsewhere (`mv-maintenance.md`, `optimizer-assertions.md`) is
  about incremental maintenance and is untouched by this change.
- **The handoff's own gap 1** (`fix/bug-window-column-read-by-position-hits-wrong-row`,
  the decorrelated scalar-aggregate under a window) was re-read and left as filed — the
  ticket is accurate and its root cause is a different site.

### Site-claim check

`tickets/backlog/debt-oversized-source-files.md` already claims
`select-aggregates.ts`. Appended an arm rather than filing: line count refreshed to
**1,486** (`wc -l`, 2026-08-12; was 1,451 on 2026-08-11), with the note that the
redirect half now has three prospective callers. No open ticket claimed
`select-modifiers.ts` for this defect —
`backlog/bug-order-by-alias-lost-when-order-by-adds-its-own-aggregate` touches
`applyOrderBy` but is about the early-vs-late sort *placement* fork, a different root
cause; the new fix ticket says so and points at it.
