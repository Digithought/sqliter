----
description: Row-count estimates for a WHERE clause with several AND/OR conditions now use each condition's own column statistics instead of one flat guess for the whole clause.
files: packages/quereus/src/planner/stats/selectivity-combine.ts (new), packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/selectivity-combine.spec.ts (new), packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/planner/stats/catalog-stats.spec.ts, docs/optimizer.md
difficulty: medium
----

Implemented as specified in the `implement/` ticket. Build, lint, and the full
`yarn test` suite are green (quereus: 7497 passing, 13 pending, 0 failing). No golden
plan moved.

## What changed

### `planner/stats/selectivity-combine.ts` (new)

Pure numeric combinators, no plan-node knowledge.

- `BACKOFF_CONJUNCT_LIMIT = 4`
- `combineConjunctive(sels)` — clamps each input to `[0,1]`, sorts ascending, keeps the
  first four, returns `s₁ · s₂^½ · s₃^¼ · s₄^⅛`, clamps the result. Empty list returns
  `1` (conjunctive identity); callers never pass one.
- `combineDisjunctive(sels)` — `1 - Π(1 - sᵢ)`, clamped. Empty list returns `0`.

The file doc-comment explains why exponential backoff beats the textbook product
`Πsᵢ` here (correlated predicates make plain independence under-estimate badly).

### `planner/analysis/predicate-conjuncts.ts`

Added `splitDisjuncts`, the exact OR mirror of `splitConjuncts` (same iterative
stack, same `instanceof BinaryOpNode` gate).

### `planner/stats/catalog-stats.ts`

`estimatePredicateSelectivity` split into an entry point plus helpers:

```
estimatePredicateSelectivity   rowCount-0 short-circuit, then estimateNode(…, 0)
  └─ estimateNode              AND / OR / NOT dispatch, else estimateLeaf
       ├─ estimateConjunction  splitConjuncts → combineConjunctive
       ├─ estimateDisjunction  splitDisjuncts → combineDisjunctive
       ├─ floorCombined        1/rowCount floor, only when ≥2 sels combined
       └─ estimateLeaf         the original switch, behaviour unchanged
```

Semantics, all as the ticket specified:

- **AND** — unestimable conjunct counts as `1.0` (no reduction claimed), *not* the
  naive `0.1`. All-unknown returns `undefined` so the whole-predicate naive fallback
  in `selectivity()` still fires.
- **OR** — any unestimable disjunct makes the whole disjunction `undefined`.
- **NOT** — `1 - inner`; `undefined` propagates.
- Depth capped at `MAX_BOOLEAN_DEPTH = 16`.
- Uppercase `'AND'`/`'OR'`/`'NOT'` only, matching the planner convention.

Two deviations from the ticket text, both deliberate — **check these first**:

1. **NOT reads its operand via `getChildren()[0]`, not `.operand`.** The existing
   unit spec `test/planner/stats/catalog-stats.spec.ts` builds mock nodes as plain
   object literals with `getChildren` but no `.operand`; reading `.operand` threw
   `TypeError: Cannot read properties of undefined`. `getChildren()` is also how the
   rest of this file introspects nodes (`extractColumnFromPredicate`,
   `extractConstantValue`), so this is consistent, not a workaround.
2. **`estimateConjunction`/`estimateDisjunction` bail to `estimateLeaf` when the
   split is a no-op** (`parts.length === 1 && parts[0] === node`). `splitConjuncts`
   gates on `instanceof BinaryOpNode`, so a mock object claiming
   `nodeType: 'BinaryOp', operator: 'AND'` would otherwise recurse on itself until
   the depth guard fired. Real plan nodes always split into ≥2 parts, so this branch
   is unreachable in production — it exists to keep the mock-based unit specs sane.

`NOTE:` tripwire comments added at three pre-existing weak spots (see *Review
findings* below).

### `rules/predicate/rule-filter-selectivity.ts`

Replaced the stale "conjunctions are NOT decomposed" comment block. No logic change.

### `docs/optimizer.md`

Replaced the one-sentence "Conjunction / join selectivity is not yet decomposed"
claim with a description of the recursive boolean model and the backoff formula.
The join half still points at `feat-join-filter-selectivity`.

## Behaviour change to scrutinise

`a = 1 and lower(s) = 'x'` used to estimate `0.1` (naive flat guess for the whole AND).
It now estimates `1/ndv(a)` — on a 4-distinct-value column, `0.25`. That is a **2.5×
looser** estimate, and it is intentional: the `0.1` was fabricated, and over-estimating
surviving rows is the safer error direction. Worth a second opinion on whether any
cost comparison in the optimizer is sensitive to that direction.

