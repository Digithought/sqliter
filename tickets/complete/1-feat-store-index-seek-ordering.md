---
description: The persistent-storage backend now tells the query planner when a secondary-index lookup already returns rows in sorted order, so a query that filters and sorts on the same indexed column skips the redundant sort step.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # indexOrderMatchesDeclaredCollation, indexOrderPreservingPrefixLength
  - packages/quereus-store/src/common/store-module-access-plan.ts   # buildIndexOrderingAdvertisement + indexOrderingSatisfies
  - packages/quereus-store/test/index-ordering.spec.ts              # 27 specs, three assertion levels
  - docs/store.md                                                    # § Query Planning table + § Order preservation
---

# Secondary-index ordering advertisement (complete)

## What shipped

The three **single-window** secondary-index arms of the store's access planner — `eq` with
`isMultiSeek === false`, `prefixRange`, and `range` in `tryIndexAccessPlan` — now attach a
`providesOrdering` / `orderingIndexName` claim built by `buildIndexOrderingAdvertisement`.
No new access path was added: every plan touched already existed and already executed
correctly. What is new is that the plan now *states* its emission order, which lets
`trySortAbsorbViaIndexOrdering` drop the Sort above shapes like `where n > 900 order by n`
and `where a = 1 order by b` over an index on `(a, b)`.

The soundness gate is deliberately **not** the seek gate. A seek window is judged against
the collation the post-fetch filter re-compares under (the index column's own `COLLATE`,
else the table column's declared one); an ordering claim is judged against the table
column's **declared** collation, because that is what `ORDER BY` uses. The two diverge on
exactly one shape — `create index ix on t (name collate nocase)` over a `BINARY`-declared
`name` — where the seek fires and the ordering claim declines. Both questions funnel
through the one shared predicate `keyOrderMatchesCollation`, so neither restates the
never-text exemption, the semantic-ordering allow-list, or the `orderPreserving`
assertion.

Claims are truncated to the leading index columns that pass and voided entirely at zero.
Required-ordering matching mirrors `MemoryTableModule.indexSatisfiesOrdering`, including
its equality-skip. The multi-seek arm, every cost-only decline, and the seek-vs-scan veto
loser make no claim, with the reason stated at each site.

## Review findings

Read the implement diff (`25a17df66`) before the handoff summary. Adversarial passes on
ordering soundness (the class where a wrong claim is a silent wrong answer), collation
handling, the planner→runtime dispatch path, DRY, source hygiene, docs, and test coverage.

### Verified sound (probed, not just read)

Built throwaway probe specs against the real store module and compared every elided-Sort
answer against an oracle (the same query with the index dropped, or the same data in a
memory-backed table). All agreed:

- **NULL placement.** Index bytes put NULL first on an ASC column and last on a DESC one
  (direction is baked in by byte inversion), which is exactly the engine's default
  placement. `where a = 1 order by b` with NULLs in `b` elides its Sort and returns them
  first, matching the no-index oracle.
- **Explicit `NULLS FIRST` / `NULLS LAST`.** Keeps its Sort in every shape I could build
  (with and without a projection between Sort and Retrieve, over both a composite and a
  single-column index).
- **`any` columns with mixed value types.** The cross-type byte order (number < text <
  blob, NULL first) equals the engine's cross-type compare order.
- **Text collations.** An index over a plain `BINARY` text column elides and returns
  `['Beta','Zeta','a','alpha']`, matching the memory table exactly.
- **`ORDER BY <col> COLLATE <name>`.** Builds a Collate node rather than a bare column
  reference, so no ordering requirement is ever extracted and the Sort always survives —
  the claim cannot be fooled into answering a differently-collated `ORDER BY`.
- **DESC index columns**, composite indexes with a DESC member, and an index that names the
  PK column explicitly (`create index ix on t (n, id)` genuinely satisfies
  `order by n, id`).
- **Planner/runtime dispatch agreement.** `StoreTableScan.query` tries PK access *before*
  secondary-index access, which would emit in PK order if it ever fired under a plan that
  claimed index order. It cannot: the planner's PK arms return before the index arms are
  even tried, under the same conditions (`pkOrderPreservingPrefix >= 1` plus the same range
  operators) the runtime uses. Confirmed with `where id > 2 and n > 1 order by n` (Sort
  retained, PK arm won) and `where n > 1 order by n` (Sort elided, index arm won).
- **`orderingLoadBearing`.** Rewrites that would change emission order under an absorbed
  Sort (`rule-key-set-seek`, `rule-monotonic-range-access`) already honor the marker.

### Fixed in this pass (minor)

- **`docs/store.md` § *Order preservation* was stale.** The implement pass updated the
  § Query Planning table but not the section that is the file's canonical account of this
  exact topic — it still said "**Three** store decisions equate [memcmp with the
  comparator]" and described only the two *seek* arms' collation question. The ordering
  advertisement is a fourth decision asking a *different* pair of collation names, which is
  the whole subtlety of the ticket. Corrected the count and added a paragraph stating the
  declared-vs-residual distinction and the `collate nocase` divergence.
- **Test coverage gaps.** Three specs added to `index-ordering.spec.ts` (24 → 27), all
  passing: NULLs in the indexed column land where the engine puts them; an explicit NULLS
  placement keeps its Sort; an `any` index column's byte order over mixed types equals the
  engine's sort order. The implement pass explicitly flagged the `any` / mixed-type surface
  as unprobed.
- **A comment asserted a case its caller cannot produce.** `indexOrderingSatisfies`'
  mid-loop "pinned column after the matched prefix" skip is unreachable from the store's
  caller — `resolveEqualityPins` stops at the first unpinned index column, so the pinned
  set is always a contiguous *leading* prefix that the leading skip has already consumed.
  The branch is worth keeping for exact parity with the memory module (whose pinned set
  can be non-contiguous); the comment now says that instead of describing it as live.
