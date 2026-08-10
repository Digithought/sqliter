# Plan Tests

This directory contains two kinds of optimizer regression tests: **golden-plan tests** (snapshot-based) and **plan-shape tests** (assertion-based).

Run all plan tests:
```bash
yarn test:plans
```

## Golden Plan Tests

Capture exact plan structures as JSON snapshots for regression testing.

Each test consists of two files:
- `{test-name}.sql` — the SQL query to test
- `{test-name}.plan.json` — the expected **optimized** plan structure

The harness discovers every `.sql` file synchronously, plans it against a fixed
`users`/`departments` schema, and compares the serialized tree to the committed
golden. A missing or mismatched golden fails the suite; an empty corpus fails the
guard test.

### Serialized shape

Each node is emitted as `{ nodeType, op, detail, logical, physical, children }`,
serialized with `util/serialization.ts`'s `safeJsonStringify`. This deliberately
mirrors the EXPLAIN / `query_plan()` introspection surface rather than the
cost-laden `serializePlanTree` debug view:

- `detail` is `node.toString()` with the unstable global node-id token stripped.
- `logical` is `node.getLogicalAttributes()`.
- `physical` is the node's `PhysicalProperties`. `Map`-valued properties render as
  the bounded `{ $map: [[k, v], …], size }` summary (capped at
  `MAP_SUMMARY_ENTRY_CAP`), so the golden corpus tracks the real
  physical-properties surface instead of `[COMPLEX_OBJECT]`.
- Cost, the node's logical `estimatedRows` getter, and the node `id` are
  intentionally **omitted** — they churn on unrelated optimizer or statistics
  changes. `physical.estimatedRows` is part of the `physical` blob and therefore
  *is* captured; the corpus never runs `ANALYZE`, so it stays stable. Object keys
  are sorted and any residual `id`/`timestamp` keys stripped for deterministic
  diffs.

The serializer lives in `_helpers.ts` (`serializePlanForGolden`) so plan-shape
specs can share it.

### Single optimized snapshot (logical/physical collapse)

`Database.getPlan()` and `Statement.compile()` both return the **optimized**
plan, so there is currently no public accessor for the pre-optimization logical
tree. The previous `.logical.json` / `.physical.json` split serialized that same
optimized plan twice (byte-identical), so it has been collapsed to one
`.plan.json`. A genuine logical-vs-physical pair would require serializing the
`_buildPlan` output before `optimizer.optimize()`, which is not exposed today.

Update golden files when plans intentionally change:
```bash
UPDATE_PLANS=true yarn test:plans
```

Tests are organized in subdirectories by query pattern (`basic/`, `joins/`, `aggregates/`, etc.).

## Plan-Shape Tests

Assert that the optimizer picks expected physical operators (join type, aggregate strategy, index access, etc.) without pinning the full plan tree. Each `*.spec.ts` file covers one optimizer category:

- **predicate-pushdown** — FILTER placement relative to JOINs and projections; PK pushdown through views
- **join-selection** — HashJoin for equi-joins on non-ordered keys; MergeJoin/HashJoin for PK-to-PK; generic JOIN for cross joins
- **aggregate-strategy** — StreamAggregate for pre-sorted/scalar; HashAggregate for unsorted GROUP BY
- **subquery-decorrelation** — EXISTS/IN/NOT EXISTS decorrelation into joins
- **cte-materialization** — Single-ref inlining; multi-ref CTE references; RECURSIVECTE node
- **constant-folding** — Literal arithmetic/predicate/VALUES folding; deterministic function folding
- **index-selection** — IndexSeek/IndexScan for equality/range on indexed columns; SeqScan fallback

Shared test helpers live in `_helpers.ts`.
