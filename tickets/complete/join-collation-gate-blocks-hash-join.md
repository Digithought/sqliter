---
description: Joins on text keys whose two columns declare different text-sorting rules — the default shape of every foreign-key join on the persistent store — used to fall back to comparing every row against every row; the planner now picks its fast hash-join strategy for them, restoring linear scaling, while merge join and plan-time equality facts stay correctly restricted.
files:
  - packages/quereus/src/planner/nodes/join-utils.ts                        # EquiJoinPair flags; shared valueFactPairs() / describeEquiPairs()
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts          # gate split: extract + tag instead of reject; conflict pairs stay residual
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # merge requires all pairs collationsMatch; build/probe flip spreads flags
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts    # driving pair must be collationsMatch; defer-check gated the same way
  - packages/quereus/src/planner/nodes/bloom-join-node.ts                   # fact-pair filter on keys/FDs/ECs; flags in plan dump
  - packages/quereus/src/planner/nodes/merge-join-node.ts                   # same, plus monotonicOn filtered
  - packages/quereus/src/planner/analysis/comparison-collation.ts           # CollationCarrier / TypeSlice; isValueDiscriminatingTypePair
  - packages/quereus/src/planner/analysis/coverage-prover.ts                # JoinAttrPair slice type; soundness note for non-discriminating pairs
  - packages/quereus/src/runtime/emit/bloom-join.ts                         # comment only (behavior already correct)
  - packages/quereus/src/runtime/emit/merge-join.ts                         # comment only (points at the new enforcement site)
  - packages/quereus/test/plan/join-selection.spec.ts                       # mismatched-collation plan assertions
  - packages/quereus/test/planner/collation-soundness.spec.ts               # USING test updated; cross-side fact test
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts           # USING + ON-condition tagging unit tests
  - packages/quereus/test/logic/11.3-mismatched-collation-join.sqllogic      # result-correctness net (INNER/LEFT/SEMI/ANTI/USING, both directions)
  - docs/optimizer-joins.md                                                  # gate → tag documentation
  - docs/optimizer-fd.md                                                     # join equi-pairs bullet; the gate's three input shapes
---

# Hash join now fires on mismatched-collation join keys

## What was wrong

`extractEquiPairs` refused to recognize `t.id = e.txn_id` as an equi-pair whenever
the two columns declared different collations. On the persistent store an
undecorated `text` primary key defaults to `NOCASE` while a plain `text` column
stays `BINARY`, so *every* text fk→pk join there produced zero equi-pairs,
physical join selection never fired, and the join stayed a quadratic nested loop
(34 ms → 2098 ms per 10× data).

## What shipped

**The single "matched collation" accept condition was split into two flags on
`EquiJoinPair`**, both required at every construction site:

- `collationsMatch` — merge join's admission bit. Merge needs both inputs
  physically ordered under the key's comparison collation, and the ordering
  property is collation-blind, so both selection rules take merge as a candidate
  only when *every* pair is matched.
- `valueDiscriminating` — the fact-minting bit. `BloomJoinNode` /
  `MergeJoinNode` filter to these pairs before `combineJoinKeys`,
  `analyzeJoinKeyCoverage`, `propagateJoinFds` and (merge only)
  `propagateJoinMonotonicOn`, closing a pre-existing over-claim where a
  matched-`NOCASE` join published equivalence classes and determination FDs
  coupling rows like `'Bob'`/`'bob'`. The full pair set still reaches the runtime
  emitters — a non-discriminating pair is a fine join *condition*, just not a
  value *fact*.

Extraction now admits every `ColumnRef = ColumnRef` pair regardless of collation.
Two shapes are still declined: the semantic-ordering gate is unchanged
(`timespan = text` stays residual), and a same-rank explicit/declared collation
*conflict* is left in the residual so the plan-time error surfaces from
`BinaryOpNode.generateType` rather than from a join rule. `USING` gets the same
treatment, except that having no residual it sinks the whole extraction on a
conflict.

No runtime emitter changes were needed: the hash emitter already resolves each
pair's collation symmetrically and normalizes both sides' keys under the result.

## Measured outcome (LevelDB store, undecorated text PKs)

| N | JOIN2 before (nested loop) | JOIN2 after (hash join) | JOIN4 after | control (IndexSeek) |
|---|---|---|---|---|
| 100 | 34 ms | 6.4 ms | — | ~3 ms |
| 1000 | **2098 ms** | **33–41 ms** | 63 ms | ~4 ms |
| 5000 | not run | 194–209 ms | 322 ms | ~6 ms |

Scaling is linear (~5× time per 5× rows), matching the "PK forced to
`collate binary`" control — without touching anyone's schema.

## Review findings

### Verified sound (checked, nothing found)

- **Result correctness of admitting mismatched pairs.** The hash emitter
  (`runtime/emit/bloom-join.ts`) resolves one collation per pair through the
  symmetric lattice and applies the *same* normalizer array to build- and
  probe-side keys, so the hash key matches exactly the rows scalar `=` matches.
  Traced for both directions of which side carries the `COLLATE`.
- **Every consumer of the widened pair set was enumerated, not assumed.** All
  the FK/elimination/fan-out/semijoin rules (`rule-join-elimination`,
  `rule-fanout-lookup-join`, `rule-join-key-inference`,
  `rule-semijoin-existence-recovery`, `rule-semi-join-fk-trivial`,
  `rule-anti-join-fk-empty`) read the *logical* `extractEquiPairsFromCondition`,
  which is still value-discrimination-gated — so no mismatched pair can reach an
  index-seek path, where comparison would happen under the index's own collation
  rather than the resolved one. That was the highest-risk hypothesis; it does not
  reach.
