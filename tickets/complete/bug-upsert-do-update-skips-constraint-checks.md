---
description: An insert that falls back to updating an existing row now checks the table's rules before writing, so a row that breaks a CHECK, a NOT NULL, or a foreign key is refused exactly as a plain update of the same row would be — and reported with the same wording.
files:
  - packages/quereus/src/runtime/row-constraints.ts                          # NEW — extracted row-validation algorithm, shared by both call sites
  - packages/quereus/src/runtime/emit/constraint-check.ts                    # thin caller of the above
  - packages/quereus/src/planner/nodes/dml-executor-node.ts                  # UpsertUpdateValidation type + field, getChildren/withChildren spans
  - packages/quereus/src/planner/building/insert.ts                          # buildUpsertUpdateValidation + call site
  - packages/quereus/src/runtime/emit/dml-executor.ts                        # validateUpsertUpdatedRow; call site in executeUpsertUpdate
  - packages/quereus/test/logic/47.5-upsert-do-update-constraints.sqllogic   # NEW — 17 sections (user-spelled arm)
  - packages/quereus/test/logic/47.6-upsert-do-update-decomposed.sqllogic    # NEW — lens-decomposition-synthesized arm
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts               # structural guard extended for the new child span
  - docs/sql-dml.md                                                          # § UPSERT — "Constraint validation on the DO UPDATE arm"
repro: verified
---

# `on conflict … do update` validates the row it composes

## What was wrong

An INSERT statement's plan carries exactly one `ConstraintCheckNode`, and it is
INSERT-shaped: it validates the **proposed** insert row and sits upstream of the
`DmlExecutorNode`. The `DO UPDATE` arm never routed the row it actually writes through
that node — `executeUpsertUpdate` composes the row from the conflicting stored row + the
SET assignments + the generated-column recompute, then calls `vtab.update` directly. So a
CHECK violation, a NOT NULL violation, a dangling child-side FK, and a parent-side
`on update restrict` breach were all stored, where the plain `UPDATE` spelling of the same
write is refused. (FK *actions* — `on update cascade` — already fired; only the validation
half was missing.)

## What shipped

**Extraction.** The row-validation algorithm moved out of `runtime/emit/constraint-check.ts`
into a new `runtime/row-constraints.ts`, behind `buildConstraintMetadata` and
`evaluateRowConstraints`. The two plan-node facts it needed are passed as a
`RowConstraintScope` (`{ operation, hasNewSection }`), and `contextRow` became an argument
rather than a mutation on shared emit-scope state (that state now has two writers).

**Plan side.** `DmlExecutorNode` carries an optional `upsertUpdateValidation`
(`checks` + `flatRowDescriptor` + `notNullDefaults`), built by `buildUpsertUpdateValidation`
whenever any clause takes the `update` action — the same construction `buildUpdateStmt`
performs for a plain UPDATE of that table. One set per statement, shared by every clause.
Its expressions are exposed through `getChildren()` (the FK probes are `not exists (…)`
subqueries, which do not work unoptimized) and sliced back in `withChildren()`.

**Runtime.** `emitDmlExecutor` appends the check + NOT NULL DEFAULT evaluators to the
existing `upsertEvaluatorInstructions` array, so the params layout is unchanged.
`executeUpsertUpdate` calls `validateUpsertUpdatedRow` on `[…existingRow, …updatedRow]`
right after the generated-column recompute and before anything is written — honoring `skip`
(per-constraint IGNORE) and `replacedRow` (NOT NULL REPLACE DEFAULT substitution) — then
runs the parent-side RESTRICT pre-walk before `vtab.update`.

## Review findings

Reviewed the implement commit `4dfbea06` diff first, then the handoff. Ran the full
`yarn test` (8681 passing in `packages/quereus`, all other workspaces green) and `yarn lint`
(clean) after every change below.

### Fixed in this pass

