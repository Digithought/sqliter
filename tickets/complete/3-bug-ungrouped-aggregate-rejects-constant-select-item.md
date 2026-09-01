description: A summary query that puts a fixed label next to its total — like asking for the word "total" alongside a row count — used to be rejected with an error instead of returning the row. It now works, as it does in other databases, and a query that filters on a total can now sort by one.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # blanket mixing throw deleted; isAggregateQuery hoisted + returned
  - packages/quereus/src/planner/building/select.ts               # allowAggregates widened; buildWindowPhase NOTE rewritten; dead hasAggregates write removed in review
  - packages/quereus/test/logic/25.5-ungrouped-aggregate-column-free-select-item.sqllogic  # NEW
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
  - packages/quereus/test/logic/07.5-window.sqllogic
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # review: ORDER-BY-only aggregate with a column-free select list
  - packages/quereus/test/logic/25.3-aggregate-isnull-empty.sqllogic
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  - docs/sql-select.md                                            # §3.3, §3.4, §3.5
----

# What landed

Two arms, one site, both in the aggregate-building path.

**Arm 1 — the select-list check no longer rejects column-free items.**
`validateAggregateProjections` opened with a blanket throw for *any* select-list item
when the query had aggregates and no `group by`. The throw was redundant: the GROUP BY
coverage walk right below it already gets the ungrouped shape right, because with no
`group by` the coverage set is empty — every bare column reference is rejected and every
item referencing no column is admitted. Deleting the throw is the fix; `hasAggregates`
and `hasGroupBy` became dead parameters and were dropped.

The line the code draws is **column-free expression vs. column reference**, not
"aggregate vs. non-aggregate". `select 'total', count(*) from t` is legal standard SQL;
`select a, count(*) from t` is not, and stays rejected — Quereus does not import
SQLite's permissive "bare columns" rule.

**Arm 2 — a `having`-only query may name an aggregate in its `order by`.** Two sites
asked "does this query name an aggregate?" (`hasAggregates || hasGroupBy`) where the
right question is "is this an aggregate query?", which a `having` satisfies on its own.
`isAggregateQuery` was hoisted above the ORDER BY aggregate collection and is now
returned from `buildAggregatePhase`; `applyOrderBy` reads it for `allowAggregates`.

**A tripwire was discharged.** The `NOTE:` above `buildWindowPhase` said a window
function above an *ungrouped* aggregate was unreachable only because the mixing check
rejected the select list that spells it. That condition tripped; the note now describes
what happens, and the shape is pinned in `07.5-window.sqllogic`.

# Behaviour deltas

| query | before | after |
| --- | --- | --- |
| `select 'total' as label, count(*) as c from t` | error | one row, `total` and `2` |
| `select 1 + 1, abs(-1), cast(1 as text), … beside an aggregate` | error | runs |
| `select case when count(*) > 1 then 'many' else 'few' end, count(*) from t` | error | runs |
| `select (select count(*) from t) as sub, count(*) from t` | error | runs |
| `select 1 from t having 1 = 1 order by count(*)` | error | one row |
| `select 1 from t having count(*) > 1` | error | one row |
| `select count(*) c, row_number() over (order by count(*)) rn from wg` | error | one row, `rn` = 1 |
| `select a, count(*) from t` | old mixing message | `Column 'a' must appear in the GROUP BY clause or be used in an aggregate function` |

The last row is the only user-visible message change, and is an improvement: the
ungrouped rejection now carries the grouped one's wording and source position and names
the offending column.

# Review findings

Read the implement diff before the handoff summary. Checked from the correctness,
DRY/dead-code, docs-accuracy, test-coverage, source-hygiene and resource angles; every
finding below was probed against the built engine, with `sqlite3` as the cross-check
wherever the question was "what *should* this do".

## Fixed in this pass (minor)

- **Dead write left by arm 2.** `select.ts` kept `let hasAggregates` and a
  `hasAggregates = true` promotion inside the aggregate branch, whose only reader was
  the `allowAggregates` argument arm 2 moved to `aggregateResult.isAggregateQuery`.
  Nothing read it afterwards, and eslint cannot see it (the variable is read *before*
  the assignment). Collapsed to a plain destructured `hasAggregates` and removed the
  promotion plus its now-false explanatory comment.
