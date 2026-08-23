---
description: A query that compares a column to a constant subquery, such as `where v = (select 1)`, crashes at plan time instead of running; make the planner treat such a value as dynamic and run the query as a normal filter.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts                  # crash site 1 (reached first) - isLiteralConstant / getLiteralValue
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts    # crash site 2 (latent behind site 1) - same helper pair
  - packages/quereus/src/planner/analysis/predicate-shape.ts                       # existing `literalValue(AST.Expression)` already encodes the rule; reuse it
  - packages/quereus/src/parser/utils.ts                                           # getSyncLiteral - throws "Literal value is a promise"
  - packages/quereus/src/planner/nodes/scalar.ts                                   # LiteralNode.getType() - documents the pending-Promise literal
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic                    # home for the end-to-end cases
  - packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts                 # existing spec for crash site 2
repro: verified
difficulty: easy
---

# A promise-valued literal is not a plan-time constant

## What happens today

Verified in `packages/quereus` (`node test-runner.mjs`, memory module), against
`create table big (id integer primary key, v integer, status text)` holding
`(1, 1, 'x'), (2, 2, 'y')`:

| query | today | expected |
| --- | --- | --- |
| `select id from big where v = (select 1)` | throws `Literal value is a promise` | `[{id:1}]` |
| `select id from big where status = (select 'x')` | throws | `[{id:1}]` |
| `select id from big where v between (select 1) and (select 2)` | throws | `[{id:1},{id:2}]` |
| `select id from big where v in ((select 1), 2)` | throws | `[{id:1},{id:2}]` |
| `select id from big where status = (select max(status) from big)` | works | unchanged |

The last row is the control: an aggregate subquery is not folded to a literal, so it
already runs as an ordinary residual filter. The fix should make the four broken shapes
behave exactly like it. (The expected rows above are the actual output observed once
both sites were guarded, in a throwaway patch that has been reverted.)

## Why

Constant folding replaces an uncorrelated constant scalar subquery with a `LiteralNode`
whose `expression.value` is a **still-pending Promise** — `LiteralNode.getType()` in
`planner/nodes/scalar.ts` documents this case explicitly. Most planner readers already
test `value instanceof Promise` and treat such a node as non-constant
(`predicate-shape.ts`, `sat-checker.ts`, `comparison-collation.ts`, `limit-offset.ts`,
`catalog-stats.ts`, `fd-utils.ts`, `mutation/*.ts`). Two readers do not, and each has a
private, near-identical `isLiteralConstant` / `getLiteralValue` pair that calls
`getSyncLiteral`, which throws on a Promise:

- `planner/analysis/constraint-extractor.ts` — `isLiteralConstant` (~line 988) and
  `getLiteralValue` (~line 1005). Reached from `extractBinaryConstraint`,
  `extractBetweenConstraints`, and `extractInConstraint`; all four broken shapes above
  crash here first.
- `planner/rules/predicate/rule-sargable-range-rewrite.ts` — `isLiteralConstant` /
  `getLiteralValue` at the bottom of the file. Independently reachable: with the
  extractor guarded, the two `=` shapes crash here instead (confirmed by temporarily
  patching the extractor and re-running). Fixing one site without the other leaves the
  bug. The original report had the two sites in the opposite order; the extractor is the
  one that fires today.

Note the two files' `unwrapCast` helpers deliberately differ — the extractor strips only
*no-op* casts (`isNoOpCast`, pinned by tickets `bug-cast-stripped-from-seek-constraints`
and `collation-blind-equality-fact-extraction`), the rewrite rule strips any single
`CastNode` and carries a `NOTE:` explaining why that is dormant. **Do not unify the
unwrapping.** Only the "is this literal a plan-time constant?" decision is shared.

## Expected behavior

A promise-valued `LiteralNode` is a *dynamic* value at plan time, not a constant:

- The sargable rewrite skips the conjunct (no range rewrite from an unknown constant).
- The extractor declines to emit a constraint for it, so the conjunct survives as a
  residual `FILTER` — which is what makes the query produce the right rows.

