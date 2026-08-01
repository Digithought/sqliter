description: When a WHERE clause has several AND-ed tests, the engine currently runs the cheapest one first. Also take into account how many rows each test throws away, so a slightly pricier test that rejects almost everything runs ahead of a cheap one that rejects almost nothing.
prereq: bug-filter-row-estimate-lost-when-predicate-rewritten
files: packages/quereus/src/planner/cost/conjunct-cost.ts, packages/quereus/src/planner/stats/conjunct-selectivity.ts, packages/quereus/src/planner/rules/predicate/rule-filter-conjunct-ordering.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/test/where-conjunct-ordering.spec.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, docs/optimizer.md, docs/optimizer-rules.md
difficulty: hard
----

## Where things stand today

`rule-filter-conjunct-ordering` (PostOptimization, registered last) sorts a
`FilterNode`'s top-level AND conjuncts so the emitter's early exit
(`runtime/emit/filter.ts`) skips expensive conjuncts for rows a cheaper one already
rejected. Its sort key is `compareConjunctCost` from `planner/cost/conjunct-cost.ts`:

```
(ConjunctCostTier, subtreeCost)   ascending, lexicographic
  Pure(0) < Volatile(1) < Subquery(2),  then getTotalCost() within the tier
```

The tier is coarse and structural on purpose. `docs/optimizer.md` § *Conjunct cost
tiers* records the measurement behind it: a tableless scalar subquery
(`(select f())`, ≈0.051) has a *lower* `getTotalCost()` than a three-term arithmetic
expression (≈0.053), because node-count-derived cost does not model "opens a whole
sub-program per row". So raw cost is **not** comparable across tiers; it is only
trusted as the within-tier tiebreak.

Separately, `rule-filter-selectivity` already estimates conjuncts one at a time — but
only on its multi-relation path, and it immediately folds the results into one
combined number via `combineConjunctive`. Nothing per-conjunct survives onto the node.

## What to build

Two changes, one behavioural decision each.

### 1. A shared per-conjunct estimator (mechanical extraction)

Move the per-conjunct estimation machinery out of
`rules/predicate/rule-filter-selectivity.ts` into a new module
`planner/stats/conjunct-selectivity.ts`, so the ordering rule and the selectivity
rule share one implementation instead of two drifting copies.

Functions to move verbatim (they are already self-contained — they take `origins`
and `context`, not a `FilterNode`):

| moved from `rule-filter-selectivity.ts` | note |
|---|---|
| `estimateConjunct` | export as **`estimateConjunctSelectivity`** |
| `conjunctRelations` | private to the new module |
| `singleRelationConjunct` | private |
| `crossRelationConjunct` | private |
| `equiJoinSelectivity` | private |
| `hasColumnStats` | private |
| `makeResolver` | export as **`makeColumnStatsResolver`** — the single-table stamping path still needs it |
| `CROSS_RELATION_INEQUALITY_SELECTIVITY` | move, and **re-export from `rule-filter-selectivity.ts`** so `test/optimizer/filter-selectivity.spec.ts:19` keeps importing it from its current path |

`rule-filter-selectivity.ts` then imports both exports and keeps `ruleFilterSelectivity`,
`singleTableSelectivity`, `multiRelationSelectivity`, `countRelations`. **No behaviour
change from this step** — the numbers it stamps must be bit-identical before and after.

Do **not** re-export the new module from `planner/stats/index.ts`. `framework/context.ts`
imports `stats/index.ts`, and the new module type-imports `OptContext`; keeping it out of
the barrel keeps that edge one-way. Say so in the module doc-comment, mirroring the same
note on `cost/conjunct-cost.ts`.

### 2. Selectivity as the within-tier sort key

**Decision: the tier stays the primary key. Selectivity replaces raw cost as the
*within-tier* key only.**

