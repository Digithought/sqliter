---
description: A query that joins a duration column to a plain text column, and also filters one side of the join to a specific value, could silently lose matching rows because the engine copied the filter's value onto the other column and compared it as raw text.
files:
  - packages/quereus/src/planner/nodes/join-node.ts                              # extractEquiPairsFromCondition — gate applied, doc comment rewritten
  - packages/quereus/src/util/comparison.ts                                      # semanticOrderingsAgree — reused predicate, unchanged
  - packages/quereus/src/planner/analysis/coverage-prover.ts                     # pureJoinEquiAttrPairs — read only, confirmed it degrades safely (see below)
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic                  # regression assertions added to "Mixed-type equi-join keys" section
  - docs/types.md                                                                # § "Semantic ordering" — updated
  - docs/optimizer-fd.md                                                         # "Join equi-pairs" bullet — updated
difficulty: easy
---

# Gate the logical equi-pair extractor on semantic ordering

## What changed

`extractEquiPairsFromCondition` (`packages/quereus/src/planner/nodes/join-node.ts`)
now requires `semanticOrderingsAgree(left.getType().logicalType, right.getType().logicalType)`
in addition to the pre-existing `isValueDiscriminatingEquality` collation gate, before
minting a `{left, right}` equi-pair from an `=` conjunct. This mirrors the gate the
*physical* extractor (`rules/join/equi-pair-extractor.ts`) already applied. A
`timespan_col = text_col` (or any mixed semantic-ordering pair, e.g. `json ↔ text`)
conjunct now contributes **zero** pairs instead of one, which is a sound under-claim:
consumers already treat "no pair for this conjunct" as "leave it in the residual /
generic comparison", never as an error.

The doc comment above the function was rewritten to state the semantic-ordering
requirement as settled behavior (previously it flagged the missing gate and pointed
at this ticket). `docs/types.md` § "Semantic ordering" and `docs/optimizer-fd.md`
("Join equi-pairs" bullet) were updated the same way — both previously described this
as a known gap; both now describe the closed gate. `docs/types.md`'s "Two surfaces
still do not follow the rule" became "One surface" (only AS OF match columns remain
ungated, tracked separately as `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering`).

## Why this was safe (not a broader risk)

`extractEquiPairsFromCondition` is one shared choke point for 8 consumers (`JoinNode`
itself, `coverage-prover.ts`, `rule-fanout-lookup-join`, `rule-join-elimination`,
`rule-join-key-inference`, `rule-semijoin-existence-recovery`, `rule-anti-join-fk-empty`,
`rule-semi-join-fk-trivial`). Every one already treats "extractor returned fewer/no
pairs" as the safe no-optimization path (declines the rewrite / falls back to a
generic join), so gating the choke point tighter can only remove wrong optimizations,
never introduce a new wrong answer.

One consumer got a closer read rather than a guess, because it cross-checks the pair
count against something else: `pureJoinEquiAttrPairs` in
`planner/analysis/coverage-prover.ts` (used by the inner-join no-row-loss proof) calls
`pureColumnEquiConjunctCount` to count `=`-of-columns conjuncts in the raw condition,
then requires `extractEquiPairsFromCondition`'s pair count to equal that count —
if they disagree it returns `undefined` (`packages/quereus/src/planner/analysis/coverage-prover.ts:738`),
which the caller (`innerJoinRetainsConstrainedTable`) treats as "no-row-loss not
proven" (`packages/quereus/src/planner/analysis/coverage-prover.ts:783`). A mixed-type
conjunct now makes the counts disagree by exactly the design this function already
handles for same-side filters — confirmed this reads correctly; no change needed.

## How to validate

- `select mxa.id as l, mxb.id as r from mxa join mxb on mxa.d = mxb.s where mxa.d = 'PT1H';`
  (mxa.d is `timespan`, mxb.s is `text`) now returns `[{"l":1,"r":10}]` instead of `[]` —
  previously the equi-pair fact let `rule-predicate-inference-equivalence` copy the
  `mxa.d = 'PT1H'` pin onto `mxb.s = 'PT1H'` and compare it as text, which matches
  nothing (`mxb.s` holds `'PT60M'`/`'PT45M'`).
- Both operand orders (`on mxa.d = mxb.s` / `on mxb.s = mxa.d`) and both pin sides
  (pinning the timespan side, pinning the text side) are covered — see the new block
  in `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` right before
  `drop table mxb; drop table mxa;` in the "Mixed-type equi-join keys agree with `=`"
  section. Each `on … where` assertion is paired with an equivalent `cross join …
  where` oracle query asserting the same result, plus one case
  (`where mxb.s = 'PT1H'`) that is *correctly* empty — pinning the TEXT side to a
  spelling that only matches under semantic-ordering comparison, not as plain text —
  to pin the asymmetry as intended rather than accidental.
- The existing same-type control in that file (`sma`/`smb`, both `timespan`) stays
  green, proving the gate does not over-decline a legitimate same-type equi-join.

## Test status

`yarn workspace @quereus/quereus run test`: **7450 passing, 0 failing, 13 pending**
(full suite, includes the new sqllogic assertions — the sqllogic runner counts one
mocha test per file, not per assertion, so the pass count doesn't move 1:1 with
assertions added). `yarn workspace @quereus/quereus run lint` (eslint + test-file
`tsc --noEmit`): clean, exit 0. `yarn build` (project-references `tsc -b`): clean,
exit 0.

## Known gaps / not covered by this ticket

- **AS OF match/partition columns** still compare by storage class + collation, not
  semantic ordering — a `timespan`/`json` AS OF match column can still mismatch. AS OF
  has no residual to demote a declined pair into, so this needed a different fix
  shape and was intentionally left out of scope. Tracked as
  `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering`.
- **`extractEqualityFds`** (`packages/quereus/src/planner/util/fd-utils.ts`), the
  neighboring filter-level extractor that mints FDs/ECs from `where`-clause equalities,
  still carries only the collation gate, not the semantic-ordering one. The prior
  implement pass probed this for an observable over-claim (constant substitution into
  projections, `distinct`, `group by`, `order by` transfer, transitive two-conjunct
  pins) across both a cross-column mixed pair and a single-column pin, and found no
  wrong answer — every equivalence class this extractor could mint from a mixed-type
  `where` conjunct apparently gets rejected or corrected elsewhere before it would
  cause a wrong answer. This was not independently re-verified in this review pass;
  it's a probe result carried forward, not a proof. If a future change makes this
  extractor's ECs drive a rewrite the current safety net doesn't cover, the same
  `semanticOrderingsAgree` gate is the fix.
- I did not independently re-derive why `extractEqualityFds` is safe without the gate
  (only inherited the prior pass's probe results) — if reviewing this ticket, treat
  that "clean" verdict as unverified rather than proven, and re-probe if there's
  reason to doubt it (e.g. a new consumer of its ECs).

## Review findings

(none yet — this section is for the review stage to fill in)
