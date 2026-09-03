description: Removed a second, contradictory decision-maker for whether a `with …` query's rows get buffered in memory, so there is now exactly one place that decides.
files:
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts       # deleted
  - packages/quereus/src/planner/optimizer.ts                              # import + registration removed; ordering comments rewritten
  - packages/quereus/src/planner/framework/pass.ts                         # ordering comment rewritten
  - packages/quereus/src/planner/cache/materialization-advisory.ts         # unchanged — now the sole owner (Rule 5a)
  - packages/quereus/src/planner/util/row-estimates.ts                     # NOTE trimmed
  - packages/quereus/src/planner/optimizer-tuning.ts                       # `cte.maxSizeForCaching` / `cte.cacheThresholdMultiplier` removed (dead once the rule was gone; `cte.maxCacheThreshold` stays — still read by rule-scalar-subquery-cache.ts)
  - packages/quereus/test/optimizer/side-effect-audit.spec.ts             # NO_SIGNAL_ALLOWLIST emptied; one test's fixture decoupled from it (see below)
  - packages/quereus/test/fuzz.spec.ts                                    # CACHE_RULES entry removed
  - packages/quereus/test/logic/49-reference-graph.sqllogic               # Test 9 expectation flipped 1 → 0 (see below)
  - packages/quereus/test/plan/cte-materialization.spec.ts                # new plan-shape test added
  - docs/optimizer.md, docs/optimizer-rules.md, docs/optimizer-parallel.md, docs/optimizer-costing.md, docs/runtime-caching.md, docs/invariants.md
difficulty: easy
----

# CTE materialization has one owner: MaterializationAdvisory

## What changed

`ruleCteOptimization` (`planner/rules/cache/rule-cte-optimization.ts`) is deleted, along
with its import and `PostOptimization` registration in `optimizer.ts`. `MaterializationAdvisory`
(`planner/cache/materialization-advisory.ts`) is now the only code that decides whether a
CTE's rows get buffered — it always was the more correct of the two, and it needed no code
changes: its Rule 5a already refuses to wrap a CTE/RecursiveCTE in a `CacheNode`, deferring
to the `materialize` mark it sets during the same pass.

The deleted rule wrapped a CTE's **source** in a `CacheNode`, gated on
`sourceSize > 0 && sourceSize < maxSizeForCaching`. That gate read a row estimate of `0` as
"empty" when it actually means "unknown, table never analyzed" — so caching silently turned
on whether `ANALYZE` had run, not on anything about the query. It also ignored the CTE's
reference count entirely, so a real (non-zero) estimate would cache **every** CTE in range,
including single-reference ones that must be inlined — and for a multi-reference CTE it
double-buffered against the advisory's own `materialize` mark (redundant, not wrong, per the
rule's own comment).

## Why nothing is lost

| case | MaterializationAdvisory (kept) | ruleCteOptimization (removed) |
|---|---|---|
| `materialized` hint | marks `materialize` → one buffer via `emitCTE` | added a second, redundant `CacheNode` buffer |
| 2+ references | marks `materialize` → one buffer | added a second, redundant `CacheNode` buffer |
| 1 reference | inlines (correct) | cached once a real row estimate existed (wrong — contradicted two existing specs, which only passed because the estimate happened to be 0) |

A data-modifying CTE body (`with d as (delete from t returning *) select …`) is marked
`materialize: true` at **build** time (`planner/building/with.ts`), before either pass runs,
and neither pass's removal touches that path — its write still runs exactly once per
statement execution.

## Edge cases checked

- **Recursive CTEs never went through the deleted rule.** Its registration was scoped to
  `nodeType: PlanNodeType.CTE`, and `RecursiveCTENode` doesn't implement `isCTECapable`
  (only `CTENode` does — `cte-node.ts:41`) — so `CapabilityDetectors.isCTE` was always false
  for it. The rule was a no-op on the recursive path from day one; deleting it changes
  nothing there. All recursive-CTE specs in `test/plan/cte-materialization.spec.ts` still
  pass unchanged.
- **The nested-loop right-cache golden plan** (`test/plan/joins/theta-nlj-right-cache.plan.json`)
  is untouched — it comes from a different rule (`rule-nested-loop-right-cache`) and the
  golden-plan sweep is green.
