---
description: When a query summarizes data two different ways and then sorts or filters by one of those summaries, the engine can silently use the wrong one and return wrong numbers, with no error.
files:
  - packages/quereus/src/planner/building/function-call.ts        # findMatchingAggregate — the one site to change
  - packages/quereus/src/planner/building/select-aggregates.ts    # buildHavingFilter / collectHavingAggregates / collectOrderByAggregates — consumers; already do the right thing
  - packages/quereus/src/planner/building/select-window.ts        # rejectUncollectedAggregates — third consumer; its NOTE needs a line
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic     # HAVING / ORDER BY coverage
  - packages/quereus/test/logic/07.5-window.sqllogic              # grouped + window coverage (grouped section starts ~line 788)
difficulty: easy
repro: verified
---

# Compare aggregate spellings by canonical AST text, not by a shallow argument peek

## Root cause — one site

`findMatchingAggregate` (`function-call.ts:32`) decides whether an aggregate written
in `HAVING`, a top-level `ORDER BY`, or a window function's `OVER (…)` clause is the
same aggregate the SELECT list already computed. It compares function name, argument
count and the `DISTINCT` flag exactly, then compares arguments **only when both sides
are bare column references or both are literals**. Every other argument shape falls
through the `if/else if` with `argsMatch` left `true`, so two aggregates over
different expressions are declared identical and the clause silently reads the wrong
computed column.

## Verified behavior at HEAD

Run in a scratch mocha spec against HEAD (`db.eval`), table
`wg(a text, b text)` with rows `('x','1'),('y','2'),('x','3')`:

| query | HEAD | correct |
|---|---|---|
| `select a, sum(b+0) s from wg group by a order by sum(a+0)` | `[{a:y,s:2},{a:x,s:4}]` | `[{a:x,s:4},{a:y,s:2}]` (all `sum(a+0)` are 0, so groups keep source order) |
| `select a, sum(b+0) s from wg group by a having sum(a+0) > 3` | `[{a:x,s:4}]` | `[]` |
| `select a, sum(b+0) s, row_number() over (order by sum(a+0)) rn from wg group by a` | `[{a:y,…,rn:1},{a:x,…,rn:2}]` | plan-time error (see below) |

## The fix

Replace the whole argument loop with the canonical-AST fingerprint the planner
already uses for exactly this question (`buildGroupByCoverage`,
`collectInnerAggregates`, `dedupeNewAggregates` all key on it):

```ts
if (expressionToString(aggFuncNode.expression).toLowerCase() === expressionToString(expr).toLowerCase()) return agg;
```

`AggregateFunctionCallNode.expression` is the original `AST.FunctionExpr`, and
`expressionToString`'s `function` case already renders `distinct` and `count(*)`, so
the name/arity/DISTINCT pre-checks above become redundant — they may stay as a cheap
early-out, but the fingerprint is the decision. `.toLowerCase()` mirrors
`dedupeNewAggregates`, which is what makes `sum(B)` in the SELECT list match `sum(b)`
in HAVING.

`select-aggregates.ts` needs **no change**. `collectHavingAggregates` /
`collectOrderByAggregates` already key on the same fingerprint, so they already build
and push a genuinely-new aggregate for the unmatched spelling; the false match in
`findMatchingAggregate` was simply shadowing it downstream in `buildHavingFilter` /
the post-aggregate ORDER BY build. With the fingerprint in place both clauses resolve
to the aggregate that was actually collected for them.

This was prototyped and the full `yarn test` suite run against it: **725 + 85 + 31 +
59 + 68 + 34 + 134 + 22 passing, 0 failures** — no existing assertion depends on the
loose match.

## Consequences to encode as tests

Unchanged (verified against the prototype):

- `select a, count(*) c from wg group by a having count(*) > 1` — reads the computed column.
- `select a, count(*) c, row_number() over (order by count(*) desc) rn from wg group by a` — asserted in `07.5-window.sqllogic`.
- `select a, count(distinct b) from wg group by a having count(distinct b) > 1` — DISTINCT participates.
- `select a, sum(b) s from wg group by a having s > 3` — alias reference, resolves through the aggregate output scope, not through this function.
- Whitespace / redundant parens (`sum(b+0)` vs `sum(b + 0)`, `sum(b)` vs `sum((b))`) still match — the fingerprint normalizes them.
- Identifier case (`sum(B)` vs `sum(b)`) still matches.

Fixed: the three queries in the table above. The `HAVING` and `ORDER BY` cases return
correct rows via the collect path; the window-specification case raises the existing
named limitation
`Aggregate function sum in a window function's ORDER BY is only supported when the
same aggregate also appears in the SELECT list` (`StatusCode.UNSUPPORTED`), which the
ticket that added it declared the correct outcome. Lifting that limitation is
`feat-aggregate-inside-window-function-argument` in `backlog/`.

## Narrowing to document, not to fix

A *qualifier* divergence between the two spellings no longer matches, because the
fingerprint renders the qualifier: `sum(w.b)` ≠ `sum(b)`.

- In `HAVING` / `ORDER BY` this is invisible — the collect path builds a second
  aggregate over the same column and the answer is identical (verified:
  `select a, sum(w.b) s from wg w group by a having sum(b) > 3` → `[{a:x,s:4}]`,
  same as HEAD). The only cost is one extra aggregate computed and a forced final
  projection.
- In a **window specification** it becomes the UNSUPPORTED error above:
  `select a, sum(w.b) s, row_number() over (order by sum(b)) rn from wg w group by a`
  succeeds at HEAD and errors after the fix. Spelling the two identically, or
  referencing the SELECT-list alias (`over (order by s)` — already asserted in
  `07.5-window.sqllogic`), both work.

Matching across qualifier divergence would mean resolving each argument to an
attribute id, which needs the arguments built — and `findMatchingAggregate` runs
*before* the build, by design. Not worth it for this shape. Record it as a `NOTE:`
tripwire in the `findMatchingAggregate` doc comment rather than filing a ticket.

## TODO

- Replace the shallow argument loop in `findMatchingAggregate`
  (`packages/quereus/src/planner/building/function-call.ts`) with the
  `expressionToString` fingerprint comparison; add the
  `import { expressionToString } from "../../emit/ast-stringify.js";` (no cycle —
  `select-aggregates.ts` in the same directory already imports it).
- Rewrite that function's doc comment: it currently *documents* the bug ("argument
  shapes it cannot compare are treated as matching"). State the fingerprint rule, and
  add the `NOTE:` tripwire for the qualifier-divergence narrowing described above.
- Add a line to `rejectUncollectedAggregates`' doc block in `select-window.ts`
  recording that its gate is only as tight as `findMatchingAggregate`, and is now
  argument-exact.
- Add HAVING / ORDER BY regressions to `packages/quereus/test/logic/07.3-group-by-extras.sqllogic`:
  the two wrong-answer queries from the table, plus the same-spelling and
  `count(distinct …)` controls so a future loosening is caught from both directions.
- Add the window-specification regression to the grouped section of
  `packages/quereus/test/logic/07.5-window.sqllogic` (near the existing
  `-- error: Aggregate function count in a window function's ORDER BY …` case at
  ~line 862): assert `over (order by sum(a+0))` against a select list computing
  `sum(b+0)` raises the same UNSUPPORTED message.
- Run `yarn test` and `yarn lint` from the repo root.
