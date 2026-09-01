description: A summary query that puts a fixed label next to its total — like asking for the word "total" alongside a row count — used to be rejected with an error instead of returning the row. It now works, as it does in other databases, and a query that filters on a total can now sort by one.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # throw deleted; isAggregateQuery hoisted + returned
  - packages/quereus/src/planner/building/select.ts               # allowAggregates widened; buildWindowPhase NOTE rewritten
  - packages/quereus/test/logic/25.5-ungrouped-aggregate-column-free-select-item.sqllogic  # NEW
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic   # having-only ORDER BY / HAVING aggregate arms
  - packages/quereus/test/logic/07.5-window.sqllogic              # window over ungrouped aggregate now succeeds
  - packages/quereus/test/logic/25.3-aggregate-isnull-empty.sqllogic       # expected message updated
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic    # parenthetical replaced with the case
  - docs/sql-select.md                                            # §3.3 implicit-group bullet, §3.4 having paragraph
difficulty: medium
----

# What landed

Two arms, one site, both in the aggregate-building path.

## Arm 1 — the select-list check no longer rejects column-free items

`validateAggregateProjections` in `select-aggregates.ts` opened with a blanket
throw for *any* select-list item when the query had aggregates and no `group by`:

```ts
if (hasAggregates && !hasGroupBy) {
	throw new QuereusError('Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY', ...);
}
```

That throw was **redundant**, not merely too strict. The GROUP BY coverage walk
immediately below it already gets the ungrouped shape right on its own: with no
`group by` the coverage set is empty, so the walk rejects every bare column
reference and admits every item that references no column. Deleting the throw is
the whole fix.

