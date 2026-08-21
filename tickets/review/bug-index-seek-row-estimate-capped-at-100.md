---
description: An index read used to tell the planner "about a hundred rows" no matter how many it really returned, so the planner kept choosing it over faster alternatives. It now reports the storage backend's real number, and the backend now counts matched rows instead of lookup keys.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts   # IndexSeekNode.computePhysical — arms 1 and 3
  - packages/quereus/src/vtab/memory/module.ts                 # estimateEqualityRows + the equality arm — arm 2
  - packages/quereus/src/vtab/index-descriptor.ts              # new accessPathPlan() helper
  - packages/quereus/test/optimizer/index-seek-row-estimates.spec.ts   # new, 8 tests
  - packages/quereus/test/vtab/runtime-key-set-protocol.spec.ts        # one test rewritten (see "The one test that moved")
  - docs/optimizer-costing.md                                  # module selectivity + what a seek node reports
  - docs/module-authoring.md                                   # new rule: `rows` counts matched rows, not seek keys
repro: verified
difficulty: medium
---

# An index seek advertises a constant row count — implemented

Three independent false claims in the row-estimate path, landed together because
arm 1 alone is a regression (see "Why all three").

## What changed

### Arm 1 — the seek node now relays the module's estimate

`IndexSeekNode.computePhysical` reported `Math.min(this.source.estimatedRows || 1000, 100)`
— a constant for every seek that was not a single-row primary-key lookup. It now reports
`Number(this.filterInfo.indexInfoOutput.estimatedRows)`, the module's own `rows` for the
access plan it chose. That number is the input to join-algorithm selection, cache
admission, sort costing and aggregate cardinality above the seek.

"The module supplied no estimate" is **not** distinguishable at the node. The rule builds
that field as `accessPlan.rows || 1000` (`rule-select-access-path.ts:420`), so a missing or
zero `rows` has already collapsed to 1000 before the node sees it. The recommended option
was taken: accept `|| 1000` as the no-answer fallback, record it in a `NOTE:` at the site,
and point at backlog `bug-row-estimate-conflates-unknown-and-zero`, which owns that
convention. No new constructor argument (`debt-access-leaf-node-positional-constructors`
stays unaggravated).

### Arm 2 — the memory backend counts matched rows, not seek keys

`MemoryTableModule.evaluateIndexAccess`'s equality arm passed `inCardinality` — the number
of seek **keys** — as its row count. New `estimateEqualityRows` (module.ts) computes:

- unique index, or the `_primary_` pseudo-index (recognised by name; `gatherAvailableIndexes`
  builds it without `unique: true`) → one row per key;
- otherwise, with `statistics` present and `rowCount > 0` and *every* equality column
  covered → `1 / max(distinctCount, 1)` per column, folded through the engine's
  `combineConjunctive`;
- otherwise the shape constant `0.1` — the store's `ARM_SELECTIVITY.eq`;
- clamped: `max(1, min(N, inCardinality × perKey))`.

Two deliberate deviations from the ticket's letter, both toward "the two backends agree":

- **`combineConjunctive`, not a raw product.** The ticket wrote `product(1 / distinctCount)`.
  The store folds with `combineConjunctive` because the design rule is "produce the number
  `CatalogStatsProvider` would produce for the same predicate". Identical for a single
  equality column (every measured case in the tests); differs only for a composite
  equality prefix, where the damped fold is the engine's answer.
- **Statistics lookup is index → current column name → `columnStats`** (lowercase), the
  store's `columnStatsFor` direction, so a post-`ANALYZE` `ALTER TABLE` misses cleanly
  rather than reading a neighbour's numbers.

**Cost left alone**, as the ticket specified: `eqMatch(inCardinality)` still sets the cost,
and the row count is overridden with `.setRows(...)`. Deriving cost from matched rows was
the measured-and-rejected variant.

