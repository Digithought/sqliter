---
description: A query comparing a column to a constant subquery, such as `where v = (select 1)`, crashes at plan time with "Literal value is a promise" instead of running.
files:
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts   # isLiteralConstant / getLiteralValue — the crash site
  - packages/quereus/src/planner/analysis/constraint-extractor.ts                  # identical isLiteralConstant / getLiteralValue pair — same class, reached next
  - packages/quereus/src/parser/utils.ts                                           # getSyncLiteral — throws on a Promise value
  - packages/quereus/src/planner/nodes/scalar.ts                                   # LiteralNode: documents that a folding pass may store a pending Promise
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The shape is rare in practice (most constant subqueries aggregate, which does not fold to a Promise literal), so a maintainer may defer it behind higher-traffic planner work.
---

# A promise-valued literal is not a plan-time constant

## Observed

On the memory module, with `create table big (id integer primary key, v integer, status text)`:

```sql
select id from big where v = (select 1);          -- throws: Literal value is a promise
select id from big where status = (select 'x');   -- throws: Literal value is a promise
select id from big where status = (select max(status) from big);  -- fine (not folded)
```

Stack: `getSyncLiteral` (parser/utils.ts) ← `getLiteralValue` ← `tryRewriteEqualityToRange`
← `ruleSargableRangeRewrite`. Found incidentally while probing join shapes for
`feat-index-nested-loop-over-pushed-constraints`; unrelated to joins — the
single-table form above reproduces it.

## Root cause

Constant folding turns an uncorrelated constant scalar subquery into a `LiteralNode`
whose `expression.value` is a **still-pending Promise** (`LiteralNode` in
`planner/nodes/scalar.ts` documents this: "A folding pass may store a still-pending
Promise (async subquery constant)"). Most planner readers tolerate that — `predicate-shape.ts`,
`sat-checker.ts`, `comparison-collation.ts`, `mutation/*.ts` all test `instanceof Promise`
and treat the node as non-constant. Two sites do not:

- `rule-sargable-range-rewrite.ts` — `isLiteralConstant` answers true for any
  `LiteralNode`, then `getLiteralValue` calls `getSyncLiteral`, which throws on a Promise.
- `constraint-extractor.ts` — the same two helpers, byte-for-byte. It is reached only
  after the rewrite rule, so today the rewrite crashes first; fix one without the other
  and the extractor crashes next.

## Expected

A promise-valued literal is a *dynamic* value at plan time, not a constant: the rewrite
should skip the conjunct and the extractor should classify it like a parameter binding
(`valueExpr` set, no `value`), so the predicate runs as a residual filter — the same
answer the non-folded `(select max(...))` form gets today.

## Shape of the fix (higher rung than two point patches)

One shared helper — e.g. `planTimeLiteralValue(node): SqlValue | undefined`, next to the
existing `unwrapCast` — that returns `undefined` for a Promise-valued `LiteralNode`, used
by both sites in place of their private `isLiteralConstant` + `getLiteralValue` pairs.
That makes "a Promise literal is not a constant" a single decision instead of a
convention each reader has to remember. Add a logic test for both spellings above.