## Test coverage — and where it is thin

New: `test/optimizer/selectivity-combine.spec.ts` (13 tests) — combinator identity,
square-root damping, order independence, the 4-conjunct cap, clamping, empty-list
identities, and `splitDisjuncts` flattening (right-nested vs left-nested, non-OR,
AND-under-OR).

Extended: `test/optimizer/filter-selectivity.spec.ts` — new
`boolean-structure selectivity` block over a 100-row table `m(id pk, a, b, c, d, e, s)`
with distinct counts 4/5/6/7/8/3.

Extended: `test/planner/stats/catalog-stats.spec.ts` — the old test named
"unsupported UnaryOp (e.g. NOT) returns undefined → fallback" was renamed (NOT is
supported now) and split into three: NOT over an unestimable operand, NOT negating an
estimable operand, and unary minus as the genuinely-unsupported case.

### Verified end-to-end through the optimizer

- `where a = 1 and b = 2` → `combineConjunctive([1/4, 1/5]) = 0.1`, strictly below the
  single-conjunct `where a = 1` stamp of `0.25`.
- `where a = 1 or b = 2` → `combineDisjunctive([1/4, 1/5]) ≈ 0.4`.
- `where not (a = 1)` → `0.75`.
- `where a = 1 or lower(s) = 'x1'` → naive `0.1`, explicitly asserted *not* to be a
  combined value.
- Three- and five-conjunct predicates stay in `[0,1]`; the five-conjunct estimate
  (`0.0247`) is far above the plain product (`0.000149`), and equals
  `combineConjunctive` over the four most selective conjuncts — `a` (ndv 4, least
  selective) is the one dropped.

### Verified only at provider level, not end-to-end

The optimizer **splits** `a = 1 and lower(s) = 'x1'` into two stacked `FilterNode`s
(pushing `a = 1` below the function call), so the mixed known/unknown AND never
reaches the provider as one predicate through `getPlan`. Those cases are asserted by
calling `new CatalogStatsProvider().selectivity(table, rawPredicate)` on the
**unoptimized** plan instead:

- unestimable AND conjunct treated as `1.0` → `0.25`
- all-unestimable AND (`lower(s) = 'x1' and upper(s) = 'X1'`) → naive `0.1`
- the `1/rowCount` combined floor

**This is the main gap.** A reviewer should decide whether provider-level assertion is
acceptable coverage for the mixed-AND rule, or whether a predicate shape exists that
keeps both conjuncts fused through optimization.

### Smoke-only

`handles degenerate and mixed boolean nesting without throwing` walks `((a=1))`,
`not not (a=1)`, `a = 1 and (b = 2 or b = 3)`, `(a=1 or b=2) and (c=3 or d=4)`,
`(a=1 and b=2) or lower(s)='x1'`, `not (a=1 or b=2)` and asserts only "in `[0,1]` or
`undefined`, no throw" — it does **not** pin the numeric result of any of them. If a
reviewer wants those numbers locked, they are unlocked today.

### Not covered at all

- `MAX_BOOLEAN_DEPTH` is never actually hit by a test; 16 levels of alternating
  OR/NOT nesting is hard to write in SQL and was not attempted.
- `rowCount === 0` on a table with catalog statistics.
- Re-running the optimizer over an already-stamped plan (idempotence). The rule's
  existing guard is unchanged, so this is inherited behaviour, but the new recursion
  is not separately proven idempotent.
- Interaction with the unique-key override in `FilterNode.computePhysical` when the
  new (smaller) selectivity is stamped. The existing mechanics test covers the
  override with a hand-stamped value, not with a combined one.

## Review findings (implement-stage tripwires)

Recorded in code, not filed as tickets:

- **Same-column conjuncts are not paired into a range.** `a > 1 and a < 10` combines
  two independent `1/3` estimates (≈0.19) rather than recognising one narrow range.
  Backoff damps the error but does not remove it. `NOTE:` at the combination site in
  `catalog-stats.ts` (`estimateConjunction`).
- **Column-vs-column comparison estimates as column-vs-constant.** `where x = y` on one
  table returns `1/ndv(x)`. Pre-existing, unchanged. `NOTE:` at
  `extractColumnFromPredicate`.
- **`IN` with a subquery reports list size 1.** `x in (select …)` falls through to
  `children.length - 1 === 1`, giving `1/ndv`. Pre-existing, unchanged. `NOTE:` at
  `extractInListSize`.
