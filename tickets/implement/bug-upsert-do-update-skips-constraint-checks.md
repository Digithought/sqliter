---
description: When an insert falls back to updating an existing row, the new values are written without checking the table's rules — so a row that breaks a CHECK, a NOT NULL, or a foreign key is stored anyway, where a plain update of the same row would have been refused.
files:
  - packages/quereus/src/planner/building/insert.ts              # build the UPDATE-shaped validation for the DO UPDATE arm (~line 900, next to buildUpsertClausePlans)
  - packages/quereus/src/planner/nodes/dml-executor-node.ts      # carry it on the node + include its expressions in getChildren/withChildren
  - packages/quereus/src/runtime/emit/dml-executor.ts            # emit its evaluators; run them inside executeUpsertUpdate (~line 524-640)
  - packages/quereus/src/runtime/emit/constraint-check.ts        # holds the row-validation logic today; extract the reusable half
  - packages/quereus/src/planner/building/constraint-builder.ts  # buildConstraintChecks / buildNotNullDefaults (unchanged, called with RowOpFlag.UPDATE)
  - packages/quereus/src/planner/building/foreign-key-builder.ts # buildChildSideFKChecks / buildParentSideFKChecks (unchanged)
  - packages/quereus/src/planner/building/update.ts              # the reference shape to mirror (~line 249-313)
  - packages/quereus/src/runtime/foreign-key-actions.ts          # assertTransitiveRestrictsForParentMutation
  - packages/quereus/test/logic/47.5-upsert-do-update-constraints.sqllogic  # NEW — the test file to write
  - docs/sql-dml.md                                              # § UPSERT (ON CONFLICT clause) — document the validation contract
repro: verified
difficulty: medium
---

# `on conflict … do update` writes rows that violate the table's constraints

## Confirmed behavior (all reproduced against `packages/quereus/dist`)

Every case below was run; in each one the plain `UPDATE` spelling of the same write is
correctly refused and the `DO UPDATE` spelling stores the illegal row.

| Case | plain `UPDATE` | `on conflict … do update` |
|---|---|---|
| CHECK (`a < 10`), set `a = 99` | `CHECK constraint failed: _check_a (a < 10)` | stored `a = 99` |
| NOT NULL, set `a = null` | `NOT NULL constraint failed: t.a` | stored `a = null` |
| child-side FK to a missing parent | `CHECK constraint failed: _fk_chi_p` | stored the dangling value |
| parent-side FK `on update restrict` | `FOREIGN KEY constraint failed: UPDATE on 'par' violates RESTRICT from 'chi'` | write allowed, child left dangling |
| subquery CHECK (auto-deferred) | `CHECK constraint failed: _check_0 (a < (select 10))` | stored the violating row |
| generated column recomputed into a CHECK violation | refused | stored `y = 100` against `check (y < 20)` |

Parent-side FK **actions** (`on update cascade`) *do* already fire on the DO UPDATE arm —
`executeForeignKeyActionsAndLens(…, 'update', …)` is called after `executeUpsertUpdate`
returns. Only the *validation* half is missing.

## Why it happens — the one site

An INSERT statement's plan carries exactly one `ConstraintCheckNode`, and it is
INSERT-shaped (`buildConstraintChecks(…, RowOpFlag.INSERT, …)`, `planner/building/insert.ts`
~line 848). It sits *above* the `DmlExecutorNode` and sees only the proposed insert row.

The DO UPDATE arm never passes through that node for the row it actually writes. It runs
inside `executeUpsertUpdate` (`runtime/emit/dml-executor.ts` ~line 524): it composes
`updatedRow` from the existing stored row plus the SET assignments plus the phase-2
generated-column recompute, then calls `vtab.update` directly. Nothing UPDATE-shaped exists
anywhere on that path.

So the fix is: give the DO UPDATE arm its own UPDATE-shaped row validation, built at plan
time exactly the way `buildUpdateStmt` builds it, carried on the `DmlExecutorNode`, and run
inside `executeUpsertUpdate` against `[…existingRow, …updatedRow]` immediately before the
`vtab.update` call.

## Architecture

### Plan side — a new payload on `DmlExecutorNode`

