description: When a query's WHERE clause ORs together one condition the planner understands and one it does not, the planner no longer throws away what it knew — it now reports a row estimate at least as large as the part it could prove.
files: packages/quereus/src/planner/stats/catalog-stats.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md
----

## What shipped

`CatalogStatsProvider`'s walk over a predicate's boolean structure returns a tagged
result instead of a bare number:

```ts
type Estimate =
	| { readonly kind: 'complete';   readonly value: number }   // stats answered the whole predicate
	| { readonly kind: 'lowerBound'; readonly value: number };  // an OR branch was unreadable; value is a floor
```

`undefined` still means "nothing could be established at all".

- **`or`, every branch readable** — unchanged `1 - Π(1 - sᵢ)`, tagged `complete`.
- **`or`, some branches readable** — `lowerBound` carrying `max(sᵢ)` over the readable
  branches. `max`, not the disjunctive combination: `1 - Π(1 - sᵢ)` assumes the branches
  do not overlap, which is an estimate, not a bound.
- **`or`, no branch readable** — `undefined`, unchanged.
- **`and`** — unchanged; a `lowerBound` conjunct counts as unknown (1.0) like an
  unreadable one, since folding a floor into a conjunctive product drags the estimate
  down and `and` deliberately errs high.
- **`not`** — a `lowerBound` operand makes the negation `undefined` (negating a floor
  yields a ceiling, which nothing downstream models).

Public surface: `selectivity()` returns `max(naive guess, floor)` for a `lowerBound`;
`statsOnlySelectivity()` returns `undefined` for one, so `rule-filter-selectivity`'s
statistics gate for filters over joins is unchanged.

Net effect on the table used by the tests (`m`: 100 rows, `a` 4 distinct, `b` 5,
`id` 100):

| SQL | Before | After |
| --- | --- | --- |
| `where a = 1 or lower(s) = 'x1'` | 0.1 | 0.25 — the floor binds |
| `where id = 5 or lower(s) = 'x1'` | 0.1 | 0.1 — floor is 0.01, naive caution stands |
| `where a = 1 or b = 2 or lower(s) = 'x1'` | 0.1 | 0.25 = `max(1/4, 1/5)`, not 0.4 |
| `where a = 1 and (b = 2 or lower(s) = 'x1')` | 0.25 | 0.25 — partial OR counts as 1.0 |
| `where not (a = 1 or lower(s) = 'x1')` | 0.3 | 0.3 — naive `UnaryOp` default |

## Review findings

### Checked

- **Bound direction end to end.** Walked every path that can produce a `lowerBound` and
  every consumer of one. `selectivity` never reports below the floor and never reports a
  partial branch as the whole answer; `statsOnlySelectivity` never lets a floor through;
  `and` and `not` both degrade a `lowerBound` to unknown rather than to a number.
- **Short-circuit equivalence.** `estimatePredicateSelectivity` folded into `estimate`
  moved the no-statistics and empty-table checks. Both produce the same observable result
  as before (`undefined` and `0` respectively), including through `statsOnlySelectivity`,
  which used to own the no-statistics check itself.
- **Callers.** `rule-filter-selectivity` (both the single-table `selectivity` path and the
  multi-relation `statsOnlySelectivity` gate) and `CatalogStatsProvider.indexSelectivity`.
  No caller is surprised by the larger number; the gate's meaning is preserved.
- **Docs.** Read every `docs/optimizer.md` paragraph the change touches plus the
  `StatsProvider` interface docs in `planner/stats/index.ts`. The `AND` / `OR` / `NOT`
  bullets and the `statsOnlySelectivity` paragraph match the new behaviour.
- **Suite.** Full `yarn test` at 7772 passing / 13 pending / 0 failing, plus lint
  (eslint + the `tsconfig.test.json` type pass) and typecheck, all clean. No
  pre-existing failures surfaced. The handoff worried the larger estimate could flip a
  plan choice somewhere; nothing in the suite moved, and no sqllogic expectation changed.

### Found and fixed in this pass

- **"Proven floor" was an overclaim.** A readable disjunct that is itself an `AND`
  reports an *upper* bound of its own value (unknown conjuncts are dropped), so a floor
  built from it can sit above the truth. Harmless — it is the same over-estimate
  direction `and` already takes on purpose — but the code and docs asserted a proof.
  Corrected the wording in the `Estimate` doc comment and in `docs/optimizer.md`, with
  the condition under which an exact floor would need a different rule.
- **Degenerate test case.** `(a = 1 and b = 2) or lower(s) = 'x1'` expected
  `max(0.1, combineConjunctive([1/4, 1/5]))`, and those are numerically identical on this
  table, so the case passed under the old give-up-and-guess behaviour too. Replaced with
  a dedicated `floors a partly-known OR at a readable AND branch` test using `b <> 2`,
  which lands the floor at ≈0.224 — clear of the naive 0.1 — and asserts that separation
  explicitly so the case cannot silently go degenerate again.
- **Missing gate regression.** The `statsOnlySelectivity` guarantee was asserted only at
  provider level. Added `leaves a partly-readable OR over one relation unstamped`: a
  filter over a join with `o.cat = 'a' or lower(o.cat) = 'x'` must stay unstamped, since
  the single-table path *would* stamp the floor and only the gate stops it.

### Tripwires recorded (not tickets)

- Floor exactness depends on the branch it came from — `NOTE:` on the `Estimate` type in
  `catalog-stats.ts`, naming the fix (exclude an `AND` with a dropped conjunct from the
  `max`) if an exact floor is ever needed.
- The `lowerBound` disjunct branch in `estimateDisjunction` is unreachable today —
  `splitDisjuncts` flattens nested ORs and no other node kind mints a `lowerBound`.
  `NOTE:` at the site so a reader does not hunt for the missing test; the handling is
  correct the moment another kind produces one, so it stays.
- No upper-bound `Estimate` kind, so `not` over a partly-known `or` gives up rather than
  reporting `1 - floor`. Already carried as a `NOTE:` in the `not` path from the prior
  ticket; left as is, since nothing observed needs it.

### Not filed, with reason

- **No unit-level `or` coverage in `test/planner/stats/catalog-stats.spec.ts`.** Real,
  and called out in the handoff, but not fixable at the level it is stated:
  `splitConjuncts` / `splitDisjuncts` gate on `instanceof BinaryOpNode`, so that spec's
  plain-object mocks can never drive `and` / `or`. Making them work means building real
  `BinaryOpNode`s, at which point the spec duplicates what the plan-building spec already
  covers. That spec already carries a comment saying exactly this.
- **The `lowerBound` tag does not survive `and`.** Deliberate and documented — it matches
  the settled `and` semantics exactly. Partiality is observable only when the top node is
  the `or` itself, which is the shape that matters.
- **`selectivity()`'s `naive === undefined` branch is untested.**
  `NaiveStatsProvider.selectivity` always returns a number, so the branch is unreachable
  through the default fallback. It is not dead code in the type sense — the constructor
  accepts an injected fallback and the interface permits `undefined` — so the guard stays
  and no test can reach it without a bespoke provider.

### Major findings

None. No new ticket filed.