Rationale, so nobody re-litigates it during implementation: the textbook rank is
`(fraction rejected) / (cost to run)`, applied globally. That requires a cost
denominator comparable across all conjuncts — which is exactly what the tier exists to
say quereus does **not** have. Promoting a `Subquery`-tier conjunct ahead of a `Pure`
one because statistics say it rejects 95% would bet a *measured* selectivity against an
*unmeasured* per-row sub-program cost. Within a tier the conjuncts are the same
structural class, so `getTotalCost()` is comparable there and the ratio is meaningful.
The ticket's motivating example (a cheap-but-weak test vs a pricier-but-strong test)
is a within-tier case — both are `Pure` — so this covers it.

New sort key:

```
primary    tier                        ascending  (unchanged)
secondary  (1 - selectivity) / cost    DESCENDING (most filtering bought per unit work)
tertiary   subtreeCost                 ascending  (ratio ties prefer the cheaper conjunct)
                                                  (ties → 0; stable sort keeps source order)
```

where `cost = Math.max(subtreeCost, MIN_CONJUNCT_COST)`. `MIN_CONJUNCT_COST = 1e-9` is a
divide-by-zero guard only — `PlanNode.estimatedCost` defaults to 0.01 and
`ColumnReferenceNode`/`LiteralNode` use 1, so no real conjunct has zero subtree cost.
The floor must never produce `Infinity` or `NaN`.

Clamp each provider-returned selectivity to `[0, 1]` before computing the benefit, the
same way `ruleFilterSelectivity` already clamps its combined value.

Compare ratios with explicit `!==` before subtracting, and fall through to the tertiary
key rather than returning a raw difference — a difference below one ULP must not collapse
two distinct keys into a tie.

## The two behavioural decisions on unknown selectivity

**The all-unknown case is an explicit branch, not a limit argument.** If *no* conjunct
in the filter got a known estimate, the rule sorts with `compareConjunctCost` verbatim —
the existing comparator, untouched. This is the regression guard the source ticket asks
for, and making it a branch means the guarantee is bit-exact rather than resting on a
floating-point monotonicity argument.

**In the mixed case, an unknown conjunct is assigned `UNKNOWN_CONJUNCT_SELECTIVITY`,
which is `DEFAULT_FILTER_SELECTIVITY` (0.5).** Reuse the existing constant from
`nodes/filter.ts` rather than declaring a second 0.5 — it is already the engine's one
"nobody knows" fraction, used by `FilterNode.estimatedRows` when nothing is stamped.
A conjunct the statistics say is *stronger* than neutral (s < 0.5) sorts ahead of
unknowns; a *weaker* one (s > 0.5) sorts behind. "No information" is the neutral
position, not the best or worst one.

This also means unknowns keep their relative order among themselves: with the benefit
term constant across a group, descending `benefit / cost` is exactly ascending `cost`.
That is why a mix cannot come out worse-ordered than cost alone — but do not rely on it
for the all-unknown guarantee; that is what the branch above is for.

**Import-cycle check for the constant.** `cost/conjunct-cost.ts` importing
`DEFAULT_FILTER_SELECTIVITY` from `nodes/filter.ts` gives
`conjunct-cost → nodes/filter → cost/index`. `cost/index.ts` imports only
`common/errors` and `common/types`, and nothing under `analysis/` or `util/` imports
`cost/conjunct-cost.ts`, so this is a DAG. Verify with the build rather than assuming;
if it does bite, put the rank comparator in the rule file (which already imports
`nodes/filter.js`) instead of duplicating the literal.

## The gate: `statsOnlySelectivity`, on both paths

The ordering rule must use `context.stats.statsOnlySelectivity` — never `selectivity`.
`selectivity` always answers, substituting `NaiveStatsProvider`'s fabricated flat guess
(0.1 for any BinaryOp, 0.3 for any UnaryOp). Those numbers differ *by node kind*, so
feeding them to a ratio would reorder conjuncts on no information at all, churning plans
across every query in the suite that never runs `ANALYZE`. `statsOnlySelectivity`
returning undefined is the honest "unknown" that the branch above handles.