```ts
// planner/nodes/dml-executor-node.ts
/**
 * UPDATE-shaped row validation for an INSERT's `on conflict … do update` arm.
 * The arm composes its row *inside* the executor and writes it directly, so it can
 * never reach the statement's ConstraintCheckNode (INSERT-shaped, and positioned
 * above the executor). This carries what buildUpdateStmt would have built for the
 * same write: OLD = the conflicting stored row, NEW = the composed row.
 * Set only when at least one clause takes the `update` action.
 */
export interface UpsertUpdateValidation {
  /** UPDATE-scoped CHECKs plus child-side and parent-side FK checks. */
  checks: ConstraintCheck[];
  /** Flat OLD|NEW descriptor the checks' column references bind through. */
  flatRowDescriptor: RowDescriptor;
  /** DEFAULT evaluators for NOT NULL columns — per-constraint REPLACE substitution. */
  notNullDefaults: NotNullDefaultPlan[];
}
```

One set, shared by every clause of a multi-clause statement — the checks are a property of
the table and the operation, not of the clause. The clause only decides *which row* is
composed; the row is bound at runtime.

`getChildren()` must list the check expressions and the NOT NULL default nodes, or the
optimizer never rewrites the subqueries inside them (the FK existence probes are
`not exists (…)` subqueries — they do not work unoptimized). Proposed canonical order,
mirrored in `withChildren`:

```
[source, ...upsertExpressions(), ...validation.checks.map(c => c.expression),
 ...validation.notNullDefaults.map(d => d.defaultNode), ...mutationContextValues.values()]
```

`withChildren` currently slices the context expressions at `1 + upsertExprs.length`; that
arithmetic has to grow the two new spans. It must also carry `upsertUpdateValidation`
forward on rebuild (same failure mode the `lensRouted` comment already warns about).

### Building it — `planner/building/insert.ts`

Next to the existing `buildUpsertClausePlans` call, when
`upsertClausePlans?.some(c => c.action === 'update')`:

- fresh OLD/NEW attribute arrays (`columnSchemaToScalarType(col)` for both, as in
  `update.ts` — OLD is a real stored row here, unlike the INSERT path where OLD is all NULL),
  and `buildOldNewRowDescriptors(…)` for the flat descriptor;
- `buildConstraintChecks(schemaAuthoredCtx, tableSchema, RowOpFlag.UPDATE, …, contextAttributes)`
  — the op mask filters correctly, so an `on insert`-only CHECK stays out and an
  `on update`-only CHECK comes in;
- when the `foreign_keys` pragma is on: `buildChildSideFKChecks(… RowOpFlag.UPDATE …)` **and**
  `buildParentSideFKChecks(… RowOpFlag.UPDATE …)`;
- `buildNotNullDefaults(schemaAuthoredCtx, tableSchema, newAttrs, contextAttributes)`.

Reuse the statement's existing `contextAttributes` / `contextDescriptor` so a CHECK
referencing a mutation-context variable binds the ids the executor already evaluates.

**Do not gate the parent-side checks on `getBatchableRestrictFks`.** `update.ts` skips them
when the statement qualifies for end-of-statement batched RESTRICT probing, because
`runUpdate` owns a `ParentRestrictBatch`. `runInsert` has no such batch, so the DO UPDATE arm
must always carry the per-row plan-time `not exists` checks. Say so in a comment at the site.

### Runtime side — extract the shared evaluator

`runtime/emit/constraint-check.ts` already contains the whole row-validation algorithm
(NOT NULL with per-constraint IGNORE / REPLACE-with-DEFAULT substitution, CHECK and FK
evaluation, deferral to the commit-time queue, `fk-parent` unchanged-columns skip, the
FK-restrict-suppressed apply-path gate, conflict-action precedence). It is private and
reaches into a `ConstraintCheckNode` for exactly two facts: `plan.operation` and whether
`plan.newRowDescriptor` exists.

Extract the reusable half into a new `runtime/row-constraints.ts` and have both
`constraint-check.ts` and `dml-executor.ts` import it. Nothing about the existing
`emitConstraintCheck` behavior changes.

```ts
// runtime/row-constraints.ts
/** The row-shape facts the evaluator needs, independent of which plan node supplied them. */
export interface RowConstraintScope {
  operation: RowOpFlag;
  /** True when the flat row carries a NEW section (false for a DELETE-shaped set). */
  hasNewSection: boolean;
}

export interface ConstraintMetadataEntry { /* as today, minus the mutable contextRow field */ }
export interface NotNullDefaultRuntime { columnIndex: number; evaluator: …; coerceColumn?: ColumnSchema }
export interface RowConstraintResult { skip: boolean; replacedRow?: Row }

export function buildConstraintMetadata(
  checks: readonly ConstraintCheck[],
  tableSchema: TableSchema,
  flatRowDescriptor: RowDescriptor,
  contextDescriptor: RowDescriptor | undefined,
  evaluators: ReadonlyArray<(ctx: RuntimeContext) => OutputValue>,
): ConstraintMetadataEntry[];

export async function evaluateRowConstraints(
  rctx: RuntimeContext,
  scope: RowConstraintScope,
  tableSchema: TableSchema,
  flatRow: Row,
  metadata: ConstraintMetadataEntry[],
  evaluators: Array<(ctx: RuntimeContext) => OutputValue>,
  stmtOR: ConflictResolution | undefined,
  notNullDefaults: NotNullDefaultRuntime[],
  contextRow: Row | undefined,
  showRow: (row: Row) => void,
): Promise<RowConstraintResult>;
```

