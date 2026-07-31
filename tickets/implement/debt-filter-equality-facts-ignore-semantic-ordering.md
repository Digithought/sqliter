---
description: When a query compares a duration column against a plain text column, the planner records "these two columns always hold the same text", which is not true — one hour can be written several different ways. Nothing acts on that false note today, but anything that starts to would return wrong rows. Stop recording it.
files:
  - packages/quereus/src/planner/util/fd-utils.ts                     # extractEqualityFds — add the gate to the col=col arm; buildPredicateFacts — NOTE only
  - packages/quereus/src/planner/nodes/plan-node.ts                   # ConstantBinding / ConstantValue — state the "compares equal to" contract
  - packages/quereus/src/util/comparison.ts                           # semanticOrderingsAgree — reused as-is, no change
  - packages/quereus/src/planner/nodes/join-node.ts                   # extractEquiPairsFromCondition — the already-gated sibling to mirror
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts    # extractEquiPairs — the other already-gated sibling
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts  # the consumer that would return wrong rows
  - packages/quereus/test/planner/collation-soundness.spec.ts         # sibling guard for the collation half (OPT-050)
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts     # sibling unit net for the join half
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic       # end-to-end regression file
  - docs/types.md                                                     # § "Semantic ordering" — "Two surfaces still do not follow the rule"
  - docs/optimizer-fd.md                                              # § "Collation gate on equality facts" — extractEqualityFds bullet
  - docs/invariants.md                                                # OPT-050 neighbourhood — new OPT-051
difficulty: medium
---

# Gate filter-level cross-column equality facts on semantic ordering

## Background: what a "semantic-ordering type" is

A few column types compare by *meaning* rather than by the text stored in them. A
`timespan` column holding `'PT1H'` (one hour) is equal to the value `'PT60M'` (sixty
minutes); a `json` column holding `'{"a":1}'` is equal to `'{ "a" : 1 }'`. Those two
types (`timespan`, `json`) declare `semanticOrdering: true`, and the engine-wide rule
(`docs/types.md` § "Semantic ordering") is that *every* place a value of such a type is
compared — `=`, `order by`, `distinct`, `group by`, `unique`, join keys — uses the
type's own comparison, never the raw text.

When the planner sees a `where` clause it records shortcut facts about the rows that
survive it, in `extractEqualityFds` (`packages/quereus/src/planner/util/fd-utils.ts`):

- `where col1 = col2` → mirror functional dependencies (`col1` determines `col2` and
  back) plus an **equivalence class** `{col1, col2}`.
