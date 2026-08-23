---
description: A query that totals something without grouping it now reports a clear, actionable error when its filtering or trimming clauses reference a column the totalled row does not carry — previously it either answered wrongly or died with an internal message.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts     # the gate split (~line 130-155), buildHavingFilter signature + coverage check (~line 1050, ~line 1145), assertGroupedPlanCoverage doc (~line 640)
  - packages/quereus/src/planner/building/select.ts                # coverage binding (~line 202) and the finished-plan guard (~line 425)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic      # new section, ~line 441-525
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # ~line 380-400
  - docs/sql-select.md                                             # § 3.5 ORDER BY, the no-`group by` bullets
---

# Review: whole-plan coverage check now runs for an aggregate query with no `group by`

## What the change is, in one paragraph

An aggregate query has clauses that sit *above* the aggregation step — `having`,
`order by`, `limit`, `offset`. Those clauses can read only what an aggregated row
carries. A whole-plan check (`assertGroupedPlanCoverage`) enforces that once the plan is
finished; unlike the per-clause checks it can see inside subqueries, so it is the one
that catches a mistaken reference buried in one. It was guarded on a value that only
exists for a query **with** `group by`, so a `group by`-less aggregate query — which
still has exactly one implicit group — never reached it. The fix splits that one value
into two bindings with one job each.

## The diff

**`select-aggregates.ts`, `buildAggregatePhase` (~line 130-155)** — one binding became
two:

- `groupedCoverageContext` — built unconditionally. Answers *"what does an aggregated
  row of this query carry?"*. Every aggregate query has an answer.
- `groupedRedirectContext` — `groupByExpressions.length > 0 ? groupedCoverageContext :
  undefined`. Answers *"are there grouping keys to rewrite post-aggregate expressions
  onto?"*. Only a `group by` query has any.

Both are returned. Every pre-existing consumer of `groupedRedirectContext` (select-list
rebuild, window phase, `applyOrderBy`, `redirectPostAggregate` inside
`buildHavingFilter`) still gets the gated one and is byte-for-byte unchanged in
behaviour.

**`buildHavingFilter`** — gained a required `groupedCoverageContext` parameter, placed
before the optional `groupedRedirectContext`. Its local
`groupedRedirectContext ?? buildGroupedRedirectContext([], aggregateAttributes,
sourceInput)` workaround is deleted; the passed-in value is the same thing.

**`select.ts`** — the finished-plan guard now reads
`if (groupedCoverageContext && aggregateResult.aggregateNode)`.

**Docs** — `docs/sql-select.md` § 3.5 said an alias "turns the extension off for **that
term**". It is the whole `order by` list; the wording is corrected and the
all-or-nothing consequence spelled out with three example queries.

## Use cases for testing and validation