Thread `contextRow` as an argument rather than keeping today's
`constraintMetadata.forEach(meta => { meta.contextRow = contextRow })` mutation of the
emit-scope metadata objects. It is only read to pass into `_queueDeferredConstraintRow`, and
leaving it as shared mutable state on an emit-scope array would now be written from two
call sites instead of one.

### Emitting and running it

In `emitDmlExecutor`, append the check evaluators and NOT NULL default evaluators to the
**existing** `upsertEvaluatorInstructions` array and record their indices. `runInsert`
already slices everything after the context evaluators into `upsertEvaluators`, so the
`params` layout and the `run` signature need no change at all.

In `executeUpsertUpdate`, after the phase-2 generated-column recompute and before
`keyValues` / `updateArgs` are built:

```
flat = [...existingRow, ...updatedRow]
bind flat (composed with the context descriptor when the statement has mutation context,
  via composeCombinedDescriptor — same shape emitConstraintCheck uses)
result = evaluateRowConstraints(..., { operation: RowOpFlag.UPDATE, hasNewSection: true }, ...)
  → result.skip          ⇒ return undefined      (per-constraint IGNORE: row silently skipped)
  → result.replacedRow   ⇒ copy its NEW section back over updatedRow (REPLACE substitution)
  → a throw              ⇒ propagates out of processInsertRow into runWithStatementSavepoints,
                           which rolls the statement savepoint back (multi-row atomicity)
then: await assertTransitiveRestrictsForParentMutation(rctx.db, tableSchema, 'update',
        existingRow, updatedRow, plan.lensRouted)
```

`updatedRow` is currently `const`; it becomes reassignable (or the substituted NEW section is
copied in cell by cell). The RESTRICT pre-walk mirrors `runUpdate`'s non-batched branch
(dml-executor.ts ~line 1211) and must sit before `vtab.update`, for the same
rowid-mode-backend reason documented there.

Pass `plan.onConflict` as `stmtOR`. The parser rejects `insert or … on conflict …` outright
(parser.ts:510) and no synthesized statement sets both, so it is `undefined` on every path
today and behavior is identical to passing `undefined` — but threading it keeps the arm
honest if that guard is ever relaxed. Note that in a comment so a reader does not read it as
live behavior.

### What must *not* change

- The insert arm's INSERT-shaped checks still run first, on the proposed row, before the
  conflict is known. This matches SQLite, and it means a proposed row that violates a CHECK
  aborts even when the DO UPDATE arm would have stored a legal value.
- One consequence worth a `NOTE:` comment at the DO UPDATE site: an auto-deferred
  (subquery-bearing) INSERT-shaped CHECK is queued against that same proposed row and
  evaluated at COMMIT, so it can abort the transaction over a row that was never stored.
  Verified: `insert into q values (1, 50) on conflict (id) do update set a = 2` on
  `check (a < (select 10))` fails at commit. This is the deferred twin of the immediate
  behavior above, consistent with it, and out of scope here — record it, don't fix it.
- `DO NOTHING` writes nothing and gains no validation.
- A clause `WHERE` that skips the row short-circuits before any of this (it already returns
  early at the top of `executeUpsertUpdate`).

### Blast radius

`planner/mutation/decomposition.ts` synthesizes `on conflict … do update set <col> = excluded.<col>`
for view / lens write decomposition (lines ~1550 and ~1909), so those member writes start
carrying UPDATE-shaped validation too. That is the correct direction — the composed member
row keeps its existing values in every unassigned column, so a well-formed decomposition
should pass — but it may surface previously silent violations in the view / lens / MV suites.
Only 10 source files reference `DmlExecutorNode`, and no plan golden covers `on conflict`, so
the plan-shape surface is small.

## Test cases

New file `packages/quereus/test/logic/47.5-upsert-do-update-constraints.sqllogic`. For each
violating case assert the error, then `select` to prove nothing was written; and assert the
message matches what the equivalent plain `UPDATE` produces.

- CHECK violation via DO UPDATE (row-level and column-level), NOT NULL violation, child-side
  FK violation under `pragma foreign_keys = true`.
