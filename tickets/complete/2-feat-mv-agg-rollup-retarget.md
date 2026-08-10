description: The query optimizer now decides which aggregates it can roll up from a materialized view by reading each aggregate's own declared algebra, instead of a hardcoded list of five aggregate names — so user-defined aggregates that declare the same algebra roll up automatically.
files: packages/quereus/src/planner/analysis/query-rewrite-matcher.ts, packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts, packages/quereus/test/query-rewrite-aggregate.spec.ts, docs/materialized-views.md, docs/mv-maintenance.md
difficulty: medium
----
## What shipped

The read-side aggregate-**rollup** matcher (answering `group by g… agg(…)` from a grouped
MV at a coarser group key by re-aggregating stored partials) no longer name-branches on
`sum`/`count`/`min`/`max`/`avg`. Rollup soundness + the recombine recipe are decided by each
fragment aggregate's declared `AggregateAlgebra` (`merge`/`decode`/`decompose`), resolved
from the function registry by `(name, argc)` via a `resolveAggregate` probe threaded from the
rule (parallel to the existing `DeterminismProbe`; the analysis module still imports no
registry). Removed: the `'sum'|'count'|'min'|'max'|'avg'` recipe-`kind` union, `ROLLUP_SUM_LIKE`,
`primitiveAggsFor`, the `count`→`coalesce(sum,0)` and `avg`→`BinaryOp /` name-branches, and the
now-unused `LiteralNode` / `isScalarFunctionSchema` imports in the rule.

The recipe is now a structural union: `passthrough` (exact-key, name-agnostic), `merge` (one
`MergeReagg` = backing col + resolved schema), `compose` (N `MergeReagg` partials + `combine`).
Re-aggregation is synthesized generically: `merge` folds the stored finalized partials through
the aggregate's own `merge ∘ decode` then `finalize`; `compose` (avg) re-aggregates each
sibling partial that way then applies the declared `combine`. Empty/zero-row groups fall out of
`finalize(identity)` (count→0, sum/min/max→NULL) — no `coalesce` needed.

## Review findings

**Verdict: implementation is correct, clean, and adequately tested. No minor fixes needed
inline; no major tickets filed.** Reviewed the full implement diff (`e048c57e`) with fresh
eyes against SPP/DRY/type-safety/error-handling/hygiene before reading the handoff.

### Correctness (the load-bearing claim) — CONFIRMED

- **The synthetic re-aggregate is honored at emit time.** The retarget's soundness hinges on
  the plan using the synthesized `merge ∘ decode` step, *not* re-resolving the aggregate by
  name from the registry. Verified both aggregate emitters read `funcNode.functionSchema`
  (`runtime/emit/hash-aggregate.ts:147`, `runtime/emit/aggregate.ts:200`) — the synthetic
  schema passed to `AggregateFunctionCallNode`. This is what makes `count` rollup =
  **sum-of-stored-counts**, not count-of-subgroups (which a name re-resolution to registered
  `count` would silently produce). The distinction is exercised by the equivalence suite.
- **`merge`-only-over-finalized-partials is sound.** Rollup merges finalized partials of
  *disjoint subgroups* — all "inserts", no retraction — so algebra law 4's insert-observational
  form suffices; `decodeExact` is correctly *not* required. Default-deny gate (`decode`
  required; DISTINCT / no-algebra / merge-without-decode all decline) is conservative and
  correct.
- **Byte-identity of the five builtins** re-verified against declarations in
  `func/builtins/aggregate.ts`: sum's `decode` count-witness = `Infinity` (absorbing, plain-`+`
  in merge → no `BigInt(Infinity)` throw), count identity decode, min/max BINARY-tighten merge
  matching their steps, avg via `decompose` + `combine` NULL/0 guard. Empty & all-NULL groups
  covered by the equivalence harness (starts at 0 rows).

### Hygiene / DRY — clean

Dead API fully removed; grep confirms no stragglers reference the old `kind`/`backingCols`/
`ROLLUP_SUM_LIKE`/`primitiveAggsFor`. Functions stay small and single-purpose; comments are
accurate and concise. Removed imports match removed code paths.

### Docs — accurate, in the right files

`materialized-views.md` (§ Aggregate rollup) and `mv-maintenance.md` rewritten to the
algebra-driven story; both referenced anchors (`schema.md#aggregate-function-algebra`,
`materialized-views.md#aggregate-rollup-indexed-view-matching`) exist. Implementer's call to
skip `optimizer.md` (no allowlist prose there) is right.

### Tests — pass; new UDAF proof is non-vacuous

- `yarn workspace @quereus/quereus run lint` — **exit 0**.
- Full `packages/quereus` suite — **7131 passing, 13 pending, exit 0**.
- Targeted rewrite + equivalence specs — 29 passing. The new `bit_xor` UDAF end-to-end test
  asserts the plan actually scans the MV backing before comparing rewrite-on vs off — a real
  regression guard for the headline capability.

### Gaps recorded (not filed — sound-but-uncovered / conditional)

- **`compose` path has no *user-defined*-decompose test** (only builtin `avg` exercises it).
  Left as a documented gap rather than a ticket: `resolveMergeablePartial` + `buildRecipeOutput`
  are fully name-agnostic and a decompose's partials always resolve to builtin `sum`/`count`,
  so a UDAF-decompose adds near-zero new code coverage over avg (which already covers both
  partials and the `count(*)`-when-NOT-NULL fallback). No latent-defect risk — the outer
  `algebra.decompose` branch is the same code avg drives.
- **Tripwire — unmemoized synthetic-schema construction.** `buildReaggAggregate` /
  `buildRecipeOutput` call `createAggregateFunction` / `createScalarFunction` on every rule
  fire. Cheap; not hot. If rollup rewriting ever profiles hot, cache by `(schema, backingCol)`.
  (Implementer flagged the same; parked here as the index.)
- **Tripwire — min/max synthetic `reaggSchema.returnType` defaults to REAL** (minFunc omits
  `returnType`, so `createAggregateFunction` defaults it). Cosmetic only: the node's actual
  type uses the correctly-`inferred` value, and `returnType` is unused at runtime. Not a defect.

## How to use / validate

Manual smoke: `create materialized view v as select k, j, sum(x), count(*), avg(x) from t
group by k, j;` then `select k, sum(x), avg(x) from t group by k;` → `query_plan()` shows a
scan of `v` + a re-aggregate. Any UDAF declaring `merge`+`decode` (or `decompose` over such
partials) in the MV body rolls up the same way, no engine change.

## Prereq

`feat-mv-agg-algebra-schema` (landed, `2ccbccf6`) supplied the `AggregateAlgebra` declarations
this consumes. `feat-mv-agg-delta-arm` is the write-side sibling reading the same declarations.
