---
description: A query that groups rows can now sort or partition a window function by a grouping column's output name, and filter on it in HAVING — the same thing an aggregate's output name already allowed.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope + two new helpers; the whole source change
  - packages/quereus/test/logic/07.5-window.sqllogic             # window-spec coverage (replaces the old negative assertion)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # HAVING coverage
  - docs/sql-select.md                                           # § 3.3 GROUP BY and § 3.4 HAVING
repro: verified
---

# Review: a grouping key can be named by its select-list alias

## What was built

`createAggregateOutputScope` (packages/quereus/src/planner/building/select-aggregates.ts)
now also registers each grouping key under the select-list alias of the column that
selects it. That scope is what a grouped query's `HAVING` predicate and (for a grouped,
windowed query) its window specifications resolve against, so one registration fixes
both clauses at once. Before this, only an *aggregate* was registered under its alias —
hence the reported asymmetry.

Source change, in full:

- `buildAggregatePhase` passes its existing `projections` list into
  `createAggregateOutputScope`.
- New `collectAliasedGroupKeys(projections, groupKeys)` maps each aliased select-list
  column to the GROUP BY position it selects, using the existing `indexGroupKeys` index:
  by base attribute id for a column reference (covers `select wg.a as k … group by a`
  and the reverse), else by identity fingerprint (covers `select upper(a) as k … group
  by upper(a)`). A projection matching no key is skipped.
- `createAggregateOutputScope` registers each such alias against the key's own output
  attribute, so `assertGroupedWindowCoverage` accepts it with no redirection.

Everything else — `redirectToGroupKeys`, `assertGroupedWindowCoverage`,
`buildHavingFilter` — is untouched.

## Deviation from the ticket, and why (read this first)

The implement ticket's TODO asked for one thing this does **not** do. It said a
collision between a select-list alias and a same-named *grouping key* should be marked
ambiguous — its example was `select a as b, b … group by a, b`. Implemented that way it
regresses two queries that work at HEAD, which I verified by hand before choosing:

```sql
-- both of these work at HEAD (373732b3), scratch mocha spec, table wg(a,b)
select a as b, b, count(*) as c from wg group by a, b;      -- rows out today
select a as b, count(*) as c from wg group by a, b having b = 'x';   -- [] today
```

The first is the fatal one. A grouped query's select list is itself rebuilt against
this scope by `buildFinalAggregateProjections`, so an ambiguity minted here rejects the
bare `b` **in the select list** — and the same ticket insists elsewhere that a
select-list column must never be affected by a sibling's alias ("The select list is NOT
widened"). The two requirements cannot both hold.

Resolution taken: **a select-list alias is the lowest-precedence name in this scope.**
It is skipped whenever a grouping key's own name or an aggregate's alias already claims
it. So `having b = '1'` under `group by a, b` still filters on the grouping key `b`,
which is also what SQLite and PostgreSQL do (an alias never outranks a real column
outside a top-level `order by`). Ambiguity is still raised for the one collision nothing
can arbitrate: two aliases naming *different* grouping keys (`select a as k, b as k …
group by a, b`).

The decision and its revisit condition are recorded as a `NOTE:` in the
`createAggregateOutputScope` doc comment. **This is the thing to argue with if you are
going to argue with anything.**

## Use cases to exercise

All of these are asserted in the two sqllogic files; the table is
`wg(a text, b text)` holding `('x','1'),('y','2'),('x','3')`.

Should work now (07.5-window.sqllogic, replacing the old `-- error: Column not found: k`
assertion; 07.3-group-by-extras.sqllogic for the HAVING arm):

- alias in `over (order by …)` and in `over (partition by …)`
- alias defined *after* the window function that names it in the select list
- bare key (`group by a`), qualified key (`group by wg.a`), computed key (`group by
  upper(a)`, `group by a || '!'`)
- alias beside an aggregate alias, both resolving through the same scope
- identifier case immaterial in either direction (`as k` / `order by K`)
- alias reaching into a **subquery** inside the window specification, correlating back
  to the grouping key
- all of the same in `HAVING`, including inside a correlated subquery

Deliberate behavior, called out in comments at both sites so a later reader does not
read it as an accident:

- an alias **shadows** a same-named base-table column — `select a as b, … over (order by
  b) … group by a` numbers the groups by `a`, not by the table's `b`. Same rule an
  aggregate alias already had, and verified working there before this change.
- an alias **does not** outrank a grouping key of the same name (the precedence
  decision above). The two discriminating assertions are `partition by b` under
  `group by a, b` (three partitions of one, not two of 2 and 1) and `having b = '1'`
  (one row, not zero).

Must still fail:

- `select a as k, k as k2 from wg group by a` — a select-list column cannot name a
  sibling's alias (`Column not found: k`). Also asserted for the aggregate form,
  `select a, count(*) as c, c + 0 as d …`.
- `select a as k, b as k, … group by a, b` — ambiguous, in both a window spec and
  `HAVING`.

## Validation run

- `yarn test` from the repo root: 9396 + 386 + 147 + 80 + 69 + 80 + 1710 + 725 + 85 +
  31 + 34 + 134 + 22 passing, 0 failing.
- `yarn lint` from the repo root: clean.
- `tsc --noEmit` in packages/quereus: clean.
- The sqllogic suite alone (363 files) passes.

## Known gaps — treat the tests as a floor

- **A pre-existing defect is now easier to reach, and I filed it rather than fixing
  it.** `select wg.a as k, row_number() over (order by k) … group by a` — a
  *table-qualified* select-list reference to a grouping key the `group by` wrote bare —
  now gets past name resolution and dies at run time with "No row context found for
  column a". It is not caused by this change: the identical failure happens at HEAD with
  no aliases anywhere (`select wg.a, row_number() over (order by a) as rn from wg group
  by a`), which I confirmed by restoring the HEAD copy of the file and re-running. Filed
  as `backlog/bug-qualified-group-key-in-select-list-breaks-window-query`, including the
  open question that ticket really turns on (why the same unbound reference is harmless
  when there is no window function). Before this change the query failed earlier, with
  the clearer `Column not found: k` — so the *message* a user sees for that shape got
  worse even though the underlying defect is older.
- **Alias registration is by select-list position only.** A grouped query's alias is
  matched to a key by attribute id or by expression fingerprint, which is the same
  vocabulary `redirectToGroupKeys` uses and carries the same known limitation (it
  compares rendered text, not resolved identity). No new exposure, but no new safety
  either.
- **Not exercised:** grouped queries inside views / materialized views whose bodies use
  a grouping-key alias; compound (`union`) arms; `group by` with an ordinal that
  resolves to an aliased column. Nothing suggests these break — the scope is built the
  same way for all of them — but I did not write assertions.
- **Ambiguity coverage is one shape.** Only `two aliases → two different keys` is
  asserted. An alias colliding with a *qualified* group key name, or with an ambiguous
  bare name already produced by `group by i.id, c.id`, is handled by the same skip rule
  but has no test.
