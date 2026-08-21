---
description: When the planner reads rows through an index, it writes down "about a hundred rows" no matter how many really come back, so it keeps picking that read over a plain table scan that would be faster. The storage backend already worked out the real number and the planner throws it away.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts   # IndexSeekNode.computePhysical — the min(tableRows || 1000, 100) cap (arm 1) and the PK-seek override next to it (arm 3)
  - packages/quereus/src/vtab/memory/module.ts                 # evaluateIndexAccess — the equality arm counts seek KEYS, not matched rows (arm 2)
  - packages/quereus/src/vtab/best-access-plan.ts              # BestAccessPlanResult.rows / AccessPlanBuilder.eqMatch
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # selectPhysicalNode — makeFullScanFilterInfo(cost, accessPlan.rows || 1000)
  - packages/quereus/src/planner/util/row-estimates.ts         # physicalSourceRows — how the number propagates upward
  - packages/quereus/src/planner/rules/cache/rule-nested-loop-right-cache.ts  # estimateRightRows — the existing private workaround
  - packages/quereus-store/src/common/store-module-access-plan.ts  # the store's per-predicate estimator; arm 2 should agree with it
  - packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts # the one test that moves (see "What moved when this was measured")
  - packages/quereus/test/optimizer/key-set-seek.spec.ts        # moves only under the rejected cost variant
  - packages/quereus/test/optimizer/join-row-estimates.spec.ts  # closest existing model for the new plan test
repro: verified
difficulty: medium
---

# An index seek advertises a constant row count

## Background: who computes what

When the planner decides how to read a table, it asks the storage backend
(`getBestAccessPlan`). The backend answers with an access plan that includes `rows` — its
own estimate of how many rows that read will hand back. That answer reaches the planner's
physical seek node as `filterInfo.indexInfoOutput.estimatedRows`.

`IndexSeekNode.computePhysical` ignores it:

```ts
estimatedRows: Math.min(this.source.estimatedRows || 1000, 100),
```

Every index seek that is not a single-row primary-key lookup therefore reports **100
rows** to everything above it, regardless of what it will actually produce. That number is
an input to every cost decision above the seek: join algorithm selection, cache admission,
sort costing, aggregate cardinality. `rule-nested-loop-right-cache` already reaches around
the node to read the backend's number directly, because the node's own figure is unusable
— one consumer has privately worked around this already.

Measured, memory backend, 2000 rows, `k` holding 4 distinct values (500 rows each), after
`analyze`:

| query | rows actually returned | backend's `rows` | node's `estimatedRows` |
|---|---|---|---|
| `where k = 1` | 500 | 1 | 100 |
| `where k > 0` | 1500 | 500 | 100 |
| `where id > 1900` | 100 | 500 | 100 |
| `where id = 5` | 1 | 1 | 1 |

No wrong rows result from any of this — it is plan choice only.

## Three arms, and why they land together

Note the `k = 1` row above. The node says 100; the backend says **1**; the truth is 500.
Adopting the backend's number without arm 2 replaces a 5x-high estimate with a 500x-low
one, and under-estimates are the more dangerous direction. Measured: with arm 1 alone,
`select pk from big where s = 'x' and v in (select id from small)` flips from a hash join
to an index-nested-loop join chosen on the strength of a fabricated "1 row" outer side.
Arm 1 alone is a regression; arms 1 and 2 together are an improvement.

Arm 3 is a separate false claim in the same function as arm 1, found while measuring it.

### Arm 1 — the seek ignores the backend's answer (engine)

`IndexSeekNode.computePhysical` should report the backend's own row estimate for the
access plan it chose, which is already on the node at
`filterInfo.indexInfoOutput.estimatedRows` (a `bigint`; convert with `Number()`).

That field is populated in `rule-select-access-path.selectPhysicalNode` via
`makeFullScanFilterInfo(accessPlan.cost, accessPlan.rows || 1000)`, which every index arm
spreads. So "the backend supplied no estimate" has **already collapsed to 1000** by the
time the node sees it — the node cannot distinguish a backend that said 1000 from one that
said nothing, and cannot distinguish `rows: 0` from either.

Decide and document which of these you want; do not invent a third spelling of "unknown"
(see `bug-row-estimate-conflates-unknown-and-zero` in backlog, which owns that
convention):

- **Recommended:** accept the existing `|| 1000` as the no-answer fallback, and leave a
  `NOTE:` at `computePhysical` saying so and pointing at the convention ticket. Both
  shipped backends always set `rows`, so the fallback is reachable only from third-party
  modules. This keeps the change to one line and does not add a fourteenth positional
  constructor argument to `IndexSeekNode` (see
  `debt-access-leaf-node-positional-constructors`).
