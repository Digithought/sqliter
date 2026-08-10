---
description: A table can be created with a computed column whose formula uses a random or time-varying function, which the engine forbids. The refusal only happens later, on the first attempt to write a row, so the table exists but can never be used.
prereq: bug-generated-body-unbound-qualifier-accepted-at-create-table
files:
  - packages/quereus/src/schema/manager.ts                 # buildTableSchemaFromAST (~1877); validateCheckConstraintDeterminism (~2311) and validateDefaultDeterminism (~2222) are the two working precedents
  - packages/quereus/src/planner/validation/determinism-validator.ts  # validateDeterministicGenerated — the write-time check that currently catches it
  - packages/quereus/src/planner/building/alter-table.ts   # the ALTER path that already rejects at declaration time
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic
  - docs/sql-ddl.md                                        # ~line 375 already says determinism is checked at ALTER time
difficulty: easy
repro: verified
---

# `CREATE TABLE` accepts a non-deterministic generated column; every write then fails

## What goes wrong

A generated column's expression must be deterministic — the engine says so and enforces
it. Three of the four places that can introduce one enforce it *at declaration time*;
the fourth does not.

| declaration | non-deterministic body rejected at declaration? |
| --- | --- |
| `create table ... check (a > random())` | yes — `validateCheckConstraintDeterminism` |
| `create table ... a integer default (random())` | yes — `validateDefaultDeterminism` |
| `alter table t add column x integer generated always as (random())` | yes — the ALTER compiles the body and runs `validateDeterministicGenerated` |
| `create table ... x integer generated always as (random())` | **no** | 

The odd one out creates the table, and then every `INSERT` / `UPDATE` / upsert on it
fails with the determinism error instead. The table exists and cannot be written to.

## Reproduction (verified — output quoted)

```sql
create table r (id integer primary key, x integer generated always as (random()) stored);
-- accepted

insert into r (id) values (1);
-- ERR: Non-deterministic expression not allowed in GENERATED ALWAYS AS for column 'x'
--      in table 'r'. Expression: random(). Use mutation context to pass non-deterministic
--      values (e.g., WITH CONTEXT (timestamp = datetime('now'))).
```

The same column added by `ALTER` is refused up front and the table is left alone:

```sql
create table h (id integer primary key, a integer);
alter table h add column r integer generated always as (random());
-- ERR: Non-deterministic expression not allowed in GENERATED ALWAYS AS for column 'r' in table 'h'. …
```

## Root cause

One missing call site. `SchemaManager.buildTableSchemaFromAST`
(`schema/manager.ts` ~1877) validates the determinism of CHECK constraints and of column
DEFAULTs before the table reaches storage, but runs no determinism validation over
`GENERATED ALWAYS AS` bodies at all — only `extractGeneratedColumnDependencies` /
`topoSortGeneratedColumns`, which are reference and cycle analyses and say nothing about
functions.

`ALTER TABLE ... ADD COLUMN` gets the check for free because
`buildAddColumnBackfill` (`planner/building/alter-table.ts`) has to compile the body
anyway to backfill existing rows, and `buildGeneratedColumnExpr` ends by calling
`validateDeterministicGenerated`. `CREATE TABLE` never compiles the body.

## Shape of the fix

Add a generated-column determinism validator alongside the two that already exist in
`SchemaManager`, and call it from `buildTableSchemaFromAST` on the same pass that
extracts generated-column dependencies.

**Model it on `validateCheckConstraintDeterminism` (AST walk over function nodes,
looking up `findFunction` and testing `FunctionFlags.DETERMINISTIC`), not on
`validateDefaultDeterminism` (which builds the expression through `buildExpression`).**
The distinction is load-bearing:

- A generated body is written in terms of the table's own columns, so it cannot be built
  against a scope the schema manager has at this point — this is the same reason the
  DEFAULT validator has to reject bare columns before it builds.
- A generated body may embed a subquery that forward-references the table being created,
  or another table that has not been imported yet during a schema reload. Compiling here
  would fail on legitimate schemas. An AST-level function-flag walk has no catalog
  dependency and no ordering hazard, so it is safe on both the `createTable` and
  `importTable` paths through `buildTableSchemaFromAST`.

Honour the `nondeterministic_schema` option exactly as the CHECK and DEFAULT validators
do — the existing escape hatch must keep working, and the write-time check honours it
too.

The error text should match what the write-time `validateDeterministicGenerated` already
emits (`Non-deterministic expression not allowed in GENERATED ALWAYS AS for column '<c>'
in table '<t>'. …`) so that moving the rejection earlier does not also change what the
user reads. Note the two validators find the offending thing differently — the AST walk
knows the offending *function name*, the write-time one reports a rendered *expression* —
so an exact string match may not be achievable; matching the sentence and the column /
table naming is enough.

## Known gap this fix does NOT close

An **unknown** function in a generated body is still accepted at `CREATE TABLE` and
fails at every write (`create table f (id integer primary key, a integer,
x integer generated always as (nosuchfn(a)) stored)` → `insert` fails with
`Function not found: nosuchfn/1`). `validateCheckConstraintDeterminism` has the same
hole for CHECK bodies, so this is a shared gap and not a generated-column one; it is
filed separately as `backlog/bug-unknown-function-not-caught-at-declaration.md`. Do not
widen this ticket to cover it — treating "function not in the registry" as a declaration
error has schema-reload and plugin-registration ordering consequences that need their
own analysis.

## Test coverage to write

In `41-generated-column-errors.sqllogic`, a new section: `create table` with a
non-deterministic generated body is rejected and the table is not created; the same
declaration under `pragma nondeterministic_schema` (match however the existing suite
sets engine options) is accepted. Check whether `41-generated-columns.sqllogic` or any
spec file already creates such a table expecting success before assuming the suite is
clean — the prototype run for the prereq ticket did not exercise this path.

## Docs to update

`docs/sql-ddl.md`, *Generated Columns*: the `ALTER TABLE ... ADD COLUMN` bullet
(~line 375) currently says "Determinism is checked at `ALTER` time, before any row is
touched — `ADD COLUMN g INTEGER GENERATED ALWAYS AS (random())` is rejected there rather
than at the next INSERT", which reads as an ALTER-only property. After this change it is
true of `CREATE TABLE` as well; state it once for both.

## TODO

- Add a generated-column determinism validator to `SchemaManager`, mirroring
  `validateCheckConstraintDeterminism`'s AST-walk shape and its `allowNonDeterministic`
  parameter.
- Call it from `buildTableSchemaFromAST`, next to the existing generated-column
  dependency extraction, before the schema is returned.
- Confirm the `importTable` path through `buildTableSchemaFromAST` still loads a
  persisted schema that legitimately contains a generated body with a subquery (no
  catalog lookup was introduced).
- Add the sqllogic coverage above, including the `nondeterministic_schema` escape hatch.
- Update the determinism sentence in `docs/sql-ddl.md`.
- `yarn test` green; `yarn lint` and `yarn typecheck` clean.