- **Parent-side RESTRICT reported the wrong error, and reported it through a redundant
  probe.** `buildUpsertUpdateValidation` deliberately did *not* gate its
  `buildParentSideFKChecks` on `getBatchableRestrictFks`, on the stated grounds that
  "`runInsert` has no batch, so the arm must always carry the per-row plan-time checks or
  parent-side RESTRICT goes unenforced." That premise is wrong: the same commit added an
  unconditional `assertTransitiveRestrictsForParentMutation` call to `executeUpsertUpdate`,
  and that pre-walk covers every inbound RESTRICT FK the plan-time probe covers (plus
  transitively cascaded ones — `foreign-key-actions.ts:557-595` vs
  `foreign-key-builder.ts:347-376`, both iterating `getReferencingForeignKeys` and filtering
  `action === 'restrict'`, with the same MATCH-SIMPLE and no-referenced-column-changed
  skips). The plan-time probe therefore added no enforcement — it only ran first and
  shadowed the better message, so `insert into p … on conflict (p) do update set p = 2`
  reported `CHECK constraint failed: _fk_<child>_<col>` where the plain `update p set p = 2`
  reports `FOREIGN KEY constraint failed: UPDATE on 'p' violates RESTRICT from '<child>'`.
  The arm is now gated exactly as `buildUpdateStmt` gates it, so both spellings agree on
  both sides of the gate, and the batchable case stops paying a per-row correlated
  subquery it never needed. Fixture § 13 now asserts parity against the plain UPDATE, and a
  new § 13b pins the non-batchable side (mixed RESTRICT/CASCADE inbound FKs) where both
  spellings still report through the plan-time probe. This closes the handoff's "worth a
  reviewer's judgment call" item; the original ticket's message-parity requirement is met.
- **No test pinned the decomposition-synthesized arm.** The handoff disclosed this gap.
  Added `test/logic/47.6-upsert-do-update-decomposed.sqllogic`: a lens decomposition
  (anchor `Car_core` + optional `Car_perf`) where an anchor-resolvable UPDATE through the
  logical table lowers to a synthesized `on conflict … do update`
  (`buildOptionalMemberInsertSelect`, action `'update'`). The member carries an
  UPDATE-scoped CHECK, so only the arm can be what refuses the write. **Vacuity-checked**:
  forcing `upsertUpdateValidation` to `undefined` makes it fail. (A first attempt using a
  plain LEFT-join view was discarded — that shape routes a matched non-preserved-side
  update to a plain UPDATE, not the arm, and passed with the fix disabled.)
- **Six stale file pointers left by the extraction.** The algorithm moved to
  `runtime/row-constraints.ts` but these still named `runtime/emit/constraint-check.ts` as
  its home: `planner/building/foreign-key-builder.ts:364`,
  `planner/mutation/lens-enforcement.ts:672`, `runtime/deferred-constraint-queue.ts:189`
  (which also undercounted the enqueue sites), `schema/constraint-builder.ts:249`,
  `docs/sync.md:499`, `docs/types.md:604`. All repointed; the `types.md` bullet also now
  says the NOT NULL DEFAULT substitution is reachable from the DO UPDATE arm too.
- **Indentation.** The new `UpsertUpdateValidation` interface was space-indented where every
  neighbouring interface in `dml-executor-node.ts` uses tabs (`.editorconfig` is the source
  of truth). Retabbed.

### Checked and found clean

- **Child-span arithmetic in `DmlExecutorNode.withChildren`.** The three spans
  (upsert clause exprs / validation / context values) slice at the right offsets, the
  rebuilt `ConstraintCheck` objects preserve `constraint` identity (which
  `generateDefaultConstraintName` compares by reference), and `upsertUpdateValidation` is
  carried forward on rebuild. The extended `dml-child-exposure.spec.ts` covers the identity
  round-trip, the clause slots, and a substitution *into* the validation span.
