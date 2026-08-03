---
description: An index seek now remembers which original WHERE conditions it is responsible for enforcing, so a later optimization can safely swap out how the table is read instead of giving up.
files:
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts
  - packages/quereus/test/optimizer/pushed-constraints-recorded.spec.ts
  - docs/optimizer-retrieve.md
difficulty: medium
---

## What landed

When a storage module claims a WHERE filter (`handledFilters[i] === true`),
`rule-select-access-path` folds it into seek keys on an `IndexSeekNode` and the predicate
stops existing as a `Filter` anywhere in the plan — the seek's `FilterInfo` becomes its only
enforcer. Previously the node kept only the encoded form (column index + operator + argv
slot), from which the predicate cannot be faithfully rebuilt: the comparison's effective
collation comes from the *original expression's* operand types, not from the column.

`IndexSeekNode` now records two things:

- `pushedConstraints?: readonly PredicateConstraint[]` — the exact planner-level constraint
  objects consumed, each carrying its `sourceExpression`.
- `orderingLoadBearing: boolean` — previously present only on `IndexScanNode`; every
  `IndexSeekNode` arm silently dropped the flag `selectPhysicalNode` was handed.

Nothing reads either field yet. Zero plan changes, zero result changes; this exists so
`feat-key-set-seek-over-pushed-constraints` (and later
`backlog/feat-index-nested-loop-over-pushed-constraints`) can stop declining.

### Where the code changed

- `table-access-nodes.ts` — both fields on `IndexSeekNode` (type-only import of
  `PredicateConstraint`, so the real `constraint-extractor → nodes/reference` module cycle
  is not created at runtime); a `withProvenance(pushedConstraints, orderingLoadBearing)`
  clone helper; both fields carried through `withChildren`.
- `rule-select-access-path.ts` — `stampSeekProvenance` at the single site between the
  `selectPhysicalNode*` dispatch and `reattachUnconsumedConstraints`; it descends through
  the collation-residual `Filter` a seek arm may wrap the leaf in. Recorded list is
  `constraints.filter(c => consumed.has(c))` — iterating `constraints`, not the `Set`, so
  order is deterministic across the index-aware and legacy arms.
  `combineResidualExpressions` is now exported.
- `rule-monotonic-range-access.ts` — its two `IndexSeekNode` clone helpers
  (`leafWithRangeBound`, `leafWithMonotonicSuppressed`) reconstruct the node
  argument-by-argument and would have silently dropped both new fields; both now carry them
  through.
- `docs/optimizer-retrieve.md` — new "Seek provenance" subsection under the Retrieve
  physicalization docs.

