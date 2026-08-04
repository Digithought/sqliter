---
description: When an insert falls back to updating an existing row (the "on conflict do update" form), auto-computed columns keep their old, now-wrong values, and it is also possible to write a bogus value straight into one — a plain update correctly prevents both.
files:
  - packages/quereus/src/planner/building/insert.ts          # buildUpsertClausePlans — the one plan-time site
  - packages/quereus/src/planner/building/update.ts          # lines 202-241: the correct behaviour, to mirror
  - packages/quereus/src/planner/nodes/dml-executor-node.ts  # UpsertClausePlan shape + getChildren/withChildren
  - packages/quereus/src/runtime/emit/dml-executor.ts        # executeUpsertUpdate — phase-2 recompute
  - packages/quereus/src/runtime/emit/update.ts              # the two-phase pattern, to mirror
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic
difficulty: medium
repro: verified
---

# `on conflict do update` skips generated-column recompute (and lets you assign one)

## Reproduced on `main` at c838ac92

Both arms confirmed by running a scratch `.sqllogic` through
`node packages/quereus/test-runner.mjs --grep <file>` (scratch file since deleted):

```sql
create table t (id integer primary key, w integer,
                g integer generated always as (w * 2));
insert into t (id, w) values (1, 1);                 -- g = 2

-- Arm A: recompute never runs
insert into t (id, w) values (1, 7) on conflict (id) do update set w = 7;
select id, w, g from t;
-- actual   {"id":1,"w":7,"g":2}     <- g still derived from the OLD w
-- expected {"id":1,"w":7,"g":14}

-- Arm B: assignment to a generated column is accepted
insert into t (id, w) values (1, 9) on conflict (id) do update set g = 99;
select id, w, g from t;
-- actual   g = 99 stored
-- expected rejected, exactly like `update t set g = 99`
--          ("Cannot UPDATE generated column 'g'")
```

## Root cause — one site

`buildUpsertClausePlans` in `packages/quereus/src/planner/building/insert.ts:315-461`,
specifically the `clause.action === 'update'` branch's loop over `clause.assignments`
(lines 419-443). It builds only the assignments the user wrote, and never routes through
`buildUpdateStmt`, so it inherits neither of the two things `building/update.ts` does:

- reject a SET whose target column is `generated` (update.ts:212-219), and
- append one implicit assignment per generated column, walking
  `tableSchema.generatedColumnTopoOrder` (update.ts:231-241).

## Design

### Arm B (trivial)

In the assignment loop, after resolving `colIndex`, reject when
`tableSchema.columns[colIndex].generated`, with the same message UPDATE uses:
`Cannot UPDATE generated column '<name>'`. Place it before the expression is built so
the diagnostic does not depend on the value expression resolving.

### Arm A — the recompute has to be a second phase, not more of the same assignments

The user's DO UPDATE assignment expressions resolve **unqualified column names against the
EXISTING (conflicting) row** and `new.` / `excluded.` against the proposed insert row
(`upsertScope`, insert.ts:378-409). At runtime `executeUpsertUpdate`
(`runtime/emit/dml-executor.ts:481-566`) evaluates every assignment with *both* row
contexts installed, then writes the composed row.

A generated column must derive from the **post-update** row, so its expression cannot be
evaluated in that same pass — the existing-row context still holds pre-update values. Use
the same two-phase shape `emitUpdate` already uses (`runtime/emit/update.ts:90-120`):

- **Plan time** (`buildUpsertClausePlans`): after the user assignments, walk
  `tableSchema.generatedColumnTopoOrder`, build each `col.generatedExpr` against a scope
  where a bare column name binds the **existing-row attribute** for that column, and
  record the column index in topo order. Gate `validateDeterministicGenerated` on
  `nondeterministic_schema` exactly as update.ts:236-238 does.
- **Runtime** (`executeUpsertUpdate`): after the user assignments have been applied and
  coerced into `updatedRow`, install one row context that maps the existing-row attribute
  ids to `updatedRow` and evaluate the generated evaluators in topo order, writing each
  result back into `updatedRow` before the next runs (so generated-from-generated sees the
  fresh value). This works because the context getter is a closure over the live array —
  same trick as update.ts's phase 2.

Details that matter:

- **Await every generated evaluator.** A generated expression may embed a scalar
  subquery and return a Promise; storing the Promise was the whole of
  `bug-update-generated-column-subquery-not-awaited`. Do not repeat it here.
- **Distinct descriptor object.** `withAsyncRowContext` keys the context map by descriptor
  *identity*, so clone the existing-row descriptor for phase 2 rather than re-binding the
  same object (`existingRowDescriptor.slice()` — it is a sparse array indexed by attribute
  id, so use `slice`, not spread, to preserve holes). Mirrors the
  `generatedRowDescriptor` in update.ts:77-82 and costs nothing.
- **Scope for the generated expressions.** Build a dedicated `RegisteredScope` over
  `existingAttributes` (bare name + `<table>.<name>`), parented on `ctx.scope`, rather than
  reusing `upsertScope` — `upsertScope` also carries `new.` / `excluded.` symbols, and a
  schema-authored expression must not be able to bind those. Wrap the resulting context in
  `schemaAuthoredContext(ctx, tableSchema.schemaName)` (see
  `planner/building/schema-authored-context.ts`) so the table's own DDL cannot bind the
  writing statement's CTEs and resolves bare relation names in its own schema — the same
  treatment update.ts gives via `schemaAuthoredUpdateCtx`.
