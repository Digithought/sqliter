---
description: A table whose rows the engine derives automatically can declare per-statement parameters that nothing is ever able to supply; declaring one and then reading it fails with a confusing "column not found" error. Reject the impossible combination when the table is declared instead.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # ~1220 attachMaintainedDerivation (both arms funnel here), ~1627 createMaintainedTable
  - packages/quereus/src/schema/manager.ts                           # ~1938 buildTableSchemaFromAST — where CREATE TABLE's context declarations become schema
  - packages/quereus/src/runtime/emit/alter-table.ts                 # ~2099 runSetMaintained — the ALTER arm
  - packages/quereus/src/core/derived-row-validator.ts               # ~203/~253/~268 — where the bad error surfaces today (no change needed once the declaration is rejected)
  - packages/quereus/src/planner/building/mutation-context.ts        # ~35 missingContextValueError — message style to match
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic
  - docs/sql-ddl.md                                                  # ~505 "Which variables a statement must supply" bullet list
  - docs/materialized-views.md                                       # DDL statements section
difficulty: easy
---

# Background

Quereus tables can declare **mutation-context variables** — per-statement parameters
that the table's DEFAULT expressions and CHECK constraints read by bare name, and that
each write supplies with a `with context <name> = …` clause:

```sql
create table t (id integer primary key, v integer check (v <= cap))
	with context (cap integer);

insert into t values (1, 5) with context cap = 10;
```

Quereus also has **maintained tables** — tables whose rows the engine derives from a
query over other tables and keeps up to date. Nobody writes to a maintained table
directly; its rows arrive from maintenance, not from a user statement. So no statement
ever carries a `with context` clause for one, and a context variable declared on a
maintained table can never receive a value.

The two clauses combine today, and the result is unsatisfiable by construction.

# What goes wrong (reproduced against the current tree)

Two authoring routes reach the same bad state. Both fail with the same misleading
message — `Column not found: cap` — raised from
`packages/quereus/src/planner/resolve.ts` while
`packages/quereus/src/core/derived-row-validator.ts` compiles the maintained table's
declared constraints. That builder passes no context attributes, so the variable name is
never registered in the constraint's scope and falls through to ordinary column
resolution.

**Arm A — declared together on CREATE:**

```sql
create table src (id integer primary key, v integer) using memory;

create table mt (
	id integer primary key,
	v integer,
	constraint gate check (v <= cap)
) using memory
maintained as select id, v from src
with context (cap integer);
-- Column not found: cap
```

**Arm B — a plain context-declaring table later made maintained:**

```sql
create table mt (id integer primary key, v integer, constraint gate check (v <= cap))
	using memory with context (cap integer);          -- accepted on its own

alter table mt set maintained as select id, v from src;
-- Column not found: cap
```

The failure lands at DDL time in both arms (the derived-row validator is compiled when
the derivation attaches, not on the first derived row), and both arms roll back cleanly
— so today's damage is a bad diagnostic, not a corrupt catalog. But even a good message
would be a dead end here: there is no statement the user could add the clause to.

Declaring variables that no constraint or default reads is accepted today and behaves
fine — the failure needs a CHECK (or a child-side foreign-key probe, same builder) that
actually reads one.

# What should happen instead

Reject the combination where the table is declared, rather than improving the message at
the point of failure. That retires the whole class in one place: CHECK constraints,
child-side FK probes, and column DEFAULT expressions all read context variables through
the same mechanism, and each would otherwise need its own handling in the derived-row
validator.

Reject **any** context declaration on a maintained table, not only one that some
constraint reads. The "declared but unread" case is harmless today, but the distinction
is invisible to the author and drifts the moment a constraint is added; one rule is
easier to state and to document.

Two error shapes, matching the style of the existing message in
`planner/building/mutation-context.ts` (`table '<schema>.<table>' requires mutation
context variable '<name>'; supply it with …`):

