---
description: A query that filters with `having` but does no counting or grouping has its filter ignored completely — every row comes back, as if the clause had not been written. Fix is to treat such a query the way other databases do, and add a test that catches any clause the planner drops.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # buildAggregatePhase — the early return that drops the clause
  - packages/quereus/test/logic/25.2-having-edge-cases.sqllogic  # HAVING behaviour cases live here
  - packages/quereus/test/clause-canary.spec.ts                  # NEW — the per-clause "clause must change the answer" guard
  - docs/sql-select.md                                           # §3.3 (implicit single group) and §3.4 (HAVING)
  - docs/runtime.md                                              # ~line 482 — "aggregate query with no group by" wording
---

# `having` with no aggregate and no `group by` is dropped from the plan

## The bug, confirmed

Against the current build (`packages/quereus/dist`, table `wg (a text, b text)`
holding `('x','1'),('y','2'),('x','3')`):

```
select a from wg having a = 'x';   → [{"a":"x"},{"a":"x"},{"a":"y"}]   -- all rows, predicate ignored
select a from wg having b = '1';   → [{"a":"x"},{"a":"x"},{"a":"y"}]
select a from wg having 1 = 0;     → [{"a":"x"},{"a":"x"},{"a":"y"}]   -- even a constant-false predicate
```

No error, no warning. The clause works normally the moment the query has an
aggregate or a `group by`.

`buildAggregatePhase` computes `shouldPushHavingBelowAggregate` and then returns
before it can be read — the flag's condition is the early return's condition plus
`stmt.having`, so the branch it guards is unreachable:

```ts
const shouldPushHavingBelowAggregate = Boolean(stmt.having && !hasAggregates && !hasGroupBy);

if (!hasAggregates && !hasGroupBy) {
    return { output: input, needsFinalProjection: false, preAggregateSort: false };
}
```

`select-aggregates.ts` is the only builder that reads `stmt.having`, so nothing
else picks the clause up.

## The semantics decision — settled

**A `having` clause makes the query an aggregate query over one implicit group.**
This is what SQLite and PostgreSQL both define, and — decisively — it is what this
repo's own documentation already says for the neighbouring case. `docs/sql-select.md`
§3.3 already states:

> A query with aggregates and **no** `group by` has one implicit group, and the same
> restriction applies to it with the empty set of grouping keys: every clause above
> the aggregation may name aggregates only.

The fix simply widens "has aggregates" to "has aggregates **or** a `having`". The
dead branch's own comment (treat the predicate as a `where`-like pre-aggregate
filter) is rejected: it claims SQLite compatibility and is not SQLite-compatible,
and it would make `having` mean two different things depending on whether an
aggregate happens to appear elsewhere in the query.

One consequence worth stating plainly, because it is a behaviour change and not
just a bug fix: `select a from wg having a = 'x'` becomes an **error**, not two
rows. `a` is a bare column read above an aggregation that carries no such column.
SQLite would answer it with an arbitrary row's `a`; Quereus deliberately does not
import SQLite's permissive bare-column rule (that decision is already recorded above
`validateAggregateProjections` and in the `assertGroupedPlanCoverage` NOTE in
`select.ts`), so Quereus rejects it, exactly as PostgreSQL does and exactly as it
already rejects `select count(*) from wg having a = 'x'`.

## The patch — written and validated

The change was prototyped end to end, built, and run against the full
`@quereus/quereus` suite: **10194 passing, 25 pending, 0 failing** — no test
anywhere depended on the dropped clause. The prototype was then reverted so this
stage hands off a clean tree; reapply it as below.

In `buildAggregatePhase`, replace the flag + early return + dead branch:

```ts
	// A `having` clause makes this an aggregate query on its own, exactly as SQLite and
	// PostgreSQL define it: with no `group by` the query has ONE implicit group over all
	// input rows, and `having` filters that single group. So a query with a `having` and
	// neither aggregates nor `group by` still goes through the aggregate pipeline below —
	// it builds an AggregateNode with no grouping keys and no aggregates, which yields
	// exactly one (empty) row, and every clause above it is subject to the usual coverage
	// rule. Returning early here instead is what silently dropped the predicate.
	const isAggregateQuery = hasAggregates || hasGroupBy || Boolean(stmt.having);

	if (!isAggregateQuery) {
		return { output: input, needsFinalProjection: false, preAggregateSort: false };
	}

	let currentInput: RelationalPlanNode = input;

	// Handle pre-aggregate sorting for ORDER BY without GROUP BY. Skip when the
	// ORDER BY names an aggregate or a SELECT-list alias — neither can be evaluated
	// against the per-input rows; they need the post-aggregate row(s).
	const preAggregateSort = Boolean(
		!hasGroupBy && stmt.orderBy && stmt.orderBy.length > 0 && !needsPostAggregateSort
	);
```