- Parent-side `on update restrict`: a DO UPDATE that changes a referenced column with a live
  child must be refused, matching the plain UPDATE's
  `FOREIGN KEY constraint failed: UPDATE on '<parent>' violates RESTRICT from '<child>'`.
- Parent-side `on update cascade` still cascades (regression guard — it already works).
- Generated-column recompute that produces a CHECK-violating value, and one that produces
  NULL in a NOT NULL generated column.
- Op-scoped constraints: an `on insert`-only CHECK must NOT fire on the DO UPDATE arm; an
  `on update`-only CHECK must.
- A transition CHECK reading `old.<col>` sees the conflicting stored row.
- Auto-deferred subquery CHECK on the composed row fires (at row time or commit, matching
  the plain UPDATE).
- Per-constraint defaults compose: `check (…) on conflict ignore` makes the DO UPDATE arm
  skip the row silently (nothing written, no error); `not null on conflict replace default …`
  substitutes the default into the composed row.
- No over-rejection: a satisfying DO UPDATE still succeeds; a clause `WHERE` that skips the
  row runs no checks and writes nothing.
- Multi-row: `insert into m values (1,5),(2,5) on conflict (id) do update set …` where row 1
  updates cleanly and row 2 violates — the whole statement rolls back under the default ABORT.
- Multi-clause: both `on conflict (a) do update` and `on conflict (b) do update` arms of one
  statement validate.

`insert or ignore … on conflict … do update` is **not** a test case — the parser rejects the
combination ("Cannot use both 'INSERT OR ...' and 'ON CONFLICT' in the same statement"). The
ticket's original use case listing it is superseded; the per-constraint `on conflict <action>`
defaults above are what carries that semantics.

## TODO

### Phase 1 — extract the shared row-constraint evaluator

- Create `packages/quereus/src/runtime/row-constraints.ts`; move `ConstraintMetadataEntry`,
  `NotNullDefaultRuntime`, `ConstraintCheckResult`, `constraintViolationMessage`,
  `pickAction`, `throwForAction`, `generateDefaultConstraintName`, `checkConstraints`,
  `checkNotNullConstraints` and `checkCheckConstraints` into it.
- Replace the `plan: ConstraintCheckNode` parameter with the `RowConstraintScope` pair
  (`operation`, `hasNewSection`); thread `contextRow` as an argument instead of mutating the
  emit-scope metadata entries.
- Export `buildConstraintMetadata` and `evaluateRowConstraints`; rewire `emitConstraintCheck`
  to call them. No behavior change — `yarn test` must be green before Phase 2 starts.

### Phase 2 — plan side

- Add `UpsertUpdateValidation` and the `upsertUpdateValidation` field to `DmlExecutorNode`;
  extend `getChildren` / `withChildren` (and carry the field forward on rebuild).
- Build it in `buildInsertStmt` when any clause takes the `update` action: fresh OLD/NEW
  attributes + flat descriptor, `buildConstraintChecks(… RowOpFlag.UPDATE …)`, both FK
  builders when the pragma is on, `buildNotNullDefaults`. Comment why the parent-side checks
  are not gated on `getBatchableRestrictFks`.

### Phase 3 — runtime side

- In `emitDmlExecutor`, emit the check and NOT NULL default evaluators into the existing
  `upsertEvaluatorInstructions` array; build the metadata and the combined descriptor once.
- In `executeUpsertUpdate`, run `evaluateRowConstraints` on `[…existingRow, …updatedRow]`
  after the generated-column phase, honoring `skip` (return undefined) and `replacedRow`
  (write the substituted NEW section back into the row that gets stored).
- Call `assertTransitiveRestrictsForParentMutation(…, 'update', existingRow, updatedRow,
  plan.lensRouted)` before `vtab.update`.
- Add the `NOTE:` comment about the deferred INSERT-shaped CHECK on a never-stored proposed row.

### Phase 4 — tests and docs

- Write `packages/quereus/test/logic/47.5-upsert-do-update-constraints.sqllogic` covering the
  list above.
- Run `yarn test` and `yarn lint` from the repo root. Investigate any new failure in the
  view / lens / MV / decomposition suites before assuming it is unrelated — those paths
  synthesize DO UPDATE statements and are the expected place for fallout.
- Update `docs/sql-dml.md` § UPSERT (ON CONFLICT clause): state that the DO UPDATE arm
  validates the composed row under UPDATE-scoped constraints, identically to the equivalent
  plain `UPDATE`, and that per-constraint `on conflict <action>` defaults apply to a violation
  raised there.