## Validation (post-review)

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn test` — green across every workspace: **8588 passing** in `packages/quereus`
  (13 pending), 374 / 113 / 63 / 17 / 28 / 1293 / 648 / 52 / 31 / 34 / 134 / 22 passing in
  the other packages. Zero failing.
- `test/plan/golden-plans.spec.ts` unchanged; `git status` shows no golden snapshot moved.
  Neither new field appears in `getLogicalAttributes`, which is why.

### Spec: `test/optimizer/pushed-constraints-recorded.spec.ts` (11 tests)

Inspects plan nodes directly via `db.getPlan(sql)` + `collectNodes(plan, isIndexSeek)`.
Fixture: `t (pk integer primary key, s text, n integer)` with secondary indexes on `s`
and `n`.

| Case | Asserts |
| --- | --- |
| `where s = 'x'` | one constraint, `sourceExpression` is the `=` `BinaryOpNode` |
| `where pk between 2 and 5` | two constraints sharing ONE `BetweenNode`; `combineResidualExpressions` returns that node, not an AND of it with itself |
| `where pk in (1,2,3)` | the `InNode` recorded (multi-seek arm) |
| `where n < 20 or n > 80` | one `OR_RANGE` constraint carrying the whole `OR` node |
| `where pk > 1 and pk < 9` | two distinct constraints, ops in `constraints` order (`['>', '<']`), and `combineResidualExpressions` returns a real `AND` |
| BINARY `=` over a NOCASE index | **added in review** — `COARSER_SAFE` cover: seek kept under a residual `Filter`, the stamp reaches the seek *through* that Filter, the residual's predicate IS the recorded `sourceExpression`, and the query still returns only the BINARY-exact row |
| `withChildren` round-trip | forced reconstruction preserves both fields |
| `where n >= 20 order by n` | Sort absorbed (no `SortNode` in plan), seek has `orderingLoadBearing === true` **and** its provenance |
| same query without `order by` | `orderingLoadBearing === false` |
| `name > 'banana' collate nocase` over a BINARY index | `MISMATCH_UNSAFE` → `SeqScan` + residual `Filter`, no seek stamped |
| legacy-arm PK equality | recorded, and the plan still executes (returns the right row) |

The legacy arm is reached via a `LegacyPlanMemoryModule` defined in the spec: it subclasses
`MemoryTableModule` and deletes `indexName` / `seekColumnIndexes` from the returned access
plan, leaving everything else (including the runtime) stock.

## Answers to the two questions the ticket asked for

**Is "Sort absorbed onto an IndexSeek" reachable from SQL?** Yes — not a hypothetical path.
`select pk, n from t where n >= 20 order by n` produces a range `IndexSeekNode` on `idx_n`
with `providesOrdering` set, `orderingLoadBearing === true`, and no `SortNode` left in the
plan. Two tests cover it — the absorbed case and the no-`ORDER BY` control that must stay
`false`. So the `orderingLoadBearing` propagation is **not** inert: the flag reaches real
seeks. It has no reader today, but the moment `rule-key-set-seek` is allowed to target a
seek, this is live correctness data.

**Did any golden plan move?** No — see Validation above.

---

## Review findings

### Verified correct (checked, nothing to change)

- **Every `IndexSeekNode` construction site is covered by the stamp.** All nine
  `new IndexSeekNode(...)` calls in `rule-select-access-path.ts` sit inside
  `selectPhysicalNodeFromPlan` / `selectPhysicalNodeLegacy`, whose single return path runs
  through `stampSeekProvenance`. The two remaining sites (`rule-monotonic-range-access.ts`)
  are clone helpers and were patched by the diff.
- **`withProvenance` dropping the cost override is behaviour-preserving.** Read
  `TableAccessNode`'s constructor (`estimatedCostOverride ?? filterInfo.indexInfoOutput.estimatedCost`),
  then every seek arm's 8th argument — all nine pass `accessPlan.cost` — then
  `makeFullScanFilterInfo(accessPlan.cost, …)` which sets `indexInfoOutput.estimatedCost` to
  that same number, and `makeIndexFilterInfo` which spreads `base.indexInfoOutput` unchanged.
  The fallback re-derives the identical self-cost. The implementer's reasoning holds.
- **"An empty `pushedConstraints` array is impossible" holds.** Traced every
  `consumed.add(...)` against every seek site: the equality arms are covered by line 539,
  prefix+range by 796-798, range by 889-890, `OR_RANGE` by 952, legacy PK equality by 1084,
  legacy PK range by 1154-1155. No seek is reachable with an empty consumed set.
- **No latent defect from `orderingLoadBearing` now reaching seeks.** Both gates that read
  it (`rule-key-set-seek.ts:439`, `index-nested-loop.ts:88`) test
  `leaf instanceof IndexScanNode`, and both are reached only after an `admitLeaf` that
  requires `fi.constraints.length === 0` — which no seek satisfies. The narrower `instanceof`
  is redundant rather than wrong today, and both rules' docs describe the gate accurately.
- **Docs.** Read `docs/optimizer-retrieve.md` (the new "Seek provenance" subsection),
  plus every other doc mentioning `IndexSeekNode` or `orderingLoadBearing`
  (`optimizer.md`, `optimizer-fd.md`, `optimizer-joins.md`, `optimizer-rules.md`,
  `invariants.md`, `progressive-optimizer.md`). All remain accurate — the ones describing
  the `orderingLoadBearing` decline describe the *gate*, which still checks `IndexScanNode`,
  so they did not go stale.

### Minor — fixed in this pass

- **`stampSeekProvenance` rebuilt its `FilterNode` by hand** (`new FilterNode(scope, inner, predicate)`),
  re-listing constructor arguments and discarding `selectivity`. Harmless today (nothing has
  stamped a selectivity that early) but it is the same silent-field-drop shape the ticket was
  written to guard against. Now calls `node.withChildren([inner, node.predicate])`, which
  short-circuits to `this` when the stamp was a no-op and carries every field forward.
- **The `FilterNode` descent branch of `stampSeekProvenance` had zero test coverage.** Every
  original test produced a bare seek; the wrapped-in-a-residual case — the only reason that
  branch exists — was listed as a known gap. Added the `COARSER_SAFE` test (BINARY `=` over a
  NOCASE index), which pins the descent, the recorded constraint, the documented
  double-application shape (residual predicate `===` recorded `sourceExpression`), and the
  end-to-end result.
- **`combineResidualExpressions` was only asserted on the de-duplicating path.** The
  `BETWEEN` case proved two constraints collapse to one node; nothing proved two *distinct*
  sources produce a real `AND`. Added that assertion to the two-sided-range test.
- **Misleading local `reversedKeys`** in the `withChildren` test — nothing was reversed.
  Inlined.

### Major — filed as a ticket

- **`backlog/debt-access-leaf-node-positional-constructors`.** `IndexSeekNode` now takes 13
  positional constructor parameters (`IndexScanNode` 10, `SeqScanNode` 6), all trailing ones
  optional with defaults, and eight hand-maintained argument lists across four clone helpers
  reproduce them. A clone site that omits a field compiles clean and silently resets it to
  its default. This diff is the evidence, not a hypothetical: it had to separately patch
  `rule-monotonic-range-access.ts`, whose two helpers would otherwise have reset
  `orderingLoadBearing` to `false` — re-permitting a rewrite that must decline. Filed rather
  than fixed inline because it is a cross-file refactor of three node classes plus their
  callers, and the right shape (options object / generic `withOverrides` / compiler-enforced
  exhaustiveness) is a design decision, not a mechanical edit.

### Tripwires — recorded, not ticketed

- **`stampSeekProvenance` descends only `FilterNode`.** Fine now — `finishSeek`'s collation
  residual is the only wrapper any seek arm produces. If a future arm wraps its seek in
  something else the stamp is skipped silently and the seek looks like it enforces nothing.
  Parked as a `NOTE:` on the function's doc comment in
  `packages/quereus/src/planner/rules/access/rule-select-access-path.ts`.

### Known gaps left open, with reasons

- **No consumer exercises either field.** Every assertion is on the recorded value, not on a
  rewrite that uses it. That is inherent to the ticket's scope — it deliberately lands the
  data ahead of `feat-key-set-seek-over-pushed-constraints`, which is the ticket that will
  read it. Not worth synthesizing a fake consumer.
- **Correlated (index-nested-loop) seeks have no `pushedConstraints` assertion.**
  `selectPhysicalNode` is also called from `rules/join/index-nested-loop.ts` with synthesized
  `innerCol = outerCol` constraints; those now get stamped with an outer-side
  `sourceExpression`. Correct data, and documented in both the field's doc comment and
  `docs/optimizer-retrieve.md`, but nothing pins the shape. Left open deliberately: the
  meaningful assertion is about what a consumer may do with an outer-referencing
  `sourceExpression`, and there is no consumer yet.
- **Composite-IN cross-product and prefix-equality-plus-trailing-range arms are covered only
  indirectly.** They share the one stamping site with the six arms that do have cases, so
  they cannot diverge structurally. Judged not worth six near-duplicate tests.
- **`rule-select-access-path.ts` is 1615 lines** (`wc -l`, post-change; the diff added 38).
  Large enough to be worth splitting, but no size-debt ticket was filed: the size is
  pre-existing and not materially worsened here, and I did not investigate far enough to name
  a specific split seam — filing without one would just move the investigation into the
  queue. Recording the measurement here so the next reader has it.