and, further down, drop the now-meaningless second condition:

```ts
	// Handle HAVING clause *after* aggregation.
	if (stmt.having) {
		currentInput = buildHavingFilter(/* unchanged args */);
	}
```

Two details in that diff are deliberate, not incidental:

- `hasAggregates` is **not** set to `true` for the having-only shape. The
  `aggregates` array really is empty, and `hasAggregates` feeds
  `validateAggregateProjections`' "cannot mix aggregate and non-aggregate columns"
  throw. Widening it there would reject `select 1 from wg having 1 = 1`.
- The `preAggregateSort` condition drops its `hasAggregates` term so it reads
  `!hasGroupBy && …`. Inside the new guard, "not grouped" already implies "aggregate
  query with one implicit group", and this keeps the documented Quereus extension
  (an ungrouped aggregate query's `order by` sorts the *input* rows below the
  aggregation) behaving the same whether or not the query happens to name an
  aggregate.

Everything else falls out of machinery that already exists and needs no change:

- `emitStreamAggregate` already has a `plan.groupBy.length === 0` path; with an empty
  `aggregates` list it yields exactly one empty row, which is the implicit group.
- `buildHavingFilter` builds the predicate above the AggregateNode and applies its own
  coverage check, so a bare column in `having` is rejected there.
- `assertGroupedPlanCoverage` is already called for every query that produced an
  AggregateNode, so a bare column in the *select list* above it is rejected there.
- `groupedCoverageContext` is already built unconditionally (that was
  `bug-no-group-by-aggregate-skips-subquery-coverage-check`, landed), so the ungrouped
  case is already wired.

## Observed behaviour under the patch

Errors (both are the correct rejection, from the two checks named above):

```
select a from wg having a = 'x';
-- HAVING references non-grouped column 'a'; HAVING may only reference GROUP BY columns or aggregate expressions
select * from wg having a = 'x';
-- (same message, for 'a')
select a from wg having 1 = 0;
-- Column 'a' must appear in the GROUP BY clause or be used in an aggregate function
```

Accepted, one implicit group:

```
select 1 as one from wg   having 1 = 1;                       → [{"one":1}]
select 1 as one from wg   having 1 = 0;                       → []
select 1 as one from empt having 1 = 1;                       → [{"one":1}]   -- empty table still yields the group
select 1 as one from wg   having (select count(*) from wg) > 2;  → [{"one":1}]
select 1 as one from wg   having (select count(*) from wg) > 5;  → []
select 1 as one from wg   having 1 = 1 limit 1;               → [{"one":1}]
select distinct 1 as one from wg having 1 = 1;                → [{"one":1}]
select 1 as one from wg   having 1 = 1 order by a;            → [{"one":1}]
create view v1 as select 1 as one from wg having 1 = 1; select * from v1;  → [{"one":1}]
```

Unchanged (regression guards):

```
select count(*) as c from wg having count(*) > 5;             → []
select count(*) as c from wg having count(*) > 1;             → [{"c":3}]
select a, count(*) as c from wg group by a having a = 'x';    → [{"a":"x","c":2}]
select count(*) as c from wg where a = 'x' having count(*) > 1;  → [{"c":2}]
select w.b from wg w where exists (select 1 from wg t having w.a = 'x') order by w.b;  → [{"b":"1"},{"b":"3"}]
```

That last one matters: a `having` inside a subquery may name an **enclosing**
query's column, exactly as `where` may. The coverage check already distinguishes
that from an ungrouped local column (§3.4 of `docs/sql-select.md` documents the
rule), and it keeps working with no aggregates present.

## The class guard: a canary test per SELECT clause

