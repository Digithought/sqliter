---
description: An insert that falls back to updating an existing row now checks the table's rules before writing, so a row that breaks a CHECK, a NOT NULL, or a foreign key is refused exactly as a plain update of the same row would be.
files:
  - packages/quereus/src/runtime/row-constraints.ts                          # NEW — the extracted row-validation algorithm, shared by both call sites
  - packages/quereus/src/runtime/emit/constraint-check.ts                    # now a thin caller of the above (pure extraction, no behavior change)
  - packages/quereus/src/planner/nodes/dml-executor-node.ts                  # UpsertUpdateValidation type + field, getChildren/withChildren spans
  - packages/quereus/src/planner/building/insert.ts                          # buildUpsertUpdateValidation (~line 371) + its call site (~line 986)
  - packages/quereus/src/runtime/emit/dml-executor.ts                        # emits the evaluators; validateUpsertUpdatedRow; call site in executeUpsertUpdate
  - packages/quereus/test/logic/47.5-upsert-do-update-constraints.sqllogic   # NEW — 16 sections
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts               # structural guard extended for the new child span
  - docs/sql-dml.md                                                          # § UPSERT — new "Constraint validation on the DO UPDATE arm" subsection
repro: verified
difficulty: medium
---

# `on conflict … do update` now validates the row it composes

## What was wrong

An INSERT statement's plan carries exactly one `ConstraintCheckNode`, and it is INSERT-shaped:
it validates the **proposed** insert row, and it sits upstream of the `DmlExecutorNode`. The
`DO UPDATE` arm never routes the row it actually writes through that node — `executeUpsertUpdate`
composes `updatedRow` from the conflicting stored row + the SET assignments + the phase-2
generated-column recompute, then calls `vtab.update` directly. So the composed row reached
storage unvalidated: a CHECK violation, a NOT NULL violation, a dangling child-side FK, and a
parent-side `on update restrict` breach were all stored, where the plain `UPDATE` spelling of
the same write is refused. (FK *actions* — `on update cascade` — already fired; only the
validation half was missing.)

## What was built

**Phase 1 — extraction (no behavior change).** `runtime/emit/constraint-check.ts` held the whole
row-validation algorithm privately, reaching into a `ConstraintCheckNode` for exactly two facts.
It moved to a new `runtime/row-constraints.ts` behind two exports, `buildConstraintMetadata` and
`evaluateRowConstraints`, with those two facts passed as a `RowConstraintScope`
(`{ operation, hasNewSection }`). `contextRow` is now an argument instead of a mutation written
onto the emit-scope metadata array (that array is now written from two call sites, so shared
mutable state there would have been a live hazard).