**This is what "extend the single-table path" amounts to, and it needs no new code
path.** `estimateConjunctSelectivity` works off `collectColumnOrigins(filter.source)`,
which populates for a one-table source exactly as for a join — `conjunctRelations` just
finds one relation instead of two. So the ordering rule calls the same estimator
regardless of how many tables sit under the Filter, and a single-table filter gets
per-conjunct estimates for free.

Note the deliberate asymmetry this leaves in place: `rule-filter-selectivity`'s
*single-table stamping* path still calls `selectivity` (naive fallback allowed) and
still hands the provider the whole predicate at once. **Do not change it.** Its output
is `filter.selectivity`, which feeds `estimatedRows` and every physical cost reader;
switching it to gated per-conjunct estimates would move row estimates across the whole
test suite for reasons unrelated to this ticket.

## Rule structure

Order the work inside `ruleFilterConjunctOrdering` so the new cost is only paid when it
can pay off:

```
nodeType !== Filter                          → null
splitConjuncts(...).length < 2               → null
any conjunct subtree has side effects        → null      (existing refusal, keep first)
context.stats.statsOnlySelectivity == null   → cost-only order, no origins walk
                                             ↓
collectColumnOrigins(filter.source)          ← only now
estimate each conjunct
no conjunct estimable                        → cost-only order (compareConjunctCost)
                                             ↓
rank by (tier, ratio desc, cost) and sort (stable)
already in that order                        → null      (the fixed point — keep it)
else                                         → new FilterNode(..., filter.selectivity)
```

The output construction is unchanged: build the `FilterNode` directly, carrying
`filter.selectivity` across, because reordering does not change the conjunct *set*.

`collectColumnOrigins` now runs a second time per Filter (the selectivity rule already
runs it once). Strengthen the existing `NOTE:` tripwire in `rule-filter-selectivity.ts`
(around line 101) to say the walk now happens twice per Filter, and that the fix if it
ever surfaces in an optimizer profile is to memoize the map per pass on `OptContext`
keyed by the source node. Do not build that cache now — nothing has measured a need.

## Test-spec migration (will break the build if missed)

`test/where-conjunct-ordering.spec.ts:46` currently reads:

```ts
// The rule never reads its context (it works off the node alone); a dummy is
// fine for direct invocation.
const DUMMY_CONTEXT = undefined as unknown as OptContext;
```

That comment stops being true. Every direct-invocation test in that file will throw on
`context.stats`. Replace `DUMMY_CONTEXT` with a real context —
`createOptContext(db.optimizer, new CatalogStatsProvider(), db.optimizer.tuning, db)`
built in `beforeEach` — and rewrite the comment. Tables in that spec are never
`ANALYZE`d, so every conjunct reads as unknown and the existing assertions must keep
passing unchanged; that is itself the strongest regression guard in the suite.

## Edge cases & interactions

Boundary values

- Every conjunct unknown → order byte-identical to today (explicit branch, not a limit).
- Exactly one conjunct known, rest unknown → known one placed relative to the 0.5 neutral.
- Selectivity exactly `1.0` → benefit 0 → ratio 0 → sorts last within its tier. Correct: it rejects nothing.
- Selectivity exactly `0.0` → benefit 1 → maximal ratio.
- Provider returns a value outside `[0, 1]` → clamped before use; no negative benefit.
- `subtreeCost` of 0 → floored; must not yield `Infinity`/`NaN`.
- Identical `(tier, ratio, cost)` on two conjuncts → comparator returns 0, stable sort keeps source order.

Cross-tier immunity

- A strongly-selective `Subquery`-tier conjunct must **not** jump ahead of a weakly-selective `Pure` one. Pin this directly — it is the decision most likely to be "improved" away later.

Sources with no usable origins (all must fall back to cost-only, none may throw)

