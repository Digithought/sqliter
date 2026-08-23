description: A query that compares a column to a constant subquery, such as `where v = (select 1)`, used to crash at plan time instead of running; the planner now treats such a value as dynamic and runs the query as a normal filter.
files:
  - packages/quereus/src/planner/analysis/predicate-shape.ts                       # new: planTimeLiteralValue(node) — the shared "is this a plan-time constant" decision
  - packages/quereus/src/planner/analysis/constraint-extractor.ts                  # isLiteralConstant now delegates to planTimeLiteralValue (crash site 1)
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts    # isLiteralConstant now delegates to planTimeLiteralValue (crash site 2)
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic                    # 5 end-to-end cases appended
  - packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts                 # 1 unit case pinning crash site 2 directly
difficulty: easy
---

# Fixed: promise-valued literal now treated as a dynamic value at plan time

## What changed

Constant folding replaces an uncorrelated constant scalar subquery (`(select 1)`)
with a `LiteralNode` whose `expression.value` is a still-pending `Promise` — see
the existing comment in `LiteralNode.getType()` (`planner/nodes/scalar.ts`). Two
planner call sites each had a private `isLiteralConstant` / `getLiteralValue` pair
that didn't check for this and crashed via `getSyncLiteral` ("Literal value is a
promise"):

- `planner/analysis/constraint-extractor.ts` (`extractBinaryConstraint`,
  `extractBetweenConstraints`, `extractInConstraint`) — crash site 1, reached
  first for all four broken query shapes.
- `planner/rules/predicate/rule-sargable-range-rewrite.ts` — crash site 2,
  independently reachable (confirmed during investigation by temporarily
  patching only site 1 and re-running; the two `=` shapes then crashed here
  instead).

Added one shared helper, `planTimeLiteralValue(node: ScalarPlanNode): SqlValue |
undefined`, in `planner/analysis/predicate-shape.ts`, next to the existing
AST-level `literalValue(expr)` (which already handled the Promise case —
`planTimeLiteralValue` just delegates to it after confirming the node is a
`LiteralNode`). Both call sites now express their private `isLiteralConstant` in
terms of it:

```ts
function isLiteralConstant(node: ScalarPlanNode): boolean /* or `node is LiteralNode` */ {
	return planTimeLiteralValue(unwrapCast(node)) !== undefined;
}
```

Each site kept its own `unwrapCast` unchanged (deliberately different between the
two files — see the `NOTE:` comments at each — do not unify). Only the "is this
literal a plan-time constant" decision is shared. SQL `NULL` stays distinguishable
from "not a constant": `planTimeLiteralValue` returns `null` (a legitimate value)
for a NULL literal and `undefined` only for a non-literal or a pending-Promise
literal; both call sites' existing `null`-specific branches are untouched.

With the promise-valued literal no longer classified as a constant, and
`isDynamicValue` (unchanged) recognizing only `ParameterReference` /
`ColumnReference`, the conjunct falls through to "no column-constant pattern
found" and survives as a residual `FILTER` — i.e. the query runs normally instead
of crashing. A `NOTE:` tripwire was added at `isDynamicValue` in
`constraint-extractor.ts` documenting this as the conservative-but-correct
outcome, and pointing at what would need verification (the seek-binding path for
a `LiteralNode` whose `getValue()` returns a Promise) if this shape ever needs to
become seek-worthy instead of just residual.

## How to validate

`yarn workspace @quereus/quereus run test` (10174 passing, 0 failing) and
`yarn workspace @quereus/quereus run lint` (clean, includes the test-file
`tsc --noEmit` pass) both ran clean after this change, from a full workspace run.

Key coverage, all exercised through the full test run above:

- `packages/quereus/test/logic/96-subquery-edge-cases.sqllogic` — new section
  "CONSTANT SCALAR SUBQUERY AS A PREDICATE VALUE" against a fresh `big` table
  (`id, v, status`, 2 rows), covering all five shapes from the ticket:
  `v = (select 1)`, `status = (select 'x')`, `v between (select 1) and (select
  2)`, `v in ((select 1), 2)`, and the aggregate-subquery control `status =
  (select max(status) from big)`. **Correction from the ticket's table**: the
  control query's expected row is `[{"id":2}]`, not `[{"id":1}]` — `max('x',
  'y')` is `'y'` (BINARY collation), which is row `id=2`; the ticket's example
  table didn't actually state an expected value for that row (just "unchanged"),
  and I initially transcribed it wrong before checking the collation myself.
- `packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts` — new unit
  test `declines date(ts) = <promise literal> instead of throwing`, pinning
  crash site 2 directly (a `LiteralNode` built with a `Promise`-wrapped value)
  so a future extractor-only fix can't silently re-hide this half of the bug.
  Uses a new local helper `litPromise(value)` alongside the existing `lit(value)`.

## Known gaps / things I did not do

- I did not isolate-run the two new test files individually to eyeball their
  pass/fail lines — I relied on the full `yarn workspace @quereus/quereus run
  test` run (10174 passing, 0 pending-as-failure, 0 failing) plus a clean
  `tsc -p tsconfig.test.json --noEmit`, which together cover both new files. An
  attempted standalone re-run of just `sargable-range-rewrite.spec.ts` was
  interrupted by tooling (background timeout) partway through and stopped
  before producing output — it was redundant with the full run, not a signal of
  a problem, but I did not get a second confirmation from it. Worth a spot-check
  if you want extra certainty.
- The deferred optimization mentioned in the ticket (pushing a resolved promise
  literal down as a dynamic seek binding via `valueExpr`/`bindingKind`, instead
  of always falling back to a residual filter) is intentionally **not** done
  here — out of scope per the ticket, tracked only as the `NOTE:` tripwire at
  `isDynamicValue` in `constraint-extractor.ts`.
- Did not touch `unwrapCast` in either file — both keep their pre-existing,
  deliberately different cast-stripping policy (no-op-casts-only in the
  extractor vs. any-cast in the rewrite rule), per the ticket's explicit
  instruction not to unify them.

