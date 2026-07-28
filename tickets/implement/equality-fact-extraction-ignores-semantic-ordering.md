---
description: When a query joins a duration column to a plain text column and also filters on one of them, the engine copies the filter over to the other column and compares it as plain text, so matching rows silently disappear from the answer.
files:
  - packages/quereus/src/planner/nodes/join-node.ts                              # extractEquiPairsFromCondition — apply the gate here (2-line change + doc comment)
  - packages/quereus/src/util/comparison.ts                                      # semanticOrderingsAgree — the predicate to reuse (already exported)
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts  # the consumer that makes the over-claim observable (no edit expected)
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic                  # regression assertions go in the existing "Mixed-type equi-join keys" section
  - docs/types.md                                                                # § "Semantic ordering" — the "Two surfaces still do not follow the rule" paragraph
  - docs/optimizer-fd.md                                                         # lines ~103-104 — the two-extractors comparison
difficulty: easy
---

# Gate the logical equi-pair extractor on semantic ordering

## Confirmed reproduction

Ran against a scratch spec (`Database` + `prepare`/`iterateRows`), memory module, no fix
applied:

```
create table pa (id integer primary key, d timespan);
create table pb (id integer primary key, s text);
insert into pa values (1, 'PT1H'), (2, 'PT30M');
insert into pb values (10, 'PT60M'), (20, 'PT45M');
```

| query | before | expected |
|---|---|---|
| `… from pa cross join pb where pa.d = pb.s and pa.d = 'PT1H'` | `[{l:1,r:10}]` | same |
| `… from pa join pb on pa.d = pb.s where pa.d = 'PT1H'` | **`[]`** | `[{l:1,r:10}]` |
| `… from pa join pb on pb.s = pa.d where pa.d = 'PT1H'` | **`[]`** | `[{l:1,r:10}]` |
| `… from pa join pb on pa.d = pb.s where pb.s = 'PT60M'` | `[{l:1,r:10}]` | same |
| `… from pa join pb on pa.d = pb.s where pb.s = 'PT1H'` | `[]` | same (text pin genuinely matches nothing) |

Exactly the two rows the ticket predicted are wrong, in both operand orders, and only
when the pin sits on the `timespan` side.

## Confirmed cause and fix

`extractEquiPairsFromCondition` (`packages/quereus/src/planner/nodes/join-node.ts`, the
`op === '='` branch) gates only on `isValueDiscriminatingEquality`, which answers a
collation question. Adding the semantic-ordering conjunct that the *physical* extractor
already applies fixes every wrong row above and leaves the correct ones alone:

```ts
import { semanticOrderingsAgree } from '../../util/comparison.js';
…
if (n.left instanceof ColumnReferenceNode && n.right instanceof ColumnReferenceNode
    && isValueDiscriminatingEquality(n.left, n.right)
    && semanticOrderingsAgree(n.left.getType().logicalType, n.right.getType().logicalType)) {
```

Verified in-tree: with this applied all five queries above return the expected result,
and `yarn workspace @quereus/quereus run test` was **7451 passing / 0 failing / 13
pending** (plus a full `yarn test` across every package, all green). The probe edit was
then reverted, so the working tree is back at HEAD — re-apply it as the first step.

The gate is central, so all eight consumers of the extractor are covered at once
(`coverage-prover.ts`, `rule-fanout-lookup-join`, `rule-join-elimination`,
`rule-join-key-inference`, `rule-semijoin-existence-recovery`, `rule-anti-join-fk-empty`,
`rule-semi-join-fk-trivial`, plus `JoinNode` itself). Each treats an empty pair list as
"no fact", which is the safe under-claim. One consumer deserves a sanity read rather
than a guess: `pureJoinEquiAttrPairs` in `analysis/coverage-prover.ts` cross-checks the
extracted pair count against `pureColumnEquiConjunctCount`; a declined mixed conjunct
now makes those disagree, so the function returns `undefined` and the no-row-loss proof
declines. That is the intended direction, but confirm it reads that way.

## Probes that came back clean (do not widen scope for these)

The neighbouring filter-level extractor `extractEqualityFds`
(`packages/quereus/src/planner/util/fd-utils.ts`) mints the same kind of value-level fact
from a `where` predicate and carries only the collation gate too. Probed for a wrong
answer along every route that would expose an over-claim — constant substitution into a
projection, `distinct`, `group by`, `order by` transfer across the equivalence class,
and a transitive two-conjunct pin — for both the cross-column mixed pair
(`pa.d = pb.s`) and the single-column pin (`where pa.d = 'PT60M'`, whose stored spelling
is `'PT1H'`). Every one returned the correct value. No defect found there, so leave it
alone; if a future change makes an equivalence class drive a rewrite that this extractor
feeds, that is when the same gate becomes necessary.

## TODO

- Re-apply the two-line gate in `extractEquiPairsFromCondition` (import +
  `semanticOrderingsAgree` conjunct).
- Rewrite the doc comment paragraph above `extractEquiPairsFromCondition` that currently
  says the collation-only gate is "not enough" and points at this ticket: state the
  semantic-ordering gate as the rule, mirroring the wording in
  `rules/join/equi-pair-extractor.ts`, and drop the ticket reference.
- Add regression assertions to the existing "Mixed-type equi-join keys agree with `=`"
  section of `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`: for each of
  the two operand orders (`on mxa.d = mxb.s`, `on mxb.s = mxa.d`) and each pin side
  (`where mxa.d = 'PT1H'`, `where mxb.s = 'PT60M'`), assert the `on … where` form equals
  the `cross join … where` form. Include the `where mxb.s = 'PT1H'` case, which is
  correctly empty — it pins the asymmetry as intended rather than accidental.
- Keep the file's same-type control (`sma`/`smb`, both `timespan`) green: it proves the
  gate does not over-decline.
- Update `docs/types.md` § "Semantic ordering" — the "Two surfaces still do **not**
  follow the rule" paragraph loses its equality-fact-extraction half (AS OF remains, so
  it becomes one surface).
- Update `docs/optimizer-fd.md` lines ~103-104 — the sub-bullet saying the two extractors
  "differ on semantic ordering, and only the physical one is gated today" is no longer
  true; fold the semantic-ordering requirement into the main bullet alongside the
  collation requirement.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`.
