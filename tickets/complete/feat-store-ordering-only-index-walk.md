---
description: The persistent-storage backend can now walk an index purely to return rows in sorted order — a query that only sorts by an indexed column no longer reads the whole table and sorts it, when the walk prices cheaper.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts  # computeFilterAccessPlan / chooseOrderingPlan / buildOrderingWalkPlan / nullSafeOrderingPrefixLength
  - packages/quereus-store/src/common/store-table-scan.ts          # plan=0 whole-index arm in analyzeIndexAccess
  - packages/quereus-store/src/common/cost-profile.ts              # SORT_COST_PER_COMPARISON / RESIDUAL_FILTER_COST_PER_ROW / estimateSortCost
  - packages/quereus-store/test/index-ordering.spec.ts             # plan-level + answer-level walk suites
  - packages/quereus-store/test/isolated-store.spec.ts             # ordering-only walk under the isolation overlay
  - docs/store.md                                                  # Query Planning table row + LIMIT caveat
  - docs/module-authoring.md                                       # providesOrdering NULL-placement contract (added in review)
---

# Completed: ordering-only index walk for the store backend

`select n from entry order by n` (10,000 rows, index on `n`, no filter) previously
full-scanned the data store in primary-key order and sorted every row. It now plans as
`LIMITOFFSET > PROJECT > INDEXSCAN` with no Sort.

## What shipped

**Planner half** (`store-module-access-plan.ts`). The former `computeBestAccessPlan` body
was extracted as `computeFilterAccessPlan`; the exported entry point wraps it with
`chooseOrderingPlan`, so every filter arm — including the early primary-key returns —
competes against an ordering walk. The walk fires only when all hold: a required ordering
is present and not already satisfied by the filter plan; the request carries no
runtime-valued `IN` set; some non-partial index's order-preserving prefix satisfies the
ordering with no pinned columns; and the cheapest walk prices strictly below
`filterPlan.cost + estimateSortCost(rows)`. Walk price is `rangeScan(N)` + `N ×
pointRead` + `N × filters × 0.2` residual.

**Scan half** (`store-table-scan.ts`). `analyzeIndexAccess` decodes the idxStr and, on
plan kind `scan` with a resolved secondary index, returns the whole-index window
immediately — gated on the plan kind, not on missing constraints, so a plan/scan
disagreement stays loud.

