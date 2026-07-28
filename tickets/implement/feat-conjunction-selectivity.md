----
description: When a WHERE clause combines several conditions with AND or OR, estimate how many rows survive by looking at each condition's own column statistics instead of falling back to one flat guess for the whole clause.
files: packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/src/planner/stats/selectivity-combine.ts (new), packages/quereus/src/planner/analysis/predicate-conjuncts.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/selectivity-combine.spec.ts (new), docs/optimizer.md
difficulty: medium
----

Follow-on to `5.5-planner-filter-selectivity` (landed): `rule-filter-selectivity` stamps a
stats-derived selectivity onto `FilterNode`, and `CatalogStatsProvider` reads real column
statistics for a single column-vs-constant comparison.

## The gap

`CatalogStatsProvider.estimatePredicateSelectivity` (`catalog-stats.ts:188`) looks for **one**
`ColumnReference` child of the predicate root. For `a = 1 and b = 2` the root is an `AND`
`BinaryOpNode` whose children are two comparisons — no direct `ColumnReference` child — so the
method returns `undefined` and `selectivity()` falls through to `NaiveStatsProvider`, which
returns a flat `0.1` for *any* `BinaryOp`. Consequences:

- `a = 1` and `a = 1 and b = 2 and c = 3` receive the same estimate.
- Real per-column histograms and distinct counts are ignored the moment a second condition appears.
- `OR` (`a = 1 or b = 2`) and `not (…)` hit the same wall.

## Design

Make selectivity estimation **recursive over the boolean structure** of the predicate, with the
existing per-node logic as the leaf case. All of this lives in the stats provider, not in the
rule, so every `stats.selectivity(...)` consumer benefits (`indexSelectivity` already delegates
to it).

### New module: `planner/stats/selectivity-combine.ts`

Pure numeric combinators, no plan-node knowledge, independently unit-testable.

```ts
/** How many conjuncts participate in the damped product. */
export const BACKOFF_CONJUNCT_LIMIT = 4;

/** Combine AND-ed selectivities. */
export function combineConjunctive(selectivities: readonly number[]): number;

/** Combine OR-ed selectivities (independence: 1 - Π(1 - s)). */
export function combineDisjunctive(selectivities: readonly number[]): number;
```

**Conjunction model — exponential backoff, not plain independence.** Sort the selectivities
ascending (most selective first), keep the first `BACKOFF_CONJUNCT_LIMIT`, and return

```
s₁ · s₂^(1/2) · s₃^(1/4) · s₄^(1/8)
```

Rationale for choosing this over the textbook product `Πsᵢ`: plain independence collapses fast
(five conditions at 0.1 each ⇒ 1e-5), and real predicates are correlated far more often than
not, so the product systematically *under*-estimates and drives pathological plan choices. The
damped form is the model SQL Server has defaulted to since 2014, needs no correlation
statistics, and is identical to plain independence for a single conjunct. Conjuncts beyond the
limit are dropped rather than multiplied in — they are the least selective ones, so they
contribute least.

Both combinators clamp each input and the result to `[0, 1]`. `combineConjunctive([])` and
`combineDisjunctive([])` should not be reachable — callers gate on a non-empty list; assert or
return 1 / 0 respectively, but document which.

### `predicate-conjuncts.ts`: add `splitDisjuncts`

`splitConjuncts` already flattens an `AND` tree (`predicate-conjuncts.ts:14`). Add the exact
mirror for `OR`, same iterative-stack shape, same doc-comment style. Do not duplicate the walk
inline in the stats provider.

### `catalog-stats.ts`: recursive estimation

Split the current `estimatePredicateSelectivity` into a thin entry point plus two private
helpers:

```
estimatePredicateSelectivity(stats, predicate)      // entry: rowCount-0 short-circuit, then estimateNode(…, depth 0)
  ├─ estimateNode(stats, node, depth)               // boolean structure: AND / OR / NOT, else leaf
  └─ estimateLeaf(stats, node)                      // the existing switch, unchanged in behaviour
```

`estimateNode` rules:

- **`AND`** — `splitConjuncts`, recurse on each. A conjunct that returns `undefined` is treated
  as selectivity `1.0` (unknown ⇒ claim no reduction) and is *not* passed to
  `NaiveStatsProvider`. If **every** conjunct is unknown, return `undefined` so the existing
  whole-predicate naive fallback in `selectivity()` still runs and behaviour is unchanged. If at
  least one conjunct is known, combine the known ones with `combineConjunctive`.
  - Treating an unknown conjunct as `1.0` rather than as the naive `0.1` is deliberate: the
    naive number is fabricated, and multiplying it in biases the estimate downward. Over-
    estimating rows is the safer error direction for plan choice. Note this in a code comment —
    it is the one place the new behaviour can read as a regression (`a = 1 and lower(b) = 'x'`
    goes from `0.1` to `1/ndv(a)`), and it is intentional.
- **`OR`** — `splitDisjuncts`, recurse on each. If **any** disjunct is unknown, return
  `undefined`: an unknown disjunct cannot be assumed to contribute nothing, and assuming `1.0`
  would make the whole disjunction `1.0`, which is safe but useless. Otherwise
  `combineDisjunctive`.
- **`NOT`** (`UnaryOpNode` with `operator === 'NOT'`) — recurse; `undefined` propagates,
  otherwise return `1 - inner`. Check for `'NOT'` *before* falling through to `estimateLeaf`,
  which handles the other `UnaryOp` operators (`IS NULL` / `IS NOT NULL`).
- **depth guard** — recursion is on `OR`/`NOT` nesting, which is unbounded in principle. Cap at
  a named constant (`MAX_BOOLEAN_DEPTH = 16`) and return `undefined` past it.
- **anything else** — `estimateLeaf`, byte-for-byte the current switch.

**Floor.** A combined result (two or more selectivities actually combined) floors at
`1 / max(stats.rowCount, 1)` — never claim fewer than one surviving row. Do **not** apply this
floor to a single leaf estimate: `IS NULL` on a column with `nullCount === 0` legitimately
returns `0` today, and `FilterNode.estimatedRows` already floors the row count at 1, so
flooring the leaf would change an observable for no gain.

### Operator casing

The planner's convention is uppercase `'AND'` / `'OR'` / `'NOT'` (`predicate-normalizer.ts:44`,
`predicate-conjuncts.ts:18`). Match it exactly; do not add case-insensitive comparison.

## Edge cases & interactions

- **Single conjunct.** `splitConjuncts` on a non-`AND` predicate yields a one-element list; the
  path must produce exactly today's number. The existing test
  `stamps 1/ndv from catalog stats and derives estimatedRows from it (not 0.5)` asserts
  `closeTo(1/ndv)` on a residual single-conjunct filter and must keep passing untouched.
- **Table with no catalog statistics.** `CatalogStatsProvider.selectivity` early-returns to the
  naive provider when `table.statistics` is undefined (`catalog-stats.ts:97`), so none of this
  code runs. The existing test
  `falls back to naive heuristic selectivity for a stats-less table` (expects exactly `0.1`)
  must keep passing.
- **`rowCount === 0`.** Entry point returns `0` before any recursion — keep that short-circuit
  first, and make sure the combined-result floor (`1/rowCount`) is never reached with
  `rowCount === 0`.
- **Column with no `columnStats` entry** on an otherwise-analyzed table ⇒ leaf returns
  `undefined` ⇒ treated as the unknown conjunct case.
- **Two conjuncts on the same column** (`a > 1 and a < 10`) are strongly anti-correlated, and
  nothing here pairs them into a range. Backoff damps the error (0.333 · 0.333^0.5 ≈ 0.19 rather
  than 0.11) but does not remove it. Add a `NOTE:` comment at the combination site recording
  this; do not attempt same-column range pairing in this ticket.
- **Column-vs-column comparison on one table** (`where x = y`): `extractColumnFromPredicate`
  picks the first `ColumnReference` child and `extractConstantValue` finds no literal, so `=`
  yields `1/ndv(x)` — wrong, but pre-existing and unchanged by this ticket. Add a `NOTE:`
  comment at `extractColumnFromPredicate`; do not fix here.
- **`IN` with a subquery** rather than a value list: `extractInListSize` falls back to
  `children.length - 1`, which is `1` for a subquery, giving `1/ndv`. Pre-existing; a `NOTE:`
  comment only.
- **Deeply nested / degenerate booleans** — `((a = 1))`, `not not (a = 1)`, `a = 1 and (b = 2 or
  b = 3)`, an `AND` whose conjuncts are themselves `OR`s. All must terminate and return a number
  in `[0, 1]` or `undefined`; none may throw.
- **Idempotence of the rule.** `rule-filter-selectivity` declines a Filter that already carries a
  selectivity (`rule-filter-selectivity.ts:31`); nothing here changes that, but re-running the
  optimizer over a stamped plan must stay a no-op.
