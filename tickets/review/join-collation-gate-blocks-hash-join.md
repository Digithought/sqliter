---
description: Joins on text keys with different declared text-sorting rules (the default shape for every foreign-key join on the persistent store) previously fell back to comparing every row against every row; the planner now picks its fast hash-join strategy for them, restoring linear scaling, while merge join and plan-time equality facts stay correctly restricted.
files:
  - packages/quereus/src/planner/nodes/join-utils.ts                        # EquiJoinPair: new required collationsMatch / valueDiscriminating flags
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts          # gate split: extract + tag instead of reject; conflict pairs stay residual
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts # merge requires all pairs collationsMatch; build/probe flip spreads flags
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts    # driving pair must be collationsMatch; defer-check gated the same way
  - packages/quereus/src/planner/nodes/bloom-join-node.ts                   # factPairs(): valueDiscriminating filter on keys/FDs/ECs; flags in plan dump
  - packages/quereus/src/planner/nodes/merge-join-node.ts                   # same, plus monotonicOn filtered
  - packages/quereus/src/planner/analysis/comparison-collation.ts           # CollationCarrier: structural param type for resolveComparisonCollation
  - packages/quereus/src/planner/analysis/coverage-prover.ts                # JoinAttrPair slice type; soundness note for non-discriminating pairs
  - packages/quereus/src/runtime/emit/bloom-join.ts                         # comment only (behavior already correct)
  - packages/quereus/src/runtime/emit/merge-join.ts                         # comment only (points at the new enforcement site)
  - packages/quereus/test/plan/join-selection.spec.ts                       # new mismatched-collation plan assertions
  - packages/quereus/test/planner/collation-soundness.spec.ts               # USING test updated to new contract; new cross-side fact test
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts           # tagged-return-shape tests incl. declared-conflict sink
  - packages/quereus/test/logic/11.3-mismatched-collation-join.sqllogic     # result-correctness net (INNER/LEFT/SEMI/ANTI/USING, both directions)
  - docs/optimizer-joins.md                                                  # gate → tag documentation
  - docs/optimizer-fd.md                                                     # join equi-pairs bullet updated
---

# Review: hash join now fires on mismatched-collation join keys

## What was wrong

`extractEquiPairs` (`rules/join/equi-pair-extractor.ts`) refused to recognize
`t.id = e.txn_id` as an equi-pair whenever the two columns declared different
collations. On the persistent store an undecorated `text` primary key defaults to
`NOCASE` while a plain `text` column stays `BINARY`, so *every* text fk→pk join
there had zero extracted pairs, `rule-join-physical-selection` never fired, and
the join stayed a quadratic nested loop (34 ms → 2098 ms per 10× data, per the
fix-stage measurements).

## What changed

**Gate split.** The old single matched-collation accept condition encoded two
independent concerns; they now travel as two required flags on `EquiJoinPair`:

- `collationsMatch` — merge join's admission bit. Merge needs both inputs
  physically ordered under the key's comparison collation and the ordering
  property is collation-blind, so both selection rules take merge as a candidate
  only when **every** pair is matched (`rule-join-physical-selection` sets merge
  cost to `Infinity` otherwise; `rule-monotonic-merge-join` skips unmatched
  driving pairs, and defers to the ordering rule only when that rule can
  actually merge).
- `valueDiscriminating` — the fact-minting bit (`isValueDiscriminatingEquality`).
  `BloomJoinNode` / `MergeJoinNode` now filter to these pairs (via a private
  `factPairs()`) before `combineJoinKeys`, `analyzeJoinKeyCoverage`,
  `propagateJoinFds`, and (merge only) `propagateJoinMonotonicOn` — closing the
  pre-existing over-claim where a matched-`NOCASE` merge join published
  equivalence classes and bidirectional determination FDs coupling rows like
  `'Bob'`/`'bob'` that are not value-equal. The full pair set still reaches the
  runtime emitters (a non-discriminating pair is a fine join *condition*, just
  not a value *fact*).

Extraction itself now admits every `ColumnRef = ColumnRef` pair regardless of
collation. Two shapes are still declined: the semantic-ordering gate is
unchanged (`timespan = text` stays residual), and a same-rank explicit/declared
collation *conflict* (declared NOCASE vs declared RTRIM) is left in the residual
so the plan-time error surfaces from `BinaryOpNode.generateType`, never from a
join rule (and never as a throw inside extraction). `extractEquiPairsFromUsing`
gets the same treatment (mismatched → tagged pairs; conflict or mixed semantic
ordering → whole extraction sinks to null, since USING has no residual).

No runtime emitter changes were needed: `emit/bloom-join.ts` already resolves
each pair's collation symmetrically (`effectiveCollationOfTypes`) and normalizes
both sides' hash keys under the result. Both emitters' lockstep comments were
rewritten to point at the new enforcement sites.

