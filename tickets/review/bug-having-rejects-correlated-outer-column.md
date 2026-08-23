description: A HAVING clause inside a subquery can now compare against a column of the surrounding query, the same way WHERE always could. Previously the engine rejected it as an ungrouped column.
repro: verified
difficulty: medium
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # the whole change lives here
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # new cases, ~line 370
  - packages/quereus/test/logic/07.5-window.sqllogic              # lines 1372-1377 pin the rejection message (untouched, still green)
  - docs/sql-select.md                                            # §3.4 HAVING
----

# HAVING now admits a correlated reference to an enclosing query

## What changed and why

A subquery may correlate to the query that contains it. Quereus supported that in
`where` but not in `having`: HAVING's coverage check flagged **any** column reference
that was not one of *this* query's grouping keys or aggregates, and a reference to an
enclosing query's column is neither, so it came out as "ungrouped".

The fix swaps HAVING's blunt allow-list for the predicate the engine already uses for
the same question elsewhere.

### Before

`buildHavingFilter` ended with a `buildGroupByCoverage` + `findUngroupedColumnRef`
pair. The coverage set held the grouping keys' attribute ids, the AggregateNode's
output attribute ids, and the GROUP BY expressions' AST fingerprints; anything not in
it was "ungrouped". Attribute ids are minted per relation instance, so an enclosing
query's scan and this subquery's scan never share one — the outer id simply was not in
the set.

### After

The check is a walk whose per-reference test is `isPreGroupingReference(node, context)`:

```ts
context.aggregateInputAttrIds.has(attrId) && !context.outputAttrIds.has(attrId)
```

True **only** for a column of *this* query's pre-grouping input that the grouped row no
longer carries. An enclosing query's column and a subquery's own column both fall
outside it by construction. This is the same predicate the finished-plan check
(`assertGroupedPlanCoverage` -> `findUngroupedPostAggregateRef`) already uses, so the two
checks now agree instead of HAVING carrying its own rule.

Three concrete edits, all in `packages/quereus/src/planner/building/select-aggregates.ts`:

- **`findUngroupedPostAggregateRef` gained a fourth parameter, `skipSubqueries`.** With
  it set, the child loop `continue`s on a relational child instead of recursing. HAVING
  passes `true`. Reason: an ungrouped reference to *this* query's column buried inside a
  HAVING subquery has always been rejected by the finished-plan check with the general
  `Column '<name>' must appear in the GROUP BY clause or be used in an aggregate
  function` wording, and descending here would pre-empt that with HAVING's own dedicated
  message. Behaviour preserved deliberately (documented at `docs/sql-select.md:621`).
- **`buildHavingFilter` derives a `coverageContext`.** `buildAggregatePhase` builds
  `groupedRedirectContext` only when there are GROUP BY keys, so an aggregate query with
  no `group by` reached HAVING with `undefined` — and had the same bug. HAVING now falls
  back to `buildGroupedRedirectContext([], aggregateAttributes, sourceInput)`, built from
  the exact two values `buildAggregatePhase` would have passed. Used for the coverage
  check **only**; `redirectPostAggregate` still receives the real
  `groupedRedirectContext` so a non-grouped query keeps its pass-through branch.
- **`buildGroupByCoverage` lost its second parameter** (`groupedOutputAttributes`). It
  existed only for the HAVING call site; the remaining caller
  (`validateAggregateProjections`, for the SELECT list) always passed one argument.
  `findUngroupedColumnRef` keeps that one caller and is otherwise unchanged.

The thrown `QuereusError` text and `loc` are byte-identical to before.

## Why dropping the grouping-key allow-list is safe

Not merely narrowed — genuinely unnecessary. `redirectPostAggregate` has already run
over `havingExpression` by the time the check happens, so a grouping key reached by any
spelling the redirect handles (bare, qualified, nested, whole-subtree fingerprint) is
already an AggregateNode-**output** reference, and `isPreGroupingReference` returns false
for those. The fingerprint and group-key-source-attrId arms of `buildGroupByCoverage`
were covering exactly the references the redirect now rewrites. The `07.5-window.sqllogic`
pins around line 1365 (`group by a || '!' ... having a || '!' = 'x!'`) exercise precisely
that path and stayed green untouched.

## Use cases to validate

Fixture used throughout (already in `07.3-group-by-extras.sqllogic` at line 241):

```sql
create table wg (a text, b text);
insert into wg values ('x','1'),('y','2'),('x','3');
```

### Now works (added as tests)

