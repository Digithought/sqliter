description: The query planner works out how many rows a WHERE clause will keep, but a late planning step could throw that number away again. A final re-derivation step now runs at the end of planning so the number always survives.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/rules/predicate/rule-filter-selectivity.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/optimizer/filter-selectivity.spec.ts, packages/quereus/test/optimizer/rule-manifest.spec.ts, docs/optimizer.md, docs/optimizer-rules.md, docs/progressive-optimizer.md
difficulty: medium
----

## What shipped

A new optimization pass, `PassId.FinalEstimates` ('final-estimates', order 37,
bottom-up), sits between the Materialization advisory (35) and Validation (40).
`rule-filter-selectivity` is registered into it a third time as
`filter-selectivity-final`.

```
ConstantFolding 0 → Structural 10 → Physical 20 → PostOptimization 30
                 → Materialization 35 → FinalEstimates 37 → Validation 40
```

Why it was needed: `FilterNode.withChildren` carries the stamped `selectivity`
forward only when the predicate child is the *same object*, so any pass that rewrites
something inside a predicate erases the estimate and `estimatedRows` falls back to the
flat `DEFAULT_FILTER_SELECTIVITY` (0.5). The Materialization advisory runs after both
existing registrations and rebuilds every path on which it marks a `with` clause for
shared materialization or injects a `CacheNode` — when that path runs through a
Filter's predicate, nothing was left to restore the number. The new pass is the
re-derivation point behind every plan-mutating pass, so an estimate's survival no
longer depends on which pass happens to touch a predicate last.

Code changes, all small:

- `framework/pass.ts` — `PassId.FinalEstimates` + its `createPass(…, 37, BottomUp)`
  entry in `STANDARD_PASSES`, with a header comment stating the "nothing plan-mutating
  registers behind this" contract.
- `optimizer.ts` — `filter-selectivity-final` manifest entry (last in the manifest);
  the old `KNOWN GAP:` paragraph on `filter-selectivity-restamp` replaced with a
  pointer to it; `RULE_MANIFEST` **newly exported** so the static guard test can read
  it (no production consumer other than the optimizer).
- `rules/predicate/rule-filter-selectivity.ts` — header comment rewritten for three
  registrations, saying what each recovers and (new) why the PostOptimization one is
  not redundant with the final one: cost readers later in that same pass consult the
  stamp, whereas the final stamp is read only at emission. The `NOTE:` walk-count
  correction (third → third and fourth).
- `nodes/filter.ts` — `withChildren` comment now names the final pass as what makes
  dropping the stamp safe regardless of which pass re-mints.

No behaviour changed other than filters that used to reach emission unstamped.

## Use cases / how to see it work

Fixture is the existing `multi-relation filter selectivity` block in
`test/optimizer/filter-selectivity.spec.ts`: table `o`, 100 rows, `ANALYZE`d;
`o.qty` has 3 distinct values, `o.rid` has 20.

| query | before | after |
| --- | --- | --- |
| `with c as (…) select * from o where o.qty = (select max(qty) from c) and o.cat = 'a'` | `0.3333…` | `0.3333…` |
| same, but `with c as materialized (…)` | **`undefined`** | `0.3333…` |
| `with c as (…) select * from o where o.qty = (select max(qty) from c) and o.rid = (select min(qty) from c) and o.cat = 'a'` | **`undefined`** | `0.028867…` |

Row 2 is the headline: the `MATERIALIZED` hint changes how the CTE executes, never
what the predicate is estimated at, so the two spellings must agree exactly. Row 3
needs no hint — two references to one `with` clause trip the same shared-materialization
mark. Its value is `combineConjunctive([1/3, 1/20])` = `0.05 · √(1/3)`.

To see the numbers by hand: dump every `FilterNode.selectivity` out of
`db.getPlan(sql)`; the upper Filter is the one whose predicate carries the scalar
subquery (`o.cat = 'a'` is left in a separate Filter below).

## Tests

`test/optimizer/filter-selectivity.spec.ts`, in the multi-relation describe block:

- **positive** — "stamps the same estimate whether or not the CTE is MATERIALIZED".
  Asserts the plain spelling is `1/ndv(o.qty)` and that the materialized spelling
  `.equal`s it exactly (not `closeTo` — the point is they must not disagree at all).
- **positive** — "stamps the upper Filter over a CTE referenced twice". Asserts
  `combineConjunctive([1/ndv(o.qty), 1/ndv(o.rid)])`, plus that the value is strictly
  below `1/ndv(o.qty)` so a regression that dropped one conjunct would show.
