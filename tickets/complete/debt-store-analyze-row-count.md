----
description: The persistent storage backend keeps a running count of how many rows each table holds; it now reports that count to the query planner, so plan costs over a stored table reflect its real size instead of a fixed guess of 1000 rows.
files:
  - packages/quereus-store/src/common/store-table-base.ts                 # primeStats, getKnownRowCount, getStatistics
  - packages/quereus-store/src/common/store-module.ts                     # sizeRequestFromLiveCount + getBestAccessPlan
  - packages/quereus/src/runtime/emit/analyze.ts                          # collectTableStatistics — vtab report vs scan
  - packages/quereus/src/index.ts                                         # TableStatistics/ColumnStatistics now exported
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # the empty-result fold, now guarded on a claimed filter
  - packages/quereus-store/test/store-row-count-to-planner.spec.ts        # 11 tests
  - packages/quereus/test/optimizer/statistics.spec.ts                    # "size-only getStatistics()" block
  - packages/quereus/test/optimizer/empty-relation.spec.ts                # no-filter `rows: 0` regression, added in review
  - docs/store.md, docs/optimizer.md, docs/module-authoring.md
difficulty: medium
----

# The planner learns how many rows a stored table actually holds

## What shipped

Three seams, plus one latent defect the work uncovered and one engine guard added during
review.

**1. `StoreTable.getStatistics()`.** Returns the maintained row count in O(1) (no scan) with
an empty `columnStats` — the store keeps no value distribution, and a distinct count or
histogram would cost a full scan of the table or of an index.

**2. `ANALYZE` discriminates on richness, not presence.** `runtime/emit/analyze.ts`'s new
`collectTableStatistics` replaced "module implements `getStatistics()` ⇒ use it verbatim,
else scan" with:

- a report carrying per-column statistics is used verbatim (unchanged for `MemoryTable`);
- a report with an empty `columnStats` reads as *"I answered the size, collect the rest
  yourself"* and the scan still runs;
- where both answer the row count, the scan wins — it counted every live row, while a
  delta-tracked count is an estimate that can drift, and reconciling that drift is much of
  what a user runs `ANALYZE` for;
- neither available ⇒ undefined, as before.

Net effect for a store table: `ANALYZE` collects exactly what it did before this ticket. The
implement ticket's premise that `ANALYZE` on a store table "collects nothing" was wrong —
`emitAnalyze` already fell back to a scan — so implementing a size-only `getStatistics()`
without this change would have made `ANALYZE` collect strictly *less*.