Setup used for everything below (matches `07.3`'s `wg`):

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');
```

### Now rejected (all six were verified broken before the fix)

Every one reports
`Column '…' must appear in the GROUP BY clause or be used in an aggregate function`.

| Query | Before |
| --- | --- |
| `select count(*) as c from wg having (select max(t.a) from wg t where t.b = wg.b) = 'x'` | returned `[]` — silently wrong |
| `select count(*) as c from wg order by c, (select max(t.a) from wg t where t.b = wg.b)` | accepted |
| `select count(*) as c from wg order by count(*), (select max(t.a) from wg t where t.b = wg.b)` | accepted |
| `select count(*) as c from wg limit b` | runtime `No row context found for column b` |
| `select count(*) as c from wg limit (select count(*) from wg t where t.b = wg.b)` | same runtime error |
| `select count(*) as c from wg limit 1 offset (select count(*) from wg t where t.b = wg.b)` | same runtime error |

The `limit`/`offset` three are the ones worth poking hardest — they are the reason this
is more than a legality nicety. They compiled a plan that could not run.

### Must stay legal — the over-rejection risk

```sql
-- subquery reading only its own columns
select count(*) as c from wg having (select max(t.a) from wg t) = 'y';   -- [{"c":3}]
select count(*) as c from wg having (select max(t.a) from wg t) = 'zz';  -- []

-- correlated reference OUT to an enclosing query, from an ungrouped inner aggregate,
-- one subquery deeper still
select w.b, (select count(*) from wg t
             having (select max(u.a) from wg u where u.b = w.b) = 'x') as c
from wg w order by w.b;
-- [{"b":"1","c":3},{"b":"2","c":null},{"b":"3","c":3}]

select count(*) as c from wg order by count(*);                        -- [{"c":3}]
select count(*) as c from wg order by (select max(t.a) from wg t);     -- [{"c":3}]
select count(*) as c from wg limit (select count(*) from wg t);        -- [{"c":3}]
```

### The documented extension that must survive

With no `group by` and no `order by` term naming a select-list alias or an aggregate,
the whole `order by` sorts the **input** rows *before* aggregation (a Quereus extension
giving an order-sensitive aggregate a deterministic input order). A correlated subquery
in such a key is evaluated once per input row and is well defined. This survives for
free because that `SortNode` sits **below** the aggregate and the coverage walk stops at
the aggregate — there is no special-case guarding it, which is exactly why it is worth
re-checking:

```sql
select group_concat(b) as g from wg
order by (select max(t.b) from wg t where t.b = wg.b) desc;   -- [{"g":"3,2,1"}]

select group_concat(b) as g from wg
order by (select max(t.b) from wg t where t.b = wg.b) asc;    -- [{"g":"1,2,3"}]
```

Asserted in both directions on purpose — a single direction would pass even if the sort
were silently dropped.

### User-visible behaviour change

`order by` placement for a no-`group by` aggregate query is decided for the **whole
list**, not per term. Naming an alias or an aggregate in *any* term moves *every* term
above the aggregate, and then every term must be covered:

```sql
select count(*) as c from g order by id;      -- legal (input sort)
select count(*) as c from g order by c, id;   -- NOW an error
select count(*) as c from g order by id, c;   -- NOW an error
```

One pinned test asserted the middle shape:
`28.2-orderby-expression-extras.sqllogic` ~line 381, `select count(*) as c from g order
by c, id;`, whose stated intent was "composes with a second sort key" — the choice of
`id` was incidental. Changed to `order by c, max(a)` and both negative twins plus the
`order by id` control added next to it. It was the only test in the suite that changed
behaviour.

## Test results

- `yarn workspace @quereus/quereus test` → **10191 passing, 25 pending, 0 failing**.
- `yarn lint` (all workspaces; the quereus one also type-checks test files) → clean.
- `npx tsc --noEmit` in `packages/quereus` → clean.

New coverage: 9 negative + 9 positive cases in `07.3-group-by-extras.sqllogic` (new
section after the correlated-HAVING one, before `drop table wg`), and 3 cases
added / 1 changed in `28.2-orderby-expression-extras.sqllogic`.

## Known gaps — treat the tests as a floor

- **Window functions above an ungrouped aggregate: probed, unreachable, unpinned.**
  `select.ts` also hands `buildWindowPhase` the gated `groupedRedirectContext`
  (unchanged), and a `WindowNode` above an ungrouped aggregate would now fall under the
  new coverage walk. In practice `select count(*), row_number() over (…) from wg` is
  rejected earlier and unconditionally by the pre-existing "Cannot mix aggregate and
  non-aggregate columns in SELECT list without GROUP BY" check, so I could not construct
  a query that reaches it. I wrote no test, because I could not write one that exercises
  the path. If a reviewer finds a spelling that does reach it, that is the untested
  corner.
- **No plan-shape test.** All new coverage is behavioural (`.sqllogic`). Nothing pins
  that the pre-aggregate `SortNode` still lands *below* the `AggregateNode`; the
  `group_concat` directional pair infers it from the answer. A `test/plan/` case would
  be stronger.
- **Compound selects and `values`-fed aggregate queries: probed by hand, not pinned.**
  `select count(*) from wg union all select count(*) from wg` → `[{"c":3},{"c":3}]` and
  `select count(*) as c from (values ('x'),('y'))` → `[{"c":2}]`, both unchanged. No
  test case added for either.
- **Materialized-view bodies were not probed.** The plain `create view` case is now
  pinned in `07.3` (a view body that is an ungrouped aggregate with `limit b` fails at
  `create view` time rather than at first read). I did not hunt for the equivalent
  materialized-view shape; the full suite is green, so nothing existing relied on it.
- **The error message for the `limit`/`offset` cases says "must appear in the GROUP BY
  clause"** to a user who wrote no `group by` at all. It is the standard SQL wording and
  matches what the grouped form emits, and the ticket specified it — but a reviewer may
  reasonably think it reads oddly in the ungrouped case. Flagging, not changing.
- The `groupedCoverageContext` is now built for *every* aggregate query, including the
  ungrouped ones that previously built nothing. `indexGroupKeys([])` produces two empty
  maps and `collectDefinedAttrIds` walks the aggregate's input subtree once. That walk
  is new work per ungrouped aggregate query per prepare. I did not measure it in
  isolation; the full suite's wall clock did not move noticeably (2m both before and
  after). Recorded as a `NOTE:` tripwire at the site — see below.

## Tripwires parked

- `packages/quereus/src/planner/building/select-aggregates.ts`, at the
  `groupedCoverageContext` binding — none added; the existing `NOTE:` above
  `assertGroupedPlanCoverage` already covers the per-prepare walk cost and now applies to
  ungrouped queries too. Its stated revisit condition ("if preparing grouped queries ever
  shows up as slow") should be read as covering ungrouped aggregate queries as well.

## Unrelated failure seen once

`packages/quereus/test/bench-calibration.spec.ts:240` (`sizeBatch` → "grows the batch
until a sample clears the minimum") failed on the first full-suite run with
`AssertionError: expected 1 to be above 1`, which `--bail` turned into a stopped suite.
It is a wall-clock assertion over `bench/lib/calibrate.mjs`, passes in isolation
(`45 passing`) and passed on the immediate full re-run. Reported in
`tickets/.pre-existing-error.md` for the runner's triage pass. Nothing was skipped or
loosened.
