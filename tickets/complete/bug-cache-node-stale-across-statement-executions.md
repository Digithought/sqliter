description: Fixed a prepared statement that cached a subquery's rows on its first run and then wrongly replayed those stale rows on later runs, even after the underlying table changed.
files: packages/quereus/src/runtime/emit/cache.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/prepared-statement-amortization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/runtime.md
----

# CacheNode row state leaks across executions of a prepared statement — done

## What changed

`emitCache` built its materialized-row `CacheState` in the emit-time closure,
so a prepared `Statement` (which caches + reuses its instruction tree across
executions, invalidating only on schema change) replayed run 1's cached rows
on run 2+ even after the source table's data changed. Fix moved `CacheState`
onto the per-execution `RuntimeContext` (`cacheStates: Map<symbol, CacheState>`),
keyed by a stable symbol minted once in the emitter closure. Same pattern as
the existing `executionMemo` / `scanConnections` fields. Fork policy wired
(`shared-cooperative`), docs updated.

## Review findings

**Reviewed:** implement diff (`git show 5299dd54`) with fresh eyes, then the
handoff. Read every touched file plus `shared-cache.ts` (the CacheState
mechanism) and `cache.spec.ts` (existing unit coverage). Checked SPP/DRY,
resource cleanup, fork contract, type safety, docs currency, and the three
injecting rules.

**Correctness — confirmed sound.** The get-or-create on `rctx.cacheStates`
keyed by a closure-stable symbol resolves to one `CacheState` per emit-site
per execution: stable within a run (re-scans replay the cache), fresh across
runs (new `RuntimeContext` → new map → re-drive source). `Symbol()` identity
makes the `plan.id` collision question moot. In-memory cache needs no teardown
(GC'd with the context), unlike `scanConnections` which registers connections
— correctly no disconnect path added. Fork sharing by reference matches the
two sibling fields and is dormant (no `ParallelDriver` query consumers).

**Minor — fixed inline (this pass):** the module-header usage-example comment
in `cache.ts` still taught the emit-time `createCacheState()` pattern — i.e.
the exact anti-pattern that caused this bug — as the recommended template for
NLJ/CTE emitters. A copy-paste would have reintroduced the defect. Rewrote it
to mint a per-emit-site symbol and get-or-create on `rctx.cacheStates`, with a
"never build CacheState at emit time" caution.

**Major:** none. No new tickets filed.

**Tripwire (conditional, no ticket):** only the uncorrelated `IN (subquery)`
injection site (`rule-in-subquery-cache`) has a stale-across-executions
regression test; `rule-cte-optimization` and `rule-mutating-subquery-cache`
route through the same shared `emitCache` and are fixed by construction, but
lack dedicated tests. Not a latent defect (the fix is in the shared emitter,
not per-rule) — recorded here rather than as a ticket. Same for the untested
`threshold > 50000` buffering branch and the cache-abandoned-then-re-run path:
fresh `CacheState` per execution makes them correct by construction, but
unexercised. If a future change moves cache lifetime logic per-rule or into
the buffering branch, add targeted coverage there.

**Verification:** `yarn workspace @quereus/quereus lint` — clean.
`yarn workspace @quereus/quereus test` — 7020 passing, 0 failing, 13 pending
(pending pre-existing, unrelated).
