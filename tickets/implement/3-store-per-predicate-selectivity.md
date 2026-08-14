<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-08-14T17:57:41.183Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\3-store-per-predicate-selectivity.implement.2026-08-14T17-57-41-183Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
----
description: The persistent storage backend guesses that any indexed lookup matches a tenth of the table, so it prices a lookup on a unique column exactly like one on a yes/no flag. Make it use the real per-column value counts the ANALYZE command already collects, so it can tell a selective query from an unselective one.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # ARM_SELECTIVITY, IndexPlanCandidate.vetoCost, the multi-seek exemptions, the seek-vs-scan comparison
  - packages/quereus-store/src/common/store-module.ts               # getBestAccessPlan / sizeRequestFromLiveCount — the entry point
  - packages/quereus/src/planner/stats/catalog-stats.ts             # TableStatistics / ColumnStatistics — already public via the package index
  - packages/quereus/src/planner/stats/histogram.ts                 # selectivityFromHistogram — needs exporting from the package index
  - packages/quereus/src/planner/stats/selectivity-combine.ts       # combineConjunctive — needs exporting from the package index
  - packages/quereus/src/index.ts                                   # the two new exports
  - packages/quereus-store/test/cost-profile.spec.ts                # pins today's veto policy; needs analyzed-table counterparts
  - packages/quereus-store/test/key-set-seek-store.spec.ts          # must stay green, analyzed and un-analyzed
  - packages/quereus-store/test/pushdown.spec.ts                    # existing access-plan assertions
  - docs/module-authoring.md                                        # what a module may read off the TableSchema it is handed
  - docs/optimizer-costing.md                                       # the cost model this changes
difficulty: hard
----

# What is wrong today

`computeBestAccessPlan` (`packages/quereus-store/src/common/store-module-access-plan.ts`)
estimates how many rows an index access returns with three fixed fractions of the table's
size — `ARM_SELECTIVITY`: equality 10%, prefix-equality-plus-bound 15%, leading-column
range 30%. They are shape constants, not measurements, so:

- `where status = 'active'` on a two-valued column and `where user_id = ?` on a
  near-unique column price identically.
- A single equality is priced at 10% of the table while ONE member of `where col in
  (v1, v2)` is priced at the same 10% — so an equality and a one-element IN disagree by 10×
  on the same column.
- Every cost decision is per-ARM (per index shape) rather than per-QUERY, which is what
  forced two workarounds that this ticket removes (below).

## The key finding: the numbers already exist, and the module can already see them

This ticket's parent plan assumed the store would have to collect and maintain its own
distinct-value counts in the `__stats__` store. It does not. The engine already has the
whole surface:

- `ANALYZE` scans the table (`packages/quereus/src/planner/stats/analyze.ts`) and produces a
  `TableStatistics`: per-column `distinctCount`, `nullCount`, `minValue`, `maxValue`, and an
  equi-height `histogram`, keyed by lowercase column name.
- `emitAnalyze` writes that onto the schema as `TableSchema.statistics` and re-registers the
  table, so subsequent planning sees it.
- `CatalogStatsProvider` (`planner/stats/catalog-stats.ts`) already consumes it for filter
  and join selectivity.
- **`VirtualTableModule.getBestAccessPlan(db, tableSchema, request)` is handed the
  `TableSchema` itself.** `tableSchema.statistics` is therefore already in scope inside
  `computeBestAccessPlan` — it is simply never read.

So the work here is consumption, not collection, and no change to
`BestAccessPlanRequest` is needed. (Making these numbers survive a database reopen IS still
missing; that is the follow-on ticket `store-persist-column-statistics`.)

## The design rule this ticket adopts

**The store's row estimate for a predicate must be the number the engine's
`CatalogStatsProvider` would produce for the same predicate.** A seek's advertised `rows`
and the estimate a residual `Filter` above it carries are describing the same row set; if
they disagree the optimizer is comparing two different worlds. So every formula below is
copied from `CatalogStatsProvider.estimateLeaf`, and the two shared numeric helpers are
imported from the engine rather than restated.

# Design

## Per-predicate selectivity

Add a selectivity resolver that, for a given arm and its seek columns, returns a fraction of
`request.estimatedRows` plus a flag saying whether real statistics produced it.

Column statistics are keyed by **lowercase column name**; the store works in column
**index**. Map through `tableInfo.columns[colIdx].name.toLowerCase()`.

Per-column factors, matching `CatalogStatsProvider.estimateLeaf` exactly:

| predicate on column c | factor |
|---|---|
| `c = v` | `1 / max(distinctCount, 1)` |
| `c in (v1 … vK)` | handled as K seeks of the equality factor — see multi-seek below |
| `c > v` / `>=` / `<` / `<=` | `selectivityFromHistogram(histogram, op, value, rowCount)` when a histogram and a plan-time `value` are both present; otherwise the arm's existing constant |
| both a lower and an upper bound on c | `max(0, lowSel + highSel - 1)`, mirroring the engine's BETWEEN handling |

