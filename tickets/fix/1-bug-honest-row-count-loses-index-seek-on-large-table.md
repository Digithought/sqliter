----
description: A never-analyzed table above roughly 6 700 rows stopped using its index for range and equality lookups, falling back to a scan with the predicate re-applied on top, because the engine prices the baseline scan at a fixed 1 000 rows while the storage module now prices its seek against the table's real size.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts   # ~542-568, the seqCost comparison
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # createSeqScan's `|| 1000`, ~1232
  - packages/quereus/bench/reference/store.json                          # 12 counters record the regression
repro: verified
difficulty: medium
----

# The two sides of the seek-vs-scan comparison no longer use the same table size

## Symptom

`select * from bench_t where id < 500` over a **never-analyzed** 10 000-row store table
plans as an index seek with the predicate **re-applied above it**:

```
FILTER      WHERE id < 500
  INDEXSEEK INDEX RANGE bench_t USING primary ORDER BY 0
```

At 4 000 rows the same query plans without the `FILTER`. The flip is at roughly 6 700
rows (arithmetic below). `analyze` makes it go away, so it only affects tables nobody has
measured — which is the default state.

The extra node is not free: it drains and re-tests every row the seek already bounded.
`store/commit-update-1000` shows `rowsOut` going `4004 → 5005`, one full extra pass.

## Repro

```js
// 10 000 rows, no ANALYZE, store backend
await db.exec(`create table bench_t (id integer primary key, val integer)`);
// ... insert 10 000 rows ...
await db.eval(`select op, detail from query_plan('select * from bench_t where id < 500')`);
// -> FILTER above INDEXSEEK. At 4 000 rows: no FILTER.
```

## Cause

`rule-grow-retrieve` decides whether to push the predicate into the module by comparing the
module's quoted price against its own baseline (~542-564):

```ts
const estimatedRows = request.estimatedRows ?? 1000;
const seqCost = seqScanCost(estimatedRows);
...
if (accessPlan.cost >= seqCost && !providesOrdering) { /* decline */ }
```

`request.estimatedRows` is `catalogRowCount(tableSchema)`, which is **`undefined`** for a
never-analyzed table — correctly so, since `unknown-row-count-stops-pretending-to-be-zero`.
The `?? 1000` then prices the baseline scan **as if the table held 1 000 rows**.

The module no longer plays along. Since `ask-the-backend-before-guessing-its-size`, the
planner sends `estimatedRows: undefined` instead of a fabricated 1 000, and `StoreModule`
fills the gap from the table's **live row count** (`sizeRequestFromLiveCount`). So it
prices its seek against the true size:

| table rows | module's range plan | engine's baseline | verdict |
|---|---|---|---|
| 4 000 | `rangeScan(1200, 0.2)` = **600.2** | `seqScanCost(1000)` = 1000 | push (correct) |
| 10 000 | `rangeScan(3000, 0.2)` = **1500.2** | `seqScanCost(1000)` = 1000 | **decline** |

Break-even: the range arm estimates `rows * 0.3` and prices `0.2 + rows * 0.5`, so it
crosses the fixed 1 000 at `rows * 0.3 * 0.5 = 1000`, i.e. **≈ 6 667 rows**. Measured flip
sits between 4 000 and 10 000, as predicted.

Confirmed the module is not at fault — probed directly across sizes, it claims the filter
every time:

```
estimatedRows=undefined  handled=[true]  idx=_primary_  rows=60    cost=30.2
estimatedRows=    1000   handled=[true]  idx=_primary_  rows=300   cost=150.2
estimatedRows=    4000   handled=[true]  idx=_primary_  rows=1200  cost=600.2
estimatedRows=   10000   handled=[true]  idx=_primary_  rows=3000  cost=1500.2
```

The residual `Filter` is therefore **not** `reattachUnconsumedConstraints` firing (its log
line never appears). On decline, `selectPhysicalNode` takes its fallback branch — the log
reads `Module has getBestAccessPlan() method` instead of `Using index-style context
provided by grow-retrieve` — re-probes the module itself, rebuilds the Retrieve pipeline
and re-attaches `moduleCtx.residualPredicate` on top (~246, ~292).

So the seek still happens; the predicate is simply enforced twice.

## Why this was invisible before

Both sides used to read the same fabricated 1 000, so the comparison was at least
self-consistent. Making the module honest without making the engine's baseline honest
turned a symmetric comparison into a mismatched one. The two changes are individually
correct and jointly wrong — the reason to fix it here rather than reverting either.

`createSeqScan`'s sibling `|| 1000` is already filed as
`bug-measured-empty-table-costed-as-thousand-rows`; this is the same fixed constant read
on the other side of a comparison, and the two should be resolved with one decision about
what an unmeasured table costs.

## What is wanted

A comparison whose two sides agree on the table's size. Sketch, not a prescription:

- **Preferred**: price the baseline through the module too — one extra probe with no
  filters gives a module-quoted full-scan cost, which is exactly what `StoreModule` already
  does internally when it prices its own seek arms against its own `fullScan`. Symmetric by
  construction and needs no new interface. `probeAccessPlan` in the same file already
  exists.
- **Cheaper**: when `request.estimatedRows` is `undefined`, decline to veto on cost at all
  (an unknown size cannot support a comparison), and let the later cost-based rules choose.
  Restores the old behavior for unmeasured tables but drops a guard.

Do not "fix" this by re-fabricating 1 000 on the request. That reinstates the bug
`ask-the-backend-before-guessing-its-size` removed and blinds every module that keeps a
live row count.

## Definition of done

- A never-analyzed table of 10 000+ rows plans `where id < k` with **no** residual `Filter`
  above the seek, and the same query over 4 000 rows is unchanged.
- A test that fails on the current code and passes after, parameterized on table size
  across the ~6 700-row break-even so a future constant change cannot slide past it.
- `yarn bench:gate` reconciled: the 12 differing counters are re-checked, and whatever
  remains genuinely intended is recorded with `yarn bench:accept --reason "<why>"`. The
  reference dates from 2026-08-19 and has not been refreshed in ~60 planner commits, so
  expect drift unrelated to this bug — each difference needs a reason, not a blanket accept.