- **Coercion.** Apply the emitter's existing static-type rule to the generated values too:
  if `genNode.getType().logicalType !== column.logicalType`, run the value through
  `validateAndParse` (see `assignmentCoercions`, dml-executor.ts:396-410). A generated
  column derives from what will be *stored*, so phase 2 must run after phase 1's coercion.

### Carrying the new nodes through the plan

The generated expression nodes are plan children and MUST be walked by the optimizer — a
subquery-valued generated expression is rewritten there, and an unwalked one reaches emit
in its unoptimized form. `DmlExecutorNode.upsertExpressions()` /
`getChildren` / `withChildren` (`planner/nodes/dml-executor-node.ts:94-170`) enumerate
`clause.assignments.values()` in insertion order and rebuild the map from
`[...clause.assignments.keys()]`, so the **smallest correct shape is to append the
generated assignments into the same `assignments` map** (a generated column can never
collide with a user target — Arm B rejects it) and add one new field to
`UpsertClausePlan` naming which column indices are generated, in topo order:

```ts
/**
 * Column indices whose assignment in {@link assignments} is an implicit
 * generated-column recompute, in `generatedColumnTopoOrder`. The runtime
 * evaluates these in a SECOND pass against the post-assignment row.
 */
generatedAssignmentColumns?: number[];
```

That keeps `getChildren`/`withChildren` working unchanged (order-preserving on both
sides). If you prefer a separate `generatedAssignments` map instead, you must extend
`upsertExpressions()` and the `withChildren` slicing to cover it — either is fine, but do
not leave the nodes out of the child walk.

Two knock-on effects to expect and confirm rather than be surprised by:

- `getLogicalAttributes` reports `assignmentCount: clause.assignments?.size` — that count
  grows for tables with generated columns. Check `test/plan/` goldens.
- The view-write decomposition synthesizes `on conflict … do update set` statements
  (`planner/mutation/decomposition.ts:1544`, `:1909`) that re-plan through this same
  builder, so both arms apply there too. Arm B's rejection is new behavior for that path;
  run the view/decomposition logic tests.

## Docs

`docs/sql-ddl.md` § Generated Columns already states "The value is computed at
INSERT/UPDATE time" and "Cannot INSERT into or UPDATE a generated column directly". Both
become true once this lands — **confirm** they read correctly and change nothing else. Do
not add a limitation note.

## Scope

- `on conflict … do nothing` writes nothing — unaffected.
- `on conflict … replace` (delete-then-insert) routes through the INSERT path, which does
  recompute — unaffected, but pin it with a control test.
- CHECK constraints are not re-validated on the DO UPDATE arm today (it calls
  `vtab.update` directly, after the insert-shaped constraint check). That is a separate
  pre-existing gap — do not widen this ticket into it.

## TODO

- [ ] Arm B: in `buildUpsertClausePlans` (`planner/building/insert.ts`), reject an
      assignment whose target column is `generated` with
      `Cannot UPDATE generated column '<name>'`.
- [ ] Add `generatedAssignmentColumns?: number[]` (topo order) to `UpsertClausePlan` in
      `planner/nodes/dml-executor-node.ts`, documented as a second-pass marker.
- [ ] Arm A plan side: after the user assignments, append one assignment per
      `generatedColumnTopoOrder` entry, built on a dedicated existing-row scope wrapped in
      `schemaAuthoredContext`, with `validateDeterministicGenerated` gated on the
      `nondeterministic_schema` option.
- [ ] Verify the appended nodes survive `getChildren`/`withChildren` round-tripping (order
      preserved, map rebuilt with the same keys).
- [ ] Arm A emit side: in `runtime/emit/dml-executor.ts`, split the runtime assignment
      indices into user vs generated, keep the generated ones in topo order, and apply the
      same `assignmentCoercions` static-type rule to them.
- [ ] Arm A runtime: in `executeUpsertUpdate`, after phase 1, evaluate the generated
      evaluators in topo order inside one row context bound (via a cloned descriptor) to
      the live `updatedRow`, `await`ing each.
- [ ] Tests in `test/logic/41-generated-column-extras.sqllogic`, alongside the existing
      generated-column cases: plain arithmetic generated column via DO UPDATE; a chained
      generated-from-generated column; a subquery-valued one whose source table changed
      between the two statements (the await path); rejection of
      `do update set <generated> = …`; and `insert or replace` as a control that still
      recomputes.
- [ ] Probe once whether a generated column that is part of the PRIMARY KEY behaves
      sanely when the recompute changes the key on the DO UPDATE arm (the update is issued
      with `oldKeyValues` from the existing row). If it misbehaves, leave it out of scope
      and file a separate ticket rather than growing this one.
- [ ] `yarn build`, `yarn test`, `yarn lint`. Confirm `docs/sql-ddl.md` § Generated
      Columns needs no edit.
