---
description: When a query filters a big table by a set of values coming from a subquery, the engine now collects that set first and looks up just those rows in the index, instead of reading the whole table.
files:
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts
  - packages/quereus/src/runtime/emit/join-key-extractor.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/rules/shared/index-style-context.ts
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/core/database-materialized-views-analysis.ts
  - packages/quereus/src/planner/mutation/propagate.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - docs/optimizer-rules.md
  - docs/optimizer.md
  - docs/optimizer-fd.md
difficulty: hard
---

# Key-set semi join: materialize the set, then seek the target — complete

## What shipped

`where col in (select …)` (and the correlated-EXISTS shapes that decorrelate to
the same join) over a column with a usable index now plans as a
`KeySetSemiJoinNode`: the inner relation is drained once into a set, every target
row is probed against it (identical to the hash semi join it replaced), and —
when the distinct key count is ≤ min(1000, the module-cost break-even) — the
target leaf's `FilterInfo` is rewritten at runtime into an ordinary single-column
`plan=5` multi-seek, byte-identical in shape to a literal `in (1,2,3)`.

No storage module changed and no new runtime protocol exists. Because the probe
is unconditional, a seek can only over-fetch (the probe trims it); every
plan-time gate exists to make an under-fetch impossible.

Shapes that fail a gate keep the hash semi join and the same answer.

## Review findings

Reviewed the implement diff (`5d725a70`) first, then the handoff. Everything
below was checked; empty categories say so explicitly.

### Correctness — nothing broken found

Traced every way the target leaf's emission order could be load-bearing without
a plan-level trace, which is the mechanism the handoff flagged as most fragile:

- Sort absorption in `rule-grow-retrieve` (the case the implementer found and
  gated with `orderingLoadBearing`) — **verified complete**. Both producers of
  `IndexStyleContext` carry the flag; `rule-select-access-path` only reaches the
  `IndexScanNode` constructor when `providesOrdering` is set, and sort absorption
  requires `providesOrdering`, so a sort-absorbed plan can never land on a
  `SeqScanNode` (which has no such field). All three `new IndexScanNode(...)`
  sites outside the access-path rule thread the flag through.
- Ordering elision, merge join, stream aggregate, DISTINCT elimination — all read
  `physical.ordering`, which neither `BloomJoinNode` nor the new node claims. Any
  `SortNode` between the join and the leaf stops `peelToLeaf` outright.
