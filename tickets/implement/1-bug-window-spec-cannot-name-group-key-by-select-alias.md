---
description: In a query that groups rows, a window function can sort by an aggregate's output name but not by a grouping column's output name, even though both are ordinary result columns — the second spelling fails with "column not found". Make the two consistent by accepting both.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope — the one site to change; buildAggregatePhase already has everything it needs
  - packages/quereus/src/planner/building/select.ts              # caller; shows that a window spec resolves through the aggregate output scope
  - packages/quereus/test/logic/07.5-window.sqllogic             # ~line 906 asserts the aggregate-alias case; add the grouping-key cases beside it
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # HAVING coverage
difficulty: medium
repro: verified
---

# A window specification can name an aggregate by its select-list alias, but not a grouping key

## What happens

Verified at HEAD (d8ee4d9) with a scratch mocha spec against
`create table wg (a text, b text)` holding `('x','1'),('x','2'),('y','3')`:

| query | today |
|---|---|
| `select a, count(*) as c, row_number() over (order by c) as rn from wg group by a` | works (asserted at 07.5-window.sqllogic:906) |
| `select a, count(*) as c from wg group by a having c > 1` | works |
| `select a as k, row_number() over (order by k) as rn from wg group by a` | `Column not found: k` |
| `select count(*) over (partition by k) as w, a as k from wg group by a` | `Column not found: k` |
| `select upper(a) as k, row_number() over (order by k) as rn from wg group by upper(a)` | `Column not found: k` |
| `select a as k, count(*) as c from wg group by a having k = 'x'` | `Column not found: k` |
| `select a as k, count(*) as c from wg group by a order by k` | works (statement-level `ORDER BY` has its own scope) |

So the alias of an *aggregate* result column is visible inside `over (…)` and
inside `HAVING`; the alias of a *grouping key* column is visible in neither, even
though both are ordinary output columns of the same query.

## Root cause

One function: `createAggregateOutputScope` in
`packages/quereus/src/planner/building/select-aggregates.ts` (~line 673). It builds the
scope that a grouped query's window specifications resolve against (via
`selectContext.scope`, set in `select.ts` from `aggregateResult.aggregateScope`), and
that `buildHavingFilter` copies symbols from.

It registers:

- each **grouping key** under the key's own column name, plus its qualified name
  when the key was written qualified — never under the select-list alias;
- each **aggregate** under its select-list alias.

Hence the asymmetry. Nothing else is wrong: `redirectToGroupKeys` /
`assertGroupedWindowCoverage` already handle every *expression*-shaped spelling of a
grouping key inside a window spec; this is purely a missing name.

## Direction chosen: register the alias

The fix ticket left the direction open — strict SQL (and PostgreSQL) allows a
select-list alias only in the statement's top-level `ORDER BY`, so under that reading
the aggregate case is the outlier and should have been rejected too. Resolve toward
**SQLite-style permissiveness** (register the grouping key under its select-list alias
as well), because:

- the permissive aggregate behavior already ships and is asserted by a test at
  07.5-window.sqllogic:906 — removing it is a behavior break for a working query;
- everything passing today keeps passing; this only adds resolutions;
- the engine tracks SQLite elsewhere on alias visibility (statement-level `ORDER BY`
  over a grouped query already resolves aliases).

### Shadowing is not a new question

Registering an alias means an alias can shadow a same-named base-table column. That is
already how aggregate aliases behave and it is verified working, not theoretical:

```sql
-- `b` is a real column of wg; the aggregate alias wins, in both clauses
select a, count(*) as b from wg group by a having b > 1;                              -- => [{"a":"x","b":2}]
select a, count(*) as b, row_number() over (order by b) as rn from wg group by a;     -- => rn 1,2
```

The corresponding grouping-key spellings are today *errors*, and after the fix they
become the same shadowing behavior:

```sql
select a as b, row_number() over (order by b) as rn from wg group by a;
-- today: Column 'b' must appear in the GROUP BY clause or be used in an aggregate function
-- after: rn over the group key `a`

select a as b, count(*) as c from wg group by a having b = 'x';
-- today: HAVING references non-grouped column 'b'
-- after: filters on the group key `a`
```

That is the intended consequence of the chosen direction — call it out in the
sqllogic comments so the next reader does not read it as an accident.

### The select list is NOT widened

A select-list column cannot see a sibling's alias today and must not start to:

```sql
select a, count(*) as c, c + 0 as d from wg group by a;   -- Column not found: c  (aggregate alias — unchanged)
select a as k, k as k2 from wg group by a;                -- Column not found: k  (must stay an error)
```

This holds for free: the select list is first built against the **pre-aggregate** scope
in `analyzeSelectColumns`, before `createAggregateOutputScope` exists, so a sibling alias
never resolves there. Assert it so a later refactor cannot quietly change it.

## Implementation sketch

`buildAggregatePhase` already receives `projections: Projection[]` — the non-aggregate
select-list columns in written order, stars expanded, each carrying its `alias`. Pass
them into `createAggregateOutputScope` and, for each projection that has an alias:

- find which grouping key it *is*, reusing the existing `indexGroupKeys` index:
  `byBaseAttrId` for a bare/qualified column reference (covers `select wg.a as k …
  group by a` and the reverse), `byFingerprint` on the projection's expression for a
  computed key (covers `select upper(a) as k … group by upper(a)`);
- skip it when it matches no grouping key — an ungrouped select column is already
  rejected upstream by `validateAggregateProjections`;
- otherwise fold the alias into the existing `bareNameOwners` / `isBareAmbiguous`
  machinery **using the target key's own owner identity** (what `groupIdentity` returns
  for that key's index), not a fresh identity. This matters: star-expanded and plain
  `select a … group by a` projections carry alias `a`, which already names that same
  key — giving them a distinct owner would mark `a` ambiguous and break queries that
  work today. A genuine collision (`select a as b, b … group by a, b`) still lands two
  distinct owners and stays ambiguous, which is right.

Register with the same `makeRef` used for the key's own names, so the alias resolves to
the AggregateNode's group output attribute. Once it does, `assertGroupedWindowCoverage`
passes it without any redirection — the attribute id is in `outputAttrIds`.

## Expected behavior after the fix

- A grouping key's select-list alias resolves inside `over (order by …)` and
  `over (partition by …)`, for bare, qualified, and computed grouping keys.
- The same alias resolves inside `HAVING`.
- The alias shadows a same-named base-table column, matching aggregate-alias behavior.
- A select-list column still cannot name a sibling column's alias.
- Everything asserted in `07.5-window.sqllogic` today still passes unchanged.

## TODO

- Thread the select-list projections into `createAggregateOutputScope` and register each
  grouping key under its select-list alias, per the sketch above.
- Update the doc comment on `createAggregateOutputScope` to state that a grouped query's
  output *names* — group keys under their own/qualified/aliased names, aggregates under
  their aliases — are what this scope publishes, and that aliases shadow base columns.
- Add sqllogic coverage in `07.5-window.sqllogic`, beside the existing aggregate-alias
  assertion (~line 906): grouping-key alias in `order by` and in `partition by`; bare,
  qualified, and computed (`upper(a)`) keys; the alias-shadows-a-base-column case with a
  comment saying it is deliberate.
- Add `HAVING`-side coverage in `07.3-group-by-extras.sqllogic` for the grouping-key alias.
- Add a negative assertion that a select-list column still cannot reference a sibling
  alias (`select a as k, k as k2 … group by a` stays an error).
- Check the ambiguity path: `select a as b, count(*) as c from wg group by a, b` — the
  alias `b` and the grouping key `b` are different columns, so a bare `b` in a window
  spec or `HAVING` must report ambiguity, not silently pick one.
- Run `yarn test` and `yarn lint` from the repo root.
