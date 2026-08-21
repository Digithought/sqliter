---
description: The persistent-storage backend now tells the planner when a secondary-index seek already returns rows in sorted order, so queries that filter and sort on the same indexed column skip the redundant sort step. Review the new ordering claims for soundness — a wrong claim silently returns wrong-order rows.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # NEW: indexOrderMatchesDeclaredCollation, indexOrderPreservingPrefixLength
  - packages/quereus-store/src/common/store-module-access-plan.ts   # NEW: buildIndexOrderingAdvertisement + indexOrderingSatisfies; attached in tryIndexAccessPlan's single-window return
  - packages/quereus-store/test/index-ordering.spec.ts              # NEW: 24 specs, three assertion levels
  - docs/store.md                                                    # § Query Planning table + collation-rule paragraph rewritten
---

# Review: secondary-index ordering advertisement (implemented)

## What was built

The three **single-window** secondary-index arms of the store's access planner (`eq`
with `isMultiSeek === false`, `prefixRange`, `range` in `tryIndexAccessPlan`) now attach
a `providesOrdering` / `orderingIndexName` claim, built by the new
`buildIndexOrderingAdvertisement`. No new access path was added — every plan touched
already existed and executed correctly; the plans now state their emission order, which
lets `trySortAbsorbViaIndexOrdering` (rule-grow-retrieve.ts) drop the Sort above e.g.
`where n > 900 order by n`.

Key design points, all per the implement ticket:

- **Soundness predicate is deliberately NOT the seek gate.** New
  `indexOrderMatchesDeclaredCollation` / `indexOrderPreservingPrefixLength`
  (pk-key-resolution.ts, next to their PK twins) compare the index key collation against
  the **table column's declared collation** — what `ORDER BY` uses — where the existing
  `indexRangeAtPositionIsOrderSafe` compares against the residual collation (index's own
  `COLLATE` else declared) — what a seek window needs. The divergent shape:
  `create index ix on t (name collate nocase)` over a BINARY-declared `name` — seek
  fires, ordering claim declines. Both delegate to `keyOrderMatchesCollation` (never-text
  exemption, semantic-ordering allow-list, `orderPreserving` assertion) — nothing
  restated.
- **Claim truncated** to `indexOrderPreservingPrefixLength`; prefix 0 voids it (mirrors
  the PK advertisement's truncation).
- **Required-ordering match mirrors `MemoryTableModule.indexSatisfiesOrdering`**
  (`indexOrderingSatisfies`), including the equality-skip: pinned set is this arm's own
  `eqCols`, so `where a = 1 order by b` over `(a, b)` elides. Declines on explicit
  `nullsFirst`, on direction mismatch (no reverse walk), and on required orderings
  longer than the (truncated) declared index columns. With no `requiredOrdering`, the
  index's own truncated ordering is advertised (pinned leading columns included).
- **Non-claiming arms untouched, with comments saying why at each**: the `plan=5`
  multi-seek (seek-key emission order; `isMultiSeek` gate, not `seekKeyCount > 1`),
  every `costOnly` decline (engine sequential-scans the data store in PK order for
  those — a claim would trigger `rule-select-access-path`'s ordering-only branch and an
  IndexScanNode the store can't serve), and the seek-vs-scan-veto loser (returns
  `scanPlan`, which keeps its PK advertisement). The `prefixRange → eq` degradation
  resolves the advertisement **after** degrading, like the row estimate.

## Validation done (floor, not ceiling)

- `yarn build`, `yarn lint`, `yarn test` (all workspaces; 9995 quereus + 1870 store +
  the rest, 0 failing), `yarn test:store` (9987 passing, 0 failing) — all green.
- New `test/index-ordering.spec.ts`, 24 specs at three levels:
  - **Plan level** (direct `getBestAccessPlan`): each arm's claim and every decline —
    multi-seek, over-length required, direction mismatch, `nullsFirst`, index `COLLATE`
    ≠ declared, custom collation without `orderPreserving`, composite truncation,
    cost-only, DESC column both directions.
  - **Answer + plan-shape level** (SQL + `query_plan()`): Sort elided + rows ordered for
    claiming shapes; Sort retained + rows correct for declining shapes; the
    nocase-index-over-BINARY-column wrong-order guard; read-your-own-writes interleave
    (pending inserts before/between/after + a pending delete); >256 matching entries
    across resolution batches with a mid-window delete; ANALYZE flipping the veto;
    isolation-layer overlay merge (`createIsolatedStoreModule`) with interleaved
    overlay rows and a moved committed row.

## What a reviewer should poke at

- **Order-soundness above all**: any shape where the claim survives but emission order ≠
  `ORDER BY` order is a silent wrong answer. The collation matrix is the risk surface —
  particularly `any`-typed columns, semantic-ordering types (TIMESPAN/JSON) as index
  columns (allow-listed via `semanticKeyOrderIsFaithful`; I did not add a
  TIMESPAN/JSON-specific ordering spec — the plan-level path is shared, but an
  end-to-end `order by <timespan col>` elision spec would tighten this).
- **`ruleGrowRetrieve`'s own requiredOrdering path** (the non-Sort-absorb caller): I
  verified the `nullsFirst` decline covers it by code reading, not by a dedicated test.
- The equality-skip uses `eqCols` (this arm's pinned prefix), never all request
  equalities — worth re-deriving that a filter-only equality on a *later* index column
  can't sneak into the pinned set (it can't: `resolveEqualityPins` stops at the first
  gap).

## Known gaps / conservative declines (deliberate, not bugs)

- A **leading** pinned column whose collation is not order-preserving voids the whole
  claim (prefix 0), even though within its single equality window the later columns'
  order would be sound. Costs an optimization only; the ticket specified
  truncate-then-match.
- `where a = 1 order by a, b` declines (required key `a` is pinned and skipped) — exact
  mirror of the memory module's behavior; the engine doesn't prune constant sort keys.
- The claim stops at the index's **declared** columns although key bytes continue into
  the PK suffix — `where n > 5 order by n, id` keeps its Sort.
- No `monotonicOn` / `supportsAsofRight` on index arms (PK advertisement has them);
  merge-join/asof over a secondary index would need them. Out of ticket scope.
- Cost-only fallbacks still carry no PK-order advertisement (pre-existing NOTE at
  `costOnlyFallback` in `computeBestAccessPlan`).
- `order by n` with **no** pushable filter still full-scans + sorts — that is the
  companion ticket `feat-store-ordering-only-index-walk` (next in implement/), which
  adds the ordering-only index walk. Neither subsumes the other.

## Docs

`docs/store.md` § Query Planning: the two secondary-index rows now say "Yes (index
order)", a multi-seek row was added, and the stale "Non-BINARY collations: the module
cannot provide collation-aware ordering" sentence was replaced with the real rule
(advertised under any `orderPreserving`-asserting collation; an index column carrying
its own `COLLATE` never advertises).