```sql
-- inner HAVING compares a grouping key against the enclosing row's column
select w.b, (select count(*) from wg t group by t.a having t.a = w.a) as c
from wg w order by w.b;
-- [{"b":"1","c":2},{"b":"2","c":1},{"b":"3","c":2}]

-- enclosing column compared against one of the inner aggregates
select w.b, (select count(*) from wg t group by t.a having count(*) = w.b + 0) as c
from wg w order by w.b;
-- [{"b":"1","c":1},{"b":"2","c":2},{"b":"3","c":null}]

-- same, enclosing column on the LEFT, non-count aggregate on the right
select w.b, (select count(*) from wg t group by t.a having w.a = max(t.a)) as c
from wg w order by w.b;
-- [{"b":"1","c":2},{"b":"2","c":1},{"b":"3","c":2}]

-- no GROUP BY at all (implicit single group)
select w.b, (select count(*) from wg t having count(*) = 3 and w.b = '2') as c
from wg w order by w.b;
-- [{"b":"1","c":null},{"b":"2","c":3},{"b":"3","c":null}]
```

### Still rejected, message unchanged (added as tests)

```sql
select w.b, (select count(*) from wg t group by t.a having t.b = '1') as c from wg w;
-- error: HAVING references non-grouped column 'b'

select w.b, (select count(*) from wg t having t.b = '1') as c from wg w;
-- error: HAVING references non-grouped column 'b'
```

### Still behaves as before, verified by hand but NOT added as tests

These were checked with a throwaway script against the fixture above, not pinned in the
suite. A reviewer wanting belt-and-braces could pin them.

```sql
select wg.a, count(*) as c from wg group by a having b = '1';
-- error: HAVING references non-grouped column 'b'; HAVING may only reference
--        GROUP BY columns or aggregate expressions   (already pinned in 07.5)

select count(*) as c from wg having b = '1';
-- error: same message                                (NOT pinned anywhere)

select a, count(*) from wg group by a having (select max(t.a) from wg t where t.a = wg.b) = 'x';
-- error: Column 'wg.b' must appear in the GROUP BY clause or be used in an aggregate
--        function                                     (NOT pinned anywhere; this is the
--        `skipSubqueries` behaviour, and it is the case most at risk from a future edit)
```

## Known gaps — read before signing off

- **The `skipSubqueries` behaviour is unpinned.** The third query above is the entire
  reason the parameter exists, and nothing in the suite would catch a regression that
  made HAVING's own message swallow it. Adding it as a test is the single highest-value
  follow-up if the reviewer wants one, and it is a two-line addition to
  `07.3-group-by-extras.sqllogic`.
- **The no-GROUP-BY negative message is only partly pinned.** The new tests assert the
  prefix (`HAVING references non-grouped column 'b'`); the sqllogic harness matches on
  substring, so the "may only reference GROUP BY columns or aggregate expressions" tail
  is not actually verified by any test, before or after this change.
- **Correlation depth beyond one level is untested.** Every new case correlates exactly
  one query outward. A HAVING correlating two levels out should work by the same
  argument (the attribute id belongs to neither this query's input nor its output) but
  was not exercised.
- **No `test:store` run.** Only `yarn workspace @quereus/quereus test` (the default,
  memory-backed) was run. This is a pure planner/build-time change with no storage
  surface, so a store run looks unnecessary — but it was not done.
- **Optimizer interaction not separately probed.** The check is build-time and runs
  before any rule fires, so rules cannot change its verdict; but no plan-level test
  asserts where the correlated HAVING FilterNode ends up after decorrelation. The new
  cases pass end-to-end, which is the evidence available.

## Something found along the way — do NOT re-file

While hand-deriving an expected value, `max(t.b)` over the **text** column `b` came back
as the integer `3`, not the text `'3'`:

```sql
select typeof(b) from wg;              -- text
select typeof(max(b)), max(b) from wg; -- integer, 3
select typeof(max(b) over ()) from wg; -- text     <- window path disagrees with aggregate
```

That is a real, pre-existing defect and it is **already tracked** as
`backlog/bug-text-coercion-in-arithmetic-and-aggregates`, arm B — root cause
`coerceAggregateValue` in `packages/quereus/src/util/coercion.ts`, which carries a doc
comment naming it. Nothing was filed. Its only effect on this ticket was that the
original ticket's second test case (`having max(t.b) = w.b`, expecting `c` = null/1/2)
could never pass: `max(t.b)` yields the number `3` while `w.b` is the text `'3'`, so the
comparison is false for every row and the subquery returns null throughout. That case was
replaced with two shapes that exercise the same arm (enclosing column vs. inner aggregate,
in both operand orders) without depending on text/number comparison.

One loose thread noticed but not touched: the doc comment on `coerceAggregateValue`
points at the stale pre-garden slug `bug-text-minmax-numeric-coercion`, and the backlog
ticket's own body asks whoever works it to repoint that reference. Left alone — it is
that ticket's file, not this one's.

## Validation run

- `yarn workspace @quereus/quereus test` — **10173 passing, 25 pending, 0 failing**.
- `yarn lint` (fans out across every package) — clean.
- `tsc -p tsconfig.json --noEmit` in `packages/quereus` — clean.
- No `tickets/.pre-existing-error.md` written: nothing in the suite failed.

## Docs

`docs/sql-select.md` §3.4 gained one paragraph stating that the HAVING restriction is
about *this* query's own columns and that a subquery's `having` may name an enclosing
query's column exactly as `where` may, cross-referencing §3.3 rather than restating it.
