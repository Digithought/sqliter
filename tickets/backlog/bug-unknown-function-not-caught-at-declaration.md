---
description: A table can be created with a rule or computed column that calls a function which does not exist. Nothing complains until someone tries to write a row, and then every write to that table fails.
files:
  - packages/quereus/src/schema/manager.ts   # validateCheckConstraintDeterminism (~2311) skips a function it cannot find; buildTableSchemaFromAST (~1877) runs no function check over generated bodies
  - packages/quereus/src/planner/building/alter-table.ts   # the ALTER path, which does catch it
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Rejecting a function the registry does not know at declaration time assumes the registry is fully populated whenever a schema is declared or reloaded — which is not obviously true for plugin-registered or late-registered functions, so tightening this could make a schema that loads today fail to load.
---

# A typo'd function name in a `CHECK` or generated column is not caught until the first write

## What goes wrong

Two kinds of table-level expression are stored at `CREATE TABLE` without ever being
checked for whether the functions they call exist:

```sql
create table cf (id integer primary key, a integer check (nosuchfn(a) > 0));
-- accepted
insert into cf (id, a) values (1, 1);
-- ERR: Function not found: nosuchfn/1

create table f (id integer primary key, a integer,
                x integer generated always as (nosuchfn(a)) stored);
-- accepted
insert into f (id, a) values (1, 1);
-- ERR: Function not found: nosuchfn/1
```

Both verified against the engine. In each case the table is created and every subsequent
write to it fails, permanently. A column `DEFAULT` with the same typo *is* rejected at
`CREATE TABLE`, and `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (nosuchfn(a))`
is rejected at declaration time too — so the behavior is inconsistent across the surfaces
that can introduce the same mistake.

## Why it happens

`SchemaManager.validateCheckConstraintDeterminism` walks the CHECK body looking for
function calls and asks the registry about each one — but when the registry does not
know the name, it simply moves on (it is looking for a *non-deterministic* function, and
an unknown function is neither). Generated bodies get no function walk at all at
`CREATE TABLE` time. `DEFAULT` bodies are different because their validator builds the
expression, and building is what surfaces an unknown function.

## Why this is filed rather than fixed

The obvious change — treat "function not in the registry" as a declaration error at the
same two sites — rests on an assumption nobody has checked: that the function registry
is always fully populated at the moment a schema is declared *and* at the moment a
persisted schema is reloaded. Plugin-provided and application-registered functions may
not be. If a schema is reloaded before its plugin registers its functions, tightening
this turns a table that works today into a table that fails to load.

Someone picking this up should establish the registration ordering first, and decide
whether the check belongs at declaration time for user-authored DDL only (leaving the
reload path permissive), before writing any code.

## Related

`implement/2-bug-nondeterministic-generated-column-accepted-at-create-table.md`
adds a determinism validator over generated bodies at `CREATE TABLE` and explicitly
leaves this hole open; it is the natural place to hang the fix once the ordering
question above is settled.