- **`isAlreadyCached` guard** — deleted along with the rule; nothing else referenced it, and
  the full suite (including the scalar-subquery-cache and nested-loop-right-cache tests,
  which independently exercise "don't double-wrap an already-cached source") is green.
- **`materialized`-hinted single-reference CTE** — added a plan-shape test (see below)
  confirming it's buffered once via the `materialize` mark, no `CacheNode`.
- **Data-modifying CTE referenced twice** — already had thorough coverage that predates
  this ticket (`test/logic/13.6-cte-dml-runs-once.sqllogic`, `test/runtime/cte-dml-once.spec.ts`),
  covering INSERT/UPDATE/DELETE bodies, both hints, 2 and 3 references, views, rollback, and
  cross-execution reset. I did not duplicate it — just confirmed it still passes.

## A pre-existing golden expectation was wrong and is now fixed

`test/logic/49-reference-graph.sqllogic` Test 9 asserted that a `MATERIALIZED`-hinted
single-reference CTE produces exactly one `CACHE` plan node — that was pinning the
*deleted* rule's redundant wrap. It now asserts zero `CACHE` nodes (the CTE is still
buffered, just via `CTENode.materialize` / `emitCTE`, not a `CacheNode`). This is the one
existing test the ticket didn't anticipate; everything else it named passed as expected once
the rule was gone.

## A collateral test fixture had to be decoupled from the (now-empty) allowlist

`test/optimizer/side-effect-audit.spec.ts` had one test —
`'does not let the allowlist excuse a rule the audit could not read'` — that picked its
fixture rule id from `[...NO_SIGNAL_ALLOWLIST.keys()][0]`. With the allowlist now empty (its
only entry was `cte-optimization`), that produced `undefined` and broke the fixture.
Rewrote it to build its own local fixture `Map` and pass it explicitly to `isExcused(u, allowlist)`
(now takes an optional allowlist parameter, defaulting to the production one) — the test no
longer depends on production `NO_SIGNAL_ALLOWLIST` having any entries, which is a more
robust test regardless of this ticket.

## Also removed: two now-dead tuning knobs

`OptimizerTuning.cte.maxSizeForCaching` and `OptimizerTuning.cte.cacheThresholdMultiplier`
had no consumer left once the rule was deleted (verified by grep across `src/` and `test/`).
`OptimizerTuning.cte.maxCacheThreshold` stays — it's still read by
`rule-scalar-subquery-cache.ts` (an unrelated, pre-existing reuse of the `cte` tuning
namespace's name; left as-is with a comment rather than renamed, to avoid rippling into
`test/vtab/in-subquery-cache-scan-count.spec.ts` and
`test/vtab/scalar-subquery-cache-scan-count.spec.ts`, which override it by that name).

## What a reviewer should sanity-check

- The two rule-ordering comment rewrites in `optimizer.ts` (~1210, ~1301 in the original)
  and `pass.ts` (~144) — I reworded them to point at `rule-nested-loop-right-cache` as the
  representative earlier-PostOptimization `CacheNode` source instead of the deleted rule;
  worth a second read for accuracy since I couldn't find an automated check for
  prose-comment correctness.
- The `optimizer-tuning.ts` cleanup (dead knobs) is slightly outside the ticket's named
  `files:` list — small and mechanical, but flag if the team would rather that landed as
  its own ticket.
- I did not touch `docs/optimizer-costing.md`'s framing of "0 means unknown, not empty" —
  it dropped its `rule-cte-optimization`-specific example sentence but keeps the general
  point, which is still accurate and still relevant to the row-estimate repair queued behind
  this ticket (`tickets/implement/5.1`–`5.5-*`).

## Validation

- `yarn build` — clean (full monorepo, including bundled apps).
- `yarn workspace @quereus/quereus run test` — 10298 passing, 25 pending, 0 failing.
- `yarn lint` (fans out to every workspace) — clean.
- `test/optimizer/plan-shape-decisions.spec.ts` and `test/plan/cte-materialization.spec.ts`
  pass, and now for the right reason: single-reference inlining is driven by the advisory's
  reference-count check, not by a row estimate that happened to read as zero.
