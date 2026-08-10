----
description: A WITH-clause query used more than once in a statement previously ran once per use; it now runs a single time per statement execution and all uses share the result. Implemented and reviewed.
files: packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/building/with.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/emit/cte.ts, packages/quereus/test/vtab/cte-multi-reference-scan-count.spec.ts, packages/quereus/test/vtab/_counting-memory-module.ts, packages/quereus/test/plan/cte-materialization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/optimizer.md, docs/runtime.md
----

# Shared materialization for multi-reference CTEs (completed)

`with x as (<expensive>) select ... from x a join x b` used to run `<expensive>`
once per reference. A non-recursive CTE referenced 2+ times (or hinted
`MATERIALIZED`) is now evaluated exactly once per statement execution; every
reference reads one shared per-execution buffer. Standard SQL `MATERIALIZED`
semantics.

## How it works (as-built)

- **Plan mark** (`materialization-advisory.ts`): a memoized (by node identity)
  top-down rewrite sets `CTENode.materialize = true` when `!isRecursive`, the
  hint is not `not_materialized`, and (hint is `materialized` OR parentCount ≥ 2).
  Memoization keeps a CTENode shared across references as ONE instance, so the
  runtime buffer key (its plan id) matches across references. CacheNode
  recommendations are re-keyed through the same memo; CTEs are excluded from
  CacheNode wraps.
- **Builder** (`with.ts`): non-recursive CTEs no longer synthesize a
  `not_materialized` default — an absent hint stays `undefined` so the advisory
  can tell "user opted out" from "no opinion".
- **Runtime** (`emit/cte.ts`): un-marked CTEs keep the pure streaming path.
  Marked CTEs get-or-create a `Promise<Row[]>` on `RuntimeContext.cteMaterializations`
  (keyed by plan id); the promise is stored synchronously before any await, so a
  second reference interleaving under a nested-loop self-join awaits it instead of
  driving its own source. Rows copied on buffer-in and on yield. A no-op `.catch`
  is pre-attached so an early-teardown drive failure can't surface as an unhandled
  rejection. Fork policy `shared-cooperative`.

## Review findings

Adversarial pass over the implement diff (commit `13ee867e`), read before the
handoff summary. Verdict: implementation is correct; one test gap closed inline.

**Correctness — no defects found.** Verified from every angle probed:
- *Buffer-key stability*: both references share one marked `CTENode` instance
  (plan test asserts identity), so their separately-emitted `emitCTE` closures
  agree on the plan-id key. The synchronous store-before-await closes the
  interleave window — the scan-count test proves the source is scanned exactly
  once for a self-join.
- *Attribute-ID stability*: the rebuilt marked `CTENode` derives its attribute
  ids from its (unchanged) source (`buildAttributes` uses `attr.id`), so column
  resolution through the references is unaffected. Confirmed by the correct-rows
  tests.
- *Fresh `tableDescriptor` on the rebuilt node is harmless*: only RECURSIVE CTEs
  read rows via `rctx.tableContexts` keyed by descriptor; non-recursive `emitCTE`
  / `emitCTEReference` pass rows as instruction params and never touch the
  descriptor. Traced both emitters to confirm.
- *Per-execution staleness*: buffer lives on a fresh `RuntimeContext` per run;
  the prepared-statement re-execution test confirms no stale replay and one scan
  per run.
- *Streaming preservation*: single-ref un-hinted CTE under `LIMIT 1` pulls only a
  handful of rows (test asserts < half the table).
- *Error propagation*: the drive's rejection reaches every awaiting reference and
  the pre-attached `.catch` prevents an unhandled rejection with no listeners —
  standard multi-consumer promise semantics.

**Test coverage — one gap closed inline (minor).** The implementer's suite
(scan-once, correct rows, streaming-under-LIMIT, prepared re-execution, plan-shape
marks incl. MATERIALIZED / NOT MATERIALIZED / recursive-exclusion, fork contract)
is strong. The source-error rejection path in `emitCTE` (pre-attached `.catch` +
await propagation) was the trickiest untested logic — added a regression:
`propagates a source error from the shared materialization drive` in
`cte-multi-reference-scan-count.spec.ts`, using a new `ThrowingMemoryModule`
(armed after the seed INSERTs so it throws only during the CTE scan drive). It
asserts a 2-ref CTE whose source errors mid-drive surfaces the error to the
consumer rather than silently yielding an empty buffer.

**Not tested, left as-is (judged not worth fragile tests):** 3+ references
(logically identical to the ≥2 path) and early-teardown detached drain (documented
tripwire). No latent-defect risk in either.

**Tripwires — verified sound, left where the implementer parked them (correctly
NOT tickets):**
- Double buffer when `rule-cte-optimization` also wraps a marked CTE's source in a
  CacheNode — correct, only wasteful; `NOTE:` at the wrap site. Confirmed it is
  waste, not a correctness issue (only the buffer owner drives; the second
  reference's separately-minted cache symbol is never used).
- Early-teardown detached drain — `NOTE:` at the drive site in `emit/cte.ts`.
- Node-sharing fragility (runtime key = shared node's plan id) — guarded by the
  plan test asserting instance identity across both references.
- Fork-lazy-map caveat (dormant) — documented in `parallel-driver.ts`; matches the
  `executionMemo` caveat.

**Spawned ticket (major, pre-existing — not caused by this work):**
`fix/bug-recursive-cte-double-reference-runaway` — a recursive CTE referenced
twice runs away to the 10000-iteration limit. Verified identical failure at the
pre-change commit `ee24d8bf`, so not a regression. The plan test
"never marks a recursive CTE for shared materialization" carries a NOTE pointing
at it. Ticket is well-formed (plain-language description, repro, root-cause
hypothesis, test hook).

**Docs — checked against code, accurate.** `docs/optimizer.md` (Materialization
Advisory: CTE mark, memoized rewrite, NOT MATERIALIZED opt-out, CacheNode
exclusion) and `docs/runtime.md` (Shared CTE materialization section + fork-policy
table row) reflect the as-built behavior. No other doc touches the CTE
materialization path.

**Validation.**
- `yarn workspace @quereus/quereus lint` — clean (also type-checks the added test).
- `yarn workspace @quereus/quereus test` — 7038 passing, 0 failing, 13 pending
  (baseline), plus the new error-path test (6 passing in its describe).
- No plan-JSON goldens carry CTE logical attributes, so adding `materialize` to
  `getLogicalAttributes` broke none.
- `yarn test:store` / `yarn test:full` NOT run (planner/runtime-level change, not
  store-level) — deferred to a human or CI for release prep.