- Threading `accessPlan.rows` through as its own optional field so the node can fall back
  to `min(tableRows || 1000, 100)` itself. Truer to the field's meaning, but pays the
  constructor cost above for a case no shipped backend reaches.

### Arm 2 — the memory backend counts seek keys, not matched rows

`MemoryTableModule.evaluateIndexAccess`, equality arm:

```ts
return AccessPlanBuilder
    .eqMatch(inCardinality)   // inCardinality is the number of seek KEYS
```

`inCardinality` is the cross-product of per-column seek-key counts — 1 for `k = 5`, 3 for
`k in (1,2,3)`. For a **unique** index that equals the matched-row count. For a
**non-unique** index it is the matched-row count divided by the number of rows sharing
each key, so `k = 1` on a column with 4 distinct values over 2000 rows is advertised as
1 row and returns 500.

Make the equality arm estimate matched rows, using the same decisions the store backend
already makes in `store-module-access-plan.ts` so the two agree
(`debt-store-engine-estimate-agreement-test` in backlog is the ticket for pinning that
agreement):

- a unique index, or the `_primary_` pseudo-index, matches at most one row per key —
  `rows = inCardinality` (note `gatherAvailableIndexes` builds the PK pseudo-index without
  `unique: true`, so match it by name or set the flag);
- otherwise, when `tableInfo.statistics` is present with `rowCount > 0` and **every**
  equality column has per-column statistics, `perKey = N * product(1 / distinctCount)`;
- otherwise a shape constant — the store uses `0.1` for its equality arm; using the same
  number reproduces the old flat 100 on the un-analyzed 1000-row default, which is why
  almost nothing moves;
- clamp: `rows = min(N, inCardinality * perKey)` — a seek cannot return more rows than the
  table holds. The store does exactly this (`Math.min(estimatedRows, inCount * rows)`).

Look up column statistics by **lowercase column name** (`TableStatistics.columnStats` is
keyed that way) via the column index, as the store does — that is what keeps a
post-`ANALYZE` `ALTER TABLE` from reading a neighbouring column's numbers.

**Cost: leave it alone.** `AccessPlanBuilder.eqMatch(n)` sets both cost (`0.5 + n * 0.3`)
and rows from one argument. Keep passing `inCardinality` to `eqMatch` and override the row
count with `.setRows(matchedRows)`. Deriving the cost from the matched-row count instead
was measured and rejected: it raises a pushed single-key equality seek's cost from 1.8 to
31.5, which moves `rule-key-set-seek`'s break-even (the rule reads
`filterInfo.indexInfoOutput.estimatedCost` as its baseline) and stops the key-set rewrite
firing at all — two `key-set-seek.spec.ts` plan-shape tests go red. Pricing a fat seek
honestly is a real and separate question; it is not this ticket.

### Arm 3 — a multi-key primary-key seek claims it returns at most one row

Immediately below the capped estimate, same function:

```ts
if (!this.isRange && this.indexName === 'primary') {
    const pk = this.source.tableSchema.primaryKeyDefinition ?? [];
    if (pk.length > 0 && this.seekKeys.length >= pk.length) {
        // Full PK equality seek — at most one row.
        ... return { ...base, estimatedRows: 1, fds: addSingletonFd(...) };
```

For a multi-key seek — `where id in (1,2,3)` on a single-column primary key —
`seekKeys.length` is 3 and `pk.length` is 1, so `3 >= 1` passes. The node reports
`estimatedRows: 1` for a seek that returns 3 rows, **and stamps the singleton functional
dependency** `{} -> all columns`, which asserts the relation holds at most one row.
Verified at HEAD, before any change:

```
select * from t where id in (1,2,3)
  IndexSeek rows=1 fds=[{determinants:[0],dependents:[1]},{determinants:[],dependents:[0,1]}]
```

The second entry is the false claim. No wrong answer results **today** — `order by`,
`group by`, `distinct`, `limit`, `union`, `max()`, an inner join and a scalar subquery were
all checked and all still return correct rows, and the scalar subquery correctly raises
"returned more than one row". But the node is advertising a property that is false right
now, and the consumers of a singleton functional dependency (uniqueness proofs, `distinct`
elision, sort elision) are exactly the rewrites that would silently drop rows if one of
them ever did lean on it.

