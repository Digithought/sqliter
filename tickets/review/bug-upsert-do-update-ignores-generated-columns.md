---
description: An insert that falls back to updating an existing row now recomputes auto-computed columns instead of leaving stale values behind, and refuses an attempt to write one directly.
files:
  - packages/quereus/src/planner/building/insert.ts          # buildUpsertClausePlans — both arms, plan side
  - packages/quereus/src/planner/nodes/dml-executor-node.ts  # UpsertClausePlan.generatedAssignmentColumns
  - packages/quereus/src/runtime/emit/dml-executor.ts        # emit split + executeUpsertUpdate phase 2
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic   # sections 9, 9b–9f
  - packages/quereus/test/optimizer/dml-child-exposure.spec.ts        # child-walk guard for the appended nodes
difficulty: medium
---

# `on conflict … do update` now recomputes generated columns, and rejects assigning one

## What was broken

`insert … on conflict … do update set` composes its row from the **existing (conflicting)
row** plus the SET assignments and writes it straight through `vtab.update`. It never
routed through `buildUpdateStmt`, so it inherited neither of the two things a plain
`UPDATE` does for generated columns:

- **Arm A** — no recompute. `g integer generated always as (w * 2)` kept its pre-update
  value after a DO UPDATE changed `w`, so the stored row was internally inconsistent.
- **Arm B** — `do update set g = 99` was accepted and wrote 99 into the generated column,
  where `update t set g = 99` correctly raises `Cannot UPDATE generated column 'g'`.

## What landed

**Arm B (`planner/building/insert.ts`, in the assignment loop).** After the target column
index resolves and before the value expression is built, an assignment whose target column
is `generated` throws `Cannot UPDATE generated column '<name>'` — same wording as
`building/update.ts:212-219`.

**Arm A, plan side (same function).** After the user assignments, one implicit assignment
per entry of `tableSchema.generatedColumnTopoOrder` is appended into the *same*
`assignments` map (a generated column can never collide with a user target — Arm B rejects
those), and the column indices are recorded in topological order on the new
`UpsertClausePlan.generatedAssignmentColumns`. Appending into the same map is what keeps
`DmlExecutorNode.getChildren()` / `withChildren()` working unchanged — both are
order-preserving over `assignments.values()` / `assignments.keys()`.

The generated expressions are built on a **dedicated** `RegisteredScope` over the
existing-row attributes (bare name and `<table>.<name>`), parented on `ctx.scope`, wrapped
in `schemaAuthoredContext(…, tableSchema.schemaName)`. Deliberately *not* `upsertScope` —
that also carries `new.` / `excluded.` symbols, and schema-authored SQL must not be able to
bind them. `validateDeterministicGenerated` runs unless the `nondeterministic_schema`
option is on, matching `update.ts`.

**Arm A, emit side (`runtime/emit/dml-executor.ts`).** The clause's assignments are split
into user targets (`assignmentIndices`, phase 1) and generated recomputes
(`generatedAssignments`, an ordered `{colIndex, evaluatorIndex}` list driven off the plan's
topo list rather than map order). The existing static-type coercion rule
(`assignmentCoercions`) applies to generated values too, since they land in the same cells.
A distinct `generatedRowDescriptor` is cloned from `existingRowDescriptor` via `.slice()`
(sparse array indexed by attribute id — `slice` preserves the holes); a missing
existing-row descriptor is an internal error rather than a silent skip.

**Arm A, runtime (`executeUpsertUpdate`).** After phase 1 has applied and coerced the user
assignments into `updatedRow`, one `withAsyncRowContext` binds the cloned descriptor to
`() => updatedRow` (a live-array closure, same trick as `emitUpdate` phase 2) and evaluates
the generated evaluators in topological order, `await`ing each and writing back before the
next runs. The distinct descriptor object matters: the runtime context map is keyed by
descriptor *identity*, so re-binding the same object would collide with the existing-row
binding.

## Use cases to exercise / validate

All in `test/logic/41-generated-column-extras.sqllogic`, sections 9 through 9f:

