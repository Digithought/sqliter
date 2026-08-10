----
description: Row-count estimates for a WHERE clause with several AND/OR conditions now use each condition's own column statistics instead of one flat guess for the whole clause.
files: packages/quereus/src/planner/stats/selectivity-combine.ts, packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/optimizer/selectivity-combine.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/planner/stats/catalog-stats.spec.ts, docs/optimizer.md
----

Shipped. `CatalogStatsProvider` now walks a predicate's boolean structure instead of
treating the whole `where` clause as one opaque node.

## Final shape

- **`planner/stats/selectivity-combine.ts`** — pure numeric combinators, no plan-node
  knowledge. `combineConjunctive` sorts selectivities ascending, keeps the four most
  selective, and damps each with a further square root (`s₁ · s₂^½ · s₃^¼ · s₄^⅛`);
  `combineDisjunctive` is `1 - Π(1 - sᵢ)`. Both clamp to `[0, 1]`.
- **`planner/stats/catalog-stats.ts`** — `estimatePredicateSelectivity` dispatches
  through `estimateNode` (AND / OR / NOT) down to `estimateLeaf` (the original
  column-statistics switch, unchanged). An unestimable `and` conjunct counts as `1.0`;
  a single unestimable `or` disjunct makes the whole disjunction unknown; `not` is
  `1 - inner`. Recursion capped at `MAX_BOOLEAN_DEPTH = 16`. A combined estimate
  floors at `1 / rowCount`.
- **`planner/analysis/predicate-conjuncts.ts`** — `splitDisjuncts` added as the OR
  mirror of `splitConjuncts`; both now share one `splitOn` helper.
- **`docs/optimizer.md`** — *Boolean decomposition* section describes the recursion,
  the backoff formula, and the known gaps.

Behaviour change worth remembering: `a = 1 and lower(s) = 'x'` used to estimate a flat
`0.1` and now estimates `1/ndv(a)`. That is looser, and deliberately so — the `0.1`
was fabricated, and over-estimating surviving rows is the safer error direction.

## Review findings

Reviewed the implement diff (`9f5ee001`) against the current tree, which has since
absorbed three sibling tickets touching `predicate-conjuncts.ts` and
`rule-filter-selectivity.ts`. Everything below was found in this pass; the
implement-stage handoff's own self-reported gaps are marked where they overlap.

### Checked and correct — no action

- **Recursion termination.** `estimateNode` increments depth once per boolean level;
  `splitConjuncts` / `splitDisjuncts` fully flatten their own operator, so a conjunct
  can never re-enter `estimateConjunction`. No unbounded path found.
- **`NOT` operand access.** The implementer flagged reading `getChildren()[0]` rather
  than `.operand` as a deviation to check first. Verified against
  `UnaryOpNode.getChildren()` (`planner/nodes/scalar.ts:74`), which returns exactly
  `[this.operand]`. Equivalent, and consistent with how the rest of the file
  introspects nodes.
- **The "split was a no-op" guard** in `estimateConjunction` / `estimateDisjunction`,
  which the implementer described as existing only to keep mock-based specs sane.
  Confirmed dead in production: `PlanNodeType.BinaryOp` is declared by exactly one
  class (`scalar.ts:160`), so `nodeType === 'BinaryOp'` and `instanceof BinaryOpNode`
  cannot disagree there. Left in place — with the guard removed the same inputs still
  resolve to `undefined`, just after 16 wasted frames, and it costs one line.
- **Input mutation.** `combineConjunctive` sorts a fresh `map()` result, so a caller's
  array is never reordered.
- **Docs.** Read `docs/optimizer.md` (*Selectivity*, *Boolean decomposition*, *Filters
  over a join*) and the doc-comments on `rule-filter-selectivity.ts` and
  `stats/index.ts`. All describe the shipped behaviour, including the parts later
  tickets changed. One sentence added; see below.

### Found and fixed in this pass

- **Assertions that could not fail.** Three tests asserted `expect(sel).to.be.a('number')`
  after a call to `selectivity()`, which always returns a number — so "returns
  undefined → fallback" was never actually tested. Rewritten to assert `undefined`
  from `statsOnlySelectivity` *and* the exact naive value from `selectivity`.
  Similarly, `expect(sel).to.not.be.closeTo(combineDisjunctive([1/ndv.a, 1]), …)`
  compared against `1`, which the value under test could never equal.
