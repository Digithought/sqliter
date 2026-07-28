---
description: When a query checks that a value appears in another table's key column and a declared foreign key already guarantees every value is there, the planner can skip the lookup entirely — but that shortcut currently never triggers for the plain "value IN (SELECT key FROM parent)" way of writing it.
files:
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/util/ind-utils.ts        # isRowPreservingPathToTable, tableSchemaOf
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts  # why the right side is a Project
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts  # the tolerant FK test to tighten when this lands
difficulty: medium
---

# FK-driven semi-join fold declines on the Project the uncorrelated IN arm produces

## Current behavior

`rule-semi-join-fk-trivial` folds `SemiJoin(L, R)` down to `L` (or
`Filter(L, fk IS NOT NULL)`) when L's join columns form a declared foreign key
referencing R's primary key — the R side then never executes.

The uncorrelated-IN decorrelation arm (`extractUncorrelatedIn`) deliberately
uses the subquery tree **verbatim** as the join's right side, so R is always a
`ProjectNode` (the subquery's SELECT list) over the parent table. Two of the
fold's gates reject that shape:

- `isRowPreservingPathToTable` accepts only `TableReference` / `Retrieve` /
  `Alias` / `Sort` wrappers — a `Project` returns false.
- `tableSchemaOf` likewise does not see through a `Project`.

So `SELECT * FROM emp WHERE dept_id IN (SELECT id FROM dept)` (with a declared
`dept_id NOT NULL REFERENCES dept(id)`) plans as a hash semi join that scans
`dept`, instead of folding to a bare scan of `emp`. The answer is correct; only
the plan improvement is lost.

The correlated EXISTS / IN arms are unaffected: their extraction descends
*through* Project wrappers and hands the node underneath to the join, so
FK folds fire there today.

## Expected behavior

A **bare-column** Project (every projection a plain `ColumnReferenceNode`)
preserves row count and multiplicity, so the fold is sound through it. Extend
the two helpers (or add a peel in the rule) to look through such Projects.

Care point: the equi-pairs are extracted against the Project's *output*
attributes. When peeling, the parent-side pair columns must still map to the
base table's column indices for `lookupCoveringFK` — a projection that renames
or reorders columns must keep that mapping intact, and a *computed* projection
must still decline.

`rule-anti-join-fk-empty` shares the same helpers; check whether any reachable
anti-join shape carries a Project right side (today's anti joins come from the
NOT EXISTS descent arm, which strips the Project, so this may be semi-only in
practice).

## Validation

- Plan test: the FK-backed case in `test/plan/subquery-decorrelation.spec.ts`
  ("answers correctly whether or not the FK fold fires") was written tolerant of
  either outcome; tighten it to assert the fold (no join, no scan of the parent
  table) once this lands.
- Answers must be unchanged across: nullable FK column (fold becomes the
  `IS NOT NULL` filter), NOT NULL FK (fold to bare L), and a subquery with an
  inner WHERE (must NOT fold — rows were filtered).