Declining is the correct, minimal answer; it matches what the non-folded
`(select max(...))` control already gets. Pushing the value down as a dynamic seek
binding (`valueExpr` set, no `value`) would be an *optimization*, not part of this fix —
`valueExpr` is evaluated by the seek machinery, and a `LiteralNode` whose `getValue()`
returns a Promise has not been validated on that path. See the tripwire task below.

## Shape of the fix

One shared decision, two call sites. Add an exported helper next to the existing
`literalValue(expr: AST.Expression)` in `planner/analysis/predicate-shape.ts` (which
already returns `undefined` for a Promise value — reuse it rather than re-writing the
`instanceof Promise` test):

```ts
/**
 * The plan-time constant value of an ALREADY-UNWRAPPED scalar node, or undefined when
 * the node is not a plan-time constant — including a LiteralNode holding a still-pending
 * Promise (a folded async subquery constant), whose value is unknown until runtime.
 * Callers keep their own cast-unwrapping policy; this decides only "is it a constant".
 */
export function planTimeLiteralValue(node: ScalarPlanNode): SqlValue | undefined;
```

Each site then expresses its private pair in terms of it, keeping its own `unwrapCast`:

```ts
function isLiteralConstant(node: ScalarPlanNode): boolean {
	return planTimeLiteralValue(unwrapCast(node)) !== undefined;
}
```

`undefined` means "not a constant"; SQL `NULL` is a legitimate constant and must stay
distinguishable from it. Both call sites already branch on a `null` constant
(`rule-sargable-range-rewrite`'s `if (literalValue === null) return undefined`, the
extractor's `constant === null && finalOp !== '='` and the BETWEEN null-bound check) —
keep that behavior byte-for-byte; only the Promise case changes.

Watch the extractor's `isLiteralConstant` type predicate (`node is LiteralNode`): it
narrows at several call sites, and a promise-valued literal is still a `LiteralNode`.
Either keep the predicate signature (the narrowing stays sound — it *is* a `LiteralNode`,
just not a usable one) or drop it to `boolean` and fix the follow-on casts; the
requirement is only that `getLiteralValue` is never reached for a node the predicate
rejected.

Watch the extractor's `isDynamicValue` too: it recognizes only `ParameterReference` and
`ColumnReference`, so a rejected promise literal falls through to "no column-constant
pattern" and the conjunct stays residual — the intended outcome. Do not add `Literal` to
`isDynamicValue` as part of this ticket (that is the deferred optimization above).

## TODO

- Add `planTimeLiteralValue(node)` to `planner/analysis/predicate-shape.ts`, delegating
  the value test to the existing `literalValue(expr)`; document the Promise case.
- Rewrite `isLiteralConstant` / `getLiteralValue` in
  `planner/analysis/constraint-extractor.ts` on top of it, leaving its `unwrapCast`
  (no-op-casts-only) untouched.
- Do the same in `planner/rules/predicate/rule-sargable-range-rewrite.ts`, leaving its
  own `unwrapCast` and the `NOTE:` above it untouched.
- Add the five queries from the table above (four broken plus the aggregate control) to
  `packages/quereus/test/logic/96-subquery-edge-cases.sqllogic`, with the expected rows
  shown there.
- Add a case to `packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts` pinning
  crash site 2 directly — the rule must decline a `col = <promise literal>` conjunct
  rather than throw — so a future extractor change cannot re-hide it.
- Add a `NOTE:` tripwire where the extractor declines the promise literal: a folded async
  subquery constant currently falls back to a residual filter; if these show up as a
  seek-worthy shape, revisit routing it through `valueExpr` / `bindingKind` (the value
  resolves before the seek runs, but the `LiteralNode`-returns-a-Promise path through the
  seek binding machinery is unverified).
- Run `yarn workspace @quereus/quereus run test` and `yarn workspace @quereus/quereus run lint`.
