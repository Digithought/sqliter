description: Foreign-key checks and cascade actions used to recompile a tiny internal query for every affected row; they now reuse compiled statements from a small per-connection cache, so each query shape is compiled once instead of once per row.
prereq: fk-restrict-statement-batch
files: packages/quereus/src/core/internal-statement-cache.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/runtime.md
difficulty: medium
----

## What was built

A per-`Database` LRU pool of compiled internal statements keyed by exact SQL text
(`InternalStatementCache`), adopted by the FK/DDL enforcement call sites that
previously did `prepare → bind → iterate → finalize` once per affected row. The
engine has no plan cache, so every fresh `prepare` paid a full parse + plan +
optimize + emit; the pool compiles each fixed shape once and rebinds. A bulk
cascade over N parents now runs a couple of compiles, not ~2N (measured
hits=998 / misses=2 over 500 cascade pairs — see the perf sentinel).

### New file: `src/core/internal-statement-cache.ts`

`InternalStatementCache` — three execute methods, all running WITHOUT the exec
mutex or transaction management (same as the raw path they replaced, which runs
while the enclosing statement already holds the mutex):

- `probe(sql, params) → boolean` — pulls at most the first row (RESTRICT existence checks).
- `run(sql, params) → void` — drains to completion; the DML mutation lands during the
  scheduler run inside the first pull (cascade `DELETE`/`UPDATE`).
- `iterate(sql, params) → AsyncIterable<Row>` — lazy full stream, leased for the whole
  loop (the transitive cascade pre-walk, which recurses inside its consuming loop).

Design points a reviewer should check:

- **LRU cap 64**, insertion-ordered `Map`; reuse re-inserts (LRU-touch), eviction takes
  from the front and finalizes idle victims. A *busy* entry is never evicted, so a deep
  cascade may transiently exceed the cap — reclaimed as leases release. `stats` exposes
  hits/misses/busyFallbacks/evictions/size (asserted by tests).
- **Busy re-entrancy guard.** Cascade recursion can re-enter with the SAME SQL text while
  the outer statement is still iterating. `lease()` never shares a busy entry — it returns
  a fresh one-shot statement (finalized on release), never the live cursor. This is the
  correctness crux; verified by the self-referential cascade test (`busyFallbacks > 0`).
- **Schema-change safety.** Cached statements ride `Statement`'s existing schema-change
  subscription + lazy `needsCompile` recompile, so they stay correct across DDL between
  executions with no bespoke invalidation. `finalize()` (evict/close) drops the listener;
  recompile swaps it — no listener leak for long-lived entries.
- **Type-agnostic binding.** Internal statements are prepared with an empty explicit
  parameter-type `Map` (`db.prepare(sql, new Map())`) so (a) bind-time type validation is
  disabled and (b) the plan is affinity-neutral — a loose-affinity (`any`) FK column that
  holds an integer key on one row and a text key on another under one SQL shape is neither
  rejected nor served a first-use-frozen plan. **This is the subtlest decision; see gaps.**

### Adopted call sites

`foreign-key-actions.ts`: `assertNoRestrictedChildrenForParentMutation` (probe), the
transitive pre-walk child scan in `assertTransitiveRestrictsForParentMutation` (iterate),
`executeSingleFKAction`'s cascade DELETE/UPDATE/SET NULL/SET DEFAULT (run),
`assertNoLensChildReferences` (probe). `schema/manager.ts`:
`assertNoReferencingChildrenForDrop` (probe).

`Database`: new `public readonly _internalStatementCache`, constructed in the ctor,
drained in `close()` before the `statements` finalize sweep (double-finalize is a no-op).

## How to validate / exercise

- `packages/quereus/test/runtime/fk-restrict-runtime.spec.ts` — new `describe('internal FK
  statement cache')`: reuse across repeated probes (hit counter), **drop+recreate child →
  recompile**, **differently-typed key rebind** (`any` column, no mismatch), **self-ref
  cascade busy-guard**, **savepoint rollback → no stale state**, **close drains the cache**.
- `packages/quereus/test/performance-sentinels.spec.ts` — new `FK cascade bulk parent delete`:
  asserts the per-row shapes compile once (miss delta < 10, hit delta > N) plus a generous
  timing bound. The hit-ratio assertion is the real sentinel; the ms bound only trips on a
  catastrophic regression.
- All existing FK behavior is unchanged — the pre-existing 15 `fk-restrict-runtime` tests,
  `test/logic/41*.sqllogic`, and `test/plan/parent-fk-check-gate` all still pass.

Gates run green: `yarn build`, `yarn test` (7171 passing), `yarn test:store` (7164 passing),
`yarn lint`.

## Known gaps / things to scrutinize (this is a floor, not a ceiling)

- **Affinity-neutral planning is the load-bearing assumption.** The empty-type-map
  preparation means these probes/DML build plans with no param type info. I argued this is
  correct for exact-equality key matching against typed columns (FK keys are same-domain, so
  no coercion is needed) and strictly safer than freezing first-use affinity. It is *not*
  bit-for-bit identical to the old fresh-per-call path, which inferred param types from each
  call's values. A reviewer should confirm no FK probe relies on param-affinity coercion
  (e.g. a probe that only matched because an inferred INTEGER param coerced a text child
  value). The `any`-column test exercises mixed types but does not prove affinity-parity for
  every column type. Consider an adversarial case: child FK column with a declared type that
  differs from the parent key's storage class.
- **Cascade DML now flows through `Statement`, not `_execWithinTransaction`.** Equivalent for
  a single DML statement, but `_execWithinTransaction` re-parsed/re-planned each call while
  the cached statement reuses emission context + scheduler. The per-execution batched-RESTRICT
  accumulation (`createParentRestrictBatch`) must still allocate per run when a cascade target
  itself has inbound RESTRICT FKs — this rides the same re-run mechanism the sibling ticket's
  "prepared statement re-runs start with a fresh key batch" test pins, but it is worth an
  explicit look at a *cascade-into-RESTRICT-grandchild* shape re-run, which no single new test
  isolates end-to-end.
- **Lens cascade DML (`issueLensFkAction`) was deliberately left OFF the cache** to respect
  the ticket's scope list (its SET DEFAULT branch also inlines a default expression, varying
  the SQL text and reducing cacheability). Same win is available later if lens-heavy cascades
  show up hot.
- **Batched RESTRICT flush (`flushParentRestrictBatch`) left on plain `prepare`** — a handful
  of compiles per statement, not per row; out of scope by design.
- **Concurrency tripwire (recorded, not a task):** `InternalStatementCache`'s class doc carries
  a `NOTE:` that the busy-guard is the safety net only under today's single-statement-at-a-time
  exec-mutex serialization; if Quereus ever runs concurrent statements on one `Database`, the
  cache would need per-statement/connection scoping, mirroring the existing `NOTE:` on
  `withFkCascadeReentry`. Greppable at `src/core/internal-statement-cache.ts`.
- **Eviction under a >64-shape busy recursion is untested** (would need a pathological FK graph
  exceeding the cap while entries are in use). The code path is defensive (skip busy, transient
  over-cap); low risk, no dedicated test.
- **Dangling doc reference:** `foreign-key-actions.ts:35` points at `docs/runtime.md § Batched
  RESTRICT`, a section the sibling (timed-out) batch ticket never added. Not introduced here,
  but noted since a reviewer will pass through that file.
