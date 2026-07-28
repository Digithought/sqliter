---
description: A query that joined a duration column to a plain text column, and also filtered one side to a specific value, silently lost matching rows because the engine copied the filter's value onto the other column and compared it as raw text. Fixed.
files:
  - packages/quereus/src/planner/nodes/join-node.ts                              # extractEquiPairsFromCondition — gate applied, doc comment rewritten
  - packages/quereus/src/util/comparison.ts                                      # semanticOrderingsAgree — reused predicate, unchanged
  - packages/quereus/src/planner/analysis/coverage-prover.ts                     # pureJoinEquiAttrPairs — read only, degrades safely
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic                  # regression assertions
  - docs/types.md                                                                # § "Semantic ordering" — updated (twice: implement, then review)
  - docs/optimizer-fd.md                                                         # "Join equi-pairs" + extractEqualityFds bullets — updated
difficulty: easy
---

# Gate the logical equi-pair extractor on semantic ordering

## What shipped

`extractEquiPairsFromCondition` (`packages/quereus/src/planner/nodes/join-node.ts`) now
requires `semanticOrderingsAgree(left.getType().logicalType, right.getType().logicalType)`
alongside the pre-existing `isValueDiscriminatingEquality` collation gate before minting a
`{left, right}` equi-pair from an `=` conjunct — the same pair of gates the *physical*
extractor (`rules/join/equi-pair-extractor.ts`) already applied. A `timespan = text` (or
any mixed semantic-ordering) conjunct now mints zero pairs. Every one of the extractor's
eight consumers treats "no pair" as the safe no-optimization path, so the tighter gate can
only remove wrong optimizations.

Before the fix,
`select … from mxa join mxb on mxa.d = mxb.s where mxa.d = 'PT1H'` (a `timespan` joined to
a `text` column) returned `[]`: the bogus equi-pair let
`rule-predicate-inference-equivalence` copy the pin onto `mxb.s = 'PT1H'` and compare it as
plain text, which matches nothing because `mxb.s` stores `'PT60M'`. It now returns the
matching row, agreeing with the `cross join … where` oracle.

Regression coverage lives in the "Mixed-type equi-join keys agree with `=`" section of
`packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`: both operand orders, both
pin sides, each paired with a `cross join` oracle, plus the case that is *correctly* empty
(pinning the text side to a spelling only semantic comparison matches) so the asymmetry is
pinned as intended. The same-type `timespan`/`timespan` control in that file stays green,
proving the gate does not over-decline.

## Review findings

**Diff read first, handoff second.** Change is 2 lines of logic + comment/doc edits.

*Checked and clean:*
- **Gate parity with the physical extractor** — `join-node.ts:88-89` is character-for-character
  the same pair of conditions as `equi-pair-extractor.ts:197-198`. No divergence to drift.
- **`semanticOrderingsAgree` semantics** — returns true only for "neither side semantic" or
  "both semantic and the *same* `LogicalType` instance". Identity comparison means two
  distinct instances of a same-named type would over-decline, which is the safe direction;
  the same-type control test proves the common path still forms pairs. Not worth a NOTE —
  the function's own doc comment already states the rule.
- **`pureJoinEquiAttrPairs`** (`analysis/coverage-prover.ts:723`) — the one consumer that
  cross-checks the extractor's pair count against `pureColumnEquiConjunctCount`. A declined
  mixed conjunct makes the counts disagree, returning `undefined`, which
  `innerJoinRetainsConstrainedTable` reads as "no-row-loss not proven" and declines. Verified
  by reading both functions: conservative direction, no change needed.
- **Other equality-fact gate sites** — swept all `isValueDiscriminatingEquality` callers.
  `rule-scalar-agg-decorrelation.ts:642` (`isValueFaithfulPair`) requires the two sides to
  share a logical type *name*, which is strictly stronger than `semanticOrderingsAgree`; no
  gap there.
- **Tests / lint / build** — re-ran `yarn workspace @quereus/quereus run test`: 7450 passing,
  0 failing, 13 pending. `yarn workspace @quereus/quereus run lint` (eslint + test-file
  `tsc --noEmit`): clean, exit 0. Matches the handoff's numbers.
- **Handoff's unverified claim, independently re-probed.** The implement pass admitted it had
  only inherited a prior probe result for `extractEqualityFds` and asked the reviewer not to
  trust it. Re-probed from scratch with a throwaway spec over a `timespan` column and a mixed
  `timespan`/`text` column pair: constant substitution into a projection and into a `||`
  expression, `distinct`, `group by`, `order by` transfer, `in (subquery)`, correlated
  `exists`, and a transitive two-conjunct pin. All eight returned the correct rows and the
  correct stored spellings. Probe file removed afterward.

*Fixed inline (minor):*
- `docs/types.md` § "Semantic ordering" had been rewritten to claim "**One** surface still
  does not follow the rule" (AS OF only). That over-claimed closure — `extractEqualityFds`
  is a second ungated surface, as the handoff itself conceded two paragraphs later. Restored
  it to two surfaces and described the latent one plainly, with the probe evidence for why it
  is not a bug today and why the gate was not simply copied over.
- `docs/optimizer-fd.md`'s `extractEqualityFds` bullet described only the collation gate with
  no hint that the sibling join extractors now carry a second one. Added a sentence stating
  the asymmetry and pointing at the new ticket.

*Filed as a new ticket (major):*
- `tickets/backlog/debt-filter-equality-facts-ignore-semantic-ordering` —
  `extractEqualityFds` mints facts that are *false*, not merely imprecise, for
  semantic-ordering operands: `where d = 'PT60M'` records "`d` holds exactly `'PT60M'` in
  every surviving row" while keeping a row that stores `'PT1H'`. Dormant, so `debt-` rather
  than `bug-`, but any future consumer that trusts the fact returns wrong rows on day one.
  Filed rather than fixed inline because the obvious one-line copy of the join gate is
  wrong-shaped for the `col = literal` case (it would decline every constant pin on a
  `timespan`/`json` column and cost real optimizations); the ticket lays out three candidate
  fix shapes to weigh.

*Tripwires:* none. Nothing in this diff is a "fine now, matters if X grows" concern — the one
conditional-looking item (`extractEqualityFds`) is a definite falsehood on a dormant path, so
per the tripwire rule it belongs in a ticket, and that is where it went.

*Deliberately not chased:* `docs/invariants.md` OPT-050 ("Equality facts require a
value-discriminating collation") lists `fd-utils.ts` and `comparison-collation.ts` but not
either join extractor, and there is no invariant covering semantic ordering at all. Both
predate this ticket and neither is made worse by it — an invariants entry for the semantic
ordering rule is a docs task of its own, not review scope here.

## Known gaps carried forward

- **AS OF match/partition columns** still compare by storage class + collation, so a
  `timespan`/`json` AS OF match column can mismatch. AS OF has no residual to demote a
  declined pair into, so it needs a different fix shape. Tracked as
  `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering`.
- **Filter-level equality facts** — see the ticket above.
