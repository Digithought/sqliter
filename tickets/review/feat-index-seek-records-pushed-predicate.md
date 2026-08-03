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
enforcer. Until now the node kept only the encoded form (column index + operator + argv
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
- `rule-monotonic-range-access.ts` — **not in the original ticket's file list.** Its two
  `IndexSeekNode` clone helpers (`leafWithRangeBound`, `leafWithMonotonicSuppressed`)
  reconstruct the node argument-by-argument and would have silently dropped both new fields,
  the same hazard the ticket flagged for `withChildren`. Both now carry them through.
- `docs/optimizer-retrieve.md` — new "Seek provenance" subsection under the Retrieve
  physicalization docs.

## Validation

- `yarn build` — clean.
- `yarn test` — green across every workspace (8587 passing in `packages/quereus`,
  13 pending; all other packages passing). `test/plan/golden-plans.spec.ts` unchanged:
  neither field is in `getLogicalAttributes`, and `git status` shows no golden file moved.
- `yarn lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).

### New spec: `test/optimizer/pushed-constraints-recorded.spec.ts` (10 tests)

Inspects plan nodes directly via `db.getPlan(sql)` + `collectNodes(plan, isIndexSeek)`.
Fixture: `t (pk integer primary key, s text, n integer)` with secondary indexes on `s`
and `n`.

| Case | Asserts |
| --- | --- |
| `where s = 'x'` | one constraint, `sourceExpression` is the `=` `BinaryOpNode` |
| `where pk between 2 and 5` | two constraints sharing ONE `BetweenNode`; `combineResidualExpressions` returns that node, not an AND of it with itself |
| `where pk in (1,2,3)` | the `InNode` recorded (multi-seek arm) |
| `where n < 20 or n > 80` | one `OR_RANGE` constraint carrying the whole `OR` node |
| `where pk > 1 and pk < 9` | two distinct constraints, ops in `constraints` order (`['>', '<']`) |
| `withChildren` round-trip | forced reconstruction preserves both fields |
| `where n >= 20 order by n` | Sort absorbed (no `SortNode` in plan), seek has `orderingLoadBearing === true` **and** its provenance |
| same query without `order by` | `orderingLoadBearing === false` |
| `name > 'banana' collate nocase` over a BINARY index | `MISMATCH_UNSAFE` → `SeqScan` + residual `Filter`, no seek stamped |
| legacy-arm PK equality | recorded, and the plan still executes (returns the right row) |

The legacy arm is reached via a `LegacyPlanMemoryModule` defined in the spec: it subclasses
`MemoryTableModule` and deletes `indexName` / `seekColumnIndexes` from the returned access
plan, leaving everything else (including the runtime) stock.

## Answers to the two questions the ticket asked for

**Is "Sort absorbed onto an IndexSeek" reachable from SQL?** Yes — it is not a hypothetical
path. `select pk, n from t where n >= 20 order by n` produces a range `IndexSeekNode` on
`idx_n` with `providesOrdering` set, `orderingLoadBearing === true`, and no `SortNode` left
in the plan. A probe over five shapes found four that hit it (single-bound range, range +
LIMIT, text range, PK `BETWEEN`); only the `OR_RANGE` shape does not advertise ordering.
Two tests cover it — the absorbed case and the no-`ORDER BY` control that must stay `false`.

That makes the `orderingLoadBearing` propagation **not** inert, contrary to the ticket's
expectation: the flag now reaches real seeks. It has no reader today, but the moment
`rule-key-set-seek` is allowed to target a seek, this is live correctness data.

**Did any golden plan move?** No. Neither field is exposed via `getLogicalAttributes`, and
the full suite (including `golden-plans.spec.ts`) is green with no snapshot file modified.

## Known gaps / what a reviewer should push on

- **No consumer exercises either field.** Every assertion is on the recorded value, not on a
  rewrite that uses it. The real proof arrives with
  `feat-key-set-seek-over-pushed-constraints`.
- **Correlated (index-nested-loop) seeks are untested here.** `selectPhysicalNode` is also
  called from `rules/join/index-nested-loop.ts` with synthesized `innerCol = outerCol`
  constraints; those now get stamped with an outer-side `sourceExpression`. That is correct
  data and documented in the field's doc comment and in `docs/optimizer-retrieve.md`, but no
  test asserts what an INLJ seek's `pushedConstraints` contains. Worth adding when a
  consumer exists to care.
- **`COARSER_SAFE` double-application is not tested.** The doc comment states that under a
  coarser-collation cover the constraint is recorded on the seek *and* re-applied above it,
  so a consumer that re-applies produces a redundant (correct, one extra evaluation)
  predicate. No test pins that shape; the collation test covers only the `MISMATCH_UNSAFE`
  decline.
- **Composite / prefix-range arms are covered only indirectly.** The spec exercises single-
  column equality, IN, two-sided range, `BETWEEN`, `OR_RANGE`, and legacy PK equality. The
  composite-IN cross-product and prefix-equality-plus-trailing-range arms share the same
  single stamping site, so they cannot diverge structurally, but neither has its own case.
- **`withProvenance` deliberately passes `undefined` for the cost override** rather than
  re-reading `this.estimatedCost`. The first attempt read it and tripped
  `test/planner/cost-additivity.spec.ts`'s static self-cost-only convention guard (which
  greps node sources for `.estimatedCost` reads). `undefined` is not a behaviour change: the
  base falls back to `filterInfo.indexInfoOutput.estimatedCost`, which is the very
  `accessPlan.cost` every seek arm passes as its override — same reasoning `withChildren`
  already relies on. Confirm that reasoning holds if you disagree.
- **`stampSeekProvenance` only descends `FilterNode`.** If a future seek arm wraps its leaf
  in anything else, the stamp is silently skipped rather than failing loudly. Matches the
  existing `while (probe instanceof FilterNode)` shape in `index-nested-loop.ts`; flagged
  rather than hardened.
