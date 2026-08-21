---
description: The persistent-storage backend can now walk an index purely to return rows in sorted order — a query that only sorts by an indexed column no longer reads the whole table and sorts it, when the walk prices cheaper.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeFilterAccessPlan extraction + chooseOrderingPlan + nullSafeOrderingPrefixLength
  - packages/quereus-store/src/common/store-table-scan.ts          # plan=0 whole-index arm in analyzeIndexAccess; empty-value NOTE extended
  - packages/quereus-store/src/common/cost-profile.ts              # SORT_COST_PER_COMPARISON / RESIDUAL_FILTER_COST_PER_ROW / estimateSortCost
  - packages/quereus-store/test/index-ordering.spec.ts             # plan-level + answer-level walk suites
  - packages/quereus-store/test/isolated-store.spec.ts             # ordering-only walk under the isolation overlay
  - docs/store.md                                                  # Query Planning table row + LIMIT caveat
  - tickets/fix/bug-desc-index-ordering-claims-misplace-nulls.md   # spawned during implementation (see below)
---

# Implemented: ordering-only index walk for the store backend

`select n from entry order by n` (10,000 rows, index on `n`, no filter) previously
full-scanned the data store in primary-key order and sorted every row. It now plans as
`LIMITOFFSET > PROJECT > INDEXSCAN` with no Sort and returns in ~18 ms end-to-end
(previously measured 62.9 ms) — verified by hand against the ticket's exact repro shape.

## What was built

**Planner half** (`store-module-access-plan.ts`). The old `computeBestAccessPlan` body
was extracted verbatim as `computeFilterAccessPlan`; the exported entry point now wraps
it with `chooseOrderingPlan`, so every filter arm — including the early PK returns —
competes against an ordering walk. The walk fires only when ALL hold:

- `requiredOrdering` present and not already satisfied by the filter plan (verbatim
  positional compare, the engine's own `orderingMatches` shape);
- no runtime-valued set in the request (engine-synthesized key-set probes must get the
  genuine filter plan — same ONE rule as the seek-vs-scan veto exemption; this guard is
  an addition beyond the ticket text, reasoned in the doc comment);
- some non-partial index's order-preserving prefix satisfies the ordering with an EMPTY
  pinned set (the ticket's conservative choice — the memory module's pinned-column skip
  is deliberately not mirrored for walks; costs an optimization, never an answer);
- the cheapest walk prices STRICTLY below `filterPlan.cost + estimateSortCost(rows)`.

Walk price: `rangeScan(N)` + `N × profile.pointRead` + `N × filters × 0.2` residual. The
constants are the memory module's, restated in `cost-profile.ts` with the reasoning.
On the parity profile the walk beats scan-then-sort from ~33 rows (no filter) / ~129
rows (one residual filter) — tests are sized above those crossovers. On IndexedDB
(`pointRead: 3.0`) an unbounded walk correctly loses.

**Scan half** (`store-table-scan.ts`). `analyzeIndexAccess` decodes the idxStr and, on
plan kind `scan` with a resolved secondary index, returns the whole-index window
(`buildFullScanBounds()`) immediately — gated on the plan kind, not on missing
constraints, so a plan/scan disagreement stays loud. `plan=0` naming `_primary_` still
falls through to the data-store full scan (unchanged, correct). Everything downstream
(`produceIndexEntries` → batched `resolveIndexEntries`, `iterateEffective` merge) was
already order-preserving and is reused untouched.

## The significant discovery: DESC + NULLs (review this hardest)

The ticket's edge-case list asserted NULLs land LAST on a DESC index walk and that this
matches the engine. **The second half is false**: the engine's ORDER BY places NULLs
FIRST for BOTH directions — placement is absolute (`orderByNullResult`,
`packages/quereus/src/util/comparison.ts`) — while DESC index bytes emit them last. An
ungated claim returns NULL rows at the wrong end with the Sort already deleted.

Handled in this ticket via `nullSafeOrderingPrefixLength`: an ordering claim (walk AND
the parent ticket's seek-arm advertisement — this is a deliberate behavior change to
landed parent behavior) truncates at the first DESC column NULLs could reach. A column
stays claimable when declared NOT NULL (the default in this engine — only explicit
`null` columns are exposed), pinned by the arm's own equality, or covered by a pushed
NULL-excluding filter (`=`, `IN`, ranges, `IS NOT NULL` — enforced by window, residual,
or `matchesFilters` in every plan this module emits). The parent's
`where n > 5 order by n desc` claims keep working through the filter exception.

The memory backend has the same bug TODAY (verified: 4-row repro returns `3,2,1,NULL`
indexed vs `NULL,3,2,1` unindexed), as does the store's PK advertisement for a nullable
DESC PK member (static) — both filed as
`fix/bug-desc-index-ordering-claims-misplace-nulls`, with an evidence note appended to
`backlog/debt-nothing-checks-advertised-row-order`.

## Known gaps / deviations for the reviewer

- **LIMIT blind spot** (per ticket, deliberately not fixed): `request.limit` is never
  populated on this path, so `order by n limit 1` prices as the whole table. NOTE at the
  comparison site; enabling engine change is `backlog/feat-sort-absorb-blind-to-limit`.
  On IndexedDB the `MAX(date)` shape stays slow until that or
  `backlog/feat-minmax-index-boundary` lands.
- **Runtime-set guard** in `chooseOrderingPlan` is beyond the ticket's text (see above).
  A literal `IN` + ORDER BY can still choose the walk; a runtime-set one never does.
- **No walk-vs-declared-profile parity veto**: the walk's row figure is the whole table
  (exact by construction, not a shape-constant estimate), so the declared `pointRead`
  judges it directly — unlike the seek arms' `vetoCost` machinery. Reasoned but worth a
  reviewer's eye.
- The legacy small-table PK point arm interaction (`where id = ? order by n`) is pinned
  by test: the point plan wins on cost and the Sort survives.
- Empty-index-value legacy-store exposure now shared by the walk — one line added to the
  existing NOTE in `produceIndexEntries`; not widened further.

## Verification run

- `yarn build`, `yarn lint`, `yarn typecheck` — clean.
- `yarn test` — all workspaces green (store suite 138 passing in the two edited specs).
- `yarn test:store` — 9,987 passing, 33 pending, 0 failing.
- Parent-ticket specs re-run as part of the same file; one deliberate plan flip: the
  parent's "ANALYZE may flip a claiming arm to the scan" wide-range case now takes the
  walk (Sort elided) instead of scan+Sort — its answer-level assertion still passes.

## Test map (for spot-checking)

- `index-ordering.spec.ts` › "plan level: ordering-only walk" — claim shapes, declines
  (partial, collation, nullable-DESC, nullsFirst, composite non-leading, tiny tables),
  the seek-vs-walk cost decision, and the parent-arm NULL-gate pins.
- `index-ordering.spec.ts` › "answer + plan-shape level: ordering-only walk" — no-filter
  walk with oracle, NULLs-first ASC completeness, DESC NOT-NULL/nullable split, the
  NULL-excluding-filter re-enable (composite, 202 rows), RYOW interleave, >256-row batch
  boundary with mid-transaction delete, residual filtering, PK-point interaction,
  empty/single-row.
- `isolated-store.spec.ts` › "ordering-only index walk under an open transaction" — the
  first `plan: 'scan'` shape to reach `IsolatedTable.resolveScanIndex` from the store;
  overlay insert/update/delete interleaved through the walk with the Sort asserted gone.
