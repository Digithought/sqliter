---
description: A query filtering with `having` but doing no counting or grouping used to have its filter ignored entirely — every row came back. It now behaves the way other databases do, and a new test suite checks that each part of a `select` statement actually affects the answer.
repro: verified
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildAggregatePhase (the fix) + validateAggregateProjections (review fix)
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic  # behaviour cases for the new shape
  - packages/quereus/test/clause-canary.spec.ts                  # NEW — per-clause "clause must change the answer" guard
  - packages/quereus/test/README.md                              # when to add a canary row
  - docs/sql-select.md                                           # §3.3 bullet + message precedence, §3.4 new paragraph
  - docs/runtime.md                                              # aggregate-boundary-check wording; both halves must cover the same shapes
  - docs/window-functions.md                                     # window over the implicit group
  - docs/architecture.md                                         # clause-canary suite registered under test strategy
  - docs/sqlite-test-crosscheck.md                               # what 25.2 now covers
---

# `having` with no aggregate and no `group by` — shipped

## What was wrong

`select a from wg having a = 'x'` returned **every** row of `wg`. So did
`having 1 = 0`. No error, no warning — the clause never reached the plan.

`buildAggregatePhase` computed a `shouldPushHavingBelowAggregate` flag and then
returned before anything could read it: the flag's condition was the early return's
condition plus `stmt.having`, so the branch it guarded was unreachable. Since
`select-aggregates.ts` is the only builder that reads `stmt.having`, nothing else
picked the clause up.

## What it does now

A `having` makes the query an aggregate query on its own — one implicit group over
all input rows, as SQLite and PostgreSQL define it. The query returns at most one
row, and every clause above the aggregation is subject to the existing coverage
rule (the implicit group carries no base-table columns at all).

**This is a behaviour change, not only a bug fix.** `select a from wg having
a = 'x'` is now an *error* rather than two rows. That was settled in the fix ticket:
Quereus does not import SQLite's permissive bare-column rule, so it rejects as
PostgreSQL does — and as it already rejected `select count(*) from wg having
a = 'x'`.

Implementation, in `buildAggregatePhase`: `shouldPushHavingBelowAggregate` and the
early return were replaced by
`const isAggregateQuery = hasAggregates || hasGroupBy || Boolean(stmt.having)`, the
unreachable pre-aggregate-filter branch deleted, the post-aggregate `having` branch
made unconditional, and `preAggregateSort` dropped its now-redundant `hasAggregates`
term. Everything it leans on — `emitStreamAggregate`'s zero-grouping-key path,
`buildHavingFilter`'s own coverage check, `assertGroupedPlanCoverage`, the
unconditional `groupedCoverageContext` — already existed.

## Review findings

Method: read the implement diff (`e18b28cc8`) before the handoff summary, then
probed the new shape directly against a built engine across ~40 query shapes the
implementer had not listed — `where` interaction, `null` predicates, `select *`,
window functions, aliases in `having`, FROM-subquery, compound select, `insert …
select`, scalar and correlated subqueries, `distinct`/`limit`/`offset`/`order by`
compositions, and the grouped/aggregate regression shapes.

### Major — one found, fixed in this pass

**`select * from t having <any predicate>` raised an INTERNAL error at the user.**
`select * from hn having 1 = 1` produced
`Internal: SELECT * column 'id' is not a GROUP BY key` with `StatusCode.INTERNAL`
(2), not the user-facing `Column 'id' must appear in the GROUP BY clause or be used
in an aggregate function` (1) that every other bare-column shape produced. Introduced
by this change: before it, the query returned all rows.

Root cause is one site, and it is an invariant, not an instance.
`validateAggregateProjections` returned early on `if (!hasGroupBy) return;`, skipping
the select-list coverage walk. `buildFinalAggregateProjections`' `select *` branch
carries an internal-consistency assert whose own comment states the invariant —
"validateAggregateProjections already rejected every star column that is not a
grouping key, so reaching here means the two disagree." The having-only shape is
exactly a query with no `group by` that *is* an aggregate query, so the two
disagreed.

Fixed by removing the early return: every caller is inside `buildAggregatePhase`'s
`isAggregateQuery` guard, so "no `group by`" there means "one implicit group with an
empty key set", and the coverage walk with an empty set is precisely the right check.
Not a special case for `select *` — restoring the invariant retires the class.

Two consequences, both pinned:
- `select val as v from hn having v = 10` now reports the coverage message instead of
  `Column not found: v`.
- When the select list *and* `having` both name an ungrouped column, the select-list
  message is raised rather than HAVING's dedicated one. That is what a `group by`
  query has always done (its select list is checked at the same point), so this makes
  the two consistent. Documented in `docs/sql-select.md` §3.3 and pinned in the
  sqllogic file, whose comment previously asserted the opposite order.

### Minor — fixed in this pass

- **Test coverage.** Added to `25.2-having-edge-cases.sqllogic`: a `where` that
  empties the input still yields the group (`where val > 100 having 1 = 1` → one row
  — `where` runs below the aggregation); a `null` predicate filters the group out;
  the shape as a FROM-subquery, as a `union all` arm, and as an `insert … select`
  source; `select * … having 1 = 1`; and the two message-precedence cases above.
- **Weak error assertions.** The clause-canary error canary asserted only the
  fragment `grp`, which appears in the query text itself — a parse error or an
  internal failure that echoed the SQL would have satisfied it. Now asserts the
  coverage message. Added a second canary for the `select *` path (a different
  builder), which fails on the exact INTERNAL-leak above.
- **Canary suite self-documentation.** The header cites `order by <ordinal> collate
  <name>` as the class's second instance but has no row for it (it is a known-open
  defect, so the row would fail). Now says so, plus which clauses are still
  unrepresented.
