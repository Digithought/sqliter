---
description: The planner used to guess how many rows survive a WHERE or HAVING clause by consulting statistics that described a different set of rows — sometimes even a different column. It now declines to guess in those cases and falls back to its neutral default.
files:
  - packages/quereus/src/planner/util/row-population.ts               # NEW — shared predicate
  - packages/quereus/src/planner/util/key-utils.ts                     # extractRowSourceTableSchema + shared recursion
  - packages/quereus/src/planner/util/column-origins.ts                # now imports the shared isRowMerging
  - packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts
  - packages/quereus/test/optimizer/filter-selectivity.spec.ts         # new describe block, 6 tests
  - docs/optimizer.md                                                  # new paragraph before "Boolean decomposition"
difficulty: medium
---

# Row-population-changing sources no longer feed the single-table estimate

## What was wrong

`rule-filter-selectivity` asked `extractTableSchema` "which base table is under this
filter?" and, on getting an answer, handed the whole predicate to the statistics
provider as if it were a plain single-table filter. That walk descends through *any*
operator with exactly one relational child — including an aggregate and a recursive
CTE, whose output rows are not their source's rows.

Two shapes were mis-estimated (both were mis-estimates only — the returned rows were
always correct):

**Aggregate.** The provider resolves a column reference by its AST **name**
(`catalog-stats.ts` `extractColumnFromPredicate`), so the answer depended on whether
the aggregate's alias happened to collide with a base-table column name:

```sql
select cat, count(*) as qty from o group by cat having qty > 2   -- selectivity 0.75
select cat, count(*) as ct  from o group by cat having ct  > 2   -- selectivity 0.10
```

Same query, two answers. The 0.75 is the fraction of `o`'s *rows* with `o.qty > 2`;
the 0.10 is the naive flat guess for a `BinaryOp`.

**Recursive CTE.** `RecursiveCTENode.getRelations()` returns only the base case, so
the walk descended the seed and reported the seed table. A filter over the CTE was
stamped `1/ndv(seed.column)`, describing neither the CTE's row count nor its value
distribution.

## What changed

- **New `planner/util/row-population.ts`** — `isRowMerging` (set operation, recursive
  CTE), `isRowRegrouping` (Aggregate / StreamAggregate / HashAggregate), and
  `changesRowPopulation` (either). Decided by `nodeType` against the `PlanNodeType`
  enum, not `instanceof`, so `key-utils.ts` can import it without a cycle.
- **`column-origins.ts`** now imports that `isRowMerging` instead of keeping a private
  `instanceof`-based copy. Behaviour is identical; the two files can no longer drift.
- **`key-utils.ts`** gained `extractRowSourceTableSchema`. Both it and the unchanged
  `extractTableSchema` run over one private `walkToTableSchema(node, strict)`; strict
  declines at `changesRowPopulation` *before* the single-relation descent. The
  permissive walk's behaviour is byte-for-byte unchanged — FK/key analysis
  (`rule-join-elimination`, `rule-fanout-lookup-join`, `rule-join-key-inference`)
  still uses it.
- **`rule-filter-selectivity.ts`** calls the strict variant. When it declines, control
  falls to `multiRelationSelectivity`, which finds no base-table origin for the
  aggregate output (or an empty origin map for the recursive CTE) and returns
  `undefined` — the Filter keeps `DEFAULT_FILTER_SELECTIVITY` (0.5).
- **`docs/optimizer.md`** — new paragraph before "Boolean decomposition" explaining the
  strict/permissive split and why `Distinct`/`LimitOffset` are excluded.

## How to exercise it

The new tests live in `test/optimizer/filter-selectivity.spec.ts`, describe block
**"single-table selectivity declines when the source changes the row population"**.
Fixture: table `o` with 100 rows, `cat` 4 distinct values, `qty` 7 distinct values
(0..6), ANALYZEd. `qty` deliberately shares its name with the `count(*)` alias.

