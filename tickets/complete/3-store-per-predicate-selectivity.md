----
description: The persistent storage backend used to assume every indexed lookup matched a tenth of the table, so a lookup on a unique column was priced the same as one on a yes/no flag. It now uses the real per-column value counts the ANALYZE command collects, so it can tell a selective query from an unselective one.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # the estimator and the three cost decisions that key off it
  - packages/quereus/src/index.ts                                   # selectivityFromHistogram + combineConjunctive exports
  - packages/quereus-store/test/column-statistics-plan.spec.ts      # 28 tests covering the estimator
  - packages/quereus-store/test/cost-profile.spec.ts                # veto-policy block re-framed + a seam test
  - packages/quereus-store/test/stats-persistence.spec.ts           # probe corrected to read est_cost
  - docs/module-authoring.md                                        # reading tableSchema.statistics; the runtimeSet contract
  - docs/optimizer-costing.md                                       # "Where a module's own SELECTIVITY fits"
difficulty: hard
----

# What landed

`computeBestAccessPlan` in the store module used to size every secondary-index arm with a
fixed fraction of the table — equality 10%, prefix-equality-plus-a-bound 15%, leading-column
range 30%. Those are shape constants, not measurements, so `where status = 'active'` on a
two-valued column and `where user_id = ?` on a near-unique column priced identically.

It now reads `TableSchema.statistics` — the per-column distinct counts, null counts and
equi-height histograms `ANALYZE` already collects — which was in scope all along, since
`getBestAccessPlan` is handed the `TableSchema` itself. No new collection, no change to
`BestAccessPlanRequest`.

**The design rule the whole change hangs on:** the store's row estimate for a predicate must
be the number the engine's `CatalogStatsProvider` would produce for the same predicate. A
seek's advertised `rows` and the estimate a residual `Filter` above it carries describe the
same row set; two different numbers have the optimizer comparing two different worlds. So
every formula is `estimateLeaf`'s, and the two shared helpers are imported from the engine
rather than restated:

- equality → `1 / max(distinctCount, 1)`
- a bound → `selectivityFromHistogram(histogram, op, value, rowCount)`
- two bounds on one column → `max(0, lowSel + highSel - 1)` (the BETWEEN arithmetic)
- across an arm's columns → `combineConjunctive` (damped independence), never a product

`selectivityFromHistogram` and `combineConjunctive` are now exported from `@quereus/quereus`.

## The three cost decisions that key off `statsBacked`

`statsBacked` is true when every column filling an EQUALITY role in the arm had real
statistics. It means "this estimate is per-QUERY", and three things read it:

1. **The multi-seek's per-row resolution charge.** A statistics-backed multi-seek pays
   `multiRows × profile.pointRead`, like every single-window arm. An unbacked one does not —
   its `min(N, K × 0.1N)` union reaches the whole table at ten seek keys, so charging a
   per-row term against it prices an artifact.
2. **The seek-vs-scan veto's exemptions.** The blanket `isMultiSeek` exemption is replaced by
   `requestCarriesRuntimeSet || (isMultiSeek && !statsBacked)`. A literal `col in (…900
   values…)` over an analyzed 100-row table now correctly loses to a scan.
3. **`vetoCost`.** Kept, not deleted: `statsBacked ? plan.cost : <the arm priced at parity
   pointRead>`. Deleting it outright (which the parent plan asked for) would re-create the
   wholesale arm shutdown `store-backend-cost-profile` refused — on an un-analyzed table a
   fixed fraction makes the veto arm-*disabling* rather than arm-tuning.

Fallback is byte-identical to the pre-statistics module: same rows, same costs, same
exemptions, and that is pinned explicitly.

# Review findings

Reviewed the implement-stage diff (`ab673631` + `d6e900ff`) against the source before reading
the handoff. Validation re-run after every change below: `yarn build`, `yarn lint`,
`yarn typecheck` clean; `yarn test` fully green (quereus 9601 passing, quereus-store 1792
passing, no failures anywhere); `yarn test:store` 9593 passing / 33 pending — matching the
handoff's baseline. The pre-existing isolation-layer failure the handoff reported was already
resolved out-of-band by the triage commit `4bc2c8df`, and `tickets/.pre-existing-error.md` is
gone; no new pre-existing failure surfaced.