Combining factors across the several columns an arm pins uses the engine's
`combineConjunctive` (damped independence — see
`packages/quereus/src/planner/stats/selectivity-combine.ts`), NOT a plain product. Restating
the product here would diverge from the engine's estimate for the same conjunction, which is
the one thing the design rule forbids.

**Statistics-backed** means: every column filling an EQUALITY role in the arm has a
`distinctCount`. A range factor that falls back to its constant does not by itself make the
arm unbacked — a `prefixRange` whose prefix has counts is still a per-query estimate.

**Fallback is exactly today's behaviour.** An arm that is not statistics-backed uses
`ARM_SELECTIVITY[arm]` unchanged, and everything downstream (below) keys off the flag so an
un-analyzed table plans byte-identically to today. `ARM_SELECTIVITY` stays in the file as
that fallback; its long `NOTE` about "the fix is real per-column statistics" is replaced by a
statement of when the constants are still reached.

## Two exemptions come out, one veto becomes conditional

Three interlocking workarounds exist today because the row estimate was a clamp rather than
an estimate. Each is re-decided:

**1. The multi-seek's missing per-row resolution charge.** Today the `plan=5` arm alone pays
no `profile.pointRead` per fetched row, because `multiRows = min(N, inCount × 0.1N)` reaches
the whole table at 10 seek keys — charging a per-row term against that clamp prices an
artifact. Under `1/D` estimation `inCount × N/D` only reaches N as K approaches D, which is
the honest point. So: **charge `multiRows × profile.pointRead` on the multi-seek arm iff the
arm is statistics-backed.** Unbacked ⇒ no charge, exactly as today.

**2. The multi-seek's exemption from the seek-vs-scan comparison.** Replace the blanket
`isMultiSeek` exemption with two narrower ones:

```
exemptFromVeto =
     requestCarriesRuntimeSet          // any filter with `runtimeSet` set
  || (isMultiSeek && !statsBacked)     // the row estimate is a clamp, as today
```

The first clause is the fix the existing NOTE at the comparison site already prescribes
verbatim ("the comparison has to exempt any request carrying a runtime-valued set, not just
the arm this module happens to pick for it"). A `runtimeSet` filter is only ever produced by
`rule-key-set-seek`'s synthesized probes (`probeModuleCosts` in
`packages/quereus/src/planner/rules/access/rule-key-set-seek.ts`) and by the key-set semi
join itself — the engine reads a probe answer that names no index as "the module declined"
and abandons the whole rewrite, so the module must never substitute its own scan verdict
there. The engine makes the scan comparison itself, off the two costs it interpolates.

A **literal** `col in (v1 … vK)` on an analyzed table is therefore now judged by the veto —
900 keys against a 100-row table correctly loses to a scan.

**3. `vetoCost` — the parity-priced veto — becomes the no-statistics fallback rather than
disappearing.** The parent plan asked for `vetoCost` to be deleted outright. Its premise was
"once selectivity is estimated per predicate". That premise does not hold on an un-analyzed
table, and deleting the field unconditionally would re-create precisely the wholesale arm
shutdown `store-backend-cost-profile` refused: with IndexedDB's declared `pointRead: 3.0`,
the fixed 30% range arm costs `0.3·N·(0.5 + 3.0) = 1.05·N` against a scan's `N` — vetoed for
every query on every table forever. So:

```
vetoCost = statsBacked ? plan.cost : <the arm priced at PARITY_COST_PROFILE.pointRead>
```

Rewrite the field's doc comment to say that, and rewrite the long reasoning block at the
comparison site: the declared profile decides an arm's fate **per query, once the estimate is
real**, and falls back to the parity price only where the estimate is still a shape constant.

Expected effect on IndexedDB (`pointRead: 3.0`), which is the outcome the parent plan
predicted and the bench in `packages/quereus-plugin-indexeddb/bench/README.md` confirms:

- range arm break-even is `1/(0.5 + 3.0) ≈ 0.286` of the table. A range the histogram puts at
  25% seeks; one it puts at 35% scans. Today's fixed 0.3 sits just above the line, which is
  why it had to be judged at parity instead.
- equality arm break-even is `1/(0.3 + 3.0) ≈ 0.303`.

## What stays as it is

- The primary-key arms already estimate honestly (`min(estimatedRows, seekKeyCount)` — the PK
  is unique, so `D = N` and `K × N/D = K` already). Do not rework them; do route the
  `_primary_` multi-seek through the same `runtimeSet` exemption wording so both arms state
  one rule.