**The DESC + NULLs discovery.** The engine's ORDER BY places NULLs FIRST for both
directions (`orderByNullResult`), while DESC index bytes emit them last. Handled by
`nullSafeOrderingPrefixLength`, which truncates an ordering claim (the walk's *and* the
parent ticket's seek-arm advertisement) at the first DESC column NULLs could reach. The
memory backend has the same bug today and the store's primary-key advertisement has it
for a nullable DESC key member — both filed as
`fix/bug-desc-index-ordering-claims-misplace-nulls`.

**Known, accepted:** `request.limit` is never populated on this path, so `order by n
limit 1` prices as the whole table; NOTE at the comparison site, enabling engine change
tracked in `backlog/feat-sort-absorb-blind-to-limit`.

## Review findings

### Checked

The implement diff was read cold, before the handoff summary. Beyond re-reading the two
changed source files:

- **Plan/scan handshake.** Traced the walk plan through `rule-select-access-path`: no
  `seekColumnIndexes` routes it to `selectPhysicalNodeLegacy`, whose earlier arms cannot
  capture it — the primary-key range arm requires `handledByCol` (all-false for a walk)
  and the point arm requires `rows <= 10` (a size at which the walk never wins the cost
  comparison). Confirmed `makeOrderedScanFilterInfo` spreads `makeFullScanFilterInfo`, so
  the FilterInfo reaching the store carries **no** constraints and neither
  `analyzePKAccess` nor the multi-seek dispatch in `StoreTableScan.query` can preempt the
  `plan=0` arm. This is the failure mode the multi-seek dispatch order was written for, so
  it was worth confirming rather than assuming.
- **Cross-type emission order.** The walk is the first shape that emits a whole untyped
  column straight from index bytes with no Sort behind it, so the store's key type tags
  must rank storage classes exactly as the engine does. They do — `encoding.ts` NULL
  `0x00` < NUMERIC `0x01` < TEXT `0x03` < BLOB `0x04` < OBJECT `0x05` against
  `comparison.ts`'s `StorageClass` NULL 0 < NUMERIC 1 < TEXT 2 < BLOB 3 < OBJECT 4. The
  two are written down independently and nothing compared them; now a test does (below).
- **Index-store isolation.** `ensureIndexStore(name)` is per index, so the unbounded
  `buildFullScanBounds()` really is this index's entries and nothing else — the comment's
  claim holds.
- **Hidden unique indexes.** Checked whether the implicit `_uc_*` index a bare `UNIQUE`
  materializes could be walked asymmetrically. It cannot: those indexes are invisible to
  `getBestAccessPlan` entirely (verified — an equality on a `UNIQUE` column still plans a
  full scan + Filter), so the walk introduces no new inconsistency there.
- **Adversarial probes**, run as a temporary spec, since deleted: mixed-type `any` column
  walk against a drop-the-index oracle; NOCASE text walk against the same oracle;
  `select distinct … order by` and `group by … order by` above a walk (checked the walk
  was not being taken and then thrown away by a hash operator — it is not; those plans
  are unchanged with and without the index); `order by … limit 3`; a hash join with a walk
  on both sides; a composite text primary key; and two candidate indexes. Every one
  returned the right answer.
- **Row-resolution path.** `produceIndexEntries` → `resolveIndexEntries` →
  `resolveRowBatch` reused untouched; confirmed the walk's no-constraint `matchesFilters`
  is trivially true and that a row whose indexed value is updated mid-transaction is not
  double-emitted (the isolation spec's `update t set v = 21` case covers it).
- **Docs**, read rather than assumed: `docs/store.md` (correct and current),
  `docs/module-authoring.md` (gap, fixed below), `docs/invariants.md` and
  `docs/optimizer-retrieve.md` (nothing stale).
- **Validation**: `yarn build`, `yarn lint`, `yarn typecheck`, `node
  scripts/check-docs.mjs` all clean; `yarn test` green across every workspace (store suite
  1,897 passing); `yarn test:store` 9,987 passing / 33 pending / 0 failing.

### Minor — fixed in this pass

- **Every walk candidate priced identically, so declaration order picked the index.**
  `buildOrderingWalkPlan`'s cost reads only the row count, the profile and the filter
  count — never the index — so the loop's `walk.cost < bestWalk.cost` never fires and the
  first-declared qualifying index always won. The comment claimed the opposite ("so
  declaration order does not decide"). Measured: with `ix_wide(n, s, u)` declared before
  `ix_narrow(n)`, `order by n` walked `ix_wide`, reading two extra encoded key columns per
  entry for the same rows. Added a width tie-break (cheapest, then narrowest) and
  corrected the comment. Pinned by a new plan-level test.
- **`docs/module-authoring.md` did not state the NULL-placement rule.** It is the
  module-author-facing contract for `providesOrdering` and the trap this ticket
  discovered — the one the memory module still falls into — was documented only in a
  store-internal function comment and a bug ticket. Added a capability-contract bullet
  spelling out that ORDER BY places NULLs first in both directions, that most key
  encodings disagree on a descending column, and the three conditions under which a
  descending column may still be claimed.
- **Test gap: no mixed-storage-class walk.** Added an answer-level test that walks an
  `any` column holding integers, reals, text and NULLs and compares against a
  drop-the-index oracle — the regression net for the type-tag/`StorageClass` agreement
  above, which nothing else checks.

### Major — none

No finding rose to a new ticket. The gaps the handoff flagged for scrutiny each held up:
the runtime-set guard is correct and its reasoning is sound (a walk's cost does not scale
with key count, and its all-false `handledFilters` would push runtime-set membership into
a residual the engine never meant to evaluate); the absence of a walk-vs-declared-profile
veto is right because the walk's row figure is the whole table by construction rather than
a shape constant, so the declared `pointRead` judges it directly; and the legacy
small-table point-arm interaction is pinned by test and behaves.

### Tripwire — recorded at the site, not filed

Taking the walk also replaces the filter plan's `rows` with the whole table. That figure
is honest for the leaf (the walk pushes nothing) but it is what the rest of the plan is
costed against, and the residual `Filter` re-narrows it only by default selectivity.
Nothing observed depends on it today. `NOTE:` at the comparison site in
`chooseOrderingPlan` says to carry `filterPlan.rows` onto the walk if a join over a walked
leaf is ever seen ordering itself around an inflated estimate.

### Considered and not filed

- **`PredicateConstraint.usable` is ignored** by `nullSafeOrderingPrefixLength`'s
  NULL-excluding-filter exception. Not this ticket's: the store module ignores `usable`
  module-wide, and every constraint the engine builds today sets it `true` (checked all
  emission sites in `planner/`). Nothing to fix until something emits `false`.
- **Source size.** `store-module-access-plan.ts` measured 1,591 lines (`wc -l`), up from
  1,340 at the parent ticket's review and 1,200 before it — a third of the file added in a
  day. The size theme already claims this path, so this is evidence, not a new ticket:
  the entry in `backlog/debt-oversized-source-files` was re-measured and given the extra
  seam this ticket created (the ordering-walk arm sits *above* the primary-key and
  secondary-index families rather than inside either).
- **The LIMIT blind spot** and the **legacy empty-index-value store exposure** are both
  already declared, `NOTE:`d at their sites, and tracked
  (`backlog/feat-sort-absorb-blind-to-limit`).