- **`docs/sql-select.md` §3.5 was left behind by arm 2.** Its ORDER BY bullet still
  defined an aggregate query as "has aggregates in `select`/`having`, or has `group
  by`" — which excludes the bare `having` that arm 2 made qualify, contradicting the
  §3.4 paragraph the same commit added. Rewritten, and it now also records the
  limitation on the other side: an aggregate written *only* in `order by` does not
  promote the query, so `select 'k' from t order by count(*)` is rejected — as it is in
  SQLite ("misuse of aggregate", verified against `sqlite3`).
- **That limitation had no pin for the newly-legal select list.** `07.3` pinned
  `select id from aob order by sum(val)` only; arm 1 makes the column-free spelling
  (`select 'k' from aob order by sum(val)`) look like it might now be promoted. Pinned
  as still-rejected, with the reasoning.
- **The handoff's own named gap — "a window function whose arguments are all literals
  beside an ungrouped aggregate is not pinned" — was probed and pinned.**
  `select count(*) as c, sum(1) over (order by count(*)) as s from wg` returns one row
  with `s` = 1; added to `07.5`.

## Filed (major)

- **`backlog/bug-outer-column-rejected-in-aggregate-select-list`** — an aggregating
  query's select list rejects a column belonging to an *enclosing* query, which is a
  constant with respect to its group and is exempt under the standard. `select a from t
  where exists (select t.a, count(*) from t x)` raises `Column 't.a' must appear in the
  GROUP BY clause…`; SQLite accepts it. Root cause is one site: the select-list walk
  (`findUngroupedColumnRef`) compares against a flat grouping-key attribute-id set with
  no notion of which query a reference belongs to, while the finished-plan walk
  (`findUngroupedPostAggregateRef` / `isPreGroupingReference`) already models exactly
  that distinction — the two disagree, and the wrong one runs first. Filed at the
  representation rung (unify the two on one predicate), not as a point fix.
  **Not a regression:** the grouped form has always been rejected, and the ungrouped
  form was rejected by the blanket throw this ticket deleted. Today's behaviour is
  pinned in a `KNOWN DIVERGENCE` block in `25.5` naming that slug, so the pins flip when
  it lands rather than the divergence drifting unnoticed.

## Checked, nothing to file

- **Arm 1's claim that the deleted throw was redundant holds.** Probed the newly-legal
  space beyond the corpus: `coalesce`, an ordinal `order by 1`, `order by` on the alias,
  `group by 1` over a literal item, `distinct`, `union all`, a literal-argument window
  function. All correct. The rejected set is equally intact — bare, qualified, buried in
  `||`, under `length()`, inside a `case`, star-expanded.
- **Arm 2 changed no other query's classification.** The ORDER BY collection's guard
  widened from `hasAggregates || hasGroupBy` to `… || having`, and the only shape that
  newly satisfies it is a `having` with no aggregate anywhere — every other path reaches
  the same value it did before, because the `having`-aggregate collection above it had
  already promoted `hasAggregates`.
- **The handoff's `uac.a` qualifier-echo worry.** The message renders the spelling the
  user wrote, for the ungrouped and grouped paths alike, through the one
  `expressionToString` every coverage error uses. Consistent and pre-existing; changing
  it would change every grouped message too. Left as pinned.
- **The `select *, count(*)` "rejected on the first expanded column" expectation.**
  Shape-dependent as the handoff says, but the walk visits projections in select-list
  order by construction, so it is as stable as the star-expansion order the same file
  already pins elsewhere. Not worth a guard of its own.
- **No plan-shape test added.** The change introduces no new plan shape: the ungrouped
  path already built an `AggregateNode`, and the window-over-ungrouped case is the same
  `WindowNode`-above-aggregate spine the grouped case has. Results and error messages
  are the right assertion level here, so `test/plan/` was deliberately left alone.
- **Source hygiene.** `select-aggregates.ts` is 1,683 lines (`wc -l`, 2026-09-01) — up 8
  from the 1,675 recorded on `debt-oversized-source-files`, which already claims this
  file and names `buildAggregatePhase` (192 lines, unchanged) as the natural first cut.
  The measurement was appended to that ticket rather than filing a second one. The
  deleted throw left no unused imports (`QuereusError`/`StatusCode` still have four call
  sites). The new comment blocks are long, but match the density of the surrounding
  file, which is deliberately heavily annotated at these seams.
- **No accepted-tradeoff `NOTE:` was overridden.** Read around every touched site; the
  only `NOTE:` in the diff's neighbourhood is the window one this ticket discharged.

## Tripwires

None new. One existing tripwire was discharged (above); it is now a plain explanatory
note with no unmet condition.

# Validation

- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json
  --noEmit`).
- `yarn workspace @quereus/quereus test` — **10281 passing, 25 pending, 0 failing**,
  re-run after the review's edits.
- `yarn test` (all workspaces, which the implement stage did not run) — all green; the
  only `Error:` lines in the log are deliberately injected by the sync/store failure
  tests.
- No pre-existing failures surfaced, so `tickets/.pre-existing-known.md` was not needed.
- Not run: `yarn test:store` (LevelDB path). The diff is confined to the planner's
  SELECT builder and its logic corpus, so the store path is not exercised differently —
  reasoning, not a measurement.
