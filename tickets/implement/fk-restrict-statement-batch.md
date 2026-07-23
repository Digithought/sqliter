<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-23T01:02:05.786Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\fk-restrict-statement-batch.implement.2026-07-23T01-02-05-786Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Deleting or re-keying many rows in a table that other tables reference by foreign key pays one or two child-table lookups per row, which is catastrophically slow on browser/disk storage; collect the affected keys and run one batched lookup per foreign key at the end of the statement instead.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/test/plan/parent-fk-check-gate.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, packages/quereus/test/logic/, packages/quereus/test/performance-sentinels.spec.ts, docs/runtime.md, docs/architecture.md
difficulty: hard
----

## Problem

Reported against `@quereus/quereus` 4.3.2 + IndexedDB store plugin (`tickets/fix/quereus-fk-delete-perf.md`, now folded into this ticket); root cause confirmed on 4.4.0 by code inspection and a memory-module repro (below). Deleting N rows from a table that is the *target* of a RESTRICT foreign key costs one full referential probe per deleted row per inbound FK — ~35 ms/row on the IndexedDB store even when the child FK column is indexed and matches nothing. A 500–1000-row parent delete takes 18–49 s; `pragma foreign_keys = off` makes it instant.

Memory-module repro on current main (1000 deleted parents, each with zero children):

| Case | Time |
|---|---|
| FK on, child indexed, 0–8000 unrelated children | ~190–350 ms (~0.2–0.35 ms/row) |
| FK on, child NOT indexed, 4000 children | 6,113 ms (~6 ms/row — O(N×K) full scan per row) |
| FK off | 8 ms |

Debug-log counting (`DEBUG='*fk*'`) confirms exactly one runtime probe per deleted row per RESTRICT FK, in addition to the plan-time check.

## Root cause

Every deleted (or re-keyed) parent row pays **two** independent probes per inbound RESTRICT FK:

1. **Plan-time check** — `buildParentSideFKChecks` (`planner/building/foreign-key-builder.ts:319`) synthesizes an *immediate* (non-deferred, because RESTRICT) `NOT EXISTS(select 1 from child where fk = OLD.pk)` constraint. Compiled once per statement but **evaluated per row** by `ConstraintCheckNode` — one correlated child query per row.
2. **Runtime pre-check** — `processDeleteRow` / `processUpdateRow` (`runtime/emit/dml-executor.ts:1144`, `:995`) call `assertTransitiveRestrictsForParentMutation`, whose step 1 (`assertNoRestrictedChildrenForParentMutation`, `runtime/foreign-key-actions.ts:343`) runs `db.prepare('select 1 from child where fk = ? limit 1')` **freshly compiled for every row** (there is no statement/plan cache), executes it, and finalizes it.

On the store module each probe is a separate storage round-trip (IndexedDB read transaction), so the per-row cost is dominated by storage latency × 2 probes × N rows. On the memory module the cost is mostly the per-row re-compile plus (when the child column is unindexed) a full child scan per row.

## Design

Replace both per-row probes with **one batched probe per FK per statement**, for the statement shapes where that is provably equivalent. This is a zero-statistics robust default in the same spirit as `quereus-in-subquery-set-probe`: the O(N + probes) bound must hold with no stats and no cost-model gating.

### Batchability gate (shared, plan-time decidable)

A DELETE or UPDATE on target table `T` uses the batched path iff **all** of:

- `foreign_keys` pragma is on;
- the write is not lens-routed (`lensRouted === false`) — lens writes keep the existing per-row machinery (logical FK duals, divergent-FK suppression);
- the statement's effective conflict resolution is default/ABORT or ROLLBACK (not FAIL / IGNORE / REPLACE — those have per-row keep/skip semantics a statement-end check cannot honor);
- **every** inbound FK on `T` (via `schemaManager.getReferencingForeignKeys`) has op-appropriate action `'restrict'` — if any FK cascades / sets-null / sets-default, the per-row transitive pre-walk must interleave with cascade execution, and a cascade could delete rows of a RESTRICT child table mid-statement, so batching would be more permissive than immediate enforcement;
- no inbound FK is self-referential (child table === `T`) — a self-ref FK's check outcome depends on which rows of `T` the same statement has already deleted.