The distinction the code now draws — and the one a reviewer should hold in mind —
is **column-free expression vs. column reference**, not "aggregate vs.
non-aggregate". `select 'total', count(*) from t` is legal standard SQL;
`select a, count(*) from t` is not and stays rejected (Quereus deliberately does
not import SQLite's permissive "bare columns" rule).

Follow-ons done: `hasAggregates` and `hasGroupBy` were dead once the throw went,
so both were dropped from the signature and the call site (not `_`-prefixed), and
the function's doc comment was rewritten — it is now purely the coverage check
and says why the empty coverage set is the right answer for one implicit group.

## Arm 2 — a `having`-only query can name an aggregate in its `order by`

Two places asked "does this query name an aggregate?" (`hasAggregates ||
hasGroupBy`) where the right question is "is this an aggregate query?" — which a
`having` satisfies on its own. `isAggregateQuery` was hoisted in
`buildAggregatePhase` above the ORDER BY aggregate collection, that collection now
gates on it, and it is **returned** from the function rather than re-derived; the
`applyOrderBy` call in `select.ts`'s aggregate branch reads
`aggregateResult.isAggregateQuery` for `allowAggregates`.

## The window tripwire has been discharged

The `NOTE:` above `buildWindowPhase` in `select.ts` said a window function above
an *ungrouped* aggregate was unreachable only because the mixing check rejected
the select list that spells it, and asked whoever loosened the check to pin the
shape. That condition tripped. The note now describes what actually happens —
the shape is reachable, `groupedRedirectContext: undefined` is correct rather
than a gap (an ungrouped query has no grouping keys to rewrite onto), and the
coverage walk is what keeps it honest — and the shape is pinned in
`07.5-window.sqllogic`.

# Behaviour deltas — what to check

Every row below was probed against the built engine and is now pinned in the
corpus.

| query | before | after |
| --- | --- | --- |
| `select 'total' as label, count(*) as c from t` | error | `total\|2` |
| `select 1 + 1 as two, count(*) as c from t` | error | `2\|2` |
| `select abs(-1) as k, count(*) as c from t` | error | `1\|2` |
| `select case when count(*) > 1 then 'many' else 'few' end as k, count(*) c from t` | error | `many\|2` |
| `select (select count(*) from t) as sub, count(*) as c from t` | error | `2\|2` |
| `select 1 as one from t having 1 = 1 order by count(*)` | error | `1` |
| `select 1 as one from t having count(*) > 1` | error | `1` |
| `select count(*) as c, row_number() over (order by count(*)) as rn from wg` | error | `3\|1` (PostgreSQL agrees) |
| `select a, count(*) from t` | old mixing message | `Column 'a' must appear in the GROUP BY clause or be used in an aggregate function` |

The last row is a **user-visible message change** and the only one. It is an
improvement: the ungrouped rejection now carries the same wording and source
position as the grouped one, and names the offending column. It is what changed
the assertion in `25.3-aggregate-isnull-empty.sqllogic`.

# Test coverage added

- **New** `25.5-ungrouped-aggregate-column-free-select-item.sqllogic` — the
  headline file. Accepted: string/integer/NULL literals, literal-only
  expressions, `abs(-1)`, several aggregates alongside, `case` over an aggregate,
  arithmetic over an aggregate, two flavours of scalar subquery, and the
  column-free item surviving `distinct` / `limit 1` / `limit 0` / `order by
  count(*)` / `having` both ways / an empty table / a derived table / a `union
  all` arm; plus `cast(1 as text)`, `1 in (1,2)` and `'a' collate binary`.
  Rejected: bare column first, bare column last, column inside `||`, column under
  `length()`, column inside a `case`, qualified `uac.a`, `select *, count(*)`,
  and two genuinely correlated subqueries. Plus a non-regression that adding the
  covering `group by` accepts the column.
- `25.2-having-edge-cases.sqllogic` — the `having`-only arms: `order by
  count(*)`, `order by count(*), max(val)` (two keys, different functions),
  `order by count(*), one` (aggregate + select-list alias in one sort),
  `having count(*) > 1` / `> 5` beside a constant select list, the same with a
  string label and an `order by`, and both over the empty table.
- `07.5-window.sqllogic` — the previously-asserted-as-error window-over-ungrouped
  -aggregate now asserts `c=3, rn=1`, with its (now-false) four-line lead-in
  comment replaced; three neighbouring error shapes added
  (`over (order by a)`, `sum(b) over ()`, `sum(count(*)) over ()`).
- `28.2-orderby-expression-extras.sqllogic` — the parenthetical that recorded
  this gap and named this ticket's slug is gone, replaced by the actual ungrouped
  counterpart of the grouped grouping-key-alias case
  (`select 'all' as k, count(*) as c from soa order by max(a), k`).

# Validation run

- `yarn workspace @quereus/quereus test` — **10281 passing, 0 failing, 25
  pending**. No pre-existing failures surfaced.
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p
  tsconfig.test.json --noEmit`).
- `tsc -p packages/quereus/tsconfig.json --noEmit` — clean.
- Not run: `yarn test:store` (LevelDB path) and the other workspaces' suites.
  This diff is entirely inside the planner's SELECT builder and its corpus, so
  the store path should be unaffected — but that is reasoning, not a measurement.

# Known gaps / where to push

Honest list of what a reviewer should not assume is settled:

- **One expectation was written to match observed output rather than predicted.**
  `select uac.a, count(*) from uac` reports `Column 'uac.a' must appear in the
  GROUP BY clause…` — the message echoes the *written spelling*, not the bare
  column name. The corpus now pins `uac.a` with a comment saying so. Worth a
  second opinion on whether echoing the qualifier is the message you want,
  since it is now pinned either way. This is not new behaviour — the grouped path
  has always done it — but this is the first assertion that nails it down.
- **Coverage of the newly-legal space is by enumeration, not by property.** The
  accepted set in 25.5 is a hand-picked list of column-free shapes — `cast`, an
  `in` list and `collate` were added after probing, but nothing *generates* them,
  so a shape nobody thought of is still untested. One notable gap: a window
  function whose arguments are all literals, sitting beside an ungrouped
  aggregate, is not pinned. If you want a class-level guard here rather than
  instances, that is a `debt-` ticket, not something this change contains.
- **The scalar-subquery cases pass for a different reason than the literal
  ones**, and the corpus now says so. `findUngroupedColumnRef` stops descending
  at any relational child, so a subquery is *skipped* by the select-list walk
  rather than proved column-free. What catches a genuinely correlated subquery
  reading an ungrouped column of this query is the later, subquery-aware
  finished-plan check (`assertGroupedPlanCoverage`). Probed and pinned in 25.5:
  `select (select count(*) from uac t where t.a = uac.a) as sub, count(*) from uac`
  is rejected with `Column 'uac.a' must appear in the GROUP BY clause…`, as is
  the `t.n > uac.n` variant. So the seam is covered — but note the rejection
  comes from a *different* check than every other error row in that file, which
  is worth a reviewer's eye if that check is ever moved or weakened.
- **`select *, count(*) from uac` is asserted to fail on `id`, the first
  expanded column.** That "first of them" is an ordering detail of the walk, not
  a documented guarantee; if star expansion order ever changes, this assertion
  moves. Low stakes, but it is a shape-dependent expectation.
- **No plan-shape test.** Everything here is asserted through results and error
  messages. Whether the ungrouped aggregate + window shape produces a *sensible*
  plan (rather than a correct-but-silly one) is unverified — `test/plan/` was
  not touched.
- **`tickets/.pre-existing-known.md` was not consulted** because nothing failed;
  if the reviewer's run surfaces something, it is worth checking there first.

# Tripwires parked

None new. One existing tripwire was **discharged** (the `buildWindowPhase`
`NOTE:` in `select.ts`, described above) — it is now a plain explanatory note
with no unmet condition, and the shape it guarded is in the corpus.