- **Docs the change should have touched but did not.** `docs/window-functions.md`
  claimed the `Aggregate → [HAVING Filter] → Window → Project` shape under a
  "**Grouped queries**" heading only — the having-only shape reaches it too, and
  `count(*) over () … having 1 = 1` is `1`, not the input row count (pinned in
  sqllogic, was `3` three times before the fix). `docs/sqlite-test-crosscheck.md`
  indexes what each fixture covers and did not mention the new shape.
  `docs/architecture.md` § test strategy and `packages/quereus/test/README.md`
  § Adding new tests did not mention the new canary suite at all — a class guard
  nobody knows to extend decays. All four updated. The `docs/runtime.md` insertion
  was also a run-on mid-paragraph; rewrapped and extended to say both halves of the
  coverage rule must cover the same shapes, citing the defect above.

### Major — filed as an arm on an existing ticket, not a new one

**`select 1 from t having 1 = 1 order by count(*)`** raises *"Aggregate function
count not allowed in this context"*; PostgreSQL accepts it, since the query is an
aggregate query. Verified identical before and after the fix, so not a regression —
the fix made the shape reachable as a meaningful query.

The implementer left this "as an explicit call for review". It is **not** fixable on
its own: two more `hasAggregates || hasGroupBy` tests (`buildAggregatePhase`'s ORDER
BY aggregate collection, and `allowAggregates: hasAggregates` in `select.ts`) would
have to widen to `isAggregateQuery` — and the aggregate would then land on
`validateAggregateProjections`' blanket "Cannot mix aggregate and non-aggregate
columns in SELECT list without GROUP BY" throw, because the select list (`1`) is a
non-aggregate item. That throw is already ticketed as
`backlog/bug-ungrouped-aggregate-rejects-constant-select-item`, at the same site.

Per the site-claim grep, that ticket owns it. Appended as an arm with the ordering
constraint (relax the throw first, then widen the two gates) and the sibling shape
`select 1 from t having count(*) > 1`. No new ticket.

### Tripwires — recorded, not ticketed

- `preAggregateSort` dropping its `hasAggregates` term means the having-only shape
  takes the pre-aggregate sort path, emitting a `sort` whose result nothing observes
  (empty aggregate list). The implementer parked this as a `NOTE:` at the
  computation with a revisit condition and the one-line elision. Reviewed and kept:
  the alternative pushes the sort above the aggregation, where the coverage check
  rejects it, making `order by` mean different things for two queries that differ
  only in whether an aggregate is named.
- `buildAggregatePhase` is **192 lines** (lines 27–218, measured `sed -n '27,218p' |
  wc -l`), and `select-aggregates.ts` is **1,675** (`wc -l`). Both are on
  `backlog/debt-oversized-source-files`, which already claims the file; appended the
  function measurement and the five sequential phases that are the natural first cut.
  Not a new ticket — pre-existing size, and this change is net +6 lines there.

### Checked, nothing found

- **Optimizer interaction with an AggregateNode carrying no keys and no aggregates.**
  `rule-aggregate-streaming` takes its `groupingKeys.length === 0` branch straight to
  `StreamAggregateNode`; `rule-groupby-fd-simplification` bails at
  `groupBy.length <= 1`. No rule elides the node, so no plan shape silently
  reintroduces the drop. Golden-plan snapshots unchanged.
- **Resource cleanup.** The canary suite closes its `Database` in `afterEach`.
- **Type safety.** No `any`, no new imports, no widened signatures.
- **Regressions.** `count(*) having count(*) > 1`, `group by … having <key>`,
  `where … having count(*)`, and the correlated-outer-column `having` shape all
  behave as before and are pinned.

### Explicitly not found

No error-handling, resource-leak, or scalability findings. Nothing about DRY: the
change is net-negative in logic and the fix removes a branch rather than adding one.
No performance finding: the only new work is one extra `SortNode` on a query shape
that returns one row, already recorded as a tripwire above.

## Validation

| Command | Result |
| --- | --- |
| `yarn build` (all packages) | clean |
| `yarn lint` (all packages; eslint + `tsc -p tsconfig.test.json` for `packages/quereus`) | clean |
| `yarn test` (full workspace) | **0 failing.** `@quereus/quereus` 10204 passing / 25 pending. Every other package unchanged. |
| `yarn test:store` — `25.2`, `07-aggregates`, `25-aggregate-edge-cases`, `07.3-group-by-extras`, `92-hash-aggregate-edge-cases`, `28.2-orderby-expression-extras` under the LevelDB backend | all pass |

**The new assertions were verified to bite**, not merely to pass: inverting one new
sqllogic expectation (`where val > 100 having 1 = 1` → `[]`) failed the file; it was
then restored and re-run green. The implementer separately verified the original
canary suite by disabling the fix and observing exactly the two having-only canaries
fail. The new `select *` canary asserts a message string that the pre-fix INTERNAL
error does not contain.

**Store-mode gap closed.** The implementer flagged `yarn test:store` as unrun. The
aggregate and having surface was run there (table above) and passes. The full
`test:store` sweep was still not run — it exceeds the agent time budget, and this is
a planner-shape change with no storage surface.

## Known limitations left open

- `select 1 from t having 1 = 1 order by count(*)` — see the arm above; resolves with
  `bug-ungrouped-aggregate-rejects-constant-select-item`.
- `select 1 from t having count(*) > 1` — same ticket, same throw.
- The canary table covers eight clauses plus two error canaries. `from`-clause
  modifiers, `with`, set operations and explicit `window` definitions have no row;
  the README now says where to add one.
