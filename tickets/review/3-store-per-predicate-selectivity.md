----
description: The persistent storage backend used to assume every indexed lookup matched a tenth of the table, so a lookup on a unique column was priced the same as one on a yes/no flag. It now uses the real per-column value counts the ANALYZE command collects, so it can tell a selective query from an unselective one.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # the estimator, the three cost decisions that key off it
  - packages/quereus/src/index.ts                                   # selectivityFromHistogram + combineConjunctive exports
  - packages/quereus-store/test/column-statistics-plan.spec.ts      # NEW — 27 tests, the estimator's behaviour
  - packages/quereus-store/test/cost-profile.spec.ts                # veto-policy block re-framed + a seam test added
  - packages/quereus-store/test/stats-persistence.spec.ts           # probe corrected (see "Things I changed that you might not expect")
  - docs/module-authoring.md                                        # reading tableSchema.statistics; the runtimeSet contract
  - docs/optimizer-costing.md                                       # "Where a module's own SELECTIVITY fits"
difficulty: hard
----

# What landed

`computeBestAccessPlan` in the store module used to size every secondary-index arm with a
fixed fraction of the table — equality 10%, prefix-equality-plus-a-bound 15%,
leading-column range 30%. Those are shape constants, not measurements, so `where status =
'active'` on a two-valued column and `where user_id = ?` on a near-unique column priced
identically.

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

`selectivityFromHistogram` and `combineConjunctive` are now exported from
`@quereus/quereus` (that half landed in the interrupted prior run, commit `ab673631`).

## The three cost decisions that key off `statsBacked`

`statsBacked` is true when every column filling an EQUALITY role in the arm had real
statistics. It means "this estimate is per-QUERY", and three things read it:

1. **The multi-seek's per-row resolution charge.** A statistics-backed multi-seek now pays
   `multiRows × profile.pointRead`, like every single-window arm does. An unbacked one still
   does not — its `min(N, K × 0.1N)` union reaches the whole table at ten seek keys, so
   charging a per-row term against it prices an artifact.
2. **The seek-vs-scan veto's exemptions.** The blanket `isMultiSeek` exemption is replaced by
   `requestCarriesRuntimeSet || (isMultiSeek && !statsBacked)`. A literal `col in (…900
   values…)` over an analyzed 100-row table now correctly loses to a scan.
3. **`vetoCost`.** Kept, not deleted: `statsBacked ? plan.cost : <the arm priced at parity
   pointRead>`. Deleting it outright (which the parent plan asked for) would re-create the
   wholesale arm shutdown `store-backend-cost-profile` refused — on an un-analyzed table a
   fixed fraction makes the veto arm-*disabling* rather than arm-tuning.

Fallback is byte-identical to the pre-statistics module: same rows, same costs, same
exemptions. That is the single most important regression guard here and it is pinned
explicitly.

# What a reviewer should actually try

## Use cases

```sql
-- Two tables, identical DDL, different data. Before ANALYZE both plan the same;
-- after, only the selective one seeks.
create table t (id integer primary key, c integer) using store;
create index ix_c on t (c);
-- t1: c is near-unique      -> `select … where c = 1` seeks
-- t2: c holds two values    -> `select … where c = 1` scans (on a pointRead >= ~3 backend)
analyze t;
```

```sql
-- The 10x disagreement this removes: `c = 1` and `c in (1)` used to price 10x apart.
-- They now agree, and K members estimate K times one equality until the union saturates
-- at K = distinctCount.
```

```sql
-- Range bounds now read the histogram rather than assuming 30%:
--   `where v < 20`  over v in 1..200  -> ~7.5% -> seeks even at IndexedDB's pointRead 3.0
--   `where v < 100` over v in 1..200  -> ~47%  -> scans
```

## Validation

- `packages/quereus-store/test/column-statistics-plan.spec.ts` — 27 tests, all green. Covers
  un-analyzed parity per arm, the 1/D equality, agreement with the engine's own combination,
  IN scaling and clamping, histogram ranges (one-sided, two-sided, and the seek→scan flip on
  an IndexedDB-like profile), wholesale fallback (renamed column, one column of a composite),
  the runtime-set probe at 2 and 1000 keys plus collinearity, and the degenerate sizes
  (`rowCount: 0`, `distinctCount: 0`, one row).
- `packages/quereus-store/test/cost-profile.spec.ts` — the "veto is profile-independent"
  block is re-framed as "…on an un-analyzed table" and gains a seam test where the SAME arm,
  SAME profile, flips its verdict once `ANALYZE` has run.
- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — one failure, pre-existing and unrelated (below).
- `yarn test:store` — 9593 passing, 33 pending. Green.

# Known gaps — read these before trusting the tests

**1. `key-set-seek-store.spec.ts` does NOT stay green if you analyze every fixture, and the
ticket predicted it would.** Unchanged (as committed) it is green. But I re-ran it under a
throwaway harness that fires `analyze <table>` after every `insert into <table>`, and 11 of
its 54 tests change plan shape. Every one is a table where the seek keys approach the table's
own row count — 3-and-4-row toy fixtures, plus the 1000-row `cap` table probed at exactly
1000 keys. In each case the engine's own break-even correctly prefers a scan, and I judged
that to be right rather than a defect: seeking 1000 keys to read a 1000-row table loses to
reading it once.

