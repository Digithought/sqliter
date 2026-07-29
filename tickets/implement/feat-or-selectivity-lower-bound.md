----
description: When a query's WHERE clause ORs together one condition the planner understands and one it does not, the planner throws away what it knew and falls back to a fixed guess that is lower than a number it could have proved.
files: packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/stats/index.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts
difficulty: medium
----

## What happens today

The planner guesses what fraction of a table's rows a `where` clause will keep. It
does this by looking at each condition separately and combining the answers.

For `or`, it only combines when it can estimate *every* branch. If any branch is a
shape it cannot read — a function call like `lower(name) = 'x'`, for example — it
gives up on the whole `or` and hands the clause to a fallback that answers a flat
0.1 (keep 10% of rows) for any comparison.

Giving up throws away information that was already in hand. `a or b` always keeps at
least as many rows as `a` alone, so any branch the planner *could* estimate is a
guaranteed floor for the whole `or`. On the table used in
`test/optimizer/filter-selectivity.spec.ts`, column `a` has 4 distinct values, so:

```sql
select * from m where a = 1 or lower(s) = 'x1'
```

is provably going to keep at least 25% of the rows — but the planner stamps 10%. It
is not merely imprecise, it contradicts something it already knew. The current test
`falls back to the naive estimate when any OR disjunct is unestimable` asserts this
behaviour, including the fact that the answer sits below the provable floor.

## Why it was left this way

The obvious repair — "just report the largest branch estimate you have" — is not
safe on its own. If the estimable branch is very selective (say 1 row in 1000) and
the unreadable branch actually matches everything, reporting 0.001 is off by a
factor of a thousand, which is worse than the flat 0.1. So the fix needs both
bounds: never report below what was proved, and never report a partial estimate as
if it were the whole answer.

## What to build

An `or` containing at least one estimable branch should end up with a number that is

- **never below** the largest estimate among the branches it could read, and
- **never below** the fallback guess it would otherwise have produced.

In other words: keep the fallback's caution, but lift it to respect the floor the
statistics already prove.

The awkward part is plumbing, not arithmetic. The floor is computed inside
`CatalogStatsProvider`, but the fallback number comes from `NaiveStatsProvider`,
which the catalog provider consults only *after* deciding it has nothing to say —
today a single `undefined` carries both "I could not answer" and "I partly could".
Those two cases need to be distinguishable at that boundary, whether by returning a
richer result internally or by having the provider apply the floor to the fallback
itself.

Note that `statsOnlySelectivity` must keep meaning "real statistics answered", since
`rule-filter-selectivity` uses it as its does-this-table-have-statistics gate for
filters over joins. A partly-known `or` should not start reading as fully known there
without that call site being reconsidered.

## Scope

Same-shaped question for `and` is already settled and should not change: an
unreadable `and` branch counts as 1.0 (claim no reduction), which is documented in
`docs/optimizer.md` under *Boolean decomposition*. Only the `or` side is open.

Update `docs/optimizer.md` when this lands — its `OR` bullet currently states the
give-up behaviour as intended.
