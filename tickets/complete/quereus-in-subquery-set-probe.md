description: `col IN (SELECT ...)` used to go quadratic (minutes) once the subquery returned more than ~1000 rows; it now builds the subquery result into a lookup set once per query and probes it per row, so it scales linearly.
files: packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts, packages/quereus/test/vtab/in-subquery-cache-scan-count.spec.ts, packages/quereus/test/optimizer/cache-rules.spec.ts, packages/quereus/test/prepared-statement-amortization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test/fuzz.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, packages/quereus/test/logic/07.7-in-subquery-caching.sqllogic, docs/runtime-caching.md, docs/optimizer-rules.md, docs/optimizer.md, docs/runtime.md, docs/invariants.md, docs/architecture.md
----

## Summary

Uncorrelated `x IN (subquery)` now materializes the subquery result once per
statement execution into a `BTree` lookup set and probes it per outer row
(O(K + N·log K)), replacing the retired `rule-in-subquery-cache` whose eager
row cache abandoned under a threshold and re-drove the subquery per outer row
(the O(N×K) cliff: 141 ms → 22.3 s → 320 s as the inner set grew past ~1000).
Correlated / non-deterministic sources keep the per-outer-row streaming path.
Implementation landed in commit 66d6d93d; see that commit and the source files
above for details.

## Review findings

Adversarial pass over the implement diff (commit 66d6d93d). Read the diff first,
then the handoff. Verdict: **implementation is sound; one minor comment fix
applied inline; no major findings; no new tickets required.**

### Checked — correctness

- **Gate predicate** `!isCorrelatedSubquery(source) && isFunctional(source)`.
  Confirmed `isCorrelatedSubquery` recurses the full subtree and keys only on
  `ColumnReference` attribute IDs (so a `?` ParameterReference is correctly *not*
  correlation — the parameterized-but-uncorrelated case takes the set-probe path).
  `isFunctional = isDeterministic && isReadOnly`, both optimistic-default
  (`!== false`), and the impure (`subtreeHasSideEffects`) branch is checked first,
  so DML sources never reach the set probe. Sound.
- **Once-per-execution memo.** Set lives on `RuntimeContext.inSetProbes`, keyed by
  a symbol minted in the emit closure — same reset-per-execution pattern as
  `cacheStates` / `executionMemo`. A partial (mid-drain) build is *not* cached
  (the `.set()` runs only after the drain loop completes), so an interrupted build
  re-tries rather than caching a half-set. Correct.
- **Three-valued membership** (hit→true, miss→NULL if inner had NULL else false,
  condition-NULL→NULL without forcing the build) matches the streaming and
  value-list paths exactly. NOT IN, empty inner, inner-NULL, and projection-position
  cases are covered in sqllogic and produce the same results as the streaming path.
- **Load-bearing source-emitter laziness.** Verified: `scan.ts` `run` is an
  `async function*`, so a non-build evaluation creates-but-never-iterates the source
  generator → no extra `connect()`/`query()`. Pinned by the rewritten scan-count
  spec (scan == 1 across match-heavy, leading-NULL, low-threshold, and prepared-
  re-run cases). Correctly recorded as a tripwire at the code site.
- **Self-referencing DELETE** is now a deterministic materialize-once snapshot
  (was previously divergent depending on cache abandon). This matches SQLite's
  "subquery sees pre-statement state" semantics — a *more* correct behavior, tested
  in sqllogic.

### Checked — dead code / dangling references

- Retired-rule references scrubbed correctly across `optimizer.ts` (RULE_MANIFEST
  entry + import), `pass.ts`, `fuzz.spec.ts` CACHE_RULES, and all docs. **One miss
  found and fixed inline (minor):** `rule-scalar-subquery-cache.ts` header comment
  still referenced the deleted `rule-in-subquery-cache` / `ruleInSubqueryCache` as
  a live contrasting rule. Reworded to historical framing while preserving the
  intrinsic "scalar consumer fully drains → non-eager is fine, do not switch to
  eager" reasoning.

### Checked — tests

Coverage is strong and exceeds a floor: scan-count guarantees, three-valued
semantics, NOCASE collation, projection-position IN, self-DELETE snapshot, DML
row counts, prepared-statement re-run, parameterized-uncorrelated rebuild, fork
contract (`shared-cooperative`), plan-shape (no CACHE node), and a memory perf
sentinel (10k×5k SELECT+DELETE, <3 s bound vs ~0.6 s actual; quadratic would be
tens of seconds). Lint clean; full memory suite **7175 passing, 0 failing, 13
pending** (re-run this pass, matches handoff).

### Tripwires (verified, not filed as tickets)

- **Eager CacheNode mode is dormant.** Confirmed no rule passes `eager: true`
  (all four `CacheNode` constructions default or pass `false`). Correct-but-unused;
  parked as a `> NOTE:` in `docs/runtime-caching.md` § Eager vs. streaming-first.
  Genuinely conditional cleanup — agreed, not a ticket.
- **Source-emitter laziness is load-bearing** — parked in the `emitIn` set-probe
  comment and the scan-count spec header. Verified accurate.

### Not filed (out of scope, already tracked / pre-existing)

- `bug-cache-threshold-abandon-cliff` (the backwards threshold still afflicting
  `rule-scalar-subquery-cache` and the nested-loop/CTE caches) is correctly left
  untouched — confirmed it already exists in `tickets/backlog/`.
- `NULL IN (empty subquery)` returns NULL rather than SQLite's `false`. This is a
  **pre-existing** discrepancy in *all three* IN paths (streaming, value-list, and
  now set-probe, which faithfully preserves it) — not introduced or worsened here.
  Noted for awareness; not chasing it inside this ticket.

## Validation performed (review pass)

- `yarn lint` — clean.
- `yarn workspace @quereus/quereus test` (memory) — 7175 passing, 0 failing, 13 pending.
- Store-side timing (LevelDB) remains manual/out-of-band per the implement handoff;
  store *correctness* is covered by `test:store` (not re-run this pass).
