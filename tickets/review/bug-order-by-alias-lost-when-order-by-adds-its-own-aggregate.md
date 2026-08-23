---
description: Fixed a summary query that sorts by two things at once — a summary it does not display, plus one of its own result column names — which used to fail with "Column not found" instead of returning rows.
files:
  - packages/quereus/src/planner/building/select.ts             # early placement deleted; tripwire NOTE at the surviving applyOrderBy call site (~line 355)
  - packages/quereus/src/planner/building/select-aggregates.ts  # orderByNeedsPostAggregateSort dropped from buildAggregatePhase's return
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # rewritten comment ~line 222; new coverage appended from ~line 462
  - docs/runtime.md                                             # ~line 469 bullet updated
difficulty: medium
---

# Retire the early ORDER BY placement for aggregate queries

## What changed

An aggregate query's `ORDER BY` used to be planned in one of two positions, and
each position could see names the other could not:

- **Early**, between the aggregation and the final projection — taken only when
  `ORDER BY` named an aggregate the `SELECT` list did not contain. Select-list
  `as` aliases do not exist yet in that position.
- **Late**, above the final projection — every other aggregate `ORDER BY`.
  Aliases are in scope there.

An `ORDER BY` that needed both lost. The early placement is now gone: every
aggregate `ORDER BY` sorts in the late position, which sees both name sets.

Plan shape changed for exactly one family of queries — those whose `ORDER BY`
introduces an aggregate the SELECT list lacks — and only by swapping two
adjacent nodes:

```
before:  Project(select list) → Sort → Aggregate
after:   Sort → Project(select list) → Aggregate
```

which is the shape every other aggregate `ORDER BY` already had.

Concretely:

- `select.ts` — the early-placement `if` block, its comment block, the
  `orderByAppliedEarly` local, and the `if (!orderByAppliedEarly)` guard around
  the surviving `applyOrderBy` are all deleted. The guard's body is now
  unconditional.
- `select-aggregates.ts` — `orderByNeedsPostAggregateSort` dropped from
  `buildAggregatePhase`'s return type and returned object (the deleted branch was
  its only consumer). The *local* `needsPostAggregateSort` stays; it still gates
  `collectOrderByAggregates` and the `preAggregateSort` decision.
  `hasOrderByOnlyAggregates` also stays — it still promotes `hasAggregates`,
  still forces `needsFinalProjection`, and still feeds `preserveForAggregate`.
- `docs/runtime.md` — the `redirectPostAggregate` bullet no longer names the
  deleted placement.

## Why the surviving placement can still resolve a sort-only aggregate

A sort key like `max(b)` in `select a, count(*)+1 as c from g group by a order by
max(b), c` binds to the `AggregateNode`'s own output attribute. The final
`ProjectNode` does not list that attribute among its output columns — yet the
`SortNode` above it still reads it, because `emitProject`
(`packages/quereus/src/runtime/emit/project.ts:31-51`) sets two row contexts per
row (its own output row *and* its source row) and keeps the source one live while
it yields. The sort evaluates its keys during that pull, before buffering. This
is `docs/runtime.md` § "Invariant: source-attr contexts and child pulls", and the
window path already shipped a plan of this exact shape.

## Tripwire recorded (not a ticket)

The surviving placement leans on **nothing sitting between the final
`ProjectNode` and the `SortNode`**. Nothing does today. If a builder or optimizer
rule ever inserts a node there — anything that buffers, especially — the
sort-only aggregate key loses its row context and the query dies with
`No row context found`.

Parked as a `NOTE:` comment at the surviving `applyOrderBy` call site in
`select.ts` (~line 355), with the remedy spelled out: widen the final projection
with one extra `ColumnReferenceNode` projection per sort-only aggregate, sort
above that, add a stripping projection above the sort. `DISTINCT` and `LIMIT`
already sit above this sort, so they would stay where they are, above the strip.

## Use cases to exercise

Fixture used throughout the new tests:
`soa (id integer primary key, a text, b text)` = `(1,'x','p'), (2,'y','q'), (3,'x','r')`.
Grouped by `a`: group `x` has `max(b)='r'` and 2 rows; group `y` has `max(b)='q'`
and 1 row. All expectations below were taken from real SQLite (`node:sqlite`),
not from Quereus.

**The shapes that used to fail with `Column not found: c`:**

```sql
select count(*) + 1 as c from soa order by max(a), c;                 -- [{"c":4}]
select length(max(a)) as c from soa order by min(b), c;               -- [{"c":1}]
select a, count(*) + 1 as c from soa group by a order by max(b), c;   -- y|2 then x|3
select distinct count(*) + 1 as c from soa order by max(a), c;
select a, count(*) + 1 as c from soa group by a order by max(b), c limit 1;
select a, count(*) + 1 as c from soa group by a having count(*) >= 1 order by max(b), c;
select a, count(*) + 1 as c from soa group by a order by max(b), c + 0;
select * from (select count(*) + 1 as c from soa order by max(a), c);
select (select count(*) + 1 as c from soa order by max(a), c) as v;   -- [{"v":4}]
```