- **Unique-key override.** `FilterNode.computePhysical` forces `estimatedRows = 1` for a filter
  whose equality conjuncts cover a unique key, regardless of the stats fraction. A smaller
  stamped selectivity must not disturb that branch.
- **Golden plans.** `test/plan/golden-plans.spec.ts` and the other `test/plan/` specs assert plan
  shape. They only shift if a test runs `ANALYZE` (otherwise `table.statistics` is undefined and
  this code never fires). Confirm the full suite is green; if a golden plan does move, inspect
  the diff and justify it in the handoff rather than re-baselining blindly.

## TODO

### Phase 1 — combinators

- Add `packages/quereus/src/planner/stats/selectivity-combine.ts` with `BACKOFF_CONJUNCT_LIMIT`,
  `combineConjunctive`, `combineDisjunctive`, and a file doc-comment explaining the backoff model
  and why it is preferred over plain independence.
- Add `splitDisjuncts` to `planner/analysis/predicate-conjuncts.ts`, mirroring `splitConjuncts`.
- Add `packages/quereus/test/optimizer/selectivity-combine.spec.ts`:
  - `combineConjunctive([0.5])` is exactly `0.5`.
  - `combineConjunctive([0.1, 0.1])` is `0.1 * Math.sqrt(0.1)` (≈ `0.0316`).
  - result is independent of input order (`[0.5, 0.1]` equals `[0.1, 0.5]`).
  - a fifth, least-selective entry does not change the result of the first four.
  - out-of-range inputs (`-1`, `2`, `NaN`-free) clamp; result always in `[0, 1]`.
  - `combineDisjunctive([0.5, 0.5])` is `0.75`; `combineDisjunctive([1, 0.3])` is `1`.
  - `splitDisjuncts` flattens a right-nested and a left-nested `OR` chain to the same set, and
    yields a single-element list for a non-`OR` node.

### Phase 2 — recursive provider

- Refactor `CatalogStatsProvider.estimatePredicateSelectivity` into entry + `estimateNode` +
  `estimateLeaf` as described, moving the existing switch into `estimateLeaf` unchanged.
- Implement the `AND` / `OR` / `NOT` / depth-guard branches and the combined-result floor.
- Add the `NOTE:` comments called out under *Edge cases* (same-column conjuncts,
  column-vs-column, `IN`-subquery list size).
- Update the stale comment block in `rules/predicate/rule-filter-selectivity.ts:40-44`, which
  currently states that conjunctions are not decomposed.

### Phase 3 — integration tests

Extend `packages/quereus/test/optimizer/filter-selectivity.spec.ts` (reuse its `seed()` /
`optimizedFilter` helpers; note the existing seed analyzes a 100-row `t(id integer primary key,
cat text)` with 4 distinct `cat` values).

- Seed a table with **two** low-cardinality non-key columns so both conjuncts survive into one
  residual `FilterNode` — the existing spec shows a key-column predicate (`id > 5`) gets pushed
  into the seek and leaves only the non-key conjunct behind. Verify the residual really carries
  the `AND` before asserting (dump `filter.predicate` if the shape is not what you expect).
- `where a = 1 and b = 2` over that table stamps `combineConjunctive([1/ndv_a, 1/ndv_b])`, and
  the value is strictly less than the single-conjunct `where a = 1` stamp.
- `where a = 1 or b = 2` stamps `combineDisjunctive([1/ndv_a, 1/ndv_b])`.
- `where a = 1 and <unestimable conjunct>` stamps exactly `1/ndv_a` (unknown treated as 1.0).
- `where a = 1 or <unestimable conjunct>` leaves the whole predicate unknown ⇒ falls back to the
  naive provider (assert the stamp equals the naive value, not a combined one).
- A three- and a five-conjunct predicate both stay within `[0, 1]` and the five-conjunct estimate
  is not smaller than the plain product would be (guards the backoff cap).

### Phase 4 — validate & document

- Update `docs/optimizer.md:296`: the sentence "Conjunction / join selectivity is not yet
  decomposed …" is now wrong for the conjunction half. Describe the recursive boolean model and
  the backoff combination; leave the join half pointing at `feat-join-filter-selectivity`.
- `yarn build`, then `yarn lint`, then `yarn test 2>&1 | tee /tmp/conj-sel-test.log; tail -n 80
  /tmp/conj-sel-test.log`.