- **Coverage prover.** `pureJoinEquiAttrPairs` now returns physical-join pairs
  that may be non-discriminating. The no-row-loss (≥1) direction stays sound — a
  coarser comparison matches a superset, so the FK-aligned parent row is never
  dropped. The complementary no-fan-out (≤1) direction is
  `proveJoinNoFanout`'s `isUnique(pk, topJoin)`, which reads the join's *output*
  keys; those come from `combineJoinKeys` over fact pairs only, so the proof
  fails closed on a NOCASE join instead of over-claiming.
- **Materialized-view matcher.** `equiPairsByBaseCol` compares fragment against
  MV pairs in base-column terms; both sides read the same schema, so collation is
  identical on both and the set comparison is unaffected.
- **`rule-monotonic-merge-join` firing with a mismatched non-driving pair** (the
  behavior the implementer flagged for a second pair of eyes). Traced: the
  non-driving pairs are residualized through `equiPairNodes`, and the merge
  emitter evaluates the residual per candidate row-pair, so the mismatched
  conjunct is evaluated by the `=` operator's own semantics. Sound. The
  `mergeAvailable` check is also permutation-invariant, so
  `reorderEquiPairsForMerge` cannot smuggle merge past it.
- **Docs.** Read `docs/optimizer-joins.md`, `docs/optimizer-fd.md`,
  `docs/optimizer.md`, `docs/invariants.md`, `docs/materialized-views.md` and the
  package README; grepped for every statement of the old "matched-collation gate"
  contract. Only the two files the implementer updated made such a claim, and both
  now read correctly.
- **Lint + tests.** `yarn build`, `yarn lint`, `yarn test` (7473 passing / 13
  pending in quereus, all other workspaces green), `yarn test:store` (7466
  passing / 20 pending). No pre-existing failures surfaced, so
  `.pre-existing-error.md` was not written.

### Fixed in this pass (minor)

- **DRY.** `factPairs()` — a 14-line doc comment plus body — and the equi-pair
  plan-dump serialization were duplicated verbatim in `bloom-join-node.ts` and
  `merge-join-node.ts`. Hoisted to `join-utils.ts` as `valueFactPairs()` and
  `describeEquiPairs()`, next to the `EquiJoinPair` definition they belong to.
  The tripwire NOTE now has one home instead of two copies to drift apart.
- **DRY, second copy.** `isValueDiscriminatingUsingPair` (the implementer's own
  flagged duplication) reimplemented the value-discrimination gate inside the
  extractor. Moved to `comparison-collation.ts` as `isValueDiscriminatingTypePair`
  alongside its two existing siblings, so the module that owns the gate owns all
  three of its input shapes (plan nodes / declared type slices / raw AST).
  `docs/optimizer-fd.md` now names all three.
- **Source hygiene.** The `JoinAttrPair` type declaration was wedged between two
  `import` statements in `coverage-prover.ts`; moved below the import block.
- **Stale comment.** `equi-pair-semantic-gate.spec.ts`'s module docstring still
  described the removed matched-collation gate.
- **Test gap.** `extractEquiPairs` — the ON-condition path, which is the
  production path for everything except `USING` — had no unit coverage of the new
  tagging; only `USING` did. Added five cases: matched-BINARY tagging,
  mismatched-collation tagging (the store fk→pk shape), operand-order
  normalization, a declared collation conflict surviving as residual while a
  sibling pair still extracts (asserting extraction neither throws nor admits it),
  and a non-textual pair staying value-discriminating despite a declared collation.

### Major findings

None. No new `fix/`, `plan/`, or `backlog/` tickets were filed — the widened
extraction is correct at every consumer traced above, and the two behavior
changes the implementer flagged as judgment calls (merge declining a mixed
multi-key join outright; the monotonic rule firing with a mismatched non-driving
pair) both check out as sound and are documented at their enforcement sites.

### Tripwires (conditional; deliberately not tickets)

- **Deliberate under-claim on matched-NOCASE key coverage.** Filtering all
  non-value-discriminating pairs out of `analyzeJoinKeyCoverage` also drops
  key-coverage and estimated-row claims for matched-NOCASE pairs whose covered key
  is itself NOCASE-enforced — a case where the claim *would* have been sound and
  which HEAD previously made. No test regressed, and the direction is the safe
  one. Parked as a `NOTE:` on `valueFactPairs()` in
  `packages/quereus/src/planner/nodes/join-utils.ts`, naming a collation-aware
  coverage check as the escape hatch if NOCASE-keyed plans ever regress.
- **Merge on the matched subset of a mixed multi-key join is not attempted** —
  all-or-nothing `collationsMatch` on the merge branch. Costs an optimization on a
  rare shape, never a row. Already parked as a comment at the decision site in
  `rule-join-physical-selection.ts` and in `docs/optimizer-joins.md`.

### Noticed, no action

`computePhysical` on both physical join nodes passes its index-pair array to
`analyzeJoinKeyCoverage` without the `>= 0` filter that `getType()` applies, so an
unresolvable attribute id would enter the set as `-1`. This is pre-existing
(untouched by this change) and inert — `-1` can never equal a real column index —
so it is neither a defect nor a tripwire, just an asymmetry worth knowing about if
either call site is ever refactored.