**Shapes that already worked and must keep working** — an alias of a *bare*
aggregate (`count(*) as c`) also lands on the aggregation's own output column, so
the old early placement could see it:

```sql
select count(*) as c from soa order by max(a), c;
select a, count(*) as c from soa group by a order by max(b), c;
select a as k, count(*) as c from soa group by a order by max(b), k;   -- grouping-key alias
select a, count(*) + 1 as c from soa group by a order by max(b), 2;    -- positional
select a from soa group by a order by max(b);                          -- sort-only aggregate, no alias
select a, count(*) over () as w from soa group by a order by max(b);   -- window path
```

**Ordering correctness.** A single-group or already-sorted fixture passes by
coincidence, so the second fixture `sog` makes `max(val)` anti-correlated with
both the group name and the group size, and includes a tie:

```
grp | rows | max(val)      by max(val) asc: a, c, d, e, b
----+------+---------      by grp asc:      a, b, c, d, e
 a  |  3   | m1            by size asc:     b, d, a, c, e
 b  |  1   | m4
 c  |  4   | m2          d and e TIE on max(val)='m3'; count(*)+1 (3 vs 6)
 d  |  2   | m3          breaks it, so the second key's own ASC/DESC is
 e  |  5   | m3          observable independently of the first key's.
```

covered ascending, descending-first-key, both-descending, under `LIMIT` with each
tiebreak direction, and once with a grouping-key alias as the tiebreak over
`min(val) desc`.

## Validation run

- `yarn lint` — clean (this is the pass that catches the removed locals).
- `yarn build` — clean.
- `yarn workspace @quereus/quereus run test` — **10173 passing, 25 pending,
  0 failing** (10198 tests).
- `yarn workspace @quereus/quereus run test:context-strict` — 10176 passing,
  22 pending, 0 failing.
- `yarn workspace @quereus/quereus run test:repr-strict` — 10182 passing,
  16 pending, 0 failing.
- Every query in the two sections above was diffed row-for-row against
  `node:sqlite` on the same fixtures; 21 of 22 matched (the 22nd is the
  independent divergence noted below).

**About the test count.** The implement ticket recorded a baseline of "10174
passing, 25 pending". This tree yields one less. That is not a test lost to this
change — it was measured directly. Running the *unmodified HEAD* planner source
against this same tree and this same (new) test file gives **10198 total tests,
10172 passing, 1 failing** (`28.2-orderby-expression-extras.sqllogic`, failing
with exactly `Column not found: c`); the changed source gives **10198 total
tests, 10173 passing, 0 failing**. Same total, one failure converted to a pass.
The ticket's 10174 came from a run that saw one more dynamically-generated case
than this tree produces; it is unrelated to this diff. Worth a reviewer's glance
if the discrepancy recurs elsewhere.

- `yarn test:store` was **not run** — the change is planner-only and
  backend-independent. Flagging it as a deliberate omission, not an oversight.

## Known gaps / things a reviewer should push on

- **The tripwire is the load-bearing assumption, and it is only a comment.**
  Nothing mechanically enforces "no node between the final `ProjectNode` and this
  `SortNode`". If you think that deserves an assertion rather than prose, that is
  a fair finding — the remedy is already written down at the site, so the
  question is only whether to pay for it now.
- **Coverage is example-based, not generated.** The new tests are a hand-built
  matrix of {bare-aggregate alias, computed-aggregate alias, grouping-key alias,
  positional} × {grouped, ungrouped} plus the modifier and nesting spellings. A
  property test over generated aggregate `ORDER BY` clauses would cover the class
  rather than the listed instances; I did not write one.
- **The `emitProject` two-context behaviour is relied on but not pinned by a test
  of its own here.** The new sqllogic cases would break if it changed, but they
  would break with a confusing runtime error rather than a targeted one.
- **The ungrouped × grouping-key-alias cell of the matrix has no test**, because
  an ungrouped aggregate query has no grouping key and the natural stand-in — a
  constant select item — is rejected by Quereus. See below.

## Separate divergence found while testing (filed, not fixed)

`validateAggregateProjections` in `select-aggregates.ts` (~lines 749-761) rejects
*any* non-aggregate select-list item when a query has aggregates and no
`GROUP BY`, including items that reference no column at all:

```sql
select 'total' as label, count(*) as c from t;   -- SQLite: total|2   Quereus: error
select 1 + 1 as two,     count(*) as c from t;   -- SQLite: 2|2       Quereus: error
```

This is independent of `ORDER BY` (it fails with no `ORDER BY` clause at all) and
independent of this change — verified at HEAD. It is *not* the deliberately-declined
"bare columns" rule (`select a, count(*) from t`), which the function's doc comment
explicitly rejects and which stands. Filed as
`backlog/bug-ungrouped-aggregate-rejects-constant-select-item`. A comment in the
new test section names that slug where the matrix cell is missing.