Implement the gate as one function (suggested home: `foreign-key-builder.ts`, exported) consumed from **both** sides so they cannot disagree:

- `buildDeleteStmt` / `buildUpdateStmt`: when batchable, **skip** the per-row parent-side `NOT EXISTS` constraint checks entirely (child-side and CHECK constraints unaffected).
- `emitDmlExecutor` delete/update paths: when batchable, **skip** the per-row `assertTransitiveRestrictsForParentMutation` call and instead accumulate keys (below).

Everything outside the gate keeps today's behavior unchanged (both checks, per-row). The REPLACE-eviction path (`processEvictions`) always stays per-row.

### Runtime accumulation + flush

- Per statement execution, per inbound RESTRICT FK: a deduplicating collection of OLD parent referenced-key tuples (a `Map` keyed on a serialized tuple is fine — dedup is an optimization, over-probing is harmless). Skip tuples containing NULL (MATCH SIMPLE — unreferenceable). For UPDATE, add a tuple only when at least one referenced column actually changed (reuse the existing `sqlValueIdentical` per-column test).
- Flush at the **end-of-statement boundary** in `runWithStatementSavepoints` (`dml-executor.ts:638`) — after the row loop, **before** `_flushDeferredMaintenance` (fail fast; skip wasted MV work) and before the statement savepoint releases, so a violation rolls the whole statement back exactly like a per-row abort would under ABORT/ROLLBACK.
- Probe per FK, chunked (~500 keys per chunk; tuning constant):
  - single-column FK: `select "fkcol" from "schema"."child" where "fkcol" in (?, ?, …) limit 1`
  - composite FK: `select "a", "b" from "schema"."child" where ("a" = ? and "b" = ?) or … limit 1`
- Any hit → throw the existing error shape: `FOREIGN KEY constraint failed: DELETE on '<parent>' violates RESTRICT from '<child>'` (`StatusCode.CONSTRAINT`). Selecting the FK columns (not `select 1`) keeps the violating key available for a future richer message; the message itself stays matcher-compatible (`/constraint|foreign|fk/i`).
- Chunks per statement is ⌈distinct keys / 500⌉ — a handful of compiles per statement instead of one per row.

### Semantics trade-off (accepted, documented)

Within the batchable class, RESTRICT detection moves from per-row to statement-end. Under ABORT/ROLLBACK the final state is identical (the statement savepoint unwinds all rows either way) and the error class/message is identical. The one observable difference: a consumer streaming `RETURNING` rows sees all rows yielded before the abort instead of only rows preceding the violating one — transient output before an error that voids the statement either way. Document in `docs/runtime.md` next to the existing RESTRICT pre-check description.

## Edge cases & interactions