- **Runtime evaluator layout.** Validation instructions are appended to
  `upsertEvaluatorInstructions`, and `runInsert` slices everything past the context
  evaluators into `upsertEvaluators`, so `checkStart` / `evaluatorIndex` land correctly and
  the `run` signature is unchanged.
- **Ordering.** Validation runs before the RESTRICT pre-walk, so a row breaking both a CHECK
  and a RESTRICT reports the CHECK — matching plain UPDATE, whose `ConstraintCheckNode` also
  precedes `processUpdateRow`'s pre-walk. Unchanged by the gating fix.
- **Skip / substitution plumbing.** IGNORE returns `undefined` from `executeUpsertUpdate`,
  which the caller already treats as "clause skipped" (same path as a clause `WHERE` that
  fails). REPLACE's substituted NEW section is copied back over the row that gets stored,
  and the deferred queue captures a snapshot array, so the later in-place copy-back cannot
  disturb a queued row.
- **Store mode.** 47.x fixtures pass under `QUEREUS_TEST_STORE=true`, as do 41 and the lens
  suites. The store-mode failure the handoff reported in
  `41-generated-column-extras.sqllogic` was already root-caused and fixed by the runner's
  triage pass (`ed8293f2`); re-verified passing, not re-reported.
- **`yarn docs:check`.** Red only on `docs/schema.md` and `docs/sync.md`, both already owned
  by `debt-docs-size-ratchet-red-again` per `tickets/.pre-existing-known.md`. My `types.md`
  edit trips nothing.
- **Size.** `runtime/emit/dml-executor.ts` measured at 1620 lines (`wc -l`), below the
  ~1,800-line threshold at which this project has previously split files, and well below the
  two files `debt-emit-source-files-too-large` already tracks (3,107 and 2,419). No ticket.

### New tickets filed

None. The one major finding (RESTRICT message / redundant probe) resolved at a single site
in ~10 lines, so it was fixed here rather than deferred.

### Tripwires

- `runtime/emit/dml-executor.ts`, at the RESTRICT pre-walk in `executeUpsertUpdate` —
  `NOTE:` rewritten for the gating fix. The arm still never gets the end-of-statement
  batched probe a plain UPDATE can, paying one pre-walk per conflicting row instead. Fine
  now; if bulk upsert against a heavily-referenced parent shows up as slow, give `runInsert`
  a `ParentRestrictBatch` the way `runUpdate` has one.
- `runtime/emit/dml-executor.ts`, at the validation call site — `NOTE:` (from the implement
  pass, left as written) the INSERT-shaped checks still run first on the **proposed** row,
  matching SQLite, so an auto-deferred subquery-bearing INSERT-shaped CHECK can be queued
  against a row that is never stored and abort the transaction at COMMIT. Verified behavior,
  deliberately out of scope.
- `plan.onConflict` is threaded into the arm's validation but is `undefined` on every
  reachable path (the parser rejects `insert or … on conflict …`). Commented as such at the
  site; kept so the arm stays correct if that guard is ever relaxed.

## Test coverage

`test/logic/47.5-upsert-do-update-constraints.sqllogic` — 17 sections, each violating case
asserting the error **and then** selecting to prove nothing was written: row-level and
column-level CHECK (with plain-UPDATE message parity), NOT NULL, clause `WHERE` skip,
`DO NOTHING`, op-scoped `on insert` vs `on update` filtering, transition CHECK reading
`old.<col>`, generated-column recompute into a CHECK and into a NOT NULL, per-constraint
`on conflict ignore` / `replace default`, multi-row rollback under ABORT, multi-clause
(PK arm and UNIQUE arm), child-side FK, parent-side `on update restrict` on both sides of
the batchability gate, `on update cascade` regression guard, auto-deferred subquery CHECK
failing at COMMIT, and a mutation-context variable inside an UPDATE-scoped CHECK.

`test/logic/47.6-upsert-do-update-decomposed.sqllogic` — the synthesized arm reached through
a lens decomposition.

`test/optimizer/dml-child-exposure.spec.ts` — structural guard on the new child span.
