---
description: A summary query that sorts by two things at once — a summary the query does not otherwise display, plus one of its own result column names — fails with "Column not found" instead of returning rows. Delete the special-case sort placement that causes it.
files:
  - packages/quereus/src/planner/building/select.ts             # lines 192, 220-251, 387-404 — the placement fork to delete
  - packages/quereus/src/planner/building/select-aggregates.ts  # line 46, 203 — orderByNeedsPostAggregateSort, returned only for the fork
  - packages/quereus/src/planner/building/select-modifiers.ts   # applyOrderBy — the single surviving call site's options
  - packages/quereus/src/runtime/emit/project.ts                # why the surviving placement resolves the sort-only aggregate
  - docs/runtime.md                                             # ~line 469 — names the placement being deleted
  - packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic  # ~line 222 comment to update; new section at the end
difficulty: medium
repro: verified
---

# Retire the early ORDER BY placement for aggregate queries

## What is wrong

An aggregate query's `ORDER BY` is planned in one of two places, and each place can
see names the other cannot:

- **Early — above the aggregation, below the final projection.**
  `packages/quereus/src/planner/building/select.ts:236-251`. Taken only when
  `ORDER BY` names an aggregate the `SELECT` list does not contain (`order by max(a)`
  in a query that never selects `max(a)`). Those extra aggregates exist only for the
  sort; the final projection drops them, so the sort was placed under it. In this
  position the select list's `as` aliases do not exist yet.
- **Late — above the final projection.** `select.ts:387-404`. Every other aggregate
  `ORDER BY`. Here the select list's aliases are in scope.

An `ORDER BY` that needs both loses. Verified against a table
`g (id integer primary key, a text, b text)` holding `(1,'x','p'),(2,'y','q'),(3,'x','r')`:

```sql
select count(*) + 1 as c from g order by max(a), c;
-- QuereusError: Column not found: c
select length(max(a)) as c from g order by min(b), c;
-- QuereusError: Column not found: c
select a, count(*) + 1 as c from g group by a order by max(b), c;
-- QuereusError: Column not found: c
```

Also failing on the same cause, found while reproducing:

```sql
select distinct count(*) + 1 as c from g order by max(a), c;
select a, count(*) + 1 as c from g group by a order by max(b), c limit 1;
select a, count(*) + 1 as c from g group by a having count(*) >= 1 order by max(b), c;
select a, count(*) + 1 as c from g group by a order by max(b), c + 0;
select * from (select count(*) + 1 as c from g order by max(a), c);
select (select count(*) + 1 as c from g order by max(a), c) as v;
```

Only an alias of a **computed** aggregate is affected. `select count(*) as c … order by
max(a), c` works, because that alias also lands on the aggregation's own output column,
which the early placement can see. The gap is exactly: the alias lives only on the
final projection. SQLite accepts every query above.

## The correction: delete the early placement

The early placement is not needed. The late placement can resolve a sort-only
aggregate on its own, and it also sees the select-list aliases — so one placement
serves both name sets and the fork disappears.

**Why the late placement can still see the sort-only aggregate.** The sort key for
`max(b)` binds to the `AggregateNode`'s own output attribute (through the aggregates
planning context, which `applyOrderBy` is already allowed to use here — the late call
site passes `allowAggregates: hasAggregates`, and `hasAggregates` is promoted to true
whenever ORDER-BY-only aggregates were collected). The final `ProjectNode` does not
list that attribute among its output columns, but `emitProject`
(`packages/quereus/src/runtime/emit/project.ts:31-51`) sets **two** row contexts per
row — its own output row *and* its source row — and keeps the source one live while it
yields. The `SortNode` directly above evaluates its keys during that pull, before it
buffers anything, so the aggregate's output row is still addressable. This is the
documented behaviour under *docs/runtime.md § Invariant: source-attr contexts and
child pulls*, and the window path already ships a plan of exactly this shape today:

```
select a, count(*) over () as w from g group by a order by max(b);
-- Sort ORDER BY "max(b)"
--   Project SELECT a, w          <- does not output max(b)
--     Window …
--       HashAggregate GROUP BY a, max(b)
```

**What was measured.** The whole change was prototyped by disabling the early branch
(`if (false && …)`) and running:

- the 22-query shape matrix above plus every neighbouring shape (bare-aggregate alias,
  computed-aggregate alias, grouping-key alias, positional keys under a sort-only
  aggregate, `distinct`, `limit`, `having`, window functions, derived table, scalar
  subquery) — **all 22 pass**, all rows match SQLite;
- ordering correctness over five groups with maxima deliberately anti-correlated with
  both group name and group size, asc and desc, with a tie on the first key broken by
  the computed alias, and with `limit` — **all orders correct**;
- `yarn workspace @quereus/quereus run test` — **10174 passing, 25 pending, 0 failing**;
- the same shape matrix under `QUEREUS_CONTEXT_STRICT=1 QUEREUS_REPR_STRICT=1` (the
  stale-row-shadow and physical-representation harnesses described in
  docs/runtime.md § Strict context test mode) — **clean, no `context-strict:` throw**.

