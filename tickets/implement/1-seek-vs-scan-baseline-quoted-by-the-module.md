description: When the query planner decides whether to let a storage backend use its index instead of reading a whole table, the two prices it compares are worked out from two different guesses at how big the table is, so on a table nobody has measured recently the index loses and the same condition ends up being checked twice on every row.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts   # ~542-545, the only site — the `?? 1000` baseline
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts   # ~713, probeAccessPlan — neighbour to the new helper
  - packages/quereus/src/vtab/best-access-plan.ts                       # AccessPlanBuilder.fullScan / rangeScan — the module-side cost shapes
  - packages/quereus/src/planner/cost/index.ts                          # seqScanCost — the engine-side shape being retired from this comparison
  - packages/quereus/src/vtab/memory/module.ts                          # MemoryTableModule.getBestAccessPlan — the test double's base class
  - packages/quereus/test/optimizer/access-plan-request-row-count.spec.ts # the sibling spec; the recording-module pattern to copy
  - packages/quereus-store/src/common/store-module.ts                   # ~126 sizeRequestFromLiveCount — the module side of the mismatch
  - packages/quereus-store/src/common/store-module-access-plan.ts       # ~640 the leading-PK range arm this veto is the only guard for
  - docs/optimizer-costing.md                                           # ~166 "Where a module's own size fits"
  - docs/optimizer-retrieve.md                                          # ~333 claims growth does no cost modeling — already false
difficulty: medium
----

# Price the seek-versus-scan baseline through the module, not through the engine

## What is wrong, in plain terms

When a query says `where id < 500`, the planner offers the work to the storage backend and
asks what it would cost. The backend answers with the price of an index seek. The planner
then compares that against the price of just reading the whole table, and pushes the work
down only if the seek wins.

The two prices are computed from different numbers. The backend prices its seek against the
table's **real** size, which it keeps a running count of. The planner prices the baseline
scan against a **fixed guess of 1 000 rows** whenever the catalog has no fresh measurement.
On a table with more rows than that guess, the honest seek price looks worse than the
made-up scan price, so the planner refuses to push the predicate down — and then the
predicate gets enforced a second time, in a `Filter` sitting on top of the seek that already
bounded the rows.

## The one site

`packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts`, in
`fallbackIndexSupports` (~542):

```ts
// Calculate baseline cost
const estimatedRows = request.estimatedRows ?? 1000;
const seqCost = seqScanCost(estimatedRows);
...
if (accessPlan.cost >= seqCost && !providesOrdering) { /* decline */ }
```

`accessPlan.cost` comes from the module. `seqCost` comes from the engine's own formula over
the engine's own row count. Nothing keeps the two row counts in agreement, and today they
routinely disagree.

Grep confirms this is the only place in the tree where an engine-derived `seqScanCost` is
compared against a module-quoted cost. The other `seqScanCost` callers
(`rule-materialized-view-rewrite`, `database-materialized-views-plan-builders`) compare
engine-modelled costs against engine-modelled costs, so they are self-consistent and are
**not** part of this ticket.

## Two ways the numbers diverge — both verified

`repro: verified`. Measured against `@quereus/store` over the in-memory provider, plan read
from `query_plan('select * from bench_t where id < 500')` on `create table bench_t (id
integer primary key, val integer)`:

| catalog state | 4 000 rows | 10 000 rows |
|---|---|---|
| never analyzed | seek, no residual | **`FILTER` above `INDEXSEEK`** |
| `analyze` run while empty, then filled | **`FILTER` above `INDEXSEEK`** | **`FILTER` above `INDEXSEEK`** |
| `analyze` run after filling | seek, no residual | seek, no residual |

- **Never analyzed.** `request.estimatedRows` is `undefined`, `?? 1000` prices the baseline
  at 1 000 rows, and `StoreModule.sizeRequestFromLiveCount` fills the gap from the live
  count. The store's leading-PK range arm estimates `rows * 0.3` and prices
  `0.2 + rows * 0.5`, so it crosses the fixed 1 000 at `rows * 0.15 = 1000`, i.e. about
  6 667 rows. Measured flip is between 6 000 and 7 000.