- `HAVING` over an aggregate — group-key attributes forward through, but `count(*) >= 4` references an aggregate output with no origin. The existing `07.7.4` sqllogic HAVING rows must not move.
- Filter over a set operation, a recursive CTE, or an `AsyncGatherNode` with the `unionAll` combinator — `collectColumnOrigins` stops at row-merging nodes.
- Filter over a `values` clause or a computed projection.
- A `StatsProvider` that does not implement `statsOnlySelectivity` → skip the origins walk entirely.

Multi-relation attribution (inherited from the shared estimator; assert it survives the move)

- Self-join `from t a join t b` — relation-instance identity must keep the two sides separate.
- CTE self-join — `CTEReferenceNode` mints per-reference relation instances.
- A conjunct spanning three or more relations → unknown.

Correlated subqueries — a known, bounded imprecision

`conjunctRelations` walks relational children, so a **correlated** subquery conjunct
(`exists (select … where i.oid = o.id)`) can resolve an outer attribute id and come back
with a base-column estimate that describes the *outer* column rather than the subquery's
result. This is pre-existing in the stamping path. It is bounded here because the tier is
primary: such a conjunct is `Subquery` tier, so a bogus estimate can only reorder it
against *other* `Subquery`-tier conjuncts, never lift it ahead of a `Pure` one. Add a test
that pins that containment, and a `NOTE:` at the estimator recording it.

Rule-framework interactions

- **Fixed point.** The key now depends on `context.stats`, which is stable within one `optimize()`. Running the rule on its own output must still return null — pin it, including in the mixed known/unknown case.
- **Stamp preservation.** `filter.selectivity` must survive the reorder unchanged, so `estimatedRows` does not move.
- **Row-set parity.** Guaranteed by construction (AND commutes under three-valued logic; a Filter rejects `false` and `NULL` alike), but keep it pinned end-to-end.
- **`fuzz.spec.ts`** already toggles `filter-conjunct-ordering` in `PREDICATE_RULES` for optimizer-equivalence differential testing; it must stay green.
- The existing `NOTE: (tripwire)` at the top of `rule-filter-conjunct-ordering.ts` — about a guard idiom (`v <> 0 and 10 / v > 1`) becoming unsafe if a scalar function that *throws* ever ships — is now reachable through a second route: selectivity can promote a conjunct past its guard even within a tier. Extend that note; do not file it as a ticket (nothing throws today).

## Tests

Unit — `test/where-conjunct-ordering.spec.ts`

- The `DUMMY_CONTEXT` migration above; all existing assertions unchanged and passing.
- `compareConjunctRank` directly: strong-but-pricier beats weak-but-cheaper within a tier; all-unknown reproduces `compareConjunctCost` order exactly; cross-tier immunity; the 1.0 / 0.0 / out-of-range / zero-cost boundaries; the stable tie.
- Rule mechanics: fires and then reaches its fixed point in the mixed case; still returns null on single-conjunct, on a non-AND (OR) predicate, and on a side-effecting subtree.

Integration — new block, `ANALYZE`d tables

Build a table where two `Pure` conjuncts have knowably different selectivity and the
*more selective one is more expensive*, so cost-alone and cost+selectivity disagree.
Assert on the reordered predicate's detail string (`FilterNode.toString()`, as the
existing `reorders a raw expensive-first filter` test does) plus row-set parity for both
written orders.

Be honest about what is *not* observable here: the counting-UDF technique used elsewhere
in the file cannot demonstrate the win, because a UDF conjunct is `Volatile` tier and has
no column statistics. Plan order plus row parity is the available proof — say so in the
block's comment rather than implying a measured speedup.

Also add a negative control asserting that the *same* query against a table that was
never `ANALYZE`d keeps the cost-only order.

Regression — `test/optimizer/filter-selectivity.spec.ts`

Every stamped number in this file must be unchanged after the extraction. That file is
the proof the refactor was behaviour-preserving; if any assertion moves, the extraction
was not verbatim.