The prototype was reverted; the working tree is unchanged.

**The one thing this leans on** is that nothing sits between the final `ProjectNode`
and the `SortNode`. No builder or optimizer rule puts anything there today. If one ever
does — anything that buffers, in particular — the sort-only aggregate key loses its row
context and the query dies with `No row context found`. That is a genuine conditional,
so it belongs in the code as a `NOTE:` tripwire at the surviving `applyOrderBy` call
site, not as a follow-up ticket. Record the remedy with it: widen the final projection
with one extra `ColumnReferenceNode` projection per sort-only aggregate, sort above
*that*, and add a stripping projection above the sort (DISTINCT and LIMIT stay where
they are, above the strip — which is where they already sit relative to this sort).

## Shape change

Only queries whose `ORDER BY` introduces an aggregate the SELECT list lacks change
plan shape, and only by swapping two adjacent nodes:

```
before:  Project(select list) → Sort → Aggregate
after:   Sort → Project(select list) → Aggregate
```

Which is the shape every other aggregate `ORDER BY` already has.

## Notes for the implementer

- `orderByNeedsPostAggregateSort` is returned from `buildAggregatePhase`
  (`select-aggregates.ts:46`, `:203`) for the deleted branch and has no other consumer.
  The **local** `needsPostAggregateSort` inside `buildAggregatePhase` stays — it gates
  `collectOrderByAggregates` and the `preAggregateSort` decision.
- `hasOrderByOnlyAggregates` stays. It still promotes `hasAggregates`, still forces
  `needsFinalProjection`, and still feeds `preserveForAggregate` in `select.ts`.
  It stops steering *placement*, which is the whole point.
- The comment block at `select.ts:222-236` documents the fork and names this bug; it
  goes with the branch.
- `test/logic/28.2-orderby-expression-extras.sqllogic:222-231` has a comment whose
  rationale ("ORDER BY that names an aggregate is applied BEFORE the grouped query's
  final projection exists, so a second ordinal key … falls back to the select list")
  stops being true. The two queries under it still return the same rows — after the
  change the ordinal binds to the final projection's output column instead of through
  the select list, and both routes resolve to `jt2.v`. Rewrite the comment; do not
  change the expectations.
- `docs/runtime.md:~469` lists "the early ORDER BY placement for order-by-only
  aggregates" among the expressions routed through `redirectPostAggregate`. Drop that
  clause — the late sort keys it merges into are already named in the same sentence.
- `yarn test:store` was not run for the prototype. The change is planner-only and
  backend-independent, so store mode should be unaffected; run it only if something
  looks storage-shaped.

## TODO

**Phase 1 — the change**

- Delete the early-placement `if` block and its comment in
  `packages/quereus/src/planner/building/select.ts` (~lines 220-251), and the
  `orderByAppliedEarly` local (line 192) together with the `if (!orderByAppliedEarly)`
  guard around the surviving `applyOrderBy` (line 387) — the guard's body becomes
  unconditional.
- Drop `orderByNeedsPostAggregateSort` from `buildAggregatePhase`'s return type and
  returned object in `select-aggregates.ts`; keep the local computation.
- Add a `NOTE:` tripwire at the surviving `applyOrderBy` call site: the sort-only
  aggregate key resolves through the adjacent `ProjectNode`'s live source-row context,
  so nothing may be inserted between that projection and this sort; name the
  widen-and-strip remedy if something ever is.

**Phase 2 — coverage**

- Extend the section that starts at
  `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic:341`
  (it already creates the `g` table this bug reproduces on) with a new section
  covering an `ORDER BY` that names both a sort-only aggregate and a select-list
  alias. Every combination of {bare-aggregate alias, computed-aggregate alias,
  grouping-key alias, positional reference} × {grouped, ungrouped}, plus the
  `distinct`, `limit`, `having`, derived-table and scalar-subquery spellings listed
  under *What is wrong*. Expectations are SQLite's rows.
- Add ordering coverage with more than one group whose sort-only aggregate maxima are
  anti-correlated with both group name and group size, ascending and descending, plus
  a case where the sort-only aggregate ties and the computed alias breaks the tie —
  a single-group or already-sorted fixture passes by coincidence.
- Rewrite the stale comment at
  `test/logic/28.2-orderby-expression-extras.sqllogic:222-226`; leave its two
  expectations alone.

**Phase 3 — docs and validation**

- Update the `redirectPostAggregate` bullet in `docs/runtime.md` (~line 469).
- `yarn lint` (catches the dead locals), `yarn build`, then
  `yarn workspace @quereus/quereus run test`. Baseline before this ticket:
  10174 passing, 25 pending, 0 failing.
- Run the new coverage under `QUEREUS_CONTEXT_STRICT=1` as well
  (`yarn workspace @quereus/quereus run test:context-strict`), since the surviving
  placement resolves the sort-only aggregate through a source-row context and that
  harness is what catches a stale one.
