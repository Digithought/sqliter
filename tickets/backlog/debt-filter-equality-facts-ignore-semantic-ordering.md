---
description: When a query filters a duration column by a specific value, the planner records "this column always holds exactly that text" — which is not true, since a one-hour duration can be written several different ways. Nothing acts on that false note today, but anything that starts to would return wrong rows.
files:
  - packages/quereus/src/planner/util/fd-utils.ts                    # extractEqualityFds — the ungated extractor
  - packages/quereus/src/util/comparison.ts                          # semanticOrderingsAgree — the predicate the join extractors use
  - packages/quereus/src/planner/nodes/join-node.ts                  # extractEquiPairsFromCondition — the sibling site, already gated
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts   # physical extractor, already gated
  - docs/types.md                                                    # § "Semantic ordering" — describes this gap
  - docs/optimizer-fd.md                                             # extractEqualityFds bullet — describes this gap
difficulty: medium
---

# Filter-level equality facts ignore semantic ordering

## Background

Some column types compare by *meaning*, not by the text stored in them. A `timespan`
column holding `'PT1H'` (one hour) is equal to the value `'PT60M'` (sixty minutes) —
the engine calls these types *semantic-ordering* types (`timespan`, `json`).

When the planner sees a `where` clause it records shortcut facts about the rows that
survive it, in `extractEqualityFds`:

- `where col1 = col2` → "these two columns hold the same value in every surviving row".
- `where col = 'literal'` → "this column holds exactly `'literal'` in every surviving row".

Both statements are **false** when a semantic-ordering type is involved.
`where d = 'PT60M'` keeps a row whose stored `d` is `'PT1H'`, so `d` is not pinned to
`'PT60M'`, and a mixed `timespan = text` pairing matches rows whose raw values differ.

The two join-side extractors that mint the same kind of fact
(`extractEquiPairsFromCondition` for logical facts, `equi-pair-extractor.ts` for
physical join keys) both refuse such a conjunct via `semanticOrderingsAgree`.
`extractEqualityFds` has no equivalent check — it gates only on collation.

## Why it is not a bug today

Probed for an observable wrong answer along every route that would expose the
over-claim, over a `timespan` column and a mixed `timespan`/`text` column pair:
constant substitution into a projection or expression, `distinct`, `group by`,
`order by` transfer across the equivalence class, `in (subquery)`, correlated
`exists`, and a transitive two-conjunct pin. All returned the correct rows and the
correct stored spellings. Nothing currently converts these facts into a row-dropping
or value-rewriting decision.

## Why it should still be closed

The fact is wrong, not merely imprecise. Any future consumer that trusts it — a new
rewrite that folds a constant binding into output, a `distinct`/`group by` elimination
driven by an `∅ → col` FD, a new equivalence-class-driven inference — returns wrong
rows the day it lands, with no test in the way.

## What makes this non-trivial

The obvious one-line fix (require `semanticOrderingsAgree` on both operands, as the
join extractors do) is wrong-shaped for the `col = literal` case: a literal never
carries a semantic-ordering type, so the check would decline **every** constant pin on
a `timespan` or `json` column, losing real optimizations for a fact that is only
partly false (the row set is still constrained; only the "one exact value" claim is
not). Desirable outcomes to weigh:

- Keep the pin's FD but drop the constant *binding* (the value-identity half), so
  cardinality reasoning survives and value substitution does not.
- Or canonicalize the binding's value through the type's `groupKey` where one exists
  (`timespan`), so the recorded value is the canonical representative — this fixes
  identity-shaped consumers but not consumers that echo the value to output.
- Apply the plain `semanticOrderingsAgree` gate to the `col1 = col2` shape only, where
  it is exactly right and costs nothing observable.

Whatever is chosen must keep the existing semantic-ordering logic tests
(`packages/quereus/test/logic/15.1-semantic-ordering.sqllogic`) green and add
assertions that pin the chosen behavior, plus a plan-level guard alongside
`packages/quereus/test/planner/collation-soundness.spec.ts` (the sibling guard for the
collation half of the same rule, invariant OPT-050).