## Fixed in this pass

**An `ANALYZE` that ran while the table was empty disabled every equality arm on it.**
The one substantive defect found. A snapshot taken on an empty table has `rowCount: 0` and a
`distinctCount` of 0 for every column. `resolveArmEstimate` applied it literally, and
`1 / max(0, 1)` reads as **1** — "this equality matches every row" — which prices the arm
above a sequential scan and hands it to the veto. Since the request is sized from the *live*
row count (`sizeRequestFromLiveCount`) rather than from the stale snapshot, this bites as soon
as rows arrive.

Verified, not inferred. On a store-backed `t(id integer primary key, a integer)` with
`create index ix_a on t (a)`, analyzed while empty and then loaded with 2000 rows over 500
distinct values:

```
never analyzed      -> INDEX SEEK t USING ix_a
analyzed when empty -> INDEX SCAN t USING _primary_, residual WHERE a = 7
```

Both return the right 4 rows — it is speed-only — but it is a regression against the pre-change
module, and against this ticket's own headline guarantee: running `ANALYZE` at the wrong moment
made the plan strictly worse than never running it, and stayed that way until someone
re-analyzed. Reachable in ordinary use by any bootstrap script that analyzes before loading
data.

It is also a straight violation of the design rule the change hangs on: the engine never
applies a vacuous snapshot at all — `estimatePredicateSelectivity` short-circuits
`rowCount === 0` (`catalog-stats.ts:286`) and never reaches `estimateLeaf`'s formulas. The
store was the only side reading those zeroes as data.

Fixed by treating `rowCount <= 0` as no statistics, so the arm falls back wholesale to its
shape constant — correct whether the table is still empty or has since grown, and it restores
the byte-identical-to-pre-statistics property. Covered by a new test in
`column-statistics-plan.spec.ts` ("a snapshot taken while the table was empty is ignored once
rows arrive") that asserts the analyzed-empty plan is identical to the never-analyzed plan in
both rows and cost, and that the SQL still seeks. The fallback conditions in
`ARM_SELECTIVITY`'s doc comment, `docs/module-authoring.md` and `docs/optimizer-costing.md`
were extended to state the case.

## Filed

**The primary-key range arm never learned to read statistics.** Appended as a second arm to
the existing `backlog/bug-store-pk-range-preempts-cheaper-index`, which already claims that
exact code site — not filed fresh. The change taught the *secondary*-index arms to size
themselves per predicate and left the leading-PK range arm on its hardcoded 30%, so it is now
the only range arm in the module that `ANALYZE` cannot improve. Verified on an analyzed
1000-row table: `where id < 10` and `where id < 900` both advertise `est_cost` 150.2, i.e.
`rows = 0.3 × 1000` in both cases, against true fractions of 1% and 90%. Speed-only (the rows
are right), but the advertised count feeds join ordering, and it makes the arm-ordering
problem that ticket already describes sharper rather than milder — the arm that wins by
position is the one carrying the estimate statistics cannot sharpen.

**Nothing enforces the design rule across the package boundary.** Filed
`backlog/debt-store-engine-estimate-agreement-test.md`. This is the handoff's own known gap #2,
promoted rather than accepted: the engine's estimator is not exported from the package root, so
the current test pins the store against the shared *formula helpers* instead. That catches the
store drifting, but not the engine changing which formula applies to a predicate shape and
leaving the store behind — a change the store's own source explicitly contemplates (moving
equality from the distinct-count to the histogram for skewed columns). Filed at the
generalized-test rung rather than as a point ticket: one test over a table of predicate shapes
covers the class.

## Recorded as tripwires, not tickets

**The two-comparison spelling of a range disagrees with the engine.** `NOTE:` added at
`rangeBoundSelectivity`. The store's `max(0, low + high - 1)` is the engine's arithmetic for
`v between 10 and 20`, but the engine reaches it only from a `Between` node and folds
`v > 10 and v < 20` through `combineConjunctive` instead — roughly 2x looser. Kept as-is
deliberately: the store's is the more accurate of the two, and a claimed range leaves no
residual `Filter` carrying the engine's competing number to compare against. The note records
that the engine is the side that should move, and the engine-side improvement is already
tracked by `feat-multi-column-correlation-stats`, whose scope explicitly includes two
conditions on the same column.