sqllogic — `test/logic/07.7.4-where-conjunct-ordering.sqllogic`

Add a selectivity-driven pair (both written orders, same rows) only if the sqllogic
runner accepts `analyze <table>;` as a statement. Check first; if it does not, keep that
coverage in the `.spec.ts` and note why in the sqllogic header rather than adding a
half-working case.

## Docs

- `docs/optimizer.md` § *Conjunct cost tiers* (~line 254) — describe the new within-tier ratio key, why the tier stays primary, the whole-filter unknown branch, and the 0.5 neutral. Extend the guard-idiom paragraph that follows.
- `docs/optimizer.md` § *Filters over a join* (~line 359) — note that per-conjunct estimation now lives in `planner/stats/conjunct-selectivity.ts` and is shared with the ordering rule, and that the ordering rule gates on `statsOnlySelectivity` on both single-table and multi-relation sources while the single-table *stamping* path deliberately still does not.
- `docs/optimizer-rules.md` line 54, the `ruleFilterConjunctOrdering` catalogue entry — update the one-line key description.
- Run `yarn docs:check`.

## Not in scope

- Memoizing `collectColumnOrigins` on `OptContext` (tripwire only — nothing measured).
- Changing what `rule-filter-selectivity` *stamps*, on either path.
- Multi-column / correlation statistics (backlog `feat-multi-column-correlation-stats`).
- Pairing conjuncts on the same column into a range (`a > 1 and a < 10`) — a known over-selectivity already recorded in `docs/optimizer.md`.

## TODO

Phase 1 — extract, no behaviour change

- Create `packages/quereus/src/planner/stats/conjunct-selectivity.ts` and move the seven functions plus `CROSS_RELATION_INEQUALITY_SELECTIVITY` per the table above; export `estimateConjunctSelectivity` and `makeColumnStatsResolver`.
- Write the module doc-comment, including the "not re-exported from `stats/index.ts`" rationale and the correlated-subquery `NOTE:`.
- Rewire `rule-filter-selectivity.ts` to import them; re-export `CROSS_RELATION_INEQUALITY_SELECTIVITY` from its old path.
- Strengthen the `NOTE:` tripwire about the doubled `collectColumnOrigins` walk.
- Run `test/optimizer/filter-selectivity.spec.ts` and confirm every stamped number is unchanged before starting phase 2.

Phase 2 — the ranking

- Add `UNKNOWN_CONJUNCT_SELECTIVITY` (= `DEFAULT_FILTER_SELECTIVITY`), `MIN_CONJUNCT_COST`, a `ConjunctRank` type and `compareConjunctRank` to `cost/conjunct-cost.ts`; keep `compareConjunctCost` exported and unchanged.
- Confirm the `nodes/filter.ts` import introduces no cycle (build, not inspection).
- Rewrite `ruleFilterConjunctOrdering` per the rule-structure sketch: side-effect refusal first, provider gate, lazy origins walk, all-unknown branch to `compareConjunctCost`, rank sort, fixed-point check, direct `FilterNode` construction carrying `filter.selectivity`.
- Extend the file's `NOTE: (tripwire)` for the second route past a guard idiom.

Phase 3 — tests and docs

- Migrate `DUMMY_CONTEXT` in `test/where-conjunct-ordering.spec.ts` to a real `OptContext`.
- Add the unit, integration, negative-control and edge-case tests listed above.
- Check whether sqllogic accepts `analyze`; extend `07.7.4` if so.
- Update `docs/optimizer.md` (two sections) and `docs/optimizer-rules.md`.

Validate

- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- `yarn lint`, `yarn typecheck`, `yarn docs:check`
- Golden plan JSON under `test/plan/` embeds `estimatedRows` and predicate detail strings. `filter.selectivity` is carried across unchanged so `estimatedRows` should not move; conjunct *order* in a detail string may. Inspect any golden that moves and confirm the new order is the intended selectivity-driven one before regenerating — do not regenerate blindly.
