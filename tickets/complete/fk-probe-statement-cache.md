description: Foreign-key checks and cascade actions used to recompile a tiny internal query for every affected row; they now reuse compiled statements from a small per-connection cache, so each query shape is compiled once instead of once per row.
files: packages/quereus/src/core/internal-statement-cache.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/runtime.md
----

## What shipped

A per-`Database` LRU pool of compiled internal statements keyed by exact SQL text
(`InternalStatementCache`), adopted by the FK/DDL enforcement call sites that previously
did `prepare → bind → iterate → finalize` once per affected row. The engine has no plan
cache, so each fresh `prepare` paid a full parse + plan + optimize + emit; the pool compiles
each fixed shape once and rebinds. A bulk cascade over N parents now runs a couple of
compiles, not ~2N.

Call sites adopting the cache: RESTRICT existence probes (`assertNoRestrictedChildrenForParentMutation`,
lens dual `assertNoLensChildReferences`), the transitive cascade pre-walk child scan
(`assertTransitiveRestrictsForParentMutation`), the cascade DML in `executeSingleFKAction`
and `issueLensFkAction`, and the drop-referencing check (`SchemaManager.assertNoReferencingChildrenForDrop`).
`Database` gains `_internalStatementCache`, drained in `close()` before the `statements` sweep.

## Review findings

Read the implement diff (`2461f81c`) first, then the code, then verified against the running
suite. Aspect passes below; empty categories are called out with the reason.

### Fixed inline (minor)

- **Lens CASCADE UPDATE was the one lens cascade branch left on `_execWithinTransaction`**
  (`foreign-key-actions.ts:876`) while lens DELETE / SET NULL / SET DEFAULT were all converted
  to `_internalStatementCache.run(...)`. An oversight, not a design choice — the handoff even
  claimed *all* lens cascade DML was "deliberately left off the cache," which the diff
  contradicts (3 of 4 branches were on). The non-lens CASCADE UPDATE already proves the
  two-param-set (`[...newParentValues, ...oldParentValues]`) `.run()` pattern, so the branch
  was converted for consistency + the perf win. `docs/runtime.md` updated to name
  `issueLensFkAction` alongside `executeSingleFKAction` as a cached cascade-DML site.

### Checked, no defect found

- **Re-entrancy / busy-guard (the correctness crux).** `lease()` never shares a `inUse`
  entry — same-SQL re-entry mid-iteration gets a fresh one-shot statement finalized on
  release; the live cursor is never aliased. Early-return in `probe` runs the async
  iterator's `.return()` (→ `_iterateRowsRawInternal` finally: `busy=false`, vtab disconnect)
  *before* `release`, so the entry is idle again when returned to the pool. Self-ref cascade
  test asserts `busyFallbacks > 0`. Sound.
- **Type-agnostic binding.** `prepare(sql, new Map())` sets an empty *explicit* parameter-type
  map ⇒ `validateParameterTypes` iterates nothing and the plan is affinity-neutral. This is
  the intended, SQLite-consistent behavior (a comparison param takes the column's affinity,
  not a first-use-frozen one) and is *not* bit-identical to the old fresh-per-call path that
  inferred param types from each call's values. Exercised by the `any`-column mixed-type test;
  the full FK behavior corpus (15 pre-existing `fk-restrict-runtime` + `logic/41*.sqllogic`,
  memory and store) is unchanged. See tripwire below for the residual edge.
- **Schema-change safety.** Cached statements ride `Statement`'s existing schema-change
  subscription + lazy `needsCompile` recompile; `finalize()` drops the listener, recompile
  swaps it — no listener leak. drop+recreate-child test covers it. A cached probe whose child
  table is later dropped is never re-probed (the FK edge is gone) and is finalized at
  evict/close — no stray recompile against a dropped table.
- **LRU / eviction.** Insert-then-evict keeps the new busy entry off the victim list; busy
  entries are skipped (never finalized under a live cursor), so a deep cascade may transiently
  exceed cap 64 and reclaim as leases release. `evictIfNeeded`'s `void finalize()` is safe —
  `finalize()` is synchronous teardown returning a resolved promise.
- **Resource cleanup.** One-shot busy-fallbacks and the defensive "entry replaced under a live
  lease" case are finalized on release; `clear()` snapshots then finalizes all entries;
  double-finalize (cache clear then `statements` sweep in `close()`) is a no-op. close-drain
  test asserts `size === 0` after close.
- **Cascade DML timing (`run`).** The DML side effect lands during `scheduler.run()` (awaited
  before any yield), so draining an empty result set still mutates. Savepoint-rollback test
  confirms a cached cascade statement holds no state across `rollback to` + reuse; validated on
  the LevelDB store path too.
- **Type safety / lint.** `yarn lint` (eslint + `tsc -p tsconfig.test.json`) clean; no `any`.
- **Source hygiene.** `internal-statement-cache.ts` (254 lines) is small, single-purpose,
  well-decomposed (`lease`/`release`/`evictIfNeeded`/`prepareInternal`); comments are dense but
  purposeful and accurate. No complaints.

### Tripwires (recorded, not filed)

- **Affinity-parity for a declared-type-mismatched FK edge.** The `any`-column test proves
  mixed-type rebinding does not throw, but does not prove affinity-*parity* for a child FK
  column whose declared type differs from the parent key's storage class (e.g. TEXT child FK
  over INTEGER parent key). Argued correct (affinity-neutral matches SQLite equality
  semantics) and the whole FK corpus is green, so this is conditional, not a live defect.
  Parked as the existing class-doc parameter-binding note in `internal-statement-cache.ts`
  plus the `docs/runtime.md` internal-statement-cache paragraph.
- **Concurrency scoping.** Class doc carries a `NOTE:` that the busy-guard is the safety net
  only under today's single-statement exec-mutex serialization; concurrent statements on one
  `Database` would need per-connection scoping. Greppable at `internal-statement-cache.ts`;
  mirrors the existing `NOTE:` on `withFkCascadeReentry`. Left as-is.

### Non-issues from the handoff's "known gaps"

- The handoff's **"dangling doc reference" gap** (`foreign-key-actions.ts:35` → `docs/runtime.md
  § Batched RESTRICT`) is **stale**: the section exists at `runtime.md:1092`, landed by the
  sibling `fk-restrict-statement-batch` ticket. No action.
- `flushParentRestrictBatch` / `createParentRestrictBatch` left on plain `prepare` (a handful of
  compiles per statement, not per row) — out of scope by design, confirmed correct.
- Eviction under a >64-shape busy recursion remains untested; the path is defensive
  (skip-busy, transient over-cap) and low risk — left uncovered, consistent with the handoff.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (memory) — **7174 passing, 13 pending, 0 failing**.
- `yarn test:store` FK/lens/cascade/savepoint/RESTRICT subset — **751 passing, 0 failing**.
- FK/lens/cascade grep subset (memory), spec reporter — 701 passing, 0 failing.