- `MAX_MULTI_SEEK_KEYS`, every collation gate, every semantic-ordering decline, and
  `claimFirstPerRole`'s positional claiming are untouched. This ticket changes **cost only**;
  no arm becomes available or unavailable on soundness grounds, and no row set changes.
- `Math.max(1, …)` on every row estimate stays load-bearing (a `rows: 0` plan claiming every
  filter makes `rule-select-access-path` fold the table access to `EmptyResultNode`).
- The store's `getStatistics()` keeps reporting a row count with an empty `columnStats`.
  `collectTableStatistics` (`runtime/emit/analyze.ts`) reads a non-empty `columnStats` as
  "this module answered cheaply, skip the scan", so reporting anything there would make
  `ANALYZE` stop collecting the very numbers this ticket consumes.

## Engine-side changes

Two pure helpers move from private to public so the store can share them instead of restating
their formulas. Both already live in `packages/quereus/src/planner/stats/`:

```ts
// packages/quereus/src/index.ts
export { selectivityFromHistogram } from './planner/stats/histogram.js';
export { combineConjunctive } from './planner/stats/selectivity-combine.js';
```

`TableStatistics`, `ColumnStatistics`, `EquiHeightHistogram` and `HistogramBucket` are
already exported (`packages/quereus/src/index.ts:367`). No other engine change is required.

# Edge cases & interactions

- **Un-analyzed table** — the common case until someone runs `ANALYZE`. Every arm must cost
  byte-identically to today, including the multi-seek's missing `pointRead` term and the
  parity-priced veto. Pin this with explicit cost-equality assertions; it is the single most
  important regression guard in the ticket.
- **Analyzed table with `rowCount: 0`.** `catalogRowCount` returns 0, and the `estimatedRows
  || undefined` spellings in `rule-select-access-path` / `rule-grow-retrieve` collapse 0 to
  "unknown" — so the request arrives with `estimatedRows` absent and
  `sizeRequestFromLiveCount` fills the live count. Selectivity is still a fraction, so this
  composes; assert no arm returns `rows: 0`.
- **`distinctCount: 0`** (a column that is entirely NULL). `1 / max(D, 1)` = 1 ⇒ the arm
  estimates the whole table ⇒ it loses the veto and scans. Correct, but assert it rather than
  discovering a division by zero.
- **A column with statistics for some seek columns and not others** — e.g. a composite index
  where one column was added by `ALTER TABLE` after the last `ANALYZE`. The arm must fall
  back wholesale rather than mixing a real factor with a shape constant.
- **`ALTER TABLE RENAME COLUMN` / `DROP COLUMN` after `ANALYZE`.** `columnStats` is keyed by
  name, so a renamed column silently has no statistics and a dropped column shifts every
  later column's index. Both must degrade to the fallback, never to a mis-attributed count —
  the lookup goes index → current name → stats, so a renamed column misses and an
  index shift cannot borrow a neighbour's numbers. Cover the rename case with a test.
- **`rule-key-set-seek` probes on an ANALYZED table.** `probeModuleCosts` asks at 2 and 1000
  keys and requires both answers to name the SAME index; if either declines, the whole
  rewrite is abandoned. Verify the module still names an index at both points on an analyzed
  table of a few hundred rows, and that the cost stays a straight line in K (the engine
  interpolates a break-even from exactly two points — a non-linear cost would make the
  interpolation meaningless). Under `statsBacked` the cost is
  `K·seekPositioning + min(N, K·N/D)·(0.3 + pointRead)`, linear until the clamp bites at
  `K ≈ D`.
- **`key-set-seek-store.spec.ts` must stay green in both states.** The 16 previously-measured
  failures came from charging a per-row term against a clamped estimate on 3-to-4-row tables;
  the `runtimeSet` exemption plus the statistics-backed gate is what keeps them passing.
  Run that file both as-is and with an `analyze` inserted after the fixtures.
- **`cost-profile.spec.ts` § "the seek-vs-scan veto is profile-independent"** asserts today's
  policy deliberately, as the marker that the choice was made on purpose. Those assertions
  stay true for un-analyzed tables; re-frame the describe block to say so and add analyzed
  counterparts where the declared profile DOES decide.
- **Two indexes competing.** The existing NOTE about an index on `(a)` out-pricing `(a, b)`'s
  `prefixRange` arm (constants 0.1 vs 0.15) is partly self-resolving under real estimates —
  re-check the comment against the new arithmetic and update or delete it rather than leaving
  a stale claim.
- **Correlated composite index columns.** `combineConjunctive`'s damped independence still
  over-estimates selectivity for `(city, state)`-shaped indexes. Out of scope; the theme
  ticket is `backlog/feat-multi-column-correlation-stats`.
