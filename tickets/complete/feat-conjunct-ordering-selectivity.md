description: When a WHERE clause has several AND-ed tests, the engine now orders them by how many rows each test throws away per unit of work, using real column statistics rather than raw cost alone — implemented, reviewed, and shipped.
files: packages/quereus/src/planner/stats/conjunct-selectivity.ts, packages/quereus/src/planner/cost/conjunct-cost.ts, packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic, docs/optimizer.md, docs/optimizer-rules.md
----

## What shipped

`rule-filter-conjunct-ordering` (PostOptimization) used to sort a Filter's
top-level AND conjuncts on `(cost tier, subtree cost)`. It now sorts on
`(cost tier, benefit/cost descending, subtree cost)`, where benefit/cost is
`(1 - selectivity) / max(subtreeCost, 1e-9)` and the selectivity comes from real
column statistics only. The cost tier (`Pure` < `Volatile` < `Subquery`) stays
the primary key, so a measured selectivity never bets against an unmeasured
per-row sub-program cost.

Three pieces:

1. **Shared estimator.** The per-conjunct estimation machinery moved verbatim
   out of `rule-filter-selectivity.ts` into `planner/stats/conjunct-selectivity.ts`
   (`estimateConjunctSelectivity`, `makeColumnStatsResolver`,
   `CROSS_RELATION_INEQUALITY_SELECTIVITY`). Deliberately not in the
   `stats/index.ts` barrel — that would cycle through `framework/context.ts`.

2. **Ranking.** `cost/conjunct-cost.ts` gained `UNKNOWN_CONJUNCT_SELECTIVITY`
   (= `DEFAULT_FILTER_SELECTIVITY`, 0.5), `MIN_CONJUNCT_COST` (divide-by-zero
   floor), `ConjunctRank` and `compareConjunctRank`. Selectivity is clamped to
   [0, 1] inside the comparator; equal ratios fall through to plain cost.
   `compareConjunctCost` is untouched.

3. **Rule.** Type/arity checks → side-effect refusal → `statsOnlySelectivity`
   gate → lazy `collectColumnOrigins` walk → per-conjunct estimation. If no
   conjunct got a real estimate the rule sorts with `compareConjunctCost`
   verbatim, so an un-ANALYZEd query orders bit-identically to the old rule. In
   the mixed case unknowns take the neutral 0.5.

Unchanged by design: what `rule-filter-selectivity` stamps, on either path. Its
single-table stamping path still hands the whole predicate to `selectivity`
(naive fallback allowed), because that number feeds `estimatedRows` and every
physical cost reader.

## Review findings

### Checked

- **Ranking math.** `compareConjunctRank` is lexicographic on
  `(tier, -ratio, cost)` — a valid strict weak ordering, so `Array.sort` is
  well-defined. The ratio `(1 - s)/cost` is the textbook rank for ordering
  independent AND-ed predicates, and descending ratio is the correct direction.
  Boundary behaviour is right: selectivity 1.0 gives zero benefit and sorts
  last within its tier regardless of how cheap it is, which is correct — a
  conjunct that rejects nothing buys nothing by running early.
- **Extraction fidelity.** `stats/conjunct-selectivity.ts` is byte-for-byte the
  old private functions with `makeResolver` renamed and exported;
  `test/optimizer/filter-selectivity.spec.ts` (68 tests, every stamped number
  asserted) passes with only an import path changed.
- **Fixed point.** The sort key derives only from node identity and
  `context.stats`, both stable within one `optimize()`. Confirmed for the
  all-unknown, all-known, and mixed cases.
- **Rule interaction.** `filter-selectivity-restamp` is registered first in
  PostOptimization and `filter-conjunct-ordering` last. The ordering rule
  carries `filter.selectivity` forward onto its new node, so the restamp rule
  declines on the rewritten Filter — no rewrite ping-pong between the two.
- **Import cycle.** `cost/conjunct-cost.ts` now value-imports
  `DEFAULT_FILTER_SELECTIVITY` from `nodes/filter.ts`, and `nodes/filter.ts`
  imports `cost/index.ts`. Not a cycle, because `conjunct-cost.ts` is
  deliberately absent from the `cost/index.ts` barrel — the constraint the
  module's own doc-comment already states. Confirmed by build and by the tests
  exercising module-init order.
- **Golden plans.** Verified by grep that no file under `test/plan/` issues an
  `ANALYZE` statement (the two hits are a helper named `analyzedPlan` and a
  comment), so every golden takes the all-unknown branch and is bit-identical.
  This is a checked fact, not an inference from the goldens passing.
- **Docs.** `docs/optimizer.md` (§ Conjunct cost tiers, § filter selectivity)
  and `docs/optimizer-rules.md` read end to end against the shipped code — both
  accurate, including the tier-primacy rationale and the mixed-case neutral.
  `docs/architecture.md` lists `planner/stats/` at directory granularity only,
  so the new module needs no entry there.
- **Source hygiene.** Rule 133 lines, estimator 208, `conjunct-cost.ts` 126,
  spec 514; `rule-filter-selectivity.ts` shrank 370 → 193. Functions are short
  and single-purpose; no size concern at any site.

### Found and fixed in this pass (minor)