- `monotonic-limit-pushdown` (runs first, produces an `OrdinalSlice` the peel
  rejects) and `monotonic-range-access` (runs after, returns an `IndexScanNode`
  the node's `withChildren` accepts) both compose safely.

Also chased the collation `COARSER_SAFE` arm — a BINARY join over a NOCASE index
admits two case-variant seek keys whose index windows overlap, which would
duplicate rows out of a semi join. **Not a defect**: both shipped modules
de-duplicate across seek keys (`scan-layer.ts` by encoded primary key,
`StoreTable.scanMultiSeek` by encoded window prefix), and the identical hazard
already exists on the literal-`in (…)` path, so it is not new here. Confirmed by
running the two-case-variant query.

### Fixed in this pass (minor)

- **Two node-type registries omitted the new node.** `JOIN_NODE_TYPES` in
  `core/database-materialized-views-analysis.ts` gates row-time materialized-view
  eligibility on "the plan contains no join"; a `KeySetSemiJoin` would have
  answered *no join* and let an ineligible multi-source plan through. Dormant
  today (analysis stops before physical join selection) but wrong the moment that
  path runs, so fixed rather than parked. `reasonForOperator` in
  `planner/mutation/propagate.ts` likewise now reports `unsupported-join` instead
  of the misleading `no-base-lineage` for an unupdateable view body. Checked
  `BINARY_JOIN_TYPES` in `join-utils.ts` too — it needs **no** change: its walk
  already rejects `semi` join types, so nothing was lost.
- **A synthesized module probe could fail a working query.** The rule asks the
  module three `getBestAccessPlan` questions the user never wrote, and a
  `validateAccessPlan` rejection propagated out and killed the whole query. Every
  other gate in this rule declines and keeps the hash semi join; this one now
  does too (logged with the module and table name, per the no-silent-swallow
  rule). This reverses the disposition the implement ticket specified and the
  handoff flagged for a reviewer opinion — a third-party module bug should not
  turn a predicate that ran fine into a hard failure.
- **`ruleKeySetSeek` was one ~200-line function divided by comment banners**,
  against the project's "decomposed sub-funcs > grouped sections" rule.
  Decomposed into `admitJoin` / `admitLeaf` / `resolveSeekColumns` /
  `probeModuleCosts` / `planPushdown` / `interpolateBreakEven`; the entrypoint is
  now ~25 lines and every gate comment moved with its gate. Pure extraction — no
  behaviour change.

### Test gaps closed (+6 tests, all suites green)

The implementer's 27 tests were a floor. Added:

- **Descending seek index** (`create index … on big(v desc)`) — the
  `seekDescending` / `seekSign = -1` branch was entirely uncovered.
- **Both untested break-even arms**, via doctored-cost modules: a key-count-
  independent seek cost (`slope <= 0` ⇒ the engine ceiling becomes the threshold,
  so 20 keys still seek) and a scan cheaper than a two-key seek (break-even
  interpolates below 1 ⇒ the rule declines outright and the hash join answers).
  Previously code-read only.
- **The new probe-validation decline**, via a module that returns a
  `handledFilters` array longer than the request's filters.
- **Abort during the drain** — asserts an `AbortError` surfaces and the target's
  `query()` is never called. The handoff listed this as a gap.
- **Non-deterministic key source** declines (plan shape).

`yarn lint`, `yarn build`, `yarn docs:check`, `yarn test` (7614 quereus + all
other packages) and `yarn test:store` (7607, LevelDB + isolation stack) are all
green, zero failures. `test/logic/07.7-in-subquery-caching.sqllogic` still passes
unmodified. No golden plans needed regeneration. No pre-existing failures
observed, so `tickets/.pre-existing-error.md` was not written.

### Docs

Read every doc the change touches and the ones it should have. `optimizer.md`
and `optimizer-rules.md` were accurate; amended the latter for the new
fail-closed probe behaviour. Found one genuine omission: `optimizer-fd.md`'s
per-node physical-property propagation table had no `KeySetSemiJoinNode` row —
added one covering what it propagates (the target's per-row facts) and what it
deliberately does not (`ordering` / `monotonicOn` / `accessCapabilities`, because
emission order is a runtime decision). Confirmed `view-updateability.md`,
`optimizer-parallel.md`, `runtime.md` and `optimizer-joins.md` need no change —
their mentions of `BloomJoinNode` are about mechanisms this node does not join.

### No new tickets filed

Every major-severity thing found already has a home: the merge-semi-join
extension (`backlog/feat-key-set-seek-merge-semi-join`), store/isolation depth
(`implement/feat-key-set-seek-store-isolation`, which names this ticket as its
prereq), pushed-constraint leaves
(`backlog/feat-key-set-seek-over-pushed-constraints`), cross-type keys
(`backlog/feat-key-set-seek-cross-type-keys`) and store PK IN-lists
(`backlog/feat-store-pk-in-list-multiseek`). Nothing new rose to ticket level.

### Tripwires parked (index — analysis lives at each site)

- `runtime/emit/key-set-semi-join.ts` (drain loop) — an NLJ-inner rescan re-drains
  the key source each pass. *(pre-existing)*
- `rules/access/rule-key-set-seek.ts` header — `orderingLoadBearing` declines are
  conservative; and the three `getBestAccessPlan` probes are uncached (cheap for
  both shipped modules, felt only by a slow third-party planner).
- `planner/optimizer.ts`, at the rule's manifest entry — **new**: a rewritten semi
  join is no longer a `HashJoin`, so `eager-prefetch-probe` stops seeing it.
  Required for the seek path (the target must not open before the key set is
  drained) but it also costs the *scan* path its concurrent probe-side prefetch.
  Only matters on a high-first-row-latency vtab.
- **New, process rather than code**: `docs/optimizer-rules.md` now sits at exactly
  its 12000-word cap. The next rule bullet added to it will fail `yarn docs:check`
  and must split the file (`backlog/debt-docs-split-lens-when-stable` is the
  nearest existing home for that kind of work). No action needed now — the check
  itself is the tripwire and it fails loudly.

### Known, deliberately unclosed

- The `INTERNAL` guard in the runtime `FilterInfoOverride` (missing per-execution
  state) stays untested — triggering it needs a scheduler fault.
- PK-keyed `IN` still plans as a **merge** semi join on both shipped backends and
  is not rewritten; that is the merge-semi-join backlog ticket, not a regression.
- The prereq `feat-uncorrelated-in-semijoin` has still not landed and remains in
  `implement/`. Uncorrelated filter-position `IN` already decorrelates to a semi
  join on current main, so every IN-shaped test here runs against the real
  pipeline; when that ticket lands, re-run these three suites.
