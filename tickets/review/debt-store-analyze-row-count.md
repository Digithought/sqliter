----
description: The persistent storage backend keeps a running count of how many rows each table holds; it now reports that count to the query planner, so plan costs over a stored table reflect its real size instead of a fixed guess of 1000 rows.
files:
  - packages/quereus-store/src/common/store-table-base.ts                 # primeStats, getKnownRowCount, getStatistics
  - packages/quereus-store/src/common/store-module.ts                     # getBestAccessPlan — the live-count substitution + its floor
  - packages/quereus/src/runtime/emit/analyze.ts                          # collectTableStatistics — vtab report vs scan
  - packages/quereus/src/index.ts                                         # TableStatistics/ColumnStatistics now exported
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # NOTE: only (the rows===0 fold)
  - packages/quereus-store/test/store-row-count-to-planner.spec.ts        # new, 11 tests
  - packages/quereus/test/optimizer/statistics.spec.ts                    # new "size-only getStatistics()" block
  - docs/store.md, docs/optimizer.md, docs/module-authoring.md
difficulty: medium
----

# Let the planner learn how many rows a stored table actually holds

## The ticket's premise was half wrong — read this first

The implement ticket said `ANALYZE` on a store table "collects nothing" and the schema entry
"still reported 0 rows and no statistics object at all", because `StoreTable` implements no
`getStatistics()`.

**That is not what happens.** `emitAnalyze` already falls back to
`collectStatisticsFromScan` when a table has no `getStatistics()`, and a store table supports
`query()`, so `ANALYZE` over one already collected an exact row count *and* full per-column
statistics. Verified before touching anything: 200 rows inserted into a store table,
`analyze t`, schema entry reported `rowCount: 200` with `columnStats` for every column.

That inverted the whole shape of the fix. Implementing a row-count-only `getStatistics()`
the way the ticket describes would have *short-circuited* that scan and made `ANALYZE`
collect **strictly less** than before — no distinct counts, no null counts, no min/max, no
histograms, so every selectivity estimate over a store table would fall back to naive
guesses. The real gap the ticket's own symptoms describe (the `where col in (select …)`
break-even always clamping at the 1000-key ceiling) is the **never-analyzed** case, which
`ANALYZE` by definition does not cover.

So the work landed as three seams instead of one. All three are in place.

## What shipped

### 1. `StoreTable.getStatistics()` — the interface the ticket asked for

`store-table-base.ts`. Returns the maintained row count in O(1) (no scan) with an **empty**
`columnStats`, because the store keeps no value distribution at all — a distinct count or a
histogram would cost a full scan of the table or of an index.

### 2. `ANALYZE` no longer loses column statistics to a size-only report

`runtime/emit/analyze.ts`, new `collectTableStatistics`. The old rule was "module implements
`getStatistics()` ⇒ use it verbatim, else scan". The new rule discriminates on **richness**,
not presence:

- a report carrying per-column statistics is used verbatim (unchanged for `MemoryTable`,
  which reads exact counts off its BTree metadata);
- a report with an empty `columnStats` reads as *"I answered the size, collect the rest
  yourself"* and the scan still runs;
- where both answer the row count, the **scan wins** — it counted every live row, while a
  delta-tracked count is an estimate that can drift, and reconciling that drift is much of
  what a user runs `ANALYZE` for;
- neither available (no `getStatistics()`, no `query()`) ⇒ undefined, as before.

Net effect for a store table: `ANALYZE` collects exactly what it did before this ticket.
That is deliberate, not an oversight — see the gap list below for what it costs.

### 3. The live count reaches access planning without `ANALYZE`