- **Analyzed while empty, then grown.** `request.estimatedRows` is a measured `0`, so
  `seqScanCost(0)` = 0.1 — and `sizeRequestFromLiveCount`'s `staleEmptySnapshot` branch
  overrides the stale 0 with the live count on the module side. The baseline is then 0.1
  against a seek priced on the true size, so the seek loses at *every* table size, 4 000
  included. The original bug report missed this arm.

The second arm is why "only substitute the baseline when `estimatedRows` is `undefined`"
is **not** an adequate fix: the veto is wrong whenever the two sides disagree, not only
when the engine's side is missing.

## Why the extra `Filter` costs something real

The seek still happens — the plan is correct, just slower. On decline, `selectPhysicalNode`
takes its fallback branch (`Module has getBestAccessPlan() method`, not `Using index-style
context provided by grow-retrieve`), re-probes the module, rebuilds the pipeline and
re-attaches `moduleCtx.residualPredicate` on top. Every row the seek already bounded is
drained and re-tested. `bench/reference/store.json`'s `store/commit-update-1000` records
`rowsOut` going `4004` to `5005` — one full extra pass.

## The fix

Ask the same module for the baseline. Replace the two lines above with a filter-free,
ordering-free, limit-free probe of the module that just quoted the seek:

```ts
const seqCost = baselineScanCost(
    req => vtabModule.getBestAccessPlan!(context.db, tableSchema, req) as BestAccessPlanResult,
    request,
);
```

```ts
function baselineScanCost(
    ask: (request: BestAccessPlanRequest) => BestAccessPlanResult,
    request: BestAccessPlanRequest,
): number {
    const baseline = ask({ ...request, filters: [], requiredOrdering: undefined, limit: undefined, offset: undefined });
    if (Number.isFinite(baseline.cost)) return baseline.cost;
    return seqScanCost(request.estimatedRows ?? 1000);
}
```

Whatever size the module used to price its seek arm, it used the same one here — symmetric
by construction, with no new module interface. `getBestAccessPlan` is documented as pure at
plan time, so the discarded probe leaves nothing behind (the same property `probeAccessPlan`
in this file already relies on, and the same reason `trySortAbsorbViaIndexOrdering` may probe
speculatively).

Notes on the details:

- **Strip the ordering, not just the filters.** The veto only fires when `!providesOrdering`
  — ordering is scored as a benefit separately — so the baseline must be the plain scan the
  seek is being compared against, not an ordering-satisfying one.
- **Keep `seqScanCost` as the non-finite fallback.** `BestAccessPlanResult.cost` is a
  required `number`, so this branch should be unreachable; keeping it means a module
  returning `NaN` degrades to exactly today's behavior instead of vetoing on a comparison
  with `NaN`. Do not delete the `seqScanCost` import.
- **Do not re-fabricate 1 000 on the request.** That would reinstate the bug
  `ask-the-backend-before-guessing-its-size` removed and blind every module that keeps a
  live row count.
- `createSeqScan`'s sibling `|| 1000` in `rule-select-access-path.ts` (~1235) is the same
  constant, but on a path that feeds the engine's own cost model rather than a comparison
  with a module. It is filed as `bug-measured-empty-table-costed-as-thousand-rows` and
  carries a `NOTE:` at the site saying so. Leave it alone here.

## Evidence the fix is right, already measured

The prototype above was applied, built, and then reverted; the tree is at HEAD. What it
showed:

- All six cells of the table above plan as a bare `INDEXSEEK` with no residual `Filter`.
- `yarn test` — full monorepo run, 10 382 + 1 952 + 755 + smaller suites — **zero failures**.
- `yarn bench:gate` — **0 differs, 56 match, all four ratio guards hold**. At HEAD the same
  gate reports **12 differs**.

That last point retires a chunk of the original ticket's definition of done. The 12
differing counters are not 60 commits of accumulated reference drift needing individual
`bench:accept` reasons — they are this regression, and `bench/reference/store.json` is the
pre-regression truth. **Expect the gate to go green on its own. Do not run
`yarn bench:accept`.** If any counter still differs after the change, that is a genuinely
new difference and needs its own reason.

