---
description: A table whose contents the engine derives automatically can declare per-statement parameters it has no way of ever receiving, and any rule that reads one then fails with a confusing "column not found" the first time a row lands.
files:
  - packages/quereus/src/core/derived-row-validator.ts          # ~253 and ~268 — builds the CHECK / FK expressions with no context symbols registered
  - packages/quereus/src/planner/building/mutation-context.ts   # the module that resolves context variables for ordinary writes
  - packages/quereus/src/schema/manager.ts                      # ~1916 — where a CREATE TABLE's context declarations become schema
  - packages/quereus/src/parser/parser.ts                       # ~2718 and ~3855 — both CREATE TABLE forms accept `maintained as` and `with context` together
repro: verified
severity: edge-case
likelihood: contrived
tradeoffs: Nobody has hit this — it needs a maintained table that both declares context variables and reads one from a constraint — so a maintainer may reasonably rank a clear error message below almost anything else, and rejecting the combination outright is a (currently harmless) narrowing of what CREATE TABLE accepts.
---

# What goes wrong

Quereus lets a table declare **mutation-context variables**: per-statement parameters
that the table's DEFAULT expressions and CHECK constraints can read, and that each
write supplies with a `with context <name> = …` clause.

Quereus also has **maintained tables** — `create table … maintained as <query>` — whose
rows the engine derives and keeps up to date from other tables. Nobody writes to a
maintained table directly, so no statement ever carries a `with context` clause for one.

The grammar accepts both on the same declaration. When it does, and one of the
maintained table's own CHECK constraints reads a context variable, the first derived row
to reach that constraint fails with:

```
Column not found: cap
```

Reproduced against the current tree:

```sql
create table src (id integer primary key, v integer) using memory;

create table mt (
	id integer primary key,
	v integer,
	constraint gate check (v <= cap)
) using memory
maintained as select id, v from src
with context (cap integer);

insert into src values (1, 5);   -- Column not found: cap
```

Two things are wrong at once:

- The message blames a missing *column*, which is exactly the misdiagnosis that
  ordinary writes were just fixed to stop producing — a write to a normal table now
  says `table 'main.mt' requires mutation context variable 'cap'; supply it with …`.
  The maintained-table path was not part of that fix and still reports the old shape.
- Even the improved message would be a dead end here, because there is no statement the
  user could add the clause to. The declaration is unsatisfiable by construction.

Declaring the variables without reading any of them is accepted and behaves fine — the
failure needs a constraint (or a FK probe, same path) that actually reads one.

# What should happen instead

The honest fix is to make the unsatisfiable declaration unrepresentable rather than to
improve the message at the point of failure: **reject `with context (…)` on a
`create table … maintained as …` declaration**, at DDL time, with an error saying a
maintained table's rows are derived and no statement can supply context to them.

That retires the whole class in one place — CHECK constraints, foreign-key probes, and
column DEFAULT expressions all read context variables through the same mechanism, and
all three would otherwise need their own handling in the derived-row validator.

The alternative — having the derived-row validator register the variables and bind them
all to NULL — is worth naming so it can be dismissed deliberately: it silently turns
every NOT NULL context variable into NULL and makes constraints pass or fail for reasons
the schema author never wrote down. Rejecting is the safer shape unless someone
identifies a real use for context variables on a derived table.

# Where it lives

`packages/quereus/src/core/derived-row-validator.ts` compiles a maintained table's
declared constraints once and reuses them for every derived row. It calls the same two
builders the DML pipeline uses (`buildConstraintChecks`, `buildChildSideFKChecks`) but
passes no context attributes, so the context variable names are never registered in the
constraint's scope and fall through to ordinary column resolution.

A guard at DDL time would sit alongside the other maintained-table declaration checks
rather than in that validator.