**Phase 2 — plan side.** `DmlExecutorNode` gained an optional `upsertUpdateValidation`
(`UpsertUpdateValidation`: `checks` + `flatRowDescriptor` + `notNullDefaults`). It is built in
`buildInsertStmt` by `buildUpsertUpdateValidation` whenever any clause takes the `update` action,
using the same construction `buildUpdateStmt` uses: fresh OLD/NEW attributes (OLD is a real
stored row here), `buildConstraintChecks(… RowOpFlag.UPDATE …)`, both FK builders when the
`foreign_keys` pragma is on, and `buildNotNullDefaults`. One set per statement, shared by every
clause. Its expressions are exposed through `getChildren()` (the FK probes are
`not exists (…)` subqueries — unoptimized they don't work) and sliced back in `withChildren()`,
which also carries the payload forward on rebuild.

**Phase 3 — runtime.** `emitDmlExecutor` appends the check + NOT NULL DEFAULT evaluators to the
existing `upsertEvaluatorInstructions` array, so the params layout and `run` signature are
unchanged. `executeUpsertUpdate` calls `validateUpsertUpdatedRow` on `[…existingRow, …updatedRow]`
right after the generated-column recompute and before anything is written — honoring `skip`
(return undefined ⇒ row silently dropped) and `replacedRow` (substituted NEW section copied back
over the row that gets stored) — then runs
`assertTransitiveRestrictsForParentMutation(…, 'update', …)` before `vtab.update`.

**Not gated on `getBatchableRestrictFks`.** `buildUpdateStmt` skips the parent-side FK checks when
the statement qualifies for end-of-statement batched RESTRICT probing, because `runUpdate` owns a
`ParentRestrictBatch`. `runInsert` has no such batch, so this arm always carries the per-row
plan-time checks. Commented at the site.

## How to exercise it

`packages/quereus/test/logic/47.5-upsert-do-update-constraints.sqllogic` — 16 sections, each
violating case asserting the error **and then** selecting to prove nothing was written:

1. row-level CHECK (+ plain-UPDATE message parity, + a satisfying DO UPDATE still succeeding)
2. column-level CHECK
3. NOT NULL
4. clause `WHERE` skips ⇒ no validation, no write
5. `DO NOTHING` ⇒ no validation, no write
6. op-scoped: `check on insert` must NOT fire here; `check on update` must
7. transition CHECK reading `old.<col>` sees the conflicting stored row (both directions)
8. generated-column recompute into a CHECK violation, and into a NOT NULL generated column
9. per-constraint defaults: `check … on conflict ignore` skips silently;
   `not null on conflict replace default 7` substitutes
10. multi-row: row 1 clean, row 2 violates ⇒ whole statement rolls back under ABORT
11. multi-clause: PK arm and UNIQUE arm each validated
12. child-side FK (+ a composed value that DOES reference a live parent, accepted)
13. parent-side `on update restrict` refused, neither table moved
14. parent-side `on update cascade` still cascades (regression guard)
15. auto-deferred subquery CHECK on the composed row, with its plain-UPDATE twin, both failing
    at COMMIT with the same message
16. mutation-context variable inside an UPDATE-scoped CHECK (failing and passing)

`packages/quereus/test/optimizer/dml-child-exposure.spec.ts` — the structural guard. Its
existing counts moved 6 → 8 children (the fixture table's `check (w >= 0)` and `w … not null
default 0` are now validation children); a new case substitutes INTO the validation span, which
neither the identity round-trip nor the clause-slot case would notice.

Verification actually run:

- `yarn test` from repo root — **green**, 8680 passing in `packages/quereus` (was 8678).
- `yarn lint` from repo root — clean.
- The new fixture also passes in **store mode** (`QUEREUS_TEST_STORE=true … --grep "47.5"`).
- **Vacuity check:** `upsertValidation` was forced `undefined` in `emitDmlExecutor` and the new
  fixture re-run — it fails at its very first assertion. The fixture genuinely pins the fix.

## Known gaps and things a reviewer should push on

- **Parent-side RESTRICT message differs from the *batched* plain UPDATE.** This arm reports
  `CHECK constraint failed: _fk_<child>_<col> (not exists (…))`; a plain UPDATE that qualifies for
  batched RESTRICT probing reports `FOREIGN KEY constraint failed: UPDATE on '<p>' violates
  RESTRICT from '<c>'`. **Measured:** a *non-batchable* plain UPDATE (mixed restrict/cascade
  inbound FKs) produces the identical message to this arm, so the divergence is the batching gate,
  not the arm. The original ticket asked the test to assert message parity with the plain UPDATE;
  that is not achievable without either gating the arm's checks (leaving RESTRICT unenforced —
  `runInsert` has no batch) or teaching `runInsert` a `ParentRestrictBatch`. Section 13 of the
  fixture documents the divergence rather than asserting parity. **Worth a reviewer's judgment
  call.**
- **Ordering choice.** Validation runs *before* the RESTRICT pre-walk, so a row violating both a
  CHECK and a RESTRICT reports the CHECK. That matches plain UPDATE precedence (its
  `ConstraintCheckNode` runs before `processUpdateRow`'s pre-walk), but it is a choice, not a
  forced one — reordering would have made section 13's message match the batched plain UPDATE at
  the cost of breaking that precedence.
- **`plan.onConflict` is threaded as `stmtOR` but is `undefined` on every reachable path** — the
  parser rejects `insert or … on conflict …` (parser.ts:510) and no synthesized statement sets
  both. Commented as such at the site. Reviewer may reasonably prefer it removed.
- **Test floor, not ceiling.** Not covered: lens-routed / view-decomposition writes that
  *synthesize* `on conflict … do update` (`planner/mutation/decomposition.ts` ~1550 and ~1909) now
  carry this validation too. The existing view / lens / MV suites pass unchanged, which is the
  evidence I have — I wrote **no new fixture** aimed at that path. If a reviewer wants a direct
  pin on decomposition-synthesized DO UPDATE under a violating member row, that gap is real.
- **`yarn test:store` full run**: 2909 passing, **1 failing** — `41-generated-column-extras.sqllogic`
  § 9e, `on conflict (k) do update` relocating a *generated stored PK*, dying at COMMIT in the
  store's isolation flush (`Cannot encode value of type undefined`). **Pre-existing**, isolated by
  disabling all three of this ticket's new code paths one at a time and re-running: it fails
  identically with the plan carrying no validation at all, and that table has no CHECK / NOT NULL
  default / FK, so this ticket's validation is an empty set there. Written up in
  `tickets/.pre-existing-error.md`. Not in `tickets/.pre-existing-known.md`.

## Tripwires parked in code

- `runtime/emit/dml-executor.ts`, in `executeUpsertUpdate` next to the RESTRICT pre-walk — `NOTE:`
  the arm always pays *both* the plan-time `not exists` probe and the runtime pre-walk per
  conflicting row, and never gets the batched end-of-statement probe. Fine now; if bulk upsert
  against a heavily-referenced parent ever shows as slow, give `runInsert` a `ParentRestrictBatch`
  and gate both sites the way `runUpdate` / `buildUpdateStmt` do.
- `runtime/emit/dml-executor.ts`, at the validation call site — `NOTE:` the INSERT-shaped checks
  still run first on the **proposed** row (matching SQLite), so an auto-deferred subquery-bearing
  INSERT-shaped CHECK is queued against a row that may never be stored and can abort the
  transaction at COMMIT. Verified behavior; deliberately out of scope.