The failure here is not "a wrong predicate" — it is **a clause the parser accepted
that never reached the plan, and said nothing about it**. That class deserves a
general guard, not only a single-case regression. `order by 2 collate nocase`
silently not sorting (`tickets/backlog/bug-order-by-ordinal-with-collate-ignored`)
is a second, independent instance of the same class already on the board.

Add `packages/quereus/test/clause-canary.spec.ts`: for each SELECT clause, a query
whose answer **must** differ from the same query with the clause removed. It fails
if the two answers match — i.e. if the clause did nothing. Follow the harness idiom
in `packages/quereus/test/filter-conjunct-early-exit.spec.ts` (`new Database()`,
`for await (const r of db.eval(sql))`).

Shape:

```ts
interface ClauseCanary {
	/** Clause under test, for the test name. */
	readonly clause: string;
	/** Query WITHOUT the clause. */
	readonly without: string;
	/** Same query WITH the clause. Must produce a different answer. */
	readonly with: string;
}
```

Cover at least `where`, `having` (both the grouped and the no-aggregate-no-group-by
shape this ticket fixes), `group by`, `order by`, `limit`, `offset`, and `distinct`.
Keep the fixture small and the difference unmistakable — e.g. `limit 1` against a
3-row table, `distinct` against a table with a duplicate, `order by a desc` against a
source that scans ascending. A clause whose only legal form raises an error is not a
canary candidate; assert the error instead of a row difference, and say so in a
comment.

Note in the file's header comment what the suite is *not*: it does not check that a
clause is implemented **correctly**, only that it is implemented **at all**. The
per-clause behaviour suites stay where they are.

## Docs

`docs/sql-select.md` §3.4 currently describes only the grouped and
aggregate-with-implicit-group cases; it needs the third. §3.3's implicit-group bullet
needs `having` added to its trigger. `docs/runtime.md` (~line 482) says the boundary
check "runs for an aggregate query with **no** `group by` too" — the definition of
"aggregate query" there now includes a having-only query, which is worth one clause.

## Not in scope

`select 'total' as label, count(*) from t` is still rejected by
`validateAggregateProjections`' blanket throw. That is a separate, already-filed
finding (`tickets/backlog/bug-ungrouped-aggregate-rejects-constant-select-item`) at
the same file but a different site, and this patch neither fixes nor worsens it —
the having-only shape leaves `hasAggregates` false and so never reaches that throw.
Do not fold it in; do note the asymmetry it produces
(`select 1 from wg having 1 = 1` works, `select 1, count(*) from wg` does not) if you
touch that function for any reason.

## TODO

### Phase 1 — the fix

- Apply the `buildAggregatePhase` patch above: replace `shouldPushHavingBelowAggregate`
  and the early return with the `isAggregateQuery` guard, delete the unreachable
  pre-aggregate-filter branch, drop `hasAggregates` from the `preAggregateSort`
  condition, and simplify the `if (stmt.having && !shouldPushHavingBelowAggregate)`
  site to `if (stmt.having)`.
- Confirm `FilterNode` and `buildExpression` are still used elsewhere in the file
  before assuming their imports are now dead — they are (`buildHavingFilter` uses
  both), so the import block should not change.

### Phase 2 — regression coverage

- Extend `packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` with the
  having-without-aggregate-without-group-by cases: the rejections, the accepted
  constant-predicate forms including the empty-table one, the subquery predicate,
  and the `limit` / `distinct` / view compositions. The "Observed behaviour" section
  above is the expected-output table.
- Keep the correlated-subquery case (`… where exists (select 1 from wg t having
  w.a = 'x')`) — it is the one shape that proves the coverage check still tells an
  enclosing query's column from an ungrouped local one when no aggregate is present.

### Phase 3 — the class guard

- Add `packages/quereus/test/clause-canary.spec.ts` as described above.
- Verify it actually bites: with the Phase 1 patch reverted, the `having` canary must
  fail. Check that before considering the suite done — a canary that passes against
  the bug is decoration.

### Phase 4 — docs and validation

- Update `docs/sql-select.md` §3.3 and §3.4, and the one clause in `docs/runtime.md`.
- `yarn build`, then `yarn test` (full workspace, not just `@quereus/quereus` — the
  prototype run covered only the latter), then `yarn lint`.
