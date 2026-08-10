description: |
  `expr IS [NOT] TRUE/FALSE` boolean-test predicates currently evaluate as residual
  filters only — they are never extracted as pushable constraints, never drive an index
  seek, and have no dedicated selectivity estimate. Results are correct (the residual
  filter runs over a full/looser scan); this is purely a missed optimization. The same
  gap pre-exists for `NOT col` and other non-(`IS NULL`/`IS NOT NULL`) unary shapes, so
  the new operators are merely consistent with the status quo, not a regression.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # extractNullConstraint gate (~L242) only matches IS NULL/IS NOT NULL → others fall to residual
  - packages/quereus/src/vtab/best-access-plan.ts                   # ConstraintOp closed union (~L13) excludes the boolean-test ops
  - packages/quereus/src/planner/stats/catalog-stats.ts             # selectivity estimation special-cases IS [NOT] NULL
  - packages/quereus/src/vtab/memory/module.ts                      # memory access-plan consumer of pushed constraints
  - packages/quereus/test/logic/03.9-is-bool-predicate.sqllogic     # existing correctness coverage (partial-index smoke asserts results, not index usage)
  - packages/quereus/test/plan/                                     # where a plan-shape assertion (index/constraint selected) would live
----

## Background

The `is-bool-predicate-support` feature added `expr IS [NOT] TRUE/FALSE` as total
postfix unary predicates (parse → type → evaluate → round-trip → partial-index
`compileUnary`). They are correct end-to-end. What they do **not** yet do:

- **Constraint extraction.** `constraint-extractor.ts` only recognizes `IS NULL` /
  `IS NOT NULL` unary ops as `PredicateConstraint`s (`extractNullConstraint`); the four
  boolean-test ops fall through to the residual predicate, so a vtab/index never sees
  them as a seekable constraint.
- **`ConstraintOp` vocabulary.** The closed union in `best-access-plan.ts` has no member
  for the boolean tests, so even if extraction were added there is no op to carry them to
  `xBestIndex`/`getBestAccessPlan`.
- **Selectivity.** `catalog-stats.ts` has no estimate for these predicates; they fall to a
  generic default.

## Why this is backlog, not a bug

Correctness holds in every path — the residual filter is always applied. The partial-index
smoke test in `03.9-is-bool-predicate.sqllogic` asserts result correctness but explicitly
does **not** assert the partial index is consulted (a full scan satisfies it too). This
ticket would close that loop.

## Scope (if picked up)

- Decide a representation: either add `IS TRUE` / `IS NOT TRUE` / `IS FALSE` / `IS NOT FALSE`
  to `ConstraintOp` and teach the memory module's access planner + partial-index matcher to
  use them, or lower them to an equivalent already-pushable shape where sound (note `x IS
  TRUE` is **not** `x = true` on NULL rows — the totality must be preserved).
- Extend `extractNullConstraint` (or a sibling) to emit the new constraints.
- Add a selectivity estimate.
- Add a **plan-shape** test (under `test/plan/`) asserting the partial index / constraint is
  actually selected — the missing assertion called out in the review.

Consider folding this in with any broader "boolean-test predicate" optimization work and
with `existence-probe-richer-forms`, which builds on the same parse/type surface.