- **Self-referential FK** (`t.parent_id references t(id)` restrict) → gate routes per-row; pin with a sqllogic test whose per-row and batched outcomes would differ (delete a parent and its referencing child in one statement).
- **Mixed inbound actions** (one restrict + one cascade FK on the same parent) → per-row path; existing transitive pre-walk tests must stay green.
- **OR FAIL / IGNORE / schema-level non-default conflict resolution** → per-row path; FAIL keeps prior rows, which the batch cannot honor.
- **Lens-routed write** → per-row path untouched (`test/lens-enforcement.spec.ts` must stay green).
- **UPDATE that touches no referenced column** → contributes nothing to the batch (and must not probe at all — pin with a test).
- **UPDATE re-keying to a still-referenced value** → violation detected at flush; statement rolls back atomically.
- **NULL referenced values** → excluded from the batch (MATCH SIMPLE).
- **Empty batch** (nothing deleted, or all keys NULL) → no probe at all.
- **Multiple inbound RESTRICT FKs** → one batch + flush per FK; `test/plan/parent-fk-check-gate.spec.ts` currently asserts two per-row plan-time checks for that shape — expectations change to zero per-row checks for batchable statements (update the spec's intent, don't delete coverage: assert the batched path enforces both FKs).
- **Composite (multi-column) FKs** → OR-of-conjunctions probe form; test with a two-column FK.
- **Collation on FK columns** → the probe uses plain SQL `=` against the child column, same as the synthesized `NOT EXISTS` — collation semantics unchanged by construction; one NOCASE test to pin it.
- **RETURNING streaming** → documented divergence above; sqllogic can only observe final state + error, which are unchanged.
- **Interaction with `quereus-in-subquery-set-probe`** (in flight): the batched probe's parameterized `IN (?, ?, …)` list is the literal value-list path of `emitIn`, not the subquery path — no dependency either direction, but confirm the value-list path handles ~500 parameters without pathology.
- **Store index pushdown**: verify via `query_plan()` that the store module serves the batched IN probe through the child index rather than a full scan. A full scan per chunk is still acceptable (per-statement, not per-row), but if the store cannot push even single-key equality to a secondary index, that is a separate amplifier — file a follow-up fix ticket against the store/IndexedDB plugin if observed.
- **Statement re-execution**: the batch is per-execution state (allocate in the emitter's run function alongside `deferredRebuilds` / `residualBatch`, never on the closure) — a prepared statement re-run must start empty.

## Validation

- sqllogic: batchable DELETE with existing child → error + full rollback (row counts prove atomicity); batchable DELETE with zero children → succeeds; UPDATE re-key violation; UPDATE non-key column no-probe; self-ref FK per-row semantics; mixed-action fallback; composite FK; NOCASE FK column.
- `test/runtime/fk-restrict-runtime.spec.ts` and `test/plan/parent-fk-check-gate.spec.ts` updated to the new plan shape without losing enforcement coverage.
- Performance sentinel (memory module, generous threshold per existing sentinel style): delete 1000 parents with 4000 **unindexed** children, FK on — pre-fix ~6 s (O(N×K)), post-fix bound well under 1 s (one scan per chunk).
- Manual store-path verification per the repro tables in the original report (LevelDB via `yarn test:store` for the suite; IndexedDB numbers are the reporter's environment).
- `yarn test`, `yarn test:store`, `yarn lint` green.

## TODO

- [ ] Shared batchability gate function (restrict-only inbound, non-self-ref, ABORT/ROLLBACK, not lens-routed, pragma on) in foreign-key-builder.ts
- [ ] Plan side: skip per-row parent-side NOT EXISTS checks in buildDeleteStmt/buildUpdateStmt when batchable
- [ ] Runtime side: per-execution per-FK key batch in emitDmlExecutor delete/update paths (dedup, NULL-skip, UPDATE changed-column filter); skip per-row assertTransitiveRestrictsForParentMutation when batchable
- [ ] Flush in runWithStatementSavepoints before _flushDeferredMaintenance: chunked IN / OR-conjunction probe per FK, existing RESTRICT error shape on hit
- [ ] Update parent-fk-check-gate.spec.ts + fk-restrict-runtime.spec.ts expectations; keep enforcement coverage
- [ ] sqllogic tests per Edge cases list
- [ ] Performance sentinel: unindexed-child bulk parent delete
- [ ] Verify store-module index pushdown for the batched probe via query_plan(); file follow-up ticket if the store full-scans single-key probes
- [ ] Docs: runtime.md RESTRICT pre-check section (batched path + RETURNING timing note); architecture.md Constraints bullet if it describes per-row FK enforcement
- [ ] `yarn test`, `yarn test:store`, `yarn lint` green
