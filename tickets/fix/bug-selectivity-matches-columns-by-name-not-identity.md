---
description: When guessing how many rows a WHERE clause keeps, the planner matches the column being filtered to table statistics by name alone. A computed column that happens to reuse a real column's name gets that real column's statistics, so renaming it silently changes the guess.
files:
  - packages/quereus/src/planner/stats/catalog-stats.ts                # extractColumnFromPredicate / estimateSimple — name-based lookup
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts  # singleTableSelectivity — the caller that hands over the whole predicate
  - packages/quereus/src/planner/util/key-utils.ts                     # extractRowSourceTableSchema — picks the table the names are resolved against
  - packages/quereus/src/planner/util/column-origins.ts                # collectColumnOrigins — the identity-based mapping the fix should reuse
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts         # where a regression test belongs
difficulty: medium
---

# Row-count guesses resolve a filtered column by name, not by identity

## What happens

The planner estimates what fraction of rows a `where` clause keeps by looking up the
filtered column in the table's collected statistics. The lookup is done by **column
name**, taken off the predicate's syntax tree
(`extractColumnFromPredicate` → `stats.columnStats.get(name.toLowerCase())` in
`planner/stats/catalog-stats.ts`). Nothing checks that the column bearing that name is
in fact the base table's column.

A subquery that computes a new column and aliases it to a name the base table already
uses therefore borrows that base column's statistics.

## Verified repro

Table `o(id integer primary key, cat text, qty integer)`, 100 rows, `qty` holding
7 distinct values, `ANALYZE`d. `1/7 ≈ 0.142857`.

```sql
-- computed column aliased to a name `o` already has:
select * from (select cat, id * 7 as qty from o) x where x.qty = 3;
--   FilterNode.selectivity = 0.14285714285714285   (= 1/ndv(o.qty))

-- identical query, alias renamed:
select * from (select cat, id * 7 as zz from o) x where x.zz = 3;
--   FilterNode.selectivity = 0.1                   (the flat fallback guess)
```

`id * 7` over 100 rows has 100 distinct values, not 7, and its value distribution has
nothing to do with `o.qty`'s. The same happens with a window function's output:

```sql
select * from (select cat, row_number() over (order by id) as qty from o) x where x.qty = 3;
--   0.14285714285714285   -- rn is 1..100; still charged o.qty's histogram
```

Only the estimate is wrong — the returned rows are always correct. The visible symptom
is that **renaming a column alias changes the planner's row estimate**, and therefore
can change which plan the optimizer picks.

## Why the recent row-population work does not cover this

`bug-single-table-selectivity-credited-to-wrong-relation` (landed) stopped the walk that
picks *which table* the predicate is resolved against from descending through operators
that change the row population — aggregates, recursive CTEs, set operations. That closed
the same-looking symptom for `having count(*) as qty > 2`.

A plain `Project` (and a `Window`) is a different case: it genuinely preserves the row
population, so the walk passes through it on purpose, and it should. The remaining defect
is one level down — the *column* the predicate names is not the base table's column even
though the *table* is right. Excluding `Project` from the walk is not the fix; it would
throw away every legitimate estimate for a filter over a subquery, which is the common
shape.

## What correct behaviour looks like

The estimator should identify the filtered column by **attribute identity** rather than
by name:

- a predicate column that traces back to a base-table column gets that column's
  statistics;
- a predicate column minted above the base table (a computed projection, a window
  function's output, an aggregate's output) has no statistics and the estimate should
  decline, leaving the neutral default rather than a borrowed number.

`collectColumnOrigins` (`planner/util/column-origins.ts`) already builds exactly this
attribute-id → base-table-column map and is already used by the same rule's
multi-relation path. The single-table path is the one that still goes by name.

Note that `CatalogStatsProvider` receives a `TableSchema` and a predicate, with no plan
context, so wiring identity through likely means either passing an attribute-id→column
mapping alongside the table, or having `rule-filter-selectivity` pre-check the
predicate's column references against `collectColumnOrigins` before delegating. Which of
those fits the provider interface is part of this ticket's research.

## Scope notes

- `select cat as qty from o` (a straight rename of a real column) currently returns the
  flat fallback rather than `o.cat`'s statistics — under-informed, not mis-attributed.
  Whether an identity-based lookup should also recover that case is worth deciding here,
  since the same mapping makes it available.
- The multi-relation path (`estimateConjunct` → `singleRelationConjunct`) resolves the
  *relation* by attribute identity but then hands the conjunct to the same name-based
  provider, so it inherits the same column-level confusion once the relation is right.
  Check it as part of the same fix.
- Expect plan-snapshot churn: filters over computed columns that currently receive a
  borrowed number will move to the default, and possibly the reverse for renamed real
  columns. `test/plan/` and `test/logic/108-cardinality-estimation.sqllogic` are the
  places to look.