**3. The live count reaches access planning without `ANALYZE`.** `StoreModule.getBestAccessPlan`
fills `BestAccessPlanRequest.estimatedRows` from a new synchronous
`StoreTable.getKnownRowCount()` (committed count plus the open transaction's buffered delta)
when the planner supplied none. A planner-supplied hint always wins, so the access path is
never costed against a different figure than the plan around it. The substituted count is
floored at 1.

**4. Fixed: the persisted count was discarded by the first write after a reopen.**
`trackMutation` / `applyPendingStats` seeded a missing `cachedStats` with `rowCount: 0`; nothing
loaded the persisted count first, so a database reopened with 500 rows reported 1 after a
single insert and the next flush made that durable. `initializeStore()` now calls `primeStats()`
— one extra KV `get` per table per session, on the path every read and write already awaits.

**5. (Review) The empty-result fold no longer fires on a plan with no filters.**
`rule-select-access-path` folds an access plan with `rows === 0` into a static empty relation,
guarded by `handledFilters.every(...)` — vacuously true for a plan with no filters. An honest
live count of 0 on a full scan therefore deleted the table read, and a statement that writes
rows before reading them returned nothing (this broke `93.4-view-mutation.sqllogic` during
implement). The guard now also requires `handledFilters.length > 0`.

## Review findings

Read the implement diff (`1ffb5309`) first, then the handoff. Scrutinised: correctness of the
three seams and their interaction; the `rows: 0` protocol; transaction/rollback accounting;
reopen and rename paths; error handling and logging conventions; type safety; source hygiene
(file size, comment-to-code ratio, function decomposition); doc accuracy against every touched
file; test coverage across happy path, edge cases, error paths and regressions.

### Fixed in this pass (minor)

- **The engine's vacuous fold guard, which the implementer flagged for a second opinion and
  filed rather than fixed.** My judgement went the other way: `handledFilters.length > 0` is a
  one-line, provably-inert-today change (the only in-tree emitter of `rows: 0` is the memory
  module's `IS NULL` on a `NOT NULL` column, which always carries that filter), and leaving a
  known correctness trap live in the engine while a shipped module works around it puts the
  guard on the wrong side. Applied, with a regression test — `packages/quereus/test/optimizer/
  empty-relation.spec.ts` § "A no-filter `rows: 0` is an estimate, not a proof" — that pins
  both arms: a module reporting a live 0 on a no-filter scan keeps its read, and the memory
  module's genuine impossible-predicate fold still fires. The store-side floor at 1 stays as
  belt-and-braces (and remains the only guard for a *filtered* plan). Full suite green.
- **`getStatistics()` reported `TableStats.updatedAt` as `lastAnalyzed`.** Those are different
  facts — the moment the count last *moved* versus the moment the table was last *analyzed* —
  and a staleness check reading the field would have been told the table had been analyzed
  when it never was. The field is now left unset, with the reason recorded at the site.
  Nothing reads `lastAnalyzed` today, so this was latent, not live.
- **A 25-line comment block wrapping 3 lines of code inside `getBestAccessPlan`.** Extracted to
  a named top-level `sizeRequestFromLiveCount(request, table)` with the reasoning as its JSDoc;
  the method body is now one expression. Composition over comment blocks, per AGENTS.md.
- **The stale comment the implementer flagged in `key-set-seek-store.spec.ts`.** It asserted
  "the planner never learns a store table's real row count" and named this ticket as the open
  gap. Rewritten: the numbers are unchanged because `cap` holds exactly 1000 rows, so the live
  count and the old placeholder coincide there — now stated as a coincidence at that size
  rather than as a permanent property.
- **Docs corrected for the new fold guard.** `docs/module-authoring.md`, `docs/optimizer.md` and
  `docs/store.md` each stated the `rows: 0` contract without the claimed-filter requirement,
  which the review change made inaccurate. All three updated; `module-authoring.md` grew 12
  words net (12429 → 12441) after tightening.

### Re-filed rather than deleted

`backlog/debt-empty-access-plan-fold-trusts-estimate` was rewritten, not closed. Its no-filter
arm landed here, but its substantive half survives: with filters present, `rows: 0` is *still* a
proof read out of a field the interface documents as an estimate, so a module reporting a very
selective estimate as 0 on a claimed filter still gets its read deleted. What it now asks for is
an explicit "predicate is unsatisfiable" signal that cannot be expressed by accident through a
number. `repro:` downgraded `verified` → `static` — the arm that was observed live is the one
that got fixed. The `NOTE:` at the fold site points at the remainder.

### Tripwires recorded (conditional — deliberately not tickets)

- **`primeStats()` failure reinstates the pre-fix behaviour for that one table**: the read
  warns and leaves `cachedStats` null, so the next `trackMutation` seeds 0 and a later flush
  makes the restarted count durable, discarding the persisted one. Only reachable on a
  stats-store read fault, which is already a storage-level failure, and the count is advisory.
  `NOTE:` at `primeStats` in `store-table-base.ts`, with the shape of the fix (a "primed or
  genuinely absent" flag gating `flushStats`) if it ever needs to be safe.
- **A prepared `Statement` caches its compiled plan** and recompiles only on a schema change,
  so a long-lived prepared statement keeps costs derived from the size the table had at first
  compile. Harmless while the substitution only moves costs, not plan shape. `NOTE:` on
  `sizeRequestFromLiveCount` in `store-module.ts`.

### Checked and found clean

- **`rows: 0` reaching the module from the engine side.** `rule-select-access-path` builds the
  request with `tableRef.estimatedRows || undefined`, so an `ANALYZE`d empty table's catalog 0
  arrives as "unknown" and gets the store's floored substitution rather than being passed
  through to `fullScan(0)`. The `||` (not `??`) is load-bearing here; it was already there.
- **Arithmetic in `computeBestAccessPlan` cannot produce a 0 from a small `estimatedRows`.**
  Every derived count is `Math.max(1, Math.floor(...))`, and the multi-seek arm is a `Math.min`
  of two values that are each ≥ 1. Lowering the substituted size from 1000 to a real small
  count therefore cannot trip the fold by rounding.
- **`MemoryTable.getStatistics()` always populates `columnStats`** for every column, even on an
  empty table, so seam 2's richness test never re-routes a memory table to a scan. The one
  exception is its `if (!schema)` early return, which yields an empty map — that table has no
  manager schema and could not be scanned meaningfully either.
- **Transaction accounting.** `pendingStatsDelta` is applied by the coordinator's `onCommit` and
  zeroed by `onRollback`, and `resetStats` clears it; `getKnownRowCount` adding it is consistent
  with what the statement will see. Pinned by the spec's begin/insert/rollback case.
- **Rename.** `renameTable` disposes the old `StoreTable` (flushing its delta) and re-keys the
  stats entry before a new instance can prime, so `primeStats` reads the migrated value under
  the new key, not a stale one.
- **Logging convention.** `console.warn('[StoreModule] …')` in `primeStats` matches every other
  warn in `quereus-store`; the package uses no `createLogger`.
- **File sizes.** `store-table-base.ts` 994 lines, `store-module.ts` 690, `analyze.ts` 130 —
  the change added ~60 lines to the largest and did not push anything past a threshold this
  repo treats as a split trigger. No size ticket.

### Gaps accepted as-is (from the implement handoff, re-examined)

- **Engine-side costs still need `ANALYZE`.** Join ordering, cache thresholds and sort costs
  read `TableSchema.statistics` via `catalogRowCount`, which only `ANALYZE` writes. Publishing
  the store's count into the engine catalog per stats-flush would invalidate cached plans and
  touch materialized-view liveness (`docs/mv-schema-change.md`); that is a design decision, not
  a defect, and correctly left unfiled. Documented in `docs/optimizer.md` § "Where a module's
  own size fits".
- **An empty store table is costed as 1 row, not 0** — deliberate, and any plan over 0 or 1
  rows is cheap either way. Still correct even with the engine guard in place, since the guard
  only covers the no-filter case.
- **A freshly created table has no count until its storage is opened**, so its first plan uses
  the 1000 placeholder. Pinned as an assertion in the spec rather than left to be tripped over.
- **No golden EXPLAIN fixture moved.** Confirmed expected: the golden corpus never runs
  `ANALYZE`, and the substitution moves costs, not plan shape, at those table sizes.
- **`docs/module-authoring.md` remains over the 12,000-word cap** (12,441). It was already over
  at HEAD (12,226) before this ticket touched it; tracked as a third arm on
  `backlog/debt-doc-size-ratchet-red-at-head`. `docs/schema.md` and `docs/sync.md` were red at
  HEAD too. Not a test failure — `.pre-existing-error.md` deliberately not written.

## Verification

All from the repository root, after the review changes.

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc --noEmit` over the quereus specs).
- `yarn typecheck` — clean across all workspaces.
- `node packages/quereus/test-runner.mjs` (memory) — **8253 passing, 0 failing, 13 pending**
  (8251 before review; the two new empty-relation tests account for the difference).
- `yarn test:store` (LevelDB backend) — **8245 passing, 0 failing, 21 pending**.
- `yarn workspace @quereus/store run test` — **1248 passing, 0 failing**.
- `yarn test` (every workspace) — clean.
- `yarn docs:check` — 3 failures, all doc-size, all pre-existing at HEAD.

No pre-existing test failures observed.

## Board bookkeeping

- `backlog/debt-empty-access-plan-fold-trusts-estimate` — rewritten to its surviving scope (see
  above).
- `backlog/debt-doc-size-ratchet-red-at-head` — already carries the `docs/module-authoring.md`
  arm from implement; unchanged by this pass.