- **Skew.** `1/D` assumes uniformity, so a 99/1 two-valued column is still mispriced for the
  common value. The histogram carries per-bucket distinct counts and could answer equality
  too, but `CatalogStatsProvider` uses `1/D` for `=` and the design rule above says match it.
  Record as a `NOTE:` tripwire at the equality site — not a ticket — naming the revisit
  condition (an equality on a skewed column measured planning wrong) and the fix (move BOTH
  the engine and the store to the histogram together).
- **NULLs.** `1/D` counts distinct NON-NULL values but is applied against the full row count,
  so a mostly-NULL column over-estimates matches. Same treatment: a `NOTE:` tripwire, not a
  divergence from the engine.
- **`bug-store-pk-range-preempts-cheaper-index`** (backlog) is untouched: the primary-key arms
  still return before any secondary index is considered, so an unselective PK range still
  preempts a selective secondary index whatever the statistics say. Say so in the handoff;
  do not fix it here.

# Key tests

In `packages/quereus-store/test/` — a new `column-statistics-plan.spec.ts` for the estimation
behaviour, plus the amendments to `cost-profile.spec.ts` named above.

- **Un-analyzed parity.** For each arm, the advertised cost and rows equal today's values
  exactly. (Capture the current numbers first, then refactor.)
- **IN grows with K, and agrees with a single equality.** On one analyzed column, the `rows`
  advertised for `col in (v1 … vK)` is K× the `rows` advertised for `col = v1`, until it
  clamps at the table size. This is the specific 10× disagreement the parent plan called out.
- **Same schema, different data.** Two tables with identical DDL and an index on `c`; one
  loaded so `c` is near-unique, one so `c` holds two values. After `analyze`, the first
  plans an index seek and the second plans a full scan — with identical SQL.
- **Range flips on the histogram.** On an analyzed table with an IndexedDB-like profile
  (`pointRead: 3.0`), a range covering ~10% of the column's value span seeks and one covering
  ~50% scans.
- **Estimate agreement.** For one equality predicate on an analyzed table, the store's
  advertised `rows` equals `round(estimatedRows × CatalogStatsProvider.selectivity(...))` for
  the same predicate — the design rule, pinned.
- **Runtime-set probe survives analysis.** On an analyzed few-hundred-row table, both the
  2-key and the 1000-key probe name the same index, and the two costs are collinear with a
  third point (e.g. 500 keys).
- **Literal IN loses to a scan when it should.** `col in (…900 values…)` over an analyzed
  100-row table returns the full-scan plan.
- **Renamed column degrades.** `analyze`, then `alter table … rename column`, then plan: the
  arm falls back to its shape constant and the answer is unchanged.

# TODO

## Phase 1 — engine exports and the estimation core

- Export `selectivityFromHistogram` and `combineConjunctive` from
  `packages/quereus/src/index.ts`; confirm `yarn build` still passes for every dependent
  package.
- Capture today's advertised costs for each arm as fixture numbers, so the un-analyzed parity
  test is written against measured values rather than re-derived formulas.
- Add the selectivity resolver to `store-module-access-plan.ts`: column-index → lowercase
  name → `ColumnStatistics`; the per-column factor table above; `combineConjunctive` across
  an arm's columns; a `statsBacked` flag; fallback to `ARM_SELECTIVITY`.
- Rewrite `ARM_SELECTIVITY`'s doc comment to describe when it is still reached, replacing the
  "the fix is real per-column statistics" note.

## Phase 2 — the three workarounds

- Charge `multiRows × profile.pointRead` on the multi-seek arm when `statsBacked`.
- Replace the `isMultiSeek` veto exemption with the `runtimeSet` / `!statsBacked` pair;
  detect `runtimeSet` once at the top of `computeBestAccessPlan` and thread it.
- Make `vetoCost` conditional on `statsBacked`; rewrite its doc comment and the reasoning
  block at the comparison site.
- Route the `_primary_` multi-seek arm's own exemption comment through the same wording so
  the two arms state one rule.

## Phase 3 — tests and docs

- Write `column-statistics-plan.spec.ts` covering the test list above.
- Re-frame `cost-profile.spec.ts` § "the seek-vs-scan veto is profile-independent" and add
  its analyzed counterparts.
- Run `key-set-seek-store.spec.ts` unchanged AND with `analyze` inserted; both green.
- Add the two `NOTE:` tripwires (skew, NULLs) at the equality site.
- Update `docs/module-authoring.md` — a module may read `tableSchema.statistics` inside
  `getBestAccessPlan`, and the contract that a request carrying `runtimeSet` must never be
  answered with the module's own scan verdict.
- Update `docs/optimizer-costing.md` with the store's new per-predicate model and its
  fallback.
- `yarn build`, `yarn lint`, `yarn test`, and `yarn test:store` (this changes store planning,
  so the store-backed logic run is in scope, not optional).
