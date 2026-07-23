----
description: The optimizer property-test suite warns that five of its eight rules never fire on the queries it generates, so its enabled-vs-disabled equivalence check proves nothing for those rules. Reshape the generated queries so each rule actually rewrites the plan.
files: packages/quereus/test/property-planner.spec.ts, packages/quereus/src/planner/optimizer.ts
difficulty: medium
----

`test/property-planner.spec.ts` fuzzes queries and asserts that disabling an optimizer
rule leaves the result set unchanged. It counts a rule as "fired" when the enabled and
disabled plans differ, and warns when a rule never fires across all 30 runs:

```
[property-planner] Rule 'predicate-pushdown' never fired across 30 runs
[property-planner] Rule 'projection-pruning' never fired across 30 runs
[property-planner] Rule 'join-key-inference' never fired across 30 runs
[property-planner] Rule 'join-greedy-commute' never fired across 30 runs
[property-planner] Rule 'subquery-decorrelation' never fired across 30 runs
```

The test still passes — equivalence holds vacuously when the plans are identical either
way — so for these five rules the suite provides no coverage. Three rules do fire and are
genuinely exercised: `filter-merge`, `distinct-elimination`, `scalar-cse`.

Root causes are in the query generators, not the engine (rule ids were verified against
the registry in `src/planner/optimizer.ts` — disabling is not a silent no-op):

- **`subquery-decorrelation`** — the generator emits `x IN (SELECT y FROM t2)`, which is
  *uncorrelated*; the rule targets correlated EXISTS/IN. It can never fire on this shape.
  Generate a correlated predicate (e.g. `WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.c = t1.c)`).
- **`projection-pruning`** — queries are `SELECT *`; there is nothing to prune. Select a
  strict subset of columns over a source that produces extra ones (e.g. a subquery or
  join whose columns are partially consumed).
- **`join-key-inference` / `join-greedy-commute`** — two tiny random tables joined on
  `t1.id = t2.<col>` give no derivable-key structure or cost asymmetry to act on. Give the
  join sides asymmetric row counts and join on declared-unique columns.
- **`predicate-pushdown`** — the Filter sits directly above a memory-vtab scan with
  nothing to commute past. Interpose a commuting node (Sort/Distinct/eligible Project or
  a subquery) between the filter and the scan so pushdown visibly moves the predicate.

Acceptance: the warning no longer prints for any covered rule (each fires at least once
per 30-run property), and the equivalence assertions still pass. Consider promoting the
warning to a failure once all covered rules fire, so future generator drift cannot make
the suite vacuous again silently.

These rules are not untested overall — dedicated logic/plan tests exist (e.g.
`test/logic/07.7-scalar-agg-decorrelation.sqllogic`, the `test/plan/` goldens) — the gap
is only the fuzz suite's disabled-rule equivalence property.
