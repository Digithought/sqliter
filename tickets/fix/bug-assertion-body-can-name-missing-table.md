---
description: A database-wide integrity rule can be created that refers to a table which does not exist — and dropping a table does not check whether any rule still refers to it. In both cases every later write to the entire database fails, with an error that never mentions the rule.
files:
  - packages/quereus/src/runtime/emit/create-assertion.ts   # emitCreateAssertion — plans the body only to discover dependencies, and swallows the failure
  - packages/quereus/src/runtime/emit/drop-table.ts         # DROP TABLE — no assertion dependency guard
  - packages/quereus/src/core/database-assertions.ts        # AssertionEvaluator.getOrCompilePlan — where the unresolvable body finally raises, at commit
  - packages/quereus/src/schema/manager.ts                  # SchemaManager.getAllAssertions — every assertion in every schema is compiled on every commit that changed anything
  - packages/quereus/test/logic/95-assertions.sqllogic      # assertion end-to-end coverage
difficulty: medium
repro: verified
---

# An assertion can end up naming a table that does not exist, and it blocks all writes

## What happens

Quereus assertions (`create assertion <name> check (<expr>)`) are database-wide
integrity rules evaluated at commit. The evaluator compiles **every** live
assertion whenever a commit touched any table at all. So a single assertion whose
body cannot be planned takes down writes to the entire database, not just to the
table it mentions.

Two routes lead there, both verified in-process at HEAD:

**1. Creating an assertion over a table that does not exist succeeds.**

```
create assertion ax check (not exists (select 1 from nope where q < 0));
-- succeeds

create table other (i integer primary key);
insert into other values (1);
-- Table 'nope' not found in schema path: main
```

`emitCreateAssertion` does plan the body — but only to discover which base tables
it depends on, and the whole discovery is wrapped in a `try/catch` that logs a
warning and continues. That is deliberate for the dependency list (which is
informational; the evaluator recomputes its own base set). The side effect is that
a body which cannot be planned at all is accepted too.

**2. Dropping a table that an assertion still refers to succeeds.**

```
create table t ( x integer primary key );
create assertion a1 check (not exists (select 1 from t where x < 0));
create table other (i integer primary key);

drop table t;
-- succeeds

insert into other values (1);
-- Table 't' not found in schema path: main
```

Nothing guards `DROP TABLE` against assertion references. (Related but distinct:
`backlog/bug-drop-column-skips-dependent-checks` covers the *column* side and the
CHECK / FK dependents; assertions are unguarded on both verbs.)

## Why it matters beyond the direct case

This is also what keeps the declarative half of
`implement/bug-table-rename-breaks-dependent-assertions` from fully converging.
Once renames propagate into stored assertion bodies, a declaration that renames a
table but leaves its assertion body naming the *old* name will, on the following
`apply schema`, drop and recreate the assertion from the stale declaration —
silently rebinding it to the vanished table and re-breaking every write. A
create-time check turns that into a clear, actionable error at the point the bad
declaration is applied.

## Expected behavior

Creating an assertion whose body cannot resolve should fail the statement, naming
the missing table, the same way `create view` over a missing table is expected to
behave. Dropping a table an assertion still refers to should be refused (or
otherwise explicitly resolved), naming the assertion — so the error arrives at the
statement that causes the problem rather than at some unrelated later write.

## Things to settle while investigating

- **Separating "cannot plan" from "dependency discovery came up short."** The
  existing `try/catch` must keep tolerating a discovery that yields nothing useful
  (see `backlog/bug-assertion-info-dependent-tables-always-empty`) while no longer
  tolerating a body that fails to plan. Decide whether a plan failure is
  distinguishable from other errors, or whether the create path should plan the
  body separately from discovering dependencies.
- **Which errors should be fatal.** A missing table is clearly fatal. A missing
  *column*, a type error, an unresolvable function — decide the boundary and state
  it, rather than fataling on anything the planner happens to throw.
- **`DROP TABLE` policy.** Refuse while a referring assertion exists, versus some
  cascade. Refusal is the smaller, more predictable rule and matches how the engine
  treats other dependents; a cascade silently deletes a user's integrity rule.
  Whichever is chosen, the message must name both objects.
- **Ordering under `apply schema`.** `generateMigrationDDL` already emits all
  assertion drops before every other drop and all assertion creates after the
  table/view/index creates, so a well-formed declarative migration should not trip
  a new refusal. Confirm this before landing, since a false refusal here would
  break existing migrations.
- **Existing databases.** A store-backed database reopened with an already-broken
  assertion must not become unopenable — the check belongs on the DDL path, not on
  catalog load (the same carve-out the reserved-tag validation makes for
  `importCatalog`).