The ticket's reasoning about this was wrong in a specific way worth understanding: the
`runtimeSet` exemption stops **this module** from substituting a scan verdict, but the
decline here is **the engine's**, made by `rule-key-set-seek` interpolating a break-even from
the two probe costs — which are now higher because the multi-seek pays its resolution charge.
The exemption cannot and should not prevent that.

What I did instead of touching that spec: added a test in the new spec asserting a key-set
semi join returns identical rows analyzed or not, at 3 keys and at 400, whichever plan the
engine picks. If you disagree with the judgment call, the term to revisit is the
`if (statsBacked) multiSeekShape.addCost(...)` line, and there is a `NOTE:` at that site.

**2. The "estimate agreement" test does not compare against `CatalogStatsProvider`
directly.** The ticket asked for `round(estimatedRows × CatalogStatsProvider.selectivity(…))`.
`CatalogStatsProvider` is not exported from the package root, and calling it needs a
`ScalarPlanNode` predicate that a store test cannot cheaply build. I also checked whether the
engine's own number is observable through `query_plan()` — it is not: a `FILTER` node's
`est_rows` reports the default 10 regardless of statistics. So the test pins the formula
independently, via the exported `combineConjunctive` / `selectivityFromHistogram`. That
catches the store diverging from the *formula*, not from a future change to
`CatalogStatsProvider` itself. If you want the stronger pin, it needs an engine-side export
or a shared fixture.

**3. Not fixed, deliberately: `bug-store-pk-range-preempts-cheaper-index`** (backlog). The
primary-key arms still return before any secondary index is considered, so an unselective PK
range still preempts a selective secondary index whatever the statistics say. Out of scope
per the ticket.

**4. Correlated composite columns and skew are still mis-estimated.** `combineConjunctive`'s
damped independence over-estimates selectivity for `(city, state)`-shaped indexes
(`backlog/feat-multi-column-correlation-stats`), and `1/D` assumes uniformity so a 99/1
two-valued column is still mispriced for the common value. Both are matched to the engine's
own behaviour by design; both are recorded as `NOTE:` tripwires at the equality site rather
than as tickets.

**5. The probe cost is concave, and the engine fits a chord through two points.** Cost is
linear in K until `multiRows` clamps at `K ≈ D`, then near-flat. A two-point interpolation
under-reads the true cost in between, so the engine can rewrite slightly more eagerly than
the model warrants. Pre-existing shape (the unbacked model clamped at K = 10 and was concave
too) — `statsBacked` moves the kink much further out, which is strictly better. Recorded as
a `NOTE:` at the multi-seek arm.

# Things I changed that you might not expect

**`stats-persistence.spec.ts`'s probe.** Its test "plans the reopened database exactly as it
planned before the close" was FAILING at HEAD. It probed `est_rows` of the plan's root row,
which is a `BLOCK` node reporting a fixed default of 10 — it can never move, analyzed or not.
The estimate does move (that query's table-access cost goes 130.3 → 8.1 once `ANALYZE` runs).
I replaced the helper with `planAccessCost`, which reads `est_cost` off the table-access node,
and documented why `est_rows` cannot serve: an access node's `est_rows` is the engine's own
estimate, while the module's advertised `rows` lives on `filterInfo.indexInfoOutput` and
reaches the plan only through the cost. This is a strengthened probe, not a loosened one —
the test now actually observes what it claims to.

**`cost-profile.spec.ts`'s policy block was re-framed, not weakened.** Its assertions were
written to say "the veto never reads the declared profile". That is now only true for
un-analyzed tables, which is every table in that file — so the block is retitled and its
header re-states the boundary, and a new test pins the other side of the seam so that
deleting the `statsBacked` condition fails there.

# Pre-existing failure (not mine)

`yarn test` has one failure, recorded in `tickets/.pre-existing-error.md`:

```
packages/quereus-isolation/test/isolation-layer.spec.ts:5269
  ANALYZE on an isolated table inside an open transaction with a dirty overlay succeeds
  AssertionError: expected 2 to equal 3
```

Broken at HEAD by commit `7471536d`, which gave `IsolatedTable` a `getStatistics` delegation.
`ANALYZE` reads a present `getStatistics` as a cheap answer and skips the scan — and the scan
was what saw the transaction's uncommitted row. The failing test builds
`new IsolationModule({ underlying: new MemoryTableModule() })` and never loads the store
package; this ticket's diff is confined to `packages/quereus-store` and `docs/`.

# Where to look first

`packages/quereus-store/src/common/store-module-access-plan.ts`:

- `resolveArmEstimate` (~line 255) — the estimator and the `statsBacked` rule
- `columnStatsFor` (~line 177) — the index → current-name → stats lookup that makes
  `ALTER TABLE RENAME COLUMN` degrade rather than mis-attribute
- `rangeBoundSelectivity` (~line 202) — the histogram half
- the multi-seek arm inside `tryIndexAccessPlan` (~line 975) — the conditional resolution
  charge and its reasoning
- the veto site in `computeBestAccessPlan` (~line 633) — the two exemptions and the
  conditional `vetoCost` policy