## Checked and deliberately left alone

- **Formula parity with `CatalogStatsProvider.estimateLeaf`**, read line by line: equality
  `1/max(D,1)`, `IN` as `min(1, K/D)`, the histogram call and its argument order, and the
  BETWEEN arithmetic all match. The `rowCount: 0` short-circuit was the only divergence, fixed
  above.
- **Skew and mostly-NULL over-estimation, and the all-NULL `distinctCount: 0` column.** Both
  already carry `NOTE:` tripwires at the equality site, both are matched to the engine's own
  behaviour by design, and the all-NULL case has a test pinning it. Left per the
  accepted-tradeoff rule — the decision is recorded at the site and its revisit condition
  ("if a skewed equality is ever measured planning wrong, move BOTH") has not tripped. Worth
  knowing the estimate there is maximally wrong in the safe direction: `1` where the truth is
  ~0.
- **`combineConjunctive([])` returning 1 with `statsBacked: true`.** Traced every path: `eq`
  always has a non-empty `eqCols`, and `range`/`prefixRange` either push a factor or return
  the fallback. Unreachable, so no guard added.
- **The `usable` flag is ignored** by `rangeBoundSelectivity`. Consistent with the rest of the
  module — `claimFirstPerRole`, `resolveEqualityPins` and `hasLeadingPkRange` all ignore it
  too — so this is the file's existing convention, not new drift.
- **`key-set-seek-store.spec.ts` left unmodified.** The implement ticket asked for it to stay
  green analyzed *and* un-analyzed; the implementer measured 11 of 54 tests changing plan
  shape under a blanket analyze and judged the new plans correct (tiny fixtures where the seek
  keys approach the row count). Re-checked the reasoning and agree: the decline there is the
  engine's break-even, not this module's veto, and the exemption cannot and should not prevent
  it. The `NOTE:` at the `if (statsBacked)` charge site names the term to revisit, and the new
  spec asserts a key-set semi join returns identical rows either way at 3 and 400 keys.
- **The concave probe cost against the engine's two-point chord.** `NOTE:` at the multi-seek
  arm; the shape is pre-existing and `statsBacked` moves the kink further out, which is
  strictly better.
- **Source hygiene.** The file is 1157 lines at a 63% comment-and-blank ratio, which reads high
  in isolation but is within this repo's norm (measured siblings: `store-table-scan.ts` 0.53,
  `pk-key-resolution.ts` 0.71, `rule-select-access-path.ts` 0.39). Not an outlier, so no split
  or trim. The new functions are short and single-purpose. One cosmetic redundancy left as-is:
  `arm === 'range' ? [] : eqCols` at the `resolveArmEstimate` call is defensive — `eqCols` is
  always empty for that arm — but it documents the intent at the call site.
- **`stats-persistence.spec.ts`'s corrected probe.** The implementer replaced a broken
  `est_rows` probe (it read a `BLOCK` root reporting a fixed default that can never move) with
  `est_cost` off the table-access node. Confirmed this strengthens rather than loosens: the
  module's advertised `rows` reaches the plan only through the cost, so `est_cost` is the only
  observable that moves. Independently confirmed while probing the PK arm — the access node's
  `est_rows` reported 10 regardless of statistics, exactly as documented.
- **Docs.** Read every file the change touched and swept for others describing the store's
  selectivity constants; only `module-authoring.md` and `optimizer-costing.md` do, and both are
  accurate and now extended with the empty-snapshot case.
- **The engine's `>=` histogram branch** adds a term that looks dimensionally wrong
  (`1/max(D,1)/total`, making `>=` ≈ `>`). Pre-existing engine code, outside this diff, and it
  does not affect this ticket's correctness — the store matches the engine exactly either way,
  which is the design rule. Not pursued.

## Out of scope, carried forward as-is

`bug-store-pk-range-preempts-cheaper-index` (the arm-ordering half),
`feat-multi-column-correlation-stats`, and `debt-store-multi-seek-union-row-estimate` remain
open and correctly describe what is still unfixed.