Threading: `evaluateIndexAccess`, `adjustPlanForOrdering` and `evaluateOrderingOnlyPlans`
all take `tableInfo` now. `buildMonotonicAdvertisement`'s open-coded
`name === '_primary_' || unique` became the shared `isUniqueIndex`.

### Arm 3 — a multi-key primary-key seek no longer claims at-most-one-row

The guard was `seekKeys.length >= pk.length`, so `where id in (1,2,3)` against a
one-column primary key passed with three keys, forced `estimatedRows: 1`, and stamped the
singleton functional dependency `∅ → all columns` — an assertion that the relation holds
at most one row, for a seek that returns three. Now `seekKeys.length === pk.length` **and**
`accessPathPlan(filterInfo.accessPath) !== 'multiSeek'`.

`estimatedRows` needs no override either way: arm 1 already reports 1 for the point seek
and 3 for the IN. New exported helper `accessPathPlan(accessPath)` in `index-descriptor.ts`
answers "which index plan does this path walk" for both the resolved and unresolved index
kinds.

## Why all three land together

`where k = 1` on 2000 rows with 4 distinct values: node said 100, backend said **1**, truth
is 500. Arm 1 alone swaps a 5x over-estimate for a 500x under-estimate — the dangerous
direction. The ticket measured arm 1 alone flipping a hash join to an index-nested-loop on
a fabricated "1 row" outer side. Arm 3 is a separate false claim in the same function.

## Verification

All measurements below were run at this diff.

| command | result |
|---|---|
| `yarn workspace @quereus/quereus run test` | **9992 passing, 0 failing**, 25 pending |
| `yarn workspace @quereus/store run test` | **1846 passing, 0 failing** |
| `yarn test:store` (LevelDB-backed logic tests) | **9984 passing, 0 failing**, 33 pending |
| `yarn bench:gate` | **56 match, 0 differs, 0 ungated, 0 new, 0 missing**; all 4 ratio guards hold |
| `yarn workspace @quereus/quereus run lint` (eslint + `tsconfig.test.json`) | clean |
| `yarn build` + `yarn typecheck` (root fan-out) | clean |
| `yarn docs:check` | clean |

**No work counter moved.** The un-analyzed 1000-row default × the 0.1 shape constant
reproduces the old flat 100 exactly, which is why the benchmark workloads are untouched.

### Measured, before and after

2000 rows, `k` = 4 distinct values, `s` = 7 distinct values, both indexed, after `analyze`:

| query | rows returned | node's `estimatedRows` before | after |
|---|---|---|---|
| `where s = 'v1'` | 286 | 100 | 285 |
| `where k = 1` | 500 | 100 | 500 |
| `where k in (1,2)` | 1000 | 100 | 1000 |
| `where id > 1900` | 100 | 100 | 500 *(range arm is still a shape constant — see gaps)* |
| `where id = 5` | 1 | 1 | 1 |
| `where id in (1,2,3)` | 3 | **1, + false singleton FD** | 3, no singleton FD |

## The one test that moved

`test/vtab/runtime-key-set-protocol.spec.ts` — *"memory module › does NOT claim ordering
over a runtime-set seek column"*. Exactly the failure the ticket predicted, and the only
one in the whole run.

Setup: 25-key runtime set on a non-unique column of a **1000-row un-analyzed** table, with
`order by` on the seek column. Under the new estimate the arm saturates
(`min(1000, 25 × 100)` is the whole table), so seek-then-sort-1000-rows prices at ~1004
against ~700 for one ordered index walk with the set left residual. The module now returns
the ordering scan.

**Argued, not re-pinned.** The move is defensible on its own terms: both plans fetch the
whole table (that is what the module believes), and only the scan avoids the sort. The
store backend saturates the same way from ten seek keys by its own documented reasoning.
The cost is one lost speed-up — `by_v` names no seek columns, so `rule-key-set-seek` reads
the answer as a decline — and only for an un-analyzed table with an `order by` on the seek
column. `ANALYZE` resolves it: real per-column statistics stop the estimate saturating.