- `where col = 'literal'` → a functional dependency `∅ → col` ("every surviving row
  agrees on `col`") plus a **constant binding** recording the literal.

Both extractions are gated on collation (`isValueDiscriminatingEquality`, invariant
OPT-050) but not on semantic ordering. The two join-side extractors that mint the same
kind of fact — `extractEquiPairsFromCondition` in `planner/nodes/join-node.ts` and
`extractEquiPairs` in `planner/rules/join/equi-pair-extractor.ts` — both carry the extra
`semanticOrderingsAgree` gate. `extractEqualityFds` is the odd one out.

## The design decision (this is settled — do not re-open it)

The prior ticket (`tickets/complete/equality-fact-extraction-ignores-semantic-ordering.md`)
listed three candidate shapes and asked for one to be chosen. It is chosen: **gate the
`col1 = col2` arm only, leave both `col = constant` arms untouched, and write down what a
constant binding actually claims.** Rationale, arm by arm:

### Arm 1 — `col1 = col2`: gate it. The fact is genuinely false.

Take `d timespan` and `s text`. `where d = s` matches on elapsed time, so both of these
rows survive:

| d        | s        |
|----------|----------|
| `'PT1H'` | `'PT60M'`|
| `'PT60M'`| `'PT1H'` |

The two rows agree on `d` (both are one hour, and `d`'s identity is elapsed time) but
disagree on `s` (`'PT60M'` and `'PT1H'` are two distinct strings, because `s`'s identity
is text). So `d → s` is false, and the equivalence class `{d, s}` is false: the two
columns do not have a common notion of "same value" to be equivalent under. Requiring
`semanticOrderingsAgree(leftLogicalType, rightLogicalType)` is exactly right here, costs
nothing observable, and makes the three extractors identical.

Same-type pairs (`timespan = timespan`, `json = json`) stay admitted — under the type's
own identity the mirror FDs and the equivalence class both hold, which is why the join
extractors admit them too.

### Arm 2 — `col = literal`: leave it alone. The fact is true under the engine's own notion of identity.

`where d = 'PT60M'` keeps every row whose `d` is one hour, whatever text it stores. Under
the engine's identity for a `timespan` column — the same identity `distinct`, `group by`
and `unique` already use, pinned throughout
`packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` — all those rows hold *the
same value*. So:

- The FD `∅ → d` ("all surviving rows agree on `d`") is **true**. Keeping it preserves
  cardinality/uniqueness reasoning.
- The constant binding is true when read as *"`d = 'PT60M'` evaluates true on every
  surviving row, under `d`'s declared comparison"* — and false only when read as *"`d`'s
  raw stored text is `'PT60M'`"*.

Every producer of a `ConstantBinding` produces the first reading (they all come from an
`=` conjunct or a declared `check`). Both consumers that exist today need only the first
reading:

- `rule-predicate-inference-equivalence` re-synthesizes `otherCol = <literal>` and types
  the synthesized literal **from the target attribute** (`synthesizeEquality`), so the
  comparison it emits is the target column's own comparison. Correct — *provided* the
  target column shares the source column's declared type, which is precisely what arm 1's
  gate now guarantees for equivalence-class transfers.
- `deriveFilterAttributeDefaults` (`planner/analysis/update-lineage.ts`) uses the binding
  as the omitted-column default when inserting through a filtered view. It writes a value
  that satisfies the view's predicate, which is all that is required.

Gating this arm would decline **every** constant pin on a `timespan`/`json` column
(a literal never declares a semantic-ordering type, so `semanticOrderingsAgree` is false
for every such conjunct), losing real optimizations to "fix" a claim that is not wrong.
Canonicalizing the bound value through the type's `groupKey` was also rejected: `json`
has no `groupKey`, `timespan`'s returns a *number* (so the recorded binding would stop
being a valid value of the column), and it would silently change which spelling a
filtered-view insert writes.

So the deliverable for arm 2 is **documentation, not code**: state the contract on the
`ConstantBinding` type so a future consumer that wants raw-value identity knows it must
not read one.

### Evidence this is dormant today, and how close it is to not being

Probed at HEAD with `query_plan()` and live queries over a `timespan`/`text` column pair.
The false facts **are** materialized — a Filter over
`where d = s and d = 'PT1H'` reports `equivClasses: [[1,2]]` and
`constantBindings: [{attrs:[1,2], value:'PT1H'}]`, i.e. the text column `s` is claimed to
hold `'PT1H'` while it stores `'PT60M'`. Every query still returned correct rows, because
the one consumer that would act on it, `rule-predicate-inference-equivalence`, reads
equivalence classes off the Filter's **source**, and adjacent filters merge into a single
Filter before that rule runs. Checked spellings that all stayed correct: nested
sub-select, common table expression, and a cross-join sub-select (a `join … on` is
already covered by the gated join extractor). One filter-merge change, or CTE references
starting to carry physical properties, re-opens it.

There is a second dormant consumer worth knowing about while editing: guard discharge.
`clauseEntailed` (same file) discharges an `eq-literal` guard clause by looking for **any
equivalence-class peer** pinned to that literal. With a false `{d, s}` class, a
`s = 'PT1H'` guard on a partial UNIQUE index would discharge from `d = 'PT1H'`, activating
a `kind: 'unique'` FD that does not hold. Arm 1's gate closes this route too — no separate
work needed, but say so in the handoff.

## What must NOT change

`buildPredicateFacts`' `columnEqs` (same file) records `col1 = col2` facts for guard
discharge and must stay ungated. It discharges an `eq-column` guard clause, and that
clause is the *same comparison* re-evaluated under the same declared types at index
maintenance time — so filter-rows and guard-scope-rows coincide whether or not semantic
ordering is involved. Gating it would be a pure completeness loss. Leave the code alone
and add a `NOTE:` comment saying why, so the next reader does not "fix" it for symmetry.

## Edge cases & interactions

Cases the implementation must handle and the reviewer will check:

- **Gate placement.** The new check belongs **inside** the `lIsCol && rIsCol` branch, not
  next to the existing `isValueDiscriminatingEquality` call at the top of the conjunct
  loop. At the top it would also kill every constant pin (arm 2), which is the failure
  mode this ticket exists to avoid. A test must pin that a `timespan = literal` conjunct
  still extracts.
- **Operand order.** `d = s` and `s = d` must behave identically (`semanticOrderingsAgree`
  is symmetric, but the surrounding branch is not — cover both).
- **Two different semantic-ordering types.** `timespan = json` must be declined
  (`semanticOrderingsAgree` returns false for two different semantic types, not just for
  mixed semantic/plain).
- **Same-type control.** `timespan = timespan` and `json = json` must still mint 2 mirror
  FDs + 1 equivalence pair. An over-declining gate is a silent optimization regression
  with no failing test unless one is written.
- **Type-identity comparison.** `semanticOrderingsAgree` compares `LogicalType` by object
  identity, so two distinct instances of a same-named type over-decline. That is the safe
  direction and matches the join extractors; do not "improve" it here.
- **Undeclared / `ANY` / unknown types.** `undefined` and `ANY` count as non-semantic, so
  `any_col = text_col` stays admitted; `any_col = timespan_col` is declined. Both are
  already pinned for the predicate itself in `equi-pair-semantic-gate.spec.ts` — the new
  tests need only cover them through `extractEqualityFds`.
- **Non-column operands.** `cast(x as timespan) = s` is not a bare `ColumnReferenceNode`
  on the left, so it never reaches the col=col arm; it falls to `constantValueOf`, which
  peels `CastNode`/`CollateNode`. Confirm the gate does not accidentally change that path.
- **Interaction with the collation gate.** A conjunct must satisfy **both** gates. A
  `timespan collate nocase = timespan` shape is already rejected by the collation gate;
  make sure adding the second gate does not reorder the two checks in a way that changes
  which one rejects (it should not — both are pure predicates).
- **Downstream physical-property output.** The `equivClasses` / `constantBindings` /
  `fds` entries in `query_plan()`'s `physical` column change for mixed-pair queries.
  Re-run the plan goldens under `packages/quereus/test/plan/`.
- **Guard discharge.** After the gate, a mixed pair no longer contributes an equivalence
  class, so `clauseEntailed`'s equivalence-class route can no longer discharge an
  `eq-literal` guard across a mixed pair. That is the point; confirm no existing guard /
  partial-UNIQUE test depended on it.

## Tests

- **Unit — `extractEqualityFds` semantic gate.** Extend
  `packages/quereus/test/planner/collation-soundness.spec.ts`'s existing
  `extractEqualityFds` unit block (it already has the column-reference / literal /
  binary-op helpers) with a `describe('semantic-ordering gate')`. Expected outputs:
  - `timespan_col = text_col` → `fds.length === 0`, `equivPairs.length === 0`,
    `constantBindings.length === 0`; same for the flipped order.
  - `timespan_col = json_col` → all zero.
  - `timespan_col = timespan_col2` → `fds.length === 2`, `equivPairs.length === 1`.
  - `json_col = json_col2` → `fds.length === 2`, `equivPairs.length === 1`.
  - `any_col = text_col` → admitted; `any_col = timespan_col` → declined.
  - `timespan_col = 'PT60M'` → `fds.length === 1` (the `∅ → col` pin) and
    `constantBindings.length === 1` with value `'PT60M'` — **the arm-2 control**.
  - `json_col = '{"a":1}'` and `timespan_col = ?` (parameter) → likewise still extracted.
- **Plan-level guard (the sibling of the collation guard).** In the same file, a
  `query_plan()`-driven test over `create table t (id integer primary key, d timespan,
  s text)`: for `select id from t where d = s and d = 'PT1H'` the Filter's `physical`
  must carry **no** `equivClasses` entry containing both `d` and `s`, and **no**
  `constantBindings` entry whose `attrs` spans both. Control: with `s` re-declared
  `timespan`, both facts must be present. (At HEAD the first query reports
  `equivClasses:[[1,2]]` and `constantBindings:[{attrs:[1,2],value:"PT1H"}]`, so this
  test fails before the change and passes after — verify that.)
- **End-to-end.** Extend the "Mixed-type equi-join keys agree with `=`" section of
  `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` with the filter-only
  spellings the join gate does not cover — a nested sub-select and a CTE, each pairing
  `where d = s` with an outer `where d = 'PT1H'`, plus the same-type control that must
  keep returning the row **and its stored spelling**. These pass at HEAD; they exist so
  the dormant path stays closed if filter merging changes.
- The whole existing `15.1-semantic-ordering.sqllogic` file must stay green.

## Docs

- `docs/types.md` § "Semantic ordering": "Two surfaces still do **not** follow the rule"
  becomes one (AS OF). Replace the "**Filter-level equality facts**" paragraph with a
  short statement of the resolved rule: cross-column equality facts require agreeing
  semantic ordering on both sides; a constant pin does not, because the pin's claim is
  "the column compares equal to this value under its own comparison", which is true.
- `docs/optimizer-fd.md` § "Collation gate on equality facts": rewrite the tail of the
  `extractEqualityFds` bullet (it currently says the extractor "carries **no**
  semantic-ordering gate" and points at this ticket). Consider retitling the section to
  cover both gates, and add the anchor the new invariant links to.
- `docs/invariants.md`: add **OPT-051 — Cross-column equality facts require agreeing
  semantic ordering** next to OPT-050. `code:` the three extractor sites
  (`fd-utils.ts` — `extractEqualityFds`, `join-node.ts` —
  `extractEquiPairsFromCondition`, `equi-pair-extractor.ts` — `extractEquiPairs`);
  `guard:` the new spec block; `doc:` the `optimizer-fd.md` anchor. Under 120 words, and
  it must state the asymmetry: the gate is on cross-*column* facts, not on constant pins.
  Back-link from the topic doc with the full heading slug. `yarn docs:check` machine-checks
  every pointer — run it.

## TODO

- Add `semanticOrderingsAgree(left.getType().logicalType, right.getType().logicalType)`
  to the `lIsCol && rIsCol` branch of `extractEqualityFds`; import from
  `../../util/comparison.js`. Rewrite the function's doc comment to describe both gates
  and to state explicitly that the constant-pin arms are deliberately ungated.
- State the `ConstantBinding` contract on its declaration in
  `planner/nodes/plan-node.ts`: the bound value is one the column **compares equal to**
  under the column's declared comparison, not necessarily its raw stored representation;
  a consumer needing raw-value identity must not read a binding. Name the two current
  consumers and why each is fine.
- Add the `NOTE:` comment on `buildPredicateFacts`' `columnEqs` explaining why it stays
  ungated (see "What must NOT change").
- Add the unit tests and the plan-level guard to
  `packages/quereus/test/planner/collation-soundness.spec.ts`.
- Add the sqllogic cases to `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`.
- Update `docs/types.md`, `docs/optimizer-fd.md`, and add OPT-051 to `docs/invariants.md`.
- Run `yarn workspace @quereus/quereus run test`, then `yarn workspace @quereus/quereus
  run lint`, then `yarn docs:check` — stream each with `2>&1 | tee` per the runner's
  idle-timeout rule.
- Handoff to `review/` must state: the guard-discharge route (`clauseEntailed`'s
  equivalence-class path for `eq-literal`) is closed as a side effect of arm 1 and was not
  separately tested; and that arm 2 was deliberately left ungated with the reasoning above,
  so a reviewer does not read it as an oversight.