Run it:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/optimizer/filter-selectivity.spec.ts" --colors
```

Cases covered:

- **recursive CTE** — every FilterNode in the plan for
  `with recursive c(qty) as (select qty from o union all select qty+1 from c where qty < 50) select * from c where qty = 3`
  is unstamped, and specifically not `1/ndv(o.qty)`.
- **aliased aggregate pair** — `having qty > 2` and `having ct > 2` over the same
  `count(*)` are both unstamped and equal to each other. This is the assertion that
  pins the fix: the answer no longer depends on the alias spelling.
- **control, group key** — `having cat = 'a'` is pushed below the aggregate by
  `rule-aggregate-predicate-pushdown` and is still stamped `1/ndv(o.cat)`.
- **control, row-preserving wrappers** — filters over `Project` / `Sort` /
  `LimitOffset` / `Distinct` over `o` are all still stamped `1/ndv(o.cat)`.
- **the two walks, directly** — on the real optimized plans, `extractTableSchema`
  still resolves to `o` through both a HashAggregate and a RecursiveCTE node, while
  `extractRowSourceTableSchema` returns `undefined` for both.

Manual check for a reviewer: pick any query where a `where` sits over a base table
through a projection or a limit, confirm `FilterNode.selectivity` is still a
statistics-derived number rather than `undefined`. Regression here would be silent
(plans get worse, results stay right), which is why the four control shapes are in
the suite.

## Validation run

- `yarn build` — clean.
- `yarn test` (repo root, all workspaces) — **0 failing**. `packages/quereus` alone:
  8116 passing. No churn in `test/logic/108-cardinality-estimation.sqllogic` and no
  `test/plan/` snapshot diffs, so nothing that was previously stamped moved to 0.5.
- `yarn lint` — clean (includes the `tsconfig.test.json --noEmit` pass over specs).
- `yarn typecheck` — clean.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

## Known gaps — treat the tests as a floor

- **`Window` is not classified.** `WindowNode` emits one row per input row, so it is
  correctly *not* in `changesRowPopulation` — but that was reasoned about, not tested.
  A filter over a window function's output has a fresh attribute id and would fall to
  the multi-relation path anyway; a filter over a *passthrough* column of a Window
  still (correctly) reaches the base table. Untested either way.
- **`Materialize`, `Cache`, `EagerPrefetch`, `AsyncGather`, `Sequencing`, `Sink`** are
  likewise pass-through by construction and left out of `changesRowPopulation`
  without a test. If any of them ever gains row-reshaping behaviour, this file is the
  place that has to learn about it.
- **The `Aggregate` (logical) nodeType is included but not exercised.** The tests only
  ever see `HashAggregate` after physical selection; the logical `Aggregate` entry is
  there for the Structural-pass registration path and is untested.
- **No test asserts the *estimatedRows* consequence**, only `selectivity === undefined`.
  A reviewer wanting belt-and-braces could assert the aggregate filter's
  `physical.estimatedRows` equals `floor(sourceRows * 0.5)`.
- **`Distinct` is a deliberate omission**, recorded as a `NOTE:` tripwire in
  `row-population.ts` — see Review findings below.

## Investigation the ticket asked for — already tracked, no new ticket filed

The ticket asked whether `rule-join-elimination.tryEliminate` and
`rule-fanout-lookup-join.recognizeBranch` can pass a join side's **output** column
indices to `checkFkPkAlignment` against a `TableSchema` that `extractTableSchema`
walked down to, and whether a spurious FK→PK "alignment" could eliminate a join it
must not.

**It is reachable, and it produces wrong rows — not just bad estimates.** Verified by
running the queries against the built engine and comparing with the
`join-elimination` rule disabled:

```sql
create table p (k integer primary key, v integer) using memory;
create table t (id integer primary key, pid integer not null references p(k), other integer) using memory;
insert into p values (5, 5), (7, 5), (9, 9);
insert into t values (10, 5, 100), (11, 9, 200);

select t.id from t left join (select v as k2, k from p) q on t.pid = q.k2;
-- actual [10, 11] / correct [10, 10, 11]

select t.id from t left join (select v as k2, k from p group by v, k) q on t.pid = q.k2;
-- actual [10, 11] / correct [10, 10, 11]
```

The INNER variant of the same query is correct, because `isRowPreservingPathToTable`
rejects the projection. The LEFT path has no such guard.

**Crucially, the aggregate is not required** — the plain reordering projection fails
identically. So this is not an aggregate/recursive-CTE hazard at all; it is raw
output-index-versus-table-column-index confusion, and it is **already fully tracked**
by `bug-fk-alignment-derived-table-indices`, currently sitting in `tickets/implement/`
with verified repros, a verified patch, and a test plan. Its planned fix
(`resolveTableColumnMapping` + `mapColumnsToTable`) also covers the aggregate variant
above: an aggregate forwards group-key attribute ids, so those translate correctly,
and a `count(*)` output carries a fresh id that maps to nothing and makes the rule
decline. No new ticket was filed and that ticket was **not** edited (it is in-flight);
the aggregate-in-the-middle repro above is recorded here so its implementer can pick
it up as an extra test case if they want one.

`rule-join-key-inference` is the third caller with the same untranslated comparison,
but it only emits a `log(...)` and always returns `null` — no correctness impact. That
too is already noted in `bug-fk-alignment-derived-table-indices`.

## Review findings

- **`Distinct` deliberately excluded from `changesRowPopulation`** — a `distinct`'s
  output rows are a *subset* of the base table's rows, not a different population, so
  the base-table row fraction stays a defensible approximation. Parked as a `NOTE:`
  tripwire at the top of `packages/quereus/src/planner/util/row-population.ts`: if a
  filter over a `distinct` ever shows a bad estimate, a heavily-skewed column is the
  reason, and `Distinct` should join `isRowRegrouping`. `LimitOffset`, `OrdinalSlice`
  and the physical access nodes are excluded on the same reasoning, named in the same
  comment.
- **`collectColumnOrigins` still walks through an aggregate on purpose** — it forwards
  group-key attribute ids to their base-table columns, which the multi-relation path
  documents as imprecise but intentional. That was left alone; it is a modelling
  choice, not drift. The genuine drift the original ticket flagged (one path stopping
  at a recursive CTE while the other walked through it) is what the shared
  `row-population.ts` closes.