- **Mock-driven `AND`/`OR` coverage is impossible, and the spec did not say so.**
  `test/planner/stats/catalog-stats.spec.ts` builds predicates as plain object
  literals; `splitConjuncts` gates on `instanceof BinaryOpNode`, so those mocks never
  decompose. Added a comment stating this and pointing at the spec that does cover it
  with real nodes, so the next person does not add an `AND` test there that silently
  passes for the wrong reason.
- **`MAX_BOOLEAN_DEPTH` was never exercised** (self-reported gap). `NOT` dispatches on
  `nodeType` alone, so it *is* reachable from the mock harness: added a 40-deep `NOT`
  nest asserting the cap declines, plus an 8-deep nest asserting nesting within the
  cap still estimates.
- **The `1/rowCount` floor was asserted where it could not bind.** The existing check
  (`sel >= 1/100` on a value of ≈0.025) passes whether or not the floor exists. Added
  a 4-row table where backoff lands at 0.125 against a floor of 0.25, so the floor is
  the thing being measured.
- **Mixed known/unknown `AND` had no end-to-end coverage** (self-reported gap — the
  implementer settled for provider-level assertions because predicate pushdown splits
  `a = 1 and lower(s) = 'x'` across two Filters). Found a shape that keeps it fused:
  nothing can be pushed out of a disjunct, so
  `(a = 1 and lower(s) = 'x1') or b = 2` reaches the optimizer whole. Added.
- **The degenerate-nesting test asserted only "in `[0,1]`, no throw"** (self-reported
  gap). Replaced with pinned expectations written as the composition the recursion
  should perform (`combineConjunctive([…, combineDisjunctive([…])])`), so a change to
  either combinator surfaces as a disagreement rather than a stale constant. All six
  shapes — including double negation and `AND` over two `OR`s — now have exact values.

### Found, filed as a ticket

- **`OR` discards a bound it already proved** → `backlog/feat-or-selectivity-lower-bound`.
  When one `or` branch is estimable and another is not, the provider declines
  entirely and the naive fallback answers a flat `0.1`. But a disjunction can never
  be more selective than its most selective branch, so
  `a = 1 or lower(s) = 'x1'` is provably ≥ 0.25 on the test table and gets stamped
  0.1 — an estimate that contradicts information already in hand. Not a trivial fix:
  simply reporting the largest known branch is worse in the opposite direction when
  that branch is very selective, so the repair needs both bounds and needs the
  "partly known" case distinguishable from "unknown" at the provider boundary. Filed
  rather than fixed inline. The existing test now asserts the shortfall explicitly
  instead of asserting a tautology, and `docs/optimizer.md` names the gap.

### Recorded as tripwires, not tickets

- **The `AND` unknown-as-1.0 assumption inverts under `NOT`.** Treating an unreadable
  conjunct as 1.0 makes an `and` estimate an upper bound; negating turns that into a
  lower bound, so `not (a = 1 and lower(s) = 'x')` errs low where the `and` path
  claims to err high. Bounded (truth lies between the estimate and 1) and only
  reachable through an explicit `NOT` over a mixed-knowledge `and`. `NOTE:` at the
  `NOT` branch in `catalog-stats.ts`, naming what to do if it ever matters — track
  bound direction alongside the number.
- Three `NOTE:` tripwires the implementer left stand as written and were verified in
  place: same-column conjuncts not paired into a range (`estimateConjunction`),
  column-vs-column comparison estimated as column-vs-constant
  (`extractColumnFromPredicate`), and `x in (select …)` reporting list size 1
  (`extractInListSize`). The latter two are pre-existing and untouched by this work.

### Noted, no action

- **`IS TRUE` / `IS FALSE` / `IS NOT TRUE` / `IS NOT FALSE` are boolean structure but
  fall through to `estimateLeaf`,** which handles only `IS NULL` / `IS NOT NULL` and
  returns `undefined` for them. That is the conservative direction (an unreadable
  `and` conjunct claims no reduction), so it degrades rather than misleads. Not worth
  a ticket at current usage.
- **`catalog-stats.ts` is 509 lines** carrying the statistics interfaces, the provider,
  and five free introspection helpers. This ticket added ~150 of those. The grouping is
  coherent and the helpers are used only here, so no split was made; worth revisiting
  if the introspection helpers grow further.
- **Idempotence of the new recursion was not separately proven** (self-reported gap).
  `ruleFilterSelectivity` declines on an already-stamped Filter before reaching the
  provider, and the recursion is a pure function of the predicate, so there is nothing
  stateful to re-run. Left as inherited behaviour.

## Validation

`yarn build`, `yarn lint`, and `yarn test` all clean: **7680 passing, 13 pending, 0
failing** (7676 before this review pass). No golden plan moved. No pre-existing
failures encountered.
