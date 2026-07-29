description: When a query's WHERE clause ORs together one condition the planner understands and one it does not, the planner no longer throws away what it knew — it now reports a row estimate at least as large as the part it could prove.
files: packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md
difficulty: medium
----

## What changed

`CatalogStatsProvider` walks a `where` predicate's boolean structure to estimate what
fraction of rows survive. Previously an `or` with any branch it could not read returned
a bare `undefined`, and the caller substituted `NaiveStatsProvider`'s flat 0.1 for a
comparison — a number that could sit *below* something the statistics already proved.

The walk now returns a small tagged result instead of a bare number:

```ts
type Estimate =
	| { readonly kind: 'complete';   readonly value: number }   // stats answered the whole predicate
	| { readonly kind: 'lowerBound'; readonly value: number };  // an OR branch was unreadable; value is a proven floor
```

`undefined` still means "nothing could be established at all".

Behaviour per node kind:

- **`or`, every branch readable** — unchanged: `1 - Π(1 - sᵢ)`, tagged `complete`.
- **`or`, some branches readable** — tagged `lowerBound` carrying `max(sᵢ)` over the
  readable branches. `max`, not the disjunctive combination: `1 - Π(1 - sᵢ)` assumes
  the branches do not overlap, which is an estimate, not a proof. If one readable
  branch subsumed another the true value would be exactly the max.
- **`or`, no branch readable** — `undefined`, unchanged.
- **`and`** — unchanged. A `lowerBound` conjunct counts as unknown (selectivity 1.0)
  exactly like an unreadable one; folding a floor into a conjunctive product would drag
  the estimate down, and `and` deliberately errs high.
- **`not`** — a `lowerBound` operand makes the negation `undefined`: negating a lower
  bound yields an *upper* bound, which nothing downstream models.

Public surface:

- `selectivity()` returns `max(naive guess, floor)` for a `lowerBound`. Both bounds
  hold: never below the proven floor, never a partial branch's estimate reported as if
  it were the whole answer.
- `statsOnlySelectivity()` returns `undefined` for a `lowerBound` — unchanged meaning
  ("real statistics answered *the predicate*"), so `rule-filter-selectivity`'s
  does-this-relation-have-usable-statistics gate for filters over joins is untouched.

`estimatePredicateSelectivity` was folded into a new private `estimate(table, predicate)`
that owns both short-circuits (no statistics → `undefined`, empty table → `complete(0)`).

## Use cases to exercise

Table `m` in `test/optimizer/filter-selectivity.spec.ts`: 100 rows, `a` has 4 distinct
values, `b` has 5, `id` is the PK with 100. `lower(s) = 'x1'` is the standard unreadable
branch (the leaf estimator reads the column off a *direct* child of the comparison, so a
function wrapper hides it).

| SQL | Before | After |
| --- | --- | --- |
| `where a = 1 or lower(s) = 'x1'` | 0.1 | 0.25 — the floor binds |
| `where id = 5 or lower(s) = 'x1'` | 0.1 | 0.1 — floor is 0.01, naive caution stands |
| `where a = 1 or b = 2 or lower(s) = 'x1'` | 0.1 | 0.25 = `max(1/4, 1/5)`, **not** `combineDisjunctive` (0.4) |
| `where a = 1 and (b = 2 or lower(s) = 'x1')` | 0.25 | 0.25 — partial OR counts as 1.0 |
| `where not (a = 1 or lower(s) = 'x1')` | 0.3 | 0.3 — naive `UnaryOp` default |
| `where a = 1 or b = 2` | `combineDisjunctive` | unchanged |

Two of those cases are provider-level only (`providerSelectivity` on the raw plan): the
optimizer absorbs `id = 5` into a key seek, and pushes conjuncts apart, so the fused
shape is not observable end-to-end.

## Validation run

- `yarn workspace @quereus/quereus run typecheck` — clean
- `yarn workspace @quereus/quereus run lint` — clean (includes the `tsconfig.test.json` pass)
- `yarn workspace @quereus/quereus run test` — 7770 passing, 13 pending, 0 failing
- `yarn build` — clean

No pre-existing failures surfaced.

## Test coverage added

In `test/optimizer/filter-selectivity.spec.ts`, `boolean-structure selectivity` describe:

- `lifts the naive estimate to the provable floor when an OR disjunct is unestimable` —
  replaces the old `falls back to the naive estimate …`, which asserted the behaviour
  this ticket removes (including that the answer sat below the provable floor).
- `keeps the naive guess when it already exceeds the floor` — the other bound.
- `floors a partly-known OR at the most permissive readable branch` — pins `max` vs
  `combineDisjunctive` explicitly.
- `treats a partly-known OR conjunct as unknown inside an AND`.
- `declines to negate a partly-known OR`.
- `reports a partly-known OR as unknown to statsOnlySelectivity` — the gate guarantee.
- The `composes AND / OR / NOT` case for `(a = 1 and b = 2) or lower(s) = 'x1'` now
  expects `max(0.1, combineConjunctive([1/ndv.a, 1/ndv.b]))` rather than a bare `0.1`.

## Known gaps — where to push

- **The `(a = 1 and b = 2) or lower(s) = 'x1'` case is numerically degenerate.**
  `combineConjunctive([0.25, 0.2])` is exactly `0.1` on this table, so `max` with the
  naive `0.1` cannot distinguish the two. It is written as the composition rather than a
  magic number, so the *intent* is visible, but the case would pass under either
  behaviour. A reviewer wanting a discriminating version would need different distinct
  counts on `m` (or a second table).
- **No unit-level coverage in `test/planner/stats/catalog-stats.spec.ts`.** That spec's
  mocks cannot drive `and`/`or` at all — `splitConjuncts`/`splitDisjuncts` gate on
  `instanceof BinaryOpNode`, and a plain object claiming `nodeType: 'BinaryOp'` never
  splits. All `or` coverage therefore rides on the plan-building spec, which is slower
  and couples the assertions to what the optimizer leaves in the residual `Filter`.
- **The `lowerBound` tag does not survive `and`.** `a = 1 and (b = 2 or lower(s) = 'x')`
  reports `complete(1/ndv(a))`, so a caller cannot tell that part of the predicate was
  unreadable. Deliberate — it matches the settled `and` semantics and the pre-existing
  behaviour exactly — but it does mean partiality is only observable at the top level
  when the top node is the `or` itself.
- **No upper-bound kind.** `not` over a partly-known `or` gives up entirely rather than
  reporting `1 - floor` as a ceiling. Cheap to add if a negated mixed-knowledge
  predicate ever drives a bad plan; deliberately not built on spec.
- **No sqllogic-level check that a plan actually changed shape.** The new number is
  asserted on `FilterNode.selectivity`, not on a chosen join order or access path. The
  estimate is now larger for these predicates, which could in principle flip a plan
  choice somewhere; nothing in the suite regressed, but nothing pins it either.
- **`selectivity()`'s `Math.max` assumes the naive fallback returns a number.** It
  handles `undefined` (falls through to the floor), but `NaiveStatsProvider.selectivity`
  never actually returns `undefined`, so that branch is untested.