`StoreModule.getBestAccessPlan` fills in `BestAccessPlanRequest.estimatedRows` from a new
synchronous `StoreTable.getKnownRowCount()` (the in-memory committed count plus the open
transaction's buffered delta) **when the planner supplied none**. A planner-supplied hint
always wins, so the access path is never costed against a different figure than the plan
around it.

`getKnownRowCount()` is synchronous because `getBestAccessPlan` is a synchronous engine
callback. That is what makes seam 4 necessary.

### 4. Fixed: the persisted count was discarded by the first write after a reopen

`trackMutation` / `applyPendingStats` seed a missing `cachedStats` with `rowCount: 0` and add
their delta to it. Nothing loaded the persisted count first, so a database reopened with 500
rows reported **1** after a single insert, and the next stats flush made that durable. Latent
before (nothing read the count for planning); a live wrong number now.

`initializeStore()` now calls a new `primeStats()` — one extra KV `get` per table per
session, on the path every read and write already awaits before touching storage. Failures
warn and leave the count unknown rather than failing the query that opened storage (same
advisory posture as the rename path's stats re-key).

### 5. The trap this ran into — `rows: 0` is a claim, not an estimate

Seam 3 initially broke `93.4-view-mutation.sqllogic` under the store backend: an outer-join
view update returned `pv: null` for a row it had just written. Root cause found and
understood, not worked around:

`rule-select-access-path.ts` folds an access plan with `rows === 0` into a **static empty
relation**. The guard meant to restrict that to a proven-impossible predicate is
`handledFilters.every(...)`, which is **vacuously true for a plan with no filters**. So an
honest live count of 0 on a full scan deleted the table read from the plan — and the
statement wrote rows into that table before reading it.

Fix on the store side: the substituted count is floored at 1, with the reasoning recorded at
the site. `MemoryTableModule` takes the same posture from the other direction (emits `rows: 0`
only for `IS NULL` on a `NOT NULL` column; maps an incoming 0 to "unknown").

The engine-side hardening is filed as `backlog/debt-empty-access-plan-fold-trusts-estimate`
(dormant — no shipped module reports a live 0), with a `NOTE:` at the fold site pointing to
it. **This is the one thing in this change most worth a second opinion**: I judged the
store-side floor to be the correct fix for *this* ticket and the vacuous-`every` guard to be
a separate defect. A reviewer could reasonably argue the guard should have been fixed here.

## Use cases to exercise

Behaviour a reviewer should be able to reproduce by hand:

- **Small stored table, never analyzed.** `create table t (...) using store`, insert 17 rows,
  ask the module for an access plan with no `estimatedRows` hint → `rows: 17`, previously
  1000. This is the ticket's headline case: the `where col in (select …)` break-even is
  computed from the backend's own cost numbers, which were being computed against 1000.
- **`ANALYZE` over a store table.** Still yields the exact scanned count and full per-column
  statistics; a deliberately corrupted maintained count (`resetStats(999)`) is reconciled back
  to the true count by `ANALYZE`.
- **Empty stored table.** Costs as 1 row, never 0. Emptied-by-delete behaves the same as
  never-filled-but-counted.
- **Mid-transaction.** `begin; insert 3 rows;` → the plan is costed against 8 rows on a
  5-row table; `rollback` returns it to 5.
- **Reopen.** Persisted count survives; the first insert after reopen adds to it; a plain
  `select` (no write at all) is enough to make the persisted count available to costing.
- **Any statement that writes a table and then reads it back** — a view update over a LEFT
  JOIN materializing its non-preserved-side row is the sharp case, covered by
  `93.4-view-mutation.sqllogic` under `yarn test:store`.

## Known gaps — please treat these as the starting point

- **Engine-side costs still need `ANALYZE`.** Seam 3 fixes the *access path* only. Join
  ordering, cache thresholds and sort costs read `TableSchema.statistics` via
  `catalogRowCount`, which only `ANALYZE` writes — so those still see the never-analyzed
  table's 0/1000. Closing that means publishing the store's count into the engine catalog,
  which I deliberately did **not** do: `schema.addTable` + a `table_modified` notification
  invalidates cached plans and (per `docs/mv-schema-change.md`) touches materialized-view
  liveness, so doing it per stats-flush is a much larger change with real churn risk. The
  ticket's second bullet under "Why it matters" is therefore only partly addressed. Not
  filed as a follow-up ticket — it is a design decision that wants a plan, and I did not want
  to file a ticket that is really "should we do this at all".
- **An empty store table is costed as 1 row, not 0.** Consequence of the floor. Harmless
  (any plan over 0 or 1 rows is cheap) but it is a deliberate inaccuracy.
- **A freshly created table has no count until its storage is opened**, so its first plan
  still uses the 1000 placeholder. `StoreModule.create` could seed `cachedStats` with 0 —
  which would then floor to 1 anyway, so I left it. Pinned as an assertion in the spec so a
  reviewer sees the boundary rather than trips over it.
- **`getKnownRowCount()` includes the open transaction's buffered delta but not per-statement
  ordering.** Within a multi-statement transaction the count is whatever has been applied so
  far; I did not chase savepoint-level precision.
- **The expected golden-plan fallout did not materialise.** The ticket budgeted for
  regenerating EXPLAIN fixtures. Nothing needed regenerating — the golden corpus never runs
  `ANALYZE`, and the store-side substitution only moves costs, not plan shape, on the corpus.
  If a reviewer thinks a golden fixture *should* have moved, that is worth chasing: it would
  mean the seam is not reaching a path I believe it reaches.
- **No test asserts the end-to-end break-even change** the ticket describes (the
  `where col in (select …)` key-set-seek decision). `key-set-seek-store.spec.ts`'s "engine
  ceiling on seek keys" block still passes unchanged because its `cap` table holds exactly
  1000 rows — the live count and the old placeholder coincide there by luck. Its comment
  block still says the planner "never learns a store table's real row count" and is now
  **stale**; I left it alone rather than rewrite another ticket's prose, but it should
  probably be corrected. That comment also names this ticket by slug.
- **Doc size.** `docs/module-authoring.md` was already over the 12,000-word cap at HEAD
  (12,226) and my additions took it to 12,429. `yarn docs:check` was already red at HEAD for
  `docs/schema.md` and `docs/sync.md`; I appended the `module-authoring.md` arm to the
  existing `backlog/debt-doc-size-ratchet-red-at-head` rather than filing a new ticket. The
  content I added there is the `rows: 0` contract, which is exactly what cost a debugging
  cycle here — I judged it load-bearing, but it is a fair thing to push back on.

## Verification

All from the repository root.

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc --noEmit` over the quereus specs).
- `yarn typecheck` — clean across all workspaces.
- `node packages/quereus/test-runner.mjs` (memory) — **8251 passing, 0 failing, 13 pending**.
- `yarn test:store` (LevelDB backend) — **8243 passing, 0 failing, 21 pending**.
- `yarn workspace @quereus/store run test` — **1248 passing, 0 failing** (1237 before this
  change; the new spec file contributes 11).
- `yarn test` (every workspace) — clean.
- `yarn docs:check` — **3 failures, all doc-size, none introduced by the source change**:
  `schema.md` and `sync.md` were red at HEAD, `module-authoring.md` was over the cap at HEAD
  (12,226 > 12,000) before I touched it. `tickets/.pre-existing-error.md` not written — this
  is a size ratchet already tracked by `backlog/debt-doc-size-ratchet-red-at-head`, not a
  failing test.

No pre-existing test failures observed in any run.

## New tickets filed

- `backlog/debt-empty-access-plan-fold-trusts-estimate` — the engine trusts a `rows: 0`
  cardinality *estimate* as a *proof* the table is empty, behind a vacuously-true guard.
  Dormant with shipped modules; a plain correctness failure for any module that reports a
  live count honestly. `repro: verified` — it is what broke `93.4-view-mutation.sqllogic`.

## Board bookkeeping

- `backlog/debt-doc-size-ratchet-red-at-head` — appended `docs/module-authoring.md` as a
  third arm (different in kind: no ratchet entry, measured against the global cap).