## The test

The bug is engine-side and needs no storage package: a `MemoryTableModule` subclass that
substitutes its own row count when the request says "unknown" reproduces it exactly, with
no rows inserted and no I/O. Verified:

```
liveRows=6700  -> INDEXSEEK
liveRows=7000  -> INDEXSEEK
liveRows=8000  -> FILTER | INDEXSEEK
liveRows=10000 -> FILTER | INDEXSEEK
```

The double is small enough to restate here:

```ts
class SelfSizingMemoryModule extends MemoryTableModule {
    liveRows = 10000;
    override getBestAccessPlan(db: Database, t: TableSchema, req: BestAccessPlanRequest): BestAccessPlanResult {
        const sized = req.estimatedRows === undefined ? { ...req, estimatedRows: this.liveRows } : req;
        return super.getBestAccessPlan(db, t, sized);
    }
}
```

The memory module's range arm prices slightly differently from the store's, so its flip sits
between 7 000 and 8 000 rather than between 6 000 and 7 000. Same defect either way.

`packages/quereus/test/optimizer/access-plan-request-row-count.spec.ts` already has the
shape to copy: a module subclass registered with `db.registerModule(...)`, a table created
`using` it, and `query_plan(...)` read through `db.eval`.

What the new spec must pin:

- A table whose module reports a live size is planned with **no** `Filter` above the
  `IndexSeek`, parameterized across sizes that straddle the break-even — include at least
  one below (1 000) and several well above (8 000, 10 000, 50 000) so a future change to a
  cost constant cannot slide the flip past the parameters.
- The stale-measurement arm: the request carries `estimatedRows: 0` while the module reports
  a large live size, and the seek still wins. This is the arm that fails at every size, and
  the one a size-only parameterization would miss.
- The test must FAIL on current `main` and pass after. Check both.

## Also in scope

- `docs/optimizer-costing.md` section *Where a module's own size fits* (~166) describes the
  module substituting its own size for the access path. Add that the seek-versus-scan
  baseline is now quoted by the module too, so the comparison cannot read two different
  table sizes.
- `docs/optimizer-retrieve.md` section *Dynamic support growth with ruleGrowRetrieve* (~333)
  lists "Purely structural — no cost modeling during growth" as a key property. That is
  already false — the `accessPlan.cost >= seqCost` veto is cost modeling — and this change
  makes it more so. Correct the claim rather than leaving it to mislead the next reader.
- Leave a `NOTE:` at the new helper recording the tripwire: the baseline costs one extra
  `getBestAccessPlan` call per grow attempt on an index-style module. Measured as free —
  no gated bench counter moved and every ratio guard held — but a module with an expensive
  `getBestAccessPlan` would pay it twice per attempt; if that ever shows up, memoize the
  filter-free answer per table per optimizer pass.
- `feat-memory-backend-sizes-itself` (backlog) would make the default in-memory backend
  report its real size the way the store does. That ticket lands this same bug on the
  default backend the whole test suite runs on. This fix pre-empts it; say so in the
  handoff so its reviewer knows the asymmetry is already closed.

## Definition of done

- The six-cell table above plans with no residual `Filter` in every cell.
- New spec in `packages/quereus/test/optimizer/`, parameterized on size and covering the
  stale-`0` arm, failing before and passing after.
- `yarn test` green; `yarn lint` and `yarn typecheck` green.
- `yarn bench:gate` green with **no** `bench:accept`.
- Both doc sections updated.

## TODO

- [ ] Replace the `?? 1000` baseline in `fallbackIndexSupports` with `baselineScanCost`, and
      add the helper next to `probeAccessPlan` with the tripwire `NOTE:`.
- [ ] Add the parameterized optimizer spec, including the stale-`estimatedRows: 0` arm;
      confirm it fails at HEAD before you take the fix.
- [ ] Update `docs/optimizer-costing.md` section *Where a module's own size fits*.
- [ ] Correct the "no cost modeling during growth" claim in `docs/optimizer-retrieve.md`.
- [ ] Run `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test`, `yarn bench:gate`.