- CREATE arm — e.g. `cannot create maintained table 'main.mt': a maintained table's rows
  are derived by the engine, so no statement can supply its mutation context variables
  (cap); remove the 'with context' clause`
- ALTER arm — e.g. `cannot make table 'main.mt' maintained: it declares mutation context
  variables (cap) that no statement can supply, because a maintained table's rows are
  derived by the engine`

`StatusCode.ERROR`, sited from the statement's `loc` where one is available (the CREATE
arm has `stmt.table.loc`; see the neighbouring shape-mismatch throw in
`createMaintainedTable`).

## Where the guard goes

One shared helper, two call sites. Both arms already funnel through
`attachMaintainedDerivation`, which makes it the natural backstop; the create-side call
is the early one that keeps `create table … maintained as` failing before it touches the
module or the catalog:

- **`createMaintainedTable`** (`runtime/emit/materialized-view-helpers.ts` ~1627) — call
  it on `declared` (the `TableSchema` that `sm.buildDeclaredTableSchema(stmt)` already
  builds), right beside the existing `describeAttachShapeMismatch` rejection and before
  `sm.createTable`. `TableSchema.mutationContext` carries the declarations, so the helper
  reads a schema rather than an AST and both arms can share it.
- **`runSetMaintained`** (`runtime/emit/alter-table.ts` ~2099) — call it on `live`,
  before `attachMaintainedDerivation`.

Putting it only inside `attachMaintainedDerivation` is also defensible (single site,
covers any future caller), but the CREATE arm would then reject *after* `sm.createTable`
has run and lean on that path's rollback. Prefer the two explicit call sites; if the
helper also lands inside the attach core as a belt-and-braces assertion, keep the
create-side call so the early rejection stays early.

Nothing needs to change in `core/derived-row-validator.ts` — once the declaration is
rejected, it can never see a maintained table carrying context variables.

## The alternative, dismissed deliberately

Having the derived-row validator register the declared variables and bind them all to
NULL would make the error go away, but it silently turns every NOT NULL context variable
into NULL and makes constraints pass or fail for reasons the schema author never wrote
down. Rejecting is the safer shape unless someone identifies a real use for context
variables on a derived table.

## No migration hazard

`packages/quereus/src/schema/ddl-generator.ts` never emits a `with context (…)` clause
for any table (verified — the file contains no context-clause emission at all), so no
persisted or exported schema text can carry the combination into a reload and trip the
new guard. That is a gap in its own right — context declarations are dropped from
generated DDL for *ordinary* tables too — but it is outside this ticket; do not widen
scope to fix it here. File it separately if it should be tracked.

# TODO

- Add a shared guard helper taking a `TableSchema` (schema name, table name, and
  `mutationContext`) that throws when the table declares one or more mutation-context
  variables, with the CREATE / ALTER message variants above. Home it next to the other
  maintained-table declaration gates in `runtime/emit/materialized-view-helpers.ts`, and
  export it so `runtime/emit/alter-table.ts` can call it.
- Call it in `createMaintainedTable` on the declared schema, before `sm.createTable`.
- Call it in `runSetMaintained` on the live table, before `attachMaintainedDerivation`.
- Append a section to
  `packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic`
  covering: (a) the CREATE arm rejected with the new message, (b) the ALTER `set
  maintained` arm rejected, (c) the rejected CREATE leaves the name free (mirror the
  existing "the failed create left nothing behind" assertion in that file), and (d) the
  rejected ALTER leaves the table plain and still writable with a `with context` value.
  Use that file's `-- error: <substring>` assertion form.
- Cover the "declared but never read" case explicitly in the same section — it is
  accepted today and this change rejects it, so assert the new behavior and make the
  narrowing visible.
- Docs: add a bullet to the "Which variables a statement must supply" list in
  `docs/sql-ddl.md` (~505) stating that a maintained table may not declare context
  variables, and why; note the same rule in the DDL statements section of
  `docs/materialized-views.md` (and in `docs/sql-alter.md` § SET MAINTAINED if it reads
  naturally there).
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