- **A doc comment overstated a guard.** It read as though the module's `nullsFirst`
  decline is what protects `order by <nullable indexed col> nulls last`. It is not — see
  the tripwire below.

### Recorded as tripwires (conditional; not filed as tickets)

Both are `NOTE:` comments on `buildIndexOrderingAdvertisement` in
`store-module-access-plan.ts`:

- **The `nullsFirst` decline is redundant belt, not the braces.** Nothing populates
  `OrderingSpec.nullsFirst` anywhere in the engine today (the memory module carries the
  same NOTE). `trySortAbsorbViaIndexOrdering` refuses a sort key with an explicit NULLS
  placement outright; `ruleGrowRetrieve`'s Sort arm goes through
  `extractOrderingFromSortKeys`, which *drops* `SortKey.nulls` — so that arm could never
  forward the placement even if it wanted to. Harmless while that arm also never absorbs
  such a Sort, which the new spec now pins. If `nullsFirst` ever starts reaching
  `requiredOrdering`, this decline flips from redundant to load-bearing. Not a latent
  defect: no reachable path today produces a wrong answer, and I probed for one.
- **The bare (no-`requiredOrdering`) claim can cost a filter pushdown.**
  `ruleGrowRetrieve` carries an equipped `providesOrdering` into its re-probe as a
  `requiredOrdering` and declines the grow if the re-probe does not match. The bare claim
  includes the equality-pinned leading columns; the matched claim skips them, so `[a, b]`
  advertised for `where a = 1` cannot be re-satisfied on a second grow. Costs an
  optimization, never an answer (a Filter preserves row order), and nothing in the suites
  regressed. The fix, if it ever shows up: advertise only the unpinned suffix.

### Filed as arms on existing tickets (major — no new tickets)

Both climbed to the highest rung that applies rather than filing point tickets, and both
landed on tickets that already own the theme:

- **`backlog/debt-nothing-checks-advertised-row-order`** — the ordering-alignment walk now
  exists **twice**, in two packages: `MemoryTableModule.indexSatisfiesOrdering` and the
  store's `indexOrderingSatisfies`. They agree only by hand-mirroring and a comment; either
  drifting elides a Sort it needed, which is precisely the failure this ticket exists to
  catch. Appended as a third instance, with both the runtime-check answer (covers it with
  no refactor) and the shared-implementation answer (retires the class — the store's
  `OrderingSpec[]` signature is the general one and lifts into `packages/quereus`).
- **`backlog/debt-oversized-source-files`** — `store-module-access-plan.ts` measures
  **1,340 lines** (`wc -l`, 2026-08-21; 1,200 before this ticket). Notable because that file
  is itself the product of an earlier split recommended by that same ticket, and has now
  outgrown the seam it was cut at. Recorded with a proposed next cut (primary-key arms /
  secondary-index arms / shared costing helpers) and a note that the file is unusually
  comment-dense, so its line count overstates its logic weight.

### Considered and not filed

- **`monotonicOn` / `supportsAsofRight` on secondary-index arms** — already owned by
  `backlog/feat-store-secondary-index-monotonic-advertisement`, which was written against
  this ticket. Correctly out of scope; no new ticket.
- **Cost-only fallbacks carry no PK-order advertisement** — an accepted-tradeoff `NOTE:`
  already sits at `costOnlyFallback` in `computeBestAccessPlan` stating the decision and
  its revisit condition ("if it shows up as slow"). Left alone per the accepted-tradeoff
  rule.
- **`indexOrderMatchesDeclaredCollation` vs `indexRangeAtPositionIsOrderSafe` near-
  duplication** — the two differ only in which collation they pass, both delegate to the
  one shared `keyOrderMatchesCollation`, and each carries the counter-example that
  justifies its existence. Duplication is in the call, not the logic; no finding.
- **Conservative declines listed in the handoff** (leading unsafe pinned column voids the
  whole claim; `where a = 1 order by a, b` declines; the claim stops at the index's
  declared columns rather than continuing into the PK suffix) — all verified deliberate,
  all cost an optimization only, all mirror the memory module. Not defects.
- **Ordering-only index walk** (`order by n` with no pushable filter still full-scans and
  sorts) — the companion ticket `feat-store-ordering-only-index-walk`, next in
  `implement/`. Neither subsumes the other.

### Categories with nothing to report

- **Error handling / resource cleanup** — nothing found, and not for lack of looking: the
  diff adds no I/O, no async work, no allocation beyond one short-lived `Set` and one
  array per plan request, and no throw sites. There is nothing to clean up.
- **Type safety** — nothing found. No `any`, no assertions, no non-null operators added;
  `Pick<BestAccessPlanResult, 'providesOrdering' | 'orderingIndexName'>` as the builder's
  return type makes an over-broad spread a compile error.
- **Performance** — nothing found. The advertisement costs one loop over the index's
  columns per candidate index per plan request, each iteration a string compare and a
  collation-registry lookup. Plan-time only, and small against the arms it sits beside.

## Validation

All run at review, all green:

- `yarn docs:check` — links, invariants, size ratchet, tiers (store.md 9,310 words against
  a 12,000 cap, so the added paragraph is well inside).
- `yarn build`, `yarn typecheck` (including the store's `tsconfig.test.json` pass over the
  spec file), `yarn lint`.
- `yarn test` — 9,995 quereus + **1,873** store (1,870 + the 3 added here) + the rest,
  **0 failing**.
- `yarn test:store` — 9,987 passing, 0 failing.
- `index-ordering.spec.ts` alone — 27 passing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