- **negative control for the NEW registration alone** — "leaves the
  materialization-marked spellings unstamped when only the final re-stamp is disabled".
  Disables only `filter-selectivity-final`: the plain spelling is still stamped (the
  PostOptimization re-stamp covers it) while both materialization-marked spellings go
  `undefined`. This is what pins the new behaviour to the new mechanism.
- **fixed pre-existing negative control** — "leaves that same Filter unstamped when the
  re-stamp registrations are disabled" (was "…the re-stamp registration is disabled").
  It disabled only `filter-selectivity-restamp`; the new registration then filled the
  stamp back in and it failed with `expected 0.25 to be undefined`. It now disables
  both, with a comment saying why.

`test/optimizer/rule-manifest.spec.ts` — new describe block, the static guard:
no `RULE_MANIFEST` entry may target a pass ordered after `PassId.FinalEstimates`, with
a failure message explaining the hole and telling the author to move the rule or add a
re-derivation point deliberately. A companion case asserts every manifest entry targets
a pass that exists in `STANDARD_PASSES`, so the ordering comparison can't silently
classify an unknown pass as "not behind".

Ticket-named regressions confirmed still passing unchanged: "reads a base column
through every CTE spelling that only varies the column list" (includes the
`MATERIALIZED` / `NOT MATERIALIZED` hints) and "re-stamps a filter-over-join whose
predicate was re-minted by scalar-subquery-cache".

## Validation run

- `yarn test` — green. `packages/quereus` 8390 passing / 13 pending (pre-existing
  skips, untouched); every other workspace green; no failures anywhere in the log.
- `yarn lint` — clean.
- `test/optimizer/**` alone: 1631 passing, 0 failing, ~6s (was ~5–6s before; the extra
  traversal is not visible at this granularity).

## Known gaps — please probe these

- **The static guard is manifest-only, so it is blind to a custom-`execute` pass.**
  `PassId.Materialization` — the pass that caused this bug — has zero manifest entries;
  it mutates the plan from its own `execute`. If someone adds another such pass ordered
  after 37, the guard still passes while the hole re-opens. Recorded as a `NOTE:` at
  the test's describe block with the extension to make (also assert on
  `STANDARD_PASSES` entries carrying an `execute`). Left as a tripwire rather than
  built, because there is exactly one custom-execute pass today and it is ordered
  before 37.
- **Cost is reasoned, not profiled.** One extra bottom-up traversal of the plan per
  `optimize()`, on top of the six already run. The rule returns `null` in O(1) on any
  Filter whose stamp survived, so added estimator work is bounded by the Filters still
  unstamped after PostOptimization — the ones that were about to be planned on 0.5,
  plus the permanently-unstampable ones, which now pay a fourth `collectColumnOrigins`
  walk. That fourth walk is a real regression for un-analyzed / computed-projection
  filters; measured only as "not visible in a 6s suite", never profiled. The existing
  `NOTE:` in `rule-filter-selectivity.ts` (memoize the origin map per pass on
  `OptContext`) is where that would be fixed if it ever matters.
- **Only `FilterNode.selectivity` is re-derived there.** The pass is named for its
  general purpose, but it holds one rule. If another node type grows a
  context-derived cached estimate, it needs its own registration here — nothing
  enforces that.
- **The pre-existing tripwire in `filter.ts` is unchanged and still live**: a carried
  selectivity was computed against *that* source's table, so if a pass ever re-sources a
  stamped Filter (same predicate object, different source) the carried estimate goes
  stale and no re-stamp fires (all three registrations decline on an already-stamped
  Filter). The `NOTE (tripwire)` at `nodes/filter.ts` says to also drop the stamp on
  `newSource !== this.source` if that shape appears. The new pass does **not** close it.
- **`RULE_MANIFEST` is now exported** solely for the test. If that widening is
  unwelcome, the alternative is exposing `Optimizer.passManager` or asserting against
  the shared-mutable `STANDARD_PASSES` after constructing a `Database` — both worse in
  my judgement, but it is a judgement call worth a second look.
- **Test-value provenance.** The expected numbers are written as compositions
  (`1/ndv[…]`, `combineConjunctive([…])`) read off the fixture's own `ANALYZE` output,
  not as pinned literals — deliberate, but it means a bug inside `combineConjunctive`
  would not be caught by these cases.

## Adjacent, deliberately untouched

`tickets/backlog/debt-optimizer-rule-order-constraints` (declarative `after:`/`before:`
edges on manifest entries) touches the same two files. Different root cause, still
backlog; left alone. If it lands, the static guard here becomes a special case of it.