The test was rewritten rather than weakened:

- The ordering claim is now asserted as the **invariant** it was always guarding — *if* the
  plan pushes the set (`seekColumnIndexes` non-empty) it must not claim `providesOrdering`
  — which is robust to which plan wins on cost.
- **The parity assertion is unchanged and still passes**: the runtime set and a literal
  `IN(25)` produce byte-identical plans. Verified directly; that is the protocol's whole
  promise.
- The new shape is asserted explicitly (`handledFilters: [false]`, `orderingIndexName: by_v`)
  with the reasoning above in a comment, so a future change to it is visible.
- The sibling test *"claims a runtime set on an indexed column as a multi-seek"* still pins
  that the seek IS taken without a required ordering — unchanged, still passing.

`test/optimizer/key-set-seek.spec.ts` stays green, as the ticket predicted for this shape.

## What a reviewer should push on

Honest gaps, in the order I would attack them:

1. **The rewritten runtime-key-set test is the judgement call in this diff.** It is the one
   place where a test's literal assertion was replaced. Read it against the two bullets
   above and decide whether the invariant form is the right trade. If you conclude the
   plan move itself is wrong, the ticket's stated levers are the shape constant or an
   `estimatedCount`-aware multi-seek estimate — not reverting arm 2.
2. **Arm 3 declines slightly more than it must.** A composite-key multi-seek whose
   cross-product reduces to exactly one tuple has `plan === 'multiSeek'` and
   `seekKeys.length === pk.length`, so it genuinely returns ≤1 row but is refused the
   singleton dependency. Conservative by choice, noted in the code. No test covers that
   shape — if you want one, it is `where (a, b) in ((1, 2))` on a composite PK.
3. **`combineConjunctive` vs the ticket's `product`.** Reasoned above, but no test measures
   a composite equality prefix on an analyzed memory table, so the divergence is untested.
   Worth one if you disagree with the reasoning.
4. **The memory module's other arms are still shape constants.** Range is `N/4`,
   prefix-range `N/8`, OR-range `N/(4×ranges)` — which is why `id > 1900` still reports
   500 for 100 real rows. Out of scope (arm 2 is the equality arm), but it means the "two
   ends the constant collapsed together" test asserts a *difference*, not two accuracies.
5. **No new test asserts a downstream plan actually changed.** The tests pin the estimate
   at the seek node; the ticket's motivating symptom (join-algorithm choice) is covered
   only transitively by the 9992-test suite not moving. A test that pins a join shape
   flipping on a corrected estimate would be stronger.

## Tripwires parked

- `estimateEqualityRows` doc comment (`vtab/memory/module.ts`) — the memory module has no
  seek-versus-scan veto (the store does), so an equality seek matching a large fraction of
  an analyzed table still prices below a full scan (`0.5 + rows × 0.3` vs `rows × 1.0`).
  Fine while the estimate is the shape constant; if a fat analyzed-table seek shows up as
  a slow plan, the veto is the fix.
- `IndexSeekNode.computePhysical` (`table-access-nodes.ts`) — records that `|| 1000` in
  `rule-select-access-path` is the sole no-answer fallback, and points at
  `bug-row-estimate-conflates-unknown-and-zero` so nobody invents a second convention.

## Docs updated

- `docs/optimizer-costing.md` — the memory module joins the store as a worked example of
  module-side selectivity; new paragraph on what a physical seek node reports and what the
  singleton-FD claim requires; the base-table paragraph no longer lists `IndexSeekNode`
  among the nodes that inherit the scan cardinality.
- `docs/module-authoring.md` — new rule for module authors: `rows` counts rows **matched**,
  not seek keys issued; pass the key count to `eqMatch` and set rows with `.setRows(...)`;
  clamp to the table size.

Related backlog tickets referenced but **not** touched:
`bug-row-estimate-conflates-unknown-and-zero`, `debt-access-leaf-node-positional-constructors`,
`debt-store-engine-estimate-agreement-test`.