- **9** — plain arithmetic generated column through DO UPDATE, with three assignment
  flavours that each must feed the recompute: a literal, `excluded.w`, and `w + 1` (which
  reads the *existing* row). Plus the Arm B rejection, a follow-up SELECT proving nothing
  was written, and `do nothing` as a no-write control.
- **9b** — generated-from-generated chain declared in *reverse* dependency order, so the
  second pass has to follow topological order rather than declaration order.
- **9c** — subquery-valued generated column whose source table gains rows *between* the two
  statements. This is the await path: storing the Promise instead of the value was the
  whole of the sibling ticket `bug-update-generated-column-subquery-not-awaited`, and the
  changed source count makes a carried-over value visible in the result.
- **9d** — **correlated** subquery generated column whose correlation is on the very column
  the SET clause changes. Distinguishes "phase 2 ran" from "phase 2 ran against the
  post-assignment row"; 9c alone cannot.
- **9e** — `insert or replace` control (delete-then-insert routes through the INSERT path,
  which already recomputed).
- **9f** — generated column that IS the primary key, where the recompute *relocates* the
  key on the DO UPDATE arm (the write is issued with `oldKeyValues` from the existing row).
  **Probed and it behaves**: the row moves 101 → 102, no duplicate, no loss. Kept as a
  pinned test rather than spun out into a separate ticket.

Plus `test/optimizer/dml-child-exposure.spec.ts`: a new case asserting the appended
generated expressions are real plan children (they contain subqueries the optimizer must
rewrite) and that `withChildren` slices them back into their own slots with the
`generatedAssignmentColumns` marker carried forward.

## Verification run

- `yarn build` — clean.
- `yarn test` — 8675 passing in `packages/quereus` (was 8674; +1 optimizer case), all other
  workspaces green, 0 failing.
- `yarn lint` — clean.
- **Non-vacuity checked**: with the runtime phase-2 block temporarily short-circuited, the
  new sqllogic section fails on `{"id":1,"w":7,"g":2}` vs the expected `g:14`, i.e. the
  exact symptom the ticket reproduced. Reverted immediately after.
- `docs/sql-ddl.md` § Generated Columns re-read — "computed at INSERT/UPDATE time" and
  "Cannot INSERT into or UPDATE a generated column directly" are now both true for this
  path. **No edit made**, per the ticket.

## Known gaps — treat the tests as a floor

- **CHECK constraints are still not re-validated on the DO UPDATE arm.** It calls
  `vtab.update` directly, after only the *insert-shaped* constraint check. This is a
  pre-existing gap the ticket explicitly fenced off, and this change does **not** close it —
  a generated column now recomputed by phase 2 is therefore also not CHECK-validated
  against its new value. No open ticket covers it (searched the board for
  `executeUpsertUpdate` / `buildUpsertClausePlans`). Worth filing from review if you agree
  it should be tracked; the root-cause site is `executeUpsertUpdate` in
  `runtime/emit/dml-executor.ts`.
- **The view-write decomposition path is untested for Arm B specifically.**
  `planner/mutation/decomposition.ts:1544` and `:1909` synthesize `on conflict … do update
  set` statements that re-plan through `buildUpsertClausePlans`, so both arms now apply
  there. The full view/decomposition logic suite passes, but the synthesized statements
  target ordinary columns — no view test writes through a basis table that has a generated
  column, so Arm B's *new rejection* on that path is covered only by "nothing regressed",
  not by a positive case. If a decomposition ever synthesizes an assignment onto a
  generated column, it would now be rejected where it previously succeeded.
- **Coverage of the phase-2 coercion is indirect.** Section 3 of the file covers a
  `typeof()`-derived `text` generated column, but only through INSERT/UPDATE — no DO UPDATE
  case drives a generated value whose static type differs from the declared column type
  through `validateAndParse`.
- **No multi-clause DO UPDATE test with generated columns.** Every new case has a single
  `on conflict` clause; the emit-side split builds per clause, so two clauses on one
  generated-column table is an untested (but structurally symmetric) shape.
- **`getLogicalAttributes` reports `assignmentCount: clause.assignments?.size`, which now
  grows** for tables with generated columns. No test golden asserts on it today (the only
  spec touching upsert clause shape uses a table without generated columns), so nothing
  broke — but a future plan golden over such a table will see the larger count.
