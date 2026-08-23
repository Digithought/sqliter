description: Several optimizer tests build fake stand-in objects for query-plan pieces instead of using the real ones, and the fakes had silently drifted out of shape — so the tests were passing without exercising the code they claim to cover.
files:
  - packages/quereus/test/optimizer/statistics-edge-cases.spec.ts   # local mockLiteral / mockColumnRef
  - packages/quereus/test/optimizer/statistics.spec.ts              # near-identical copy
  - packages/quereus/test/planner/stats/catalog-stats.spec.ts       # near-identical copy, plus inline literal objects
  - packages/quereus/test/optimizer/index-nested-loop-batched.spec.ts
  - packages/quereus/test/planner/stats/index.spec.ts
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts  # the counter-example: builds real nodes
tradeoffs: Real plan nodes need a scope and an AST expression to construct, so a faithful factory is more setup than a four-key object literal — a maintainer may reasonably judge the current fakes good enough for statistics tests that only read two fields.

# Duck-typed plan-node test doubles drift from the real nodes

## What happened

Three optimizer spec files each define their own `mockLiteral`, building a plain object
and casting it:

```ts
function mockLiteral(value: SqlValue): ScalarPlanNode {
	return {
		nodeType: 'Literal',
		expression: { value },          // <-- no `type: 'literal'`
		getChildren: () => [],
		getRelations: () => [],
	} as unknown as ScalarPlanNode;
}
```

A real literal's `expression` is an `AST.LiteralExpr`, which always carries
`type: 'literal'`. The fakes omitted it. Nothing noticed, because
`as unknown as ScalarPlanNode` tells the compiler to stop checking.

It surfaced when `bug-constant-subquery-literals-collide-in-cse` routed
`planner/stats/catalog-stats.ts` through the shared accessor that checks that tag: every
mocked literal suddenly read as "not a literal", and catalog-statistics selectivity fell
back to its heuristics. One test caught it; the rest of that run was masked by `--bail`.
The mocks were corrected in that ticket, but the mechanism that let them drift is
untouched.

The same file also contains two tests that were passing **for the wrong reason** before
the correction — they meant to exercise a "value is not known at plan time" path, but the
missing tag short-circuited the check first, so the path under test never ran.

## Why it is worth fixing rather than living with

The failure mode is silent and self-concealing: a fake that has drifted makes the code
under test take a *different branch* and the assertion still passes, so the test reports
green while covering nothing. There is no way to notice except by accident, as happened
here. Count as measured with
`grep -rc "as unknown as ScalarPlanNode" packages/quereus/test --include=*.ts`:
**27 such casts across 5 files** (catalog-stats 13, statistics-edge-cases 7,
statistics 5, index-nested-loop-batched 1, planner/stats/index 1).

`test/optimizer/expression-fingerprint.spec.ts` already shows the alternative — its
`lit()`, `colRef()`, `binOp()` helpers construct genuine `LiteralNode` /
`ColumnReferenceNode` / `BinaryOpNode` objects against `EmptyScope.instance`. Those
helpers cannot drift, because the constructors enforce the shape.

## What "done" looks like

One shared, typed factory module for plan-node test doubles that returns **real** nodes,
adopted by the five files above, with the per-file `mockLiteral` / `mockColumnRef` copies
deleted. Success criterion is not "tests still pass" — they pass today — but that
constructing a mis-shaped literal becomes a compile error rather than a silent behavior
change.

Nodes whose real constructors genuinely cannot be driven from a test (if any turn up)
should stay as casts, with a one-line comment at the site saying which field the
surrounding test actually depends on.
