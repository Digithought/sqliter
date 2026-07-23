----
description: Bulk deletes or re-keys of rows referenced by other tables' foreign keys used to pay one or two child-table lookups per row; the affected keys are now collected and checked with one batched lookup per foreign key at the end of the statement, making large parent deletes fast on slow storage.
files: packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/test/logic/41.9-fk-restrict-batched.sqllogic, packages/quereus/test/logic/41-foreign-keys.sqllogic, packages/quereus/test/plan/parent-fk-check-gate.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/runtime.md, docs/architecture.md
----
## What was built

Statement-end batched enforcement of parent-side FK RESTRICT, replacing both per-row probes
(the plan-time synthesized `NOT EXISTS` constraint and the runtime transitive pre-walk) for
provably-equivalent statement shapes.

- **Shared gate** — `getBatchableRestrictFks` (`planner/building/foreign-key-builder.ts:488`).
  A DELETE/UPDATE batches iff not lens-routed, conflict resolution is default/ABORT or
  ROLLBACK, and every inbound FK is a non-self-referential `restrict` for the op. Returns the
  FK list to batch or `undefined` (keep per-row). Consumed by BOTH the plan builders
  (`delete.ts:227`, `update.ts:286` skip the per-row `NOT EXISTS` checks) and the DML executor
  (`dml-executor.ts:957` / `:1135`), so the two sides cannot disagree. `foreign_keys` pragma
  is checked by callers, not the gate; the runtime flush re-checks it at execution time.
- **Runtime accumulation** — `createParentRestrictBatch` / `accumulateParentRestrictKeys`
  (`runtime/foreign-key-actions.ts`). Per-execution, per-FK dedup Map keyed on an injective
  type-tagged serialization; skips NULL-containing tuples (MATCH SIMPLE) and UPDATE rows
  changing no referenced column (`sqlValueIdentical`). Allocated inside the run function
  (never the emit closure) so re-run prepared statements start empty.
- **Flush** — `flushParentRestrictBatch`, fired in `runWithStatementSavepoints`
  (`dml-executor.ts:649`) after the row loop, BEFORE `_flushDeferredMaintenance` and before
  the statement savepoint releases — a hit rolls the whole statement back. Probes per FK in
  500-key chunks: `fkcol in (?, …)` single-column, OR-of-conjunctions composite. Throws the
  existing `FOREIGN KEY constraint failed: <OP> on '<parent>' violates RESTRICT from
  '<child>'` error shape. Gate excludes FAIL, so the flush always runs under the savepoint.
- **Docs** — `docs/runtime.md` § "Batched RESTRICT" (new section; includes the RETURNING
  timing note) and the `docs/architecture.md` Constraints FK bullet.
- **Backlog spawned** — `feat-store-in-list-index-pushdown` (see below).

Accepted, documented semantics change: within the batchable class, a consumer streaming
`RETURNING` sees all rows yielded before the violation aborts, instead of only rows preceding
the violating one. Final state and error class are identical (statement savepoint unwinds).

## Tests to lean on

- `test/logic/41.9-fk-restrict-batched.sqllogic` — 10 cases: batchable DELETE violation +
  atomic rollback, zero-children success, UPDATE re-key violation, UPDATE non-key-column
  no-op, self-ref FK per-row fallback, mixed restrict+cascade fallback, composite two-column
  FK, NOCASE collation equivalence, NULL exclusion, multiple inbound RESTRICT FKs.
- `test/plan/parent-fk-check-gate.spec.ts` — updated: batchable statements now assert ZERO
  per-row plan-time FK checks; non-batchable shapes (lens-routed, mixed actions, self-ref)
  still assert the per-row checks. Enforcement coverage moved to runtime/sqllogic, not lost.
- `test/runtime/fk-restrict-runtime.spec.ts` — batched-path runtime enforcement cases added.
- `test/performance-sentinels.spec.ts:430` — 1000 parents / 4000 unindexed children delete,
  bound 2500 ms (pre-batching ~6000 ms, post ~100 ms).
- `test/logic/41-foreign-keys.sqllogic` — error expectations for batchable shapes changed from
  the plan-time `CHECK constraint failed: _fk_…` form to the runtime
  `violates RESTRICT from '<child>'` form (both match the documented `/constraint|foreign|fk/i`
  matcher contract). Reviewer should confirm each rewritten expectation really is a batchable
  shape and not lost coverage of the plan-time form.

## Validation performed (this run, current main)

- `yarn lint` green (eslint + tsc over test files).
- `yarn test` (memory): 7173 passing, 0 failing.
- `yarn test:store` (LevelDB): 7167 passing, 0 failing, 19 pending (memory-only skips).
  Note: an earlier run of this ticket saw a 10 s mocha timeout in
  `test/incremental/maintenance-equivalence.spec.ts` ("lateral fan-out + partial WHERE")
  under store — that was the pre-`fk-probe-statement-cache` store path being slow, not an
  assertion failure; with that ticket landed the whole store suite dropped ~8 min → ~1 min
  and the test passes.
- Store index pushdown verified via `query_plan()` against a live LevelDB store module:
  single-key equality on the child FK column seeks the secondary index (`INDEXSEEK ...
  USING idx_child_pid`) — so no per-row amplifier exists. The batched IN-list probe, however,
  full-scans the child primary index with a residual filter on the store (memory seeks the
  secondary index for the same query). Acceptable per-statement cost per the ticket; filed
  `backlog/feat-store-in-list-index-pushdown` with the repro.

## Known gaps / reviewer attention

- The flush builds probe SQL by string interpolation of quoted identifiers + `?` params.
  Identifier quoting rides `quoteIdentifier`; worth an adversarial glance at odd table/column
  names (embedded quotes, mixed-case, attached-schema names — non-`main` schema is prefixed).
- The gate treats `onConflict === undefined` as batchable (DELETE has no OR clause; UPDATE
  default is ABORT). If statement-level `UPDATE OR`/`DELETE OR` ever lands (currently a
  documented non-goal), the gate's conflict check is already parameterized for it.
- Dedup serialization (`serializeKeyTuple`) type-tags number vs bigint vs string vs blob;
  a value equal across JS types (1 vs 1n) probes twice — harmless over-probe, by design.
- No lens-path changes; `test/lens-enforcement.spec.ts` untouched and green in the suite.
- IndexedDB numbers from the original report are the reporter's environment; store-path
  verification here used LevelDB.
