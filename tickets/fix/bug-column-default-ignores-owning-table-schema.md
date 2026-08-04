---
description: When a column's default value is written as a query, the engine looks up the tables it names using whatever database the *writing* statement is pointed at, instead of the one the table itself lives in — so the same table definition can read different data depending on who inserts into it. Rule checks on the very same table already resolve the correct way, so one table definition can disagree with itself.
files:
  - packages/quereus/src/planner/building/schema-authored-context.ts  # the shared helper; today it clears CTEs but leaves the schema path alone
  - packages/quereus/src/planner/building/insert.ts                   # createRowExpansionProjection call — defaults + generated columns
  - packages/quereus/src/planner/building/update.ts                   # generated-column recompute, buildNotNullDefaults
  - packages/quereus/src/planner/building/constraint-builder.ts       # buildConstraintChecks / buildNotNullDefaults — the check arm already narrows
  - packages/quereus/src/planner/building/foreign-key-builder.ts      # both FK builders already narrow
  - docs/schema.md                                                    # § stored bodies resolve against their home schema — states the rule for checks/FKs, silent on defaults
repro: verified
---

# A column default resolves relation names on the writer's schema path, not the table's own

## What happens

A table in the `temp` schema whose column default and check constraint each read the
same unqualified name `c`, with a `c` in both schemas:

```sql
create table main.c (k integer primary key);
insert into main.c values (1);                      -- 1 row
create table temp.c (k integer primary key);
insert into temp.c values (1), (2), (3);            -- 3 rows

create table temp.t (
  id integer primary key,
  w  integer default (select count(*) from c),
  check ((select count(*) from c) = 3)
);

pragma schema_path = 'main';
insert into temp.t (id) values (1);
select id, w from temp.t;    -- [{"id":1,"w":1}]
```

The insert succeeds — so the `check` read `temp.c` (3 rows), the table's own schema. The
default stored `w = 1` — so it read `main.c`, the writer's path. Two expressions written
side by side in one table definition, resolving the same name to two different tables.

Verified at `bd71b3c9` with a scratch test against a fresh `Database` (memory backend).

The same statement path is reachable per-statement, not only via the session pragma: an
`insert … with schema <name>` sets the path for that one statement and the default
follows it.

## Why

`buildConstraintChecks` and both foreign-key builders narrow the planning context to
`[tableSchema.schemaName]` themselves before compiling the table's own SQL. The default
and generated-column builds have no equivalent narrowing: `createRowExpansionProjection`
(`building/insert.ts`) is handed the statement's `with schema` context, and the
`buildNotNullDefaults` / generated-column-recompute sites are handed the caller's bare
context. Either way the path is the *writer's*, never the table's.

`schemaAuthoredContext` (`building/schema-authored-context.ts`) is the natural single
site: it is already the one wrapper every schema-authored build passes through, and its
header comment records the omission deliberately — it clears the common-table-expression
namespace and documents leaving `schemaPath` alone as a separate question. This ticket is
that question, and the answer is now observed rather than hypothetical.

## Expected behaviour

Every expression written in a table's own definition — column `default`, generated
column, `check`, foreign-key probe — resolves unqualified relation names against the
owning table's schema, whatever path the writing statement runs on. Concretely, the repro
above must store `w = 3`.

`docs/schema.md` already states this rule for check and foreign-key bodies ("they resolve
against the owning table's schema *only*, with no default-path fallback"); it is silent
on defaults and generated columns, and should state the same rule for them once the
behaviour matches.

## Notes

- If the fix lands in `schemaAuthoredContext`, the builders' own narrowing becomes
  redundant — worth collapsing so there is one place that decides, but check first that
  no caller depends on the builders narrowing when reached from
  `core/derived-row-validator.ts`, which builds them on a fresh context of its own.
- No `.sqllogic` coverage exists for a `with schema`-bearing write today; the schema-path
  split is currently pinned by nothing, so a fix should add an arm. `main` and `temp` are
  both available in a bare `Database`, which is enough for the collision case above.
- Prior work `bug-schema-defaults-bind-callers-cte` (in `tickets/complete/`) built the
  shared helper and fixed the *common-table-expression* half of the same leak. It
  explicitly scoped the schema-path half out, on the basis that no wrong answer had been
  observed; the repro above is that wrong answer.