**Supporting changes.** `resolveComparisonCollation` / `collationContribution`
now accept a structural `CollationCarrier` (`Pick<ScalarType, 'collationName' |
'collationSource'>`) so the USING extractor can run conflict detection over
attribute-type slices. `coverage-prover.ts`'s `pureJoinEquiAttrPairs` returns a
new `JoinAttrPair` id-slice type instead of full `EquiJoinPair` (its proofs read
only the pairing; the doc comment records why non-discriminating pairs are safe
for the no-row-loss direction). The build/probe flip in
`rule-join-physical-selection` spreads the source pair so flags survive.
`getLogicalAttributes()` on both physical nodes serializes the flags **only when
non-default**, so existing plan-dump goldens stay byte-identical while a
mismatched pair is visible in `query_plan()`.

## Measured outcome (LevelDB store, undecorated text PKs — the reported shape)

Re-run of the fix-stage harness (schema `txn`/`entry` + `account`/`account_group`,
2 entries per txn; JOIN2 = 2-way join with filter + order by; JOIN4 = 4-way
grouped join; timing harness deliberately NOT committed):

| N | JOIN2 before (fix-stage, nested loop) | JOIN2 after (hash join) | JOIN4 after | control (IndexSeek) |
|---|---|---|---|---|
| 100 | 34 ms | 6.4 ms | — | ~3 ms |
| 1000 | **2098 ms** | **33–41 ms** | 63 ms | ~4 ms |
| 5000 | not run | 194–209 ms | 322 ms | ~6 ms |

Plan on the store path is now `HASHJOIN` over two `INDEXSCAN`s (was nested-loop
`JOIN` + `Cache`); all three joins of JOIN4 select `HASHJOIN`. Scaling is linear
(~5× time per 5× rows), matching the ticket's "PK forced to `collate binary`"
control row — without touching anyone's schema.

## Validation run

- `yarn build`, `yarn lint`, root `yarn test` (all workspaces) — green.
- `yarn test:store` — green (7461 passing / 20 pending). One iteration was
  needed: the new sqllogic's fan-out section originally used a plain text PK,
  which the *store* defaults to NOCASE (the very behavior under fix), collapsing
  the case-variant seed rows; the parent's case-variant column is now a non-PK
  column so the file is mode-agnostic.
- Golden plan snapshots unchanged (flags serialize only when non-default).

## Test surface for the reviewer

- `test/plan/join-selection.spec.ts` — mismatched pair selects `HASHJOIN` (both
  directions of which side carries the `COLLATE`, and LEFT); never `MERGEJOIN`
  even when both inputs are ordered on the key; matched-NOCASE control still
  physical; result-shape check that case-variants join.
- `test/planner/collation-soundness.spec.ts` — new test walks the optimized tree
  to the physical join and asserts no equivalence class and no
  `determination`-kind FD couples the two sides for a matched-NOCASE join
  (composite key FDs spanning sides are legitimately allowed); the USING test at
  the old reject-outright contract was updated, keeping its row-count and
  no-key-over-claim assertions.
- `test/planner/equi-pair-semantic-gate.spec.ts` — tagged return shape for
  USING: mismatched → `collationsMatch:false/valueDiscriminating:false`; matched
  NOCASE → `true/false`; declared NOCASE-vs-RTRIM conflict → null; semantic
  ordering sinks unchanged.
- `test/logic/11.3-mismatched-collation-join.sqllogic` — INNER / LEFT / SEMI
  (IN + EXISTS) / ANTI / USING over NOCASE-vs-BINARY keys, both directions,
  including the fan-out shape where one NOCASE probe row matches two
  binary-distinct rows (join, DISTINCT and SEMI all correct).

## Known gaps / judgment calls to scrutinize

- **Deliberate under-claim on matched-NOCASE key coverage.** Filtering *all*
  non-`valueDiscriminating` pairs out of `analyzeJoinKeyCoverage` also drops
  key-coverage/estimated-rows claims for matched-NOCASE pairs whose covered key
  is itself NOCASE-enforced — a case where the claim would have been sound and
  which HEAD previously made. No test regressed, but plans over NOCASE-keyed
  schemas get weaker cardinality info than before. Tripwire NOTE comments sit on
  `factPairs()` in both physical nodes; a collation-aware coverage check is the
  escape hatch if this ever bites.
- **Merge on the matched subset of a mixed multi-key join is not attempted**
  (all-or-nothing `collationsMatch` on the merge branch), per the ticket's
  minimal-change rationale. Costs an optimization on a rare shape, never a row.
- **`rule-monotonic-merge-join` can now fire while a *different* pair is
  mismatched** (the mismatched pair is residualized; only the driving pair must
  be matched). This is sound — the merge comparator only touches the driving
  key — but is a behavior the old blanket gate made impossible; worth a second
  pair of eyes.
- The `estimatedRows` input to the physical-selection *cost comparison* still
  uses the raw child estimates (unchanged); only the propagated output facts
  changed.
- `isValueDiscriminatingUsingPair` duplicates the plan-node gate's logic over
  declared attribute slices (both-BINARY, else both-never-text). Kept local to
  the extractor; if a third variant ever appears it should be consolidated.
