description: When a WHERE clause has several AND-ed tests, the engine now orders them by how many rows each test throws away per unit of work (using ANALYZE statistics), not just by raw cost — implemented and fully green; ready for adversarial review.
files: packages/quereus/src/planner/stats/conjunct-selectivity.ts, packages/quereus/src/planner/cost/conjunct-cost.ts, packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic, docs/optimizer.md, docs/optimizer-rules.md
----

## What was built

`rule-filter-conjunct-ordering` (PostOptimization) previously sorted a Filter's
top-level AND conjuncts on `(cost tier, subtree cost)`. It now sorts on
`(cost tier, benefit/cost descending, subtree cost)`, where benefit/cost is
`(1 - selectivity) / max(subtreeCost, 1e-9)` and selectivity comes from real
column statistics only. The tier (`Pure` < `Volatile` < `Subquery`) stays the
primary key — a measured selectivity never bets against an unmeasured per-row
sub-program cost, so a strongly-selective subquery conjunct can never jump
ahead of a weak pure one.

Three code changes:

1. **Extraction (no behaviour change).** The per-conjunct estimation machinery
   moved verbatim from `rule-filter-selectivity.ts` into a new shared module
   `planner/stats/conjunct-selectivity.ts` (`estimateConjunctSelectivity`,
   `makeColumnStatsResolver`, `CROSS_RELATION_INEQUALITY_SELECTIVITY` — the
   constant is re-exported from its old path so existing imports keep working).
   The module is deliberately NOT in the `stats/index.ts` barrel (would cycle
   through `framework/context.ts`). Verified behaviour-preserving:
   `test/optimizer/filter-selectivity.spec.ts` (68 tests, every stamped number
   asserted) passed unchanged before phase 2 started.

2. **Ranking.** `cost/conjunct-cost.ts` gained `UNKNOWN_CONJUNCT_SELECTIVITY`
   (= `DEFAULT_FILTER_SELECTIVITY`, 0.5 — reused, not a second literal),
   `MIN_CONJUNCT_COST` (1e-9, divide-by-zero guard only), `ConjunctRank`
   (extends `ConjunctCost` with `selectivity`) and `compareConjunctRank`.
   Selectivity is clamped to [0, 1] inside the comparator; equal ratios fall
   through to plain cost via an explicit `!==` check (never a raw ratio
   difference); `compareConjunctCost` is untouched.