- **Overclaiming comment on `MIN_CONJUNCT_COST`.** It said the floor
  "guarantees the ratio can never be Infinity or NaN" — but `Math.max(NaN, x)`
  is `NaN`, so a NaN cost would propagate straight into the comparator and make
  the sort undefined. Reworded to the true claim: the floor stops a *zero* from
  producing Infinity, and NaN does not arise because `getTotalCost()` sums
  finite per-node costs. No behaviour change; the guard was already right.
- **Misleading comment on the provider short-circuit.**
  `estimateSelectivities`' doc implied the `statsOnlySelectivity == null` check
  spares the origins walk whenever no estimate is possible. It does not: the
  production `CatalogStatsProvider` always implements the method, so a database
  with nothing ANALYZEd still pays the walk. Reworded, with the cost stated
  plainly and parked as a tripwire (below).
- **Dead compatibility re-export.** `rule-filter-selectivity.ts` re-exported
  `CROSS_RELATION_INEQUALITY_SELECTIVITY` from its old home solely so one
  importer — `test/optimizer/filter-selectivity.spec.ts` — would not have to
  change its import line. `AGENTS.md` is explicit that backwards compatibility
  is not a concern yet, so the indirection is pure cost. Removed; the test now
  imports from `stats/conjunct-selectivity.ts` directly.
- **Two test-coverage gaps**, both asymmetries the implementer's suite left
  open. Each new test *fails* under the cost-only rule, so neither is vacuous:
  - *Measured-weak sinks behind unknown.* Every existing end-to-end test moved
    a measured-**stronger** conjunct forward. Nothing covered the other arm:
    `strong <> 3` estimates 0.98 (weaker than the 0.5 neutral) **and** is the
    cheaper subtree, so cost alone leaves it first and the rule declines. Now
    pinned that the neutral cuts both ways and it sinks behind the unknown.
  - *Ordering over a join source.* The estimator's multi-relation path was
    exercised only through the stamping rule. But a filter over a join is
    exactly what `rule-predicate-pushdown` leaves behind, and it is the only
    shape where the origins map spans several relation instances. Now pinned
    through the ordering rule, with each conjunct attributed to its own table.
  - `rawFilter` gained an optional `needle` argument so a test can pick among a
    join plan's several raw Filters; the single-Filter call sites are unchanged.

### Found and filed as new tickets (major)

None. Nothing surfaced that could not be resolved inside this pass — no
correctness defect, no missing error path, no resource-cleanup or type-safety
issue. The rule's failure modes are all "fall back to cost-only ordering",
which is the pre-existing behaviour and is reached by an explicit branch.

### Tripwires recorded (conditional — deliberately not tickets)

- **Origins walk paid twice per Filter, even with nothing ANALYZEd.**
  `collectColumnOrigins` now runs in both the stamping rule and the ordering
  rule, and the provider short-circuit does not help the production provider.
  Unmeasured. `NOTE:` at `rule-filter-conjunct-ordering.ts`
  (`estimateSelectivities`), naming the fix — memoize the map per pass on
  `OptContext` keyed by the source node — and cross-referencing the companion
  `NOTE:` already at `rule-filter-selectivity.ts`.
- **Guard-idiom second route** (`v <> 0 and 10 / v > 1`): selectivity can now
  promote a conjunct past a same-tier guard where cost alone would not have.
  Inert — nothing quereus defines throws on a bad arithmetic edge. Already
  `NOTE:`d by the implementer in the rule header and in `docs/optimizer.md`;
  left as written.
- **Correlated-subquery estimate describes the outer column**, not the
  subquery's result. Pre-existing in the stamping path and contained in the
  ordering path by tier primacy. Already `NOTE:`d at
  `stats/conjunct-selectivity.ts`; left as written.

### Considered and deliberately left alone

- The explicit all-unknown `compareConjunctCost` branch is provably redundant —
  uniform 0.5 through `compareConjunctRank` yields the identical order, which
  the implementer's own comparator test demonstrates. Kept anyway: it is a
  cheap, documented bit-identity guarantee covering the un-ANALYZEd majority of
  the suite, and collapsing it would trade a proof for an argument.
- `DEFAULT_FILTER_SELECTIVITY` living in `nodes/filter.ts` while
  `cost/conjunct-cost.ts` imports it is slightly odd layering, but the
  alternative is a second 0.5 literal, and relocating the constant is churn
  well beyond this ticket.
- The end-to-end proof is plan order plus row parity, not a measured speedup.
  That limit is real and the implementer stated it: a counting-UDF conjunct is
  `Volatile` tier with no column statistics, so the win is not observable that
  way. Not a defect — no cheaper honest measurement exists at this layer.

## Validation

- `yarn lint` — 0 (eslint + `tsc -p tsconfig.test.json --noEmit` across
  `packages/quereus`; every other package is an intentional no-op).
- `yarn typecheck` — 0. `yarn build` — 0.
- `yarn test` — **8296 passing, 0 failing** in `packages/quereus` (8294 before
  this review; +2 from the tests added above), and green across every other
  workspace.
- `test/where-conjunct-ordering.spec.ts` — 37 passing.
  `test/optimizer/filter-selectivity.spec.ts` — 68 passing after the import
  move.
- `yarn docs:check` — one failure, `docs/sync.md` word-count ratchet
  (12670 vs 12538). Pre-existing at HEAD, in a package this ticket never
  touches, and already tracked in `tickets/.pre-existing-known.md` under
  `debt-doc-size-ratchet-red-at-head` (in-flight). Not re-reported. The
  additions to `docs/optimizer.md` and `docs/optimizer-rules.md` passed their
  own ratchets.