The guard wants "the seek keys pin every primary-key column, once each". Distinguish the
multi-key case — the seek is a multi-seek (`accessPath.plan === 'multiSeek'`, or
`seekKeys.length > pk.length`, or the seek was built from a multi-value equality) — and in
that case neither force 1 nor add the singleton dependency. Arm 1 supplies the right row
count for free (the backend says 3); the dependency must simply not be stamped.

## What moved when this was measured

Prototype: arm 1 as recommended, arm 2 as recommended (rows only, cost untouched, table
clamp applied). Arm 3 was **not** in the prototype.

- `yarn workspace @quereus/quereus run test` — 9919 passing, **1 failing**.
- `yarn workspace @quereus/store run test` (after `yarn workspace @quereus/quereus run build`)
  — 1846 passing, 0 failing.
- `yarn bench:gate` — `56 match, 0 differs, 0 ungated, 0 new, 0 missing`, all four ratio
  guards hold. **No work counter moved at all.** The original ticket's "expect plan
  snapshots to move" caution did not materialise on the benchmark workloads.

The single failure is `test/vtab/runtime-key-set-protocol.spec.ts` — *"memory module › does
NOT claim ordering over a runtime-set seek column"*. It asserts `handledFilters`
deep-equals `[true]` (the seek is taken) for a 25-key runtime set on a non-unique column of
a 1000-row **un-analyzed** table with an `order by` on the seek column. Under the new
estimate the arm saturates (`min(1000, 25 * 100)` is the whole table), the sort over that
many rows outprices the seek plan, and the module returns the ordering-only scan with the
filter left residual. That is the honest consequence of the shape constant, and the store
backend already saturates the same way at ten seek keys by its own documented reasoning.

Argue that move on its merits rather than re-pinning it silently: for 25 unknown keys
against an un-analyzed table with a required ordering, a single ordered scan plus a
residual filter is a defensible choice. If you conclude it is not, the lever is the shape
constant or an `estimatedCount`-aware multi-seek estimate — not reverting arm 2. Either way
the test's *other* assertions (no `providesOrdering`, and runtime-set parity with a literal
`IN`) must still hold, and the parity assertion is the one that must not be weakened.

`test/optimizer/key-set-seek.spec.ts` stays green under the recommended shape. It goes red
under arm 1 alone, and red differently under the rejected cost variant — treat either as a
signal you have drifted from the shape above, not as a test to re-pin.

## TODO

- Arm 1: `IndexSeekNode.computePhysical` reports
  `Number(this.filterInfo.indexInfoOutput.estimatedRows)` instead of
  `Math.min(this.source.estimatedRows || 1000, 100)`. Replace the existing `NOTE` (which
  predicted this) with one recording where the no-answer fallback now lives and pointing at
  `bug-row-estimate-conflates-unknown-and-zero`.
- Arm 2: memory backend's equality arm advertises matched rows — unique/PK exact,
  statistics-backed `product(1/distinctCount)` when every equality column has stats, shape
  constant `0.1` otherwise, clamped to the table size. Keep `eqMatch`'s cost argument as
  `inCardinality` and set rows via `.setRows(...)`.
- Arm 2 threading: `evaluateIndexAccess` needs the `TableSchema` for statistics; it is
  reached from `findBestAccessPlan` and from `evaluateOrderingOnlyPlans` (via
  `adjustPlanForOrdering`), so all three signatures take it.
- Arm 3: the primary-key branch must not force `estimatedRows: 1` or stamp the singleton
  functional dependency for a multi-key seek. Add a test that `where id in (1,2,3)` stamps
  no `{} -> all columns` dependency and reports 3 rows.
- Add a plan test asserting the seek's advertised estimate tracks the backend's answer
  across a selective seek and a large-fraction range seek on the same analyzed table — the
  two ends the constant currently collapses together.
  `test/optimizer/join-row-estimates.spec.ts` is the closest existing model for the harness
  (build a `Database`, `analyze`, walk `plan.physical.estimatedRows`).
- Add a `NOTE:` at the memory backend's equality arm recording the tripwire this surfaced:
  the memory backend has no seek-versus-scan veto (the store does), so an equality seek
  matching a large fraction of the table still prices below a full scan (`0.5 + rows * 0.3`
  against `rows * 1.0`). Fine while the estimate is a shape constant; if a fat
  analyzed-table seek ever shows up as a slow plan, the veto is the fix.
- Re-run `yarn workspace @quereus/quereus run test`, `yarn workspace @quereus/store run test`
  (after building quereus), and `yarn bench:gate`. Read every counter that moves — a changed
  work count here is the intended signal, not noise. `yarn test:store` was not run during
  this investigation and is worth one pass, since the store backend is where the real
  per-predicate estimates come from.