3. **Rule rewrite.** Order of work inside the rule: type/arity checks →
   side-effect refusal (unchanged, first) → `statsOnlySelectivity == null`
   gate (no origins walk paid when the provider can't answer) → lazy
   `collectColumnOrigins` walk → per-conjunct estimation. **If no conjunct got
   a real estimate, the rule sorts with `compareConjunctCost` verbatim — an
   explicit branch**, so an un-ANALYZEd query orders bit-identically to the old
   rule. In the mixed case unknowns take the neutral 0.5. Output construction
   unchanged (direct `FilterNode` build carrying `filter.selectivity`).

Deliberately NOT changed: what `rule-filter-selectivity` stamps, on either
path. Its single-table stamping path still calls `selectivity` (naive fallback
allowed) with the whole predicate — changing that would move row estimates
suite-wide for reasons unrelated to this ticket.

## Use cases to poke at in review

- **The win case:** `select id from wa where weak = 1 and strong in (2, 3)` on
  an ANALYZE'd table where `weak` has 2 distinct values and `strong` has 50.
  The IN conjunct is the pricier subtree, so cost-only runs `weak` first; the
  statistics (0.04 vs 0.5) overrule it. Both written orders converge on
  strong-first; asserted via `FilterNode.toString()` detail plus row parity.
- **Regression guard:** the same query against a never-ANALYZEd table keeps
  the cost-only order (cheap `weak` first) — the explicit all-unknown branch.
  Every pre-existing test in `where-conjunct-ordering.spec.ts` (built on
  un-ANALYZEd tables) passes with assertions unchanged, which is the strongest
  guard in the suite.
- **Cross-tier immunity:** a selectivity-0 `Subquery`-tier rank never outranks
  a selectivity-1 `Pure` rank (unit-pinned — this is the decision most likely
  to be "improved" away later).
- **Correlated-subquery containment:** `strong = (select wa.strong)` resolves
  only outer attributes, so the estimator answers 1/ndv(strong) — a number
  describing the outer column, not the subquery result. Pinned that the
  Subquery tier contains the damage (`weak = 1` still sorts first); `NOTE:` at
  the estimator records the imprecision.
- **Boundaries:** selectivity exactly 1.0 (sorts last in tier), 0.0 (maximal
  benefit), out-of-range values (clamped), zero subtree cost (floored, finite),
  identical keys (stable tie), equal ratios (tertiary cost key).
- **Fixed point:** the rule's own output returns null, including in the mixed
  known/unknown case (`context.stats` is stable within one optimize()).

## Validation performed

- `test/optimizer/filter-selectivity.spec.ts` — 68 passing, run standalone
  after phase 1 alone and again at the end (proof of verbatim extraction).
- `test/where-conjunct-ordering.spec.ts` — 35 passing (14 pre-existing
  unchanged, 21 new/extended). `DUMMY_CONTEXT` migrated to a real
  `createOptContext(db.optimizer, new CatalogStatsProvider(), …)` — the old
  "rule never reads its context" comment stopped being true.
- `07.7.4-where-conjunct-ordering.sqllogic` — extended with an ANALYZE'd
  selectivity pair, both written orders (the runner accepts `analyze`; note
  it does NOT accept `insert into … with recursive`, so the seed data is a
  literal VALUES list).
- Full suite `yarn test`: 8294 passing, 0 failing (fuzz differential test with
  `filter-conjunct-ordering` toggling included; golden plans under `test/plan/`
  unchanged — no regeneration needed, as goldens never ANALYZE and the
  all-unknown branch is bit-exact).
- `yarn lint`, root `yarn typecheck`, root `yarn build` all exit 0. The
  `conjunct-cost → nodes/filter` import was confirmed cycle-free by build AND
  by runtime (tests exercise the module-init order).
- `yarn docs:check`: one failure — `docs/sync.md` word-count ratchet — which is
  pre-existing at HEAD, untouched by this ticket, and already tracked in
  `tickets/.pre-existing-known.md` under `debt-doc-size-ratchet-red-at-head`.
  My own additions to `docs/optimizer.md` / `docs/optimizer-rules.md` passed
  their ratchets.

## Known gaps / honest notes for the reviewer

- The integration proof is **plan order + row parity, not a measured
  speedup** — a counting-UDF conjunct is Volatile tier with no column
  statistics, so the win is not observable that way. Said explicitly in the
  test block comment.
- `collectColumnOrigins` now runs **twice** per Filter (stamping rule +
  ordering rule). Tripwire `NOTE:` strengthened at
  `rule-filter-selectivity.ts` (~line 100) with the memoize-on-OptContext fix
  if it ever profiles hot. Not built — nothing measured.
- The guard-idiom tripwire (`v <> 0 and 10 / v > 1` vs a future throwing
  scalar) gained a second route: selectivity can promote a conjunct past a
  same-tier guard. `NOTE:` extended in the rule header and in
  `docs/optimizer.md`; inert today (nothing throws).
- A stats provider that implements `statsOnlySelectivity` but has no analyzed
  tables still pays the origins walk per multi-conjunct Filter (estimates all
  come back undefined). Covered by the same tripwire; the provider-missing
  short-circuit only helps providers that omit the method.
- `weak = 1` on the test table estimates exactly 0.5 — numerically equal to
  the unknown-conjunct neutral. Harmless (the mixed-case test uses an
  unestimable `weak + 0 = 1` instead), but a reviewer eyeballing the fixtures
  should know the coincidence is deliberate.
- The prereq (`bug-filter-row-estimate-lost-when-predicate-rewritten`) still
  shows on the board in `implement/`, but its fix is already present at the
  HEAD this was built on: the `filter-selectivity-restamp` PostOptimization
  registration and its spec tests exist and pass. Built on that ground as the
  workflow rules direct.
