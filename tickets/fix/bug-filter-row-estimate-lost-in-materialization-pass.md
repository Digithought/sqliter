description: The query planner works out how many rows a WHERE clause will keep, but a late planning step that decides which intermediate results to keep in memory can throw that number away again — so some queries are still planned on a crude 50% guess.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts
difficulty: medium
repro: verified
----

## What goes wrong

A `FilterNode` carries an optional `selectivity` — the fraction of its source's rows the
`where` clause is expected to keep. `FilterNode.withChildren` drops that number whenever the
predicate it is rebuilt with is a different object than the one it had. Any planner step that
rewrites something *inside* a predicate therefore erases the estimate, and every later consumer
falls back to the flat `DEFAULT_FILTER_SELECTIVITY` (0.5).

`bug-filter-row-estimate-lost-when-predicate-rewritten` fixed this for the PostOptimization
pass by registering `rule-filter-selectivity` a second time there (`filter-selectivity-restamp`)
to re-derive the number after those rewrites. That registration is the **last** re-stamp point
in the pipeline — but it is not the last step that re-mints predicates. The **Materialization**
pass (`PassId.Materialization`, order 35) runs afterwards, and it rebuilds any path on which it
marks a `with` clause for shared materialization or wraps a node in a cache. When that path runs
through a Filter's predicate, the stamp is erased again with nothing left to restore it.

## Repro (verified)

Against the fixture already in `test/optimizer/filter-selectivity.spec.ts` (`o` = 100 rows,
`ANALYZE`d, `o.qty` has 3 distinct values):

```sql
-- stamped: the residual Filter carries selectivity 1/3
with c as (select cat, qty from o)
select * from o where o.qty = (select max(qty) from c) and o.cat = 'a';

-- NOT stamped: identical plan shape, only the hint differs
with c as materialized (select cat, qty from o)
select * from o where o.qty = (select max(qty) from c) and o.cat = 'a';
```

The second query's upper Filter reaches emission with `selectivity === undefined`. The hint is
not required — referencing the same `with` clause twice, where at least one reference is inside
a scalar subquery in the `where`, reproduces it as well:

```sql
with c as (select cat, qty from o)
select * from o
where o.qty = (select max(qty) from c) and o.rid = (select min(qty) from c) and o.cat = 'a';
```

Isolation already done: disabling `cte-optimization` and `scalar-subquery-cache` (the two
PostOptimization rules that inject caches) changes nothing, so the re-mint is not happening in
PostOptimization — it is the Materialization pass. A `MATERIALIZED` CTE read from the *outer*
`from` rather than from inside the predicate keeps its stamp (covered today by the "reads a base
column through every CTE spelling" case), because there only the Filter's *source* is rebuilt and
`withChildren` preserves the stamp across a source change.

## Why it matters

The affected Filters plan on 0.5 instead of their real fraction. On the repro above that is a
~3× cardinality error at that node, which propagates into every cost decision made above it
(join side selection, cache thresholds, limit pushdown).

## Expected behaviour

A Filter that had a derivable row estimate must still carry it when the plan reaches emission,
regardless of which pass last rewrote something inside its predicate. Equivalently: the estimate
must be either preserved across, or re-derived after, *every* predicate-re-minting step — not
only the ones known when the re-stamp was added.

## Design constraints for whoever picks this up

- `PassId.Materialization` is a **custom-execute** pass (`createMaterializationPass` in
  `framework/pass.ts` — `rules: []`, one `execute` that runs `MaterializationAdvisory`). A third
  entry in `RULE_MANIFEST` cannot target it; it has no rule slots.
- The pass after it is `PassId.Validation` (order 40). Registering a plan-*mutating* rule in a
  pass named and documented as validation is a design smell worth rejecting rather than
  reaching for by default.
- Three shapes of fix were visible from the review; pick deliberately rather than by
  convenience:
  1. a dedicated final re-stamp point behind Materialization (new pass, or a re-stamp step
     appended inside the materialization pass's own `execute`);
  2. teach the advisory's rebuild to carry a Filter's stamp across its own re-mints — it only
     ever wraps/marks nodes, never changes predicate semantics, so carrying is sound *there*
     specifically;
  3. make `FilterNode.withChildren` preserve the stamp when the predicate is only cosmetically
     re-minted. The prior ticket rejected this and its reasoning is worth reading before
     re-opening it: `fingerprintExpression` deliberately returns a unique value for
     subquery-bearing nodes, and a "skeleton equality" test would have to assume no estimator
     ever reads inside a subquery, which is not obviously true for a correlated one.
- Whatever lands, it should close the general hole rather than the CTE instance of it: the same
  loss recurs for any future pass that rewrites inside a predicate. A guard that makes the
  omission loud (e.g. an assertion in the Validation pass that a Filter which *could* be
  estimated is not silently unstamped) is worth considering alongside the fix.

## Test expectations

- The two repro queries above stamp their upper Filter at `1 / ndv['o.qty']`, matching the
  no-hint spelling exactly — two spellings of one query must not disagree.
- The existing "reads a base column through every CTE spelling" and
  "re-stamps a filter-over-join whose predicate was re-minted by scalar-subquery-cache" cases
  keep passing unchanged.
- A negative control that pins the new behaviour to the new mechanism, in the style of the
  existing `filter-selectivity-restamp`-disabled test.
