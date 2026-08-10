description: Bulk deletes or re-keys of rows referenced by other tables' foreign keys used to pay one or two child-table lookups per row; the affected keys are now collected and checked with one batched lookup per foreign key at the end of the statement, making large parent deletes fast on slow storage.
files: packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic, packages/quereus/test/logic/41-foreign-keys.sqllogic, packages/quereus/test/plan/parent-fk-check-gate.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/runtime.md, docs/architecture.md
----
## What was built

Statement-end batched enforcement of parent-side FK RESTRICT, replacing both per-row probes
(the plan-time synthesized `NOT EXISTS` constraint and the runtime transitive pre-walk) for
provably-equivalent statement shapes. A DELETE/UPDATE batches iff it is not lens-routed, its
conflict resolution is default/ABORT/ROLLBACK, and every inbound FK is a non-self-referential
`restrict` for the op. When admitted, both plan builders skip the per-row `NOT EXISTS` checks
and the DML executor accumulates each affected row's OLD referenced-key tuple, flushing one
chunked probe per FK (`fkcol in (?, …)`, 500-key chunks) at the end-of-statement boundary —
under the statement savepoint, before deferred maintenance, so a hit rolls the whole statement
back. Shared gate `getBatchableRestrictFks` (`foreign-key-builder.ts:488`) is consulted by
both sides so plan and runtime cannot disagree.

The implementation was verified sound in review; the batched path is provably equivalent to
per-row enforcement for the admitted shapes (see findings). Accepted, documented semantics
change: within the batchable class a consumer streaming `RETURNING` sees all rows yielded
before the violation aborts; final state and error class are identical.

Backlog spawned by implement: `feat-store-in-list-index-pushdown` (store full-scans the batched
IN-list probe instead of seeking the secondary index — acceptable per-statement cost).

## Review findings

Adversarial pass over the implement diff (code landed in the timeout-resume commit `5c618f21`,
docs + board move in `a10a62de`). Lint clean; full memory suite **7173 passing / 0 failing**;
FK runtime spec **22 passing** (21 + the one test added below). Angles checked and outcomes:

**Correctness — CONFIRMED sound, no defects.**
- *Phantom-code check.* The implement commit `a10a62de` touched only docs+tickets, which looked
  alarming; traced the actual code to the prior timeout-resume commit `5c618f21`. All claimed
  symbols (`getBatchableRestrictFks`, `createParentRestrictBatch`, `accumulateParentRestrictKeys`,
  `flushParentRestrictBatch`) are present and wired. Not phantom.
- *Gate plan/runtime consistency.* Both `delete.ts:226` / `update.ts:272,286` (plan) and
  `dml-executor.ts:957,1135` (runtime) call the same gate. Plan skips `NOT EXISTS` iff gate
  batchable; runtime accumulates iff batchable. Verified toggle-safe: plan gates on the
  `foreign_keys` pragma, the runtime flush re-checks it — flipping the pragma between prepare and
  execute cannot leave a statement half-enforced.
- *Gate exclusions.* FAIL/IGNORE/REPLACE, any cascade/set-null/set-default inbound FK, self-ref,
  and lens-routed all correctly return `undefined` (keep per-row). Each fallback shape is pinned
  by `parent-fk-check-gate.spec.ts` and `41.9-fk-restrict-batched.sqllogic`.
- *Atomicity.* Batchable ⇒ non-FAIL ⇒ the statement savepoint is always created
  (`runWithStatementSavepoints:581`); the flush (`dml-executor.ts:649`) runs inside the try,
  under that savepoint, before `_flushDeferredMaintenance` — a hit unwinds the whole statement.
- *Equivalence.* The gate requires every inbound FK be `restrict`, so there is no cascade FROM
  the parent and the transitive closure is depth-1; the batched depth-1 probe is exactly what the
  per-row pre-walk would check. OLD-key accumulation is pre-`vtab.update` (same observation point
  as per-row), dedup serialization is injective (type-tagged + length-prefixed), MATCH-SIMPLE
  NULL skip and the UPDATE no-key-change short-circuit mirror the per-row rules, and batch state
  is per-execution (re-run freshness is tested).
- *Error shape / message swap.* The `41-foreign-keys.sqllogic` expectations that changed from the
  plan-time `CHECK constraint failed: _fk_…` form to the runtime `violates RESTRICT from '<child>'`
  form were each confirmed to be genuinely batchable shapes: the message only swaps when the
  plan-time check is removed, so a passing suite is itself proof the gate agrees on those shapes.
- *Identifier quoting / attached-schema prefix* (implement flagged this for a glance). The flush's
  `quoteIdentifier` + non-`main` `schemaPrefix` are byte-for-byte the same pattern as the proven
  per-row `assertNoRestrictedChildrenForParentMutation` — no new quoting risk introduced.
- *Composite FK.* OR-of-conjunctions where-clause with `chunk.flat()` params binds in placeholder
  order; covered by sqllogic case 7.

**Test coverage — minor gap fixed inline.**
- The flush probes accumulated keys in 500-key chunks. The perf sentinel exercises the multi-chunk
  path on **success** (1000 keys, no match) and existing cases cover single-chunk **violations**,
  but no test drove a violation landing **past the first chunk**. Added
  `fk-restrict-runtime.spec.ts` case *"a violation past the first 500-key probe chunk still fires
  and rolls back"* (600 parents, child references parent #600) — the one untested branch of the new
  flush loop. Passes.

**Source hygiene.** `foreign-key-actions.ts` is now ~1040 lines but cohesive (all FK enforcement:
physical actions, lens walker, lens restrict, batched section). The batched section is ~130 lines
of small single-purpose functions with accurate comments. No refactor warranted.

**Tripwires (parked, no action needed).**
- `serializeKeyTuple` type-tags number vs bigint, so `1` and `1n` probe twice — a harmless
  over-probe already documented at the function.
- Attached-schema (non-`main`) child in the *batched* probe path has no dedicated test; the
  quoting/prefix code is copied verbatim from the proven per-row path, so risk is negligible —
  noted here rather than filed.

**Major findings:** none — no new fix/plan/backlog tickets spawned.
**Blocked:** none.
