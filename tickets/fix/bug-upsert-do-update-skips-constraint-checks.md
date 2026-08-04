<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-08-04T15:22:42.535Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\bug-upsert-do-update-skips-constraint-checks.fix.2026-08-04T15-22-42-533Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
---
description: When an insert falls back to updating an existing row, the new values are written without checking the table's rules — so a row that breaks a CHECK, a NOT NULL, or a foreign key is stored anyway, where a plain update of the same row would have been refused.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts    # executeUpsertUpdate — composes the row and calls vtab.update with no row-constraint pass
  - packages/quereus/src/planner/building/insert.ts      # ~line 848 — buildConstraintChecks(..., RowOpFlag.INSERT, ...): the only checks an INSERT plan builds
  - packages/quereus/src/planner/building/update.ts      # the UPDATE-shaped equivalent, for comparison
  - packages/quereus/src/planner/nodes/constraint-check-node.ts
  - packages/quereus/test/logic/41-generated-column-extras.sqllogic   # sections 9-9i cover the same arm for generated columns
repro: verified
difficulty: medium
---

# `on conflict … do update` writes rows that violate the table's constraints

## What goes wrong

`insert … on conflict … do update set` has two outcomes. If the insert succeeds, the proposed
row is validated normally. If it conflicts and takes the DO UPDATE arm, the engine composes a
new row (existing row + the SET assignments) and writes it straight to storage — without ever
validating that composed row.

Three kinds of constraint are silently skipped. Each was reproduced; in every case the plain
`UPDATE` spelling of the same write is correctly refused.

```sql
create table t (id integer primary key, a integer not null check (a < 10));
insert into t values (1, 1);

update t set a = 99;    -- CHECK constraint failed: _check_a (a < 10)   ✔ refused
update t set a = null;  -- NOT NULL constraint failed: t.a              ✔ refused

insert into t values (1, 5) on conflict (id) do update set a = 99;    -- stored: a = 99    ✘
insert into t values (1, 5) on conflict (id) do update set a = null;  -- stored: a = null  ✘
```

Foreign keys go the same way, with `pragma foreign_keys = true`:

```sql
create table par (id integer primary key);
insert into par values (1);
create table chi (id integer primary key, p integer references par(id));
insert into chi values (1, 1);

update chi set p = 998;   -- CHECK constraint failed: _fk_chi_p   ✔ refused
insert into chi values (1, 1) on conflict (id) do update set p = 999;   -- stored: p = 999  ✘
```

The table now holds a row that its own declared schema says cannot exist. Nothing later
re-validates it, so the violation persists across restarts and replicates outward.

## Why it happens

An INSERT statement's plan builds exactly one set of row constraint checks, and they are
INSERT-shaped: `buildConstraintChecks(…, RowOpFlag.INSERT, …)` in `planner/building/insert.ts`.
They live in a `ConstraintCheckNode` that sits *above* the DML executor and sees only the
proposed insert row.

The DO UPDATE arm never reaches that node's verdict for the row it actually writes. It runs
inside the executor (`executeUpsertUpdate` in `runtime/emit/dml-executor.ts`), composes its own
row, and calls `vtab.update` directly. There is no UPDATE-shaped check anywhere on that path —
so `RowOpFlag.UPDATE` CHECKs, NOT NULL, and child-side FK existence probes simply never run.

This is why the arm needed its own generated-column recompute as well (that half landed
separately, in `bug-upsert-do-update-ignores-generated-columns`) — and it means a generated
column recomputed by that pass is likewise never CHECK-validated against its new value.

## Expected behavior

Taking the DO UPDATE arm must be equivalent, constraint-wise, to running the corresponding
`UPDATE`:

- a composed row failing a CHECK (row-level or column-level, `RowOpFlag.UPDATE`-scoped) aborts
  the statement with the same diagnostic the plain UPDATE gives;
- a NULL in a NOT NULL column aborts the same way;
- a child-side foreign key whose new value has no parent aborts the same way, and parent-side
  FK actions fire on the same terms as an ordinary UPDATE;
- the `OR ABORT/FAIL/IGNORE/ROLLBACK` conflict-resolution semantics of the enclosing statement
  apply to a violation raised here exactly as they do to one raised on the insert arm;
- a violation leaves no partial write behind (the statement-level savepoint already in
  `runWithStatementSavepoints` should cover this once the check throws in the right place).

`DO NOTHING` writes nothing and needs no new validation. The insert arm's existing
INSERT-shaped checks must keep working unchanged.

## Scope notes for whoever picks this up

- The check has to run against the **post-recompute** row — i.e. after the generated-column
  second pass in `executeUpsertUpdate`, not before it.
- The view-write decomposition path (`planner/mutation/decomposition.ts`) synthesizes
  `on conflict … do update` statements internally, so whatever lands here starts applying to
  view and lens writes too. That is the correct direction, but it may surface previously
  silent violations in those suites.
- Both `on conflict … do update` arms of a multi-clause statement need the same treatment;
  each clause composes its own row.

## Use cases to exercise

- CHECK, NOT NULL and FK violations through DO UPDATE, each asserted to produce the *same*
  error as the equivalent plain UPDATE, with a follow-up SELECT proving nothing was written.
- A DO UPDATE whose SET is fine but whose **generated-column recompute** produces a
  CHECK-violating or NULL value in a NOT NULL generated column.
- A satisfying DO UPDATE still succeeding (no over-rejection), including one whose WHERE
  clause skips the row entirely.
- Multi-row upsert where an early row updates cleanly and a later one violates — the whole
  statement rolls back under the default ABORT.
- The same violations under `insert or ignore … on conflict … do update`, to pin how the
  statement-level OR clause composes with a violation from this arm.
