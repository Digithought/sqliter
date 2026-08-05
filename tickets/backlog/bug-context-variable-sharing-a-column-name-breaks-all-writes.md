---
description: A table can be created with a per-statement parameter whose name matches one of its own columns, but if any rule on that table reads the parameter, every insert, update and delete into that table then fails with a confusing internal message.
files:
  - packages/quereus/src/planner/building/constraint-builder.ts   # ~84 registers the bare parameter name, ~130/~147 register the bare column name, into the same scope
  - packages/quereus/src/planner/scopes/registered.ts             # ~45 — the throw
  - docs/sql-ddl.md                                               # § 2.6.2 Mutation Context — documents both spellings as supported
repro: verified
---

# A mutation-context variable that shares a column name makes the table unwritable

## What a mutation-context variable is

Quereus lets a table declare per-statement parameters alongside its columns
(`docs/sql-ddl.md` § 2.6.2 Mutation Context). The writer supplies values for them
on each statement, and CHECK constraints and column defaults can read them —
the documented use case is tenant isolation and audit trails:

```sql
create table tenant_records (
  id integer primary key, tenant_id text,
  constraint tenant_check check (new.tenant_id = context.current_tenant_id)
) using memory with context (current_tenant_id text);
```

The docs state that both the qualified spelling (`context.currentTenant`) and the
bare one (`currentTenant`) resolve.

## What happens

If a parameter's name matches one of the table's own column names, `CREATE TABLE`
is accepted — and then every write to the table fails:

```sql
create table C1 (id integer primary key, a integer,
                 constraint ck check (new.a > context.a)) using memory
  with context (a integer);

insert into C1 with context a = 3 values (1, 5);
-- ERROR: Symbol 'a' already exists in the same scope.
```

Verified against the memory module at commit `3bd01d40`. The message names no
table, no constraint, and no statement element the user wrote; nothing in it
suggests the parameter/column collision, so the table reads as simply broken.

Note the CHECK is what triggers it. The same table *without* a CHECK accepts
writes fine — the collision only surfaces when something builds the scope that
holds both names:

```sql
create table C2 (id integer primary key, a integer) using memory
  with context (a integer);
insert into C2 with context a = 3 values (1, 5);   -- succeeds
```

## Where it comes from

`packages/quereus/src/planner/building/constraint-builder.ts` builds one scope
for the constraint expression and registers into it, unconditionally:

- the bare parameter name and `context.<name>` (~line 84 and ~87), and
- the bare column name (~line 130 for the NEW image, ~line 147 for OLD), alongside
  `new.<col>` / `old.<col>`.

`registerSymbol` refuses a duplicate key (`packages/quereus/src/planner/scopes/registered.ts`
~line 45), so the two bare registrations collide and throw while the write is being
planned.

## Expected behaviour

Two questions, and the second only matters once the first is answered:

1. **Should the collision be allowed at all?** Refusing it at `CREATE TABLE` /
   `ALTER TABLE ... RENAME COLUMN` — with a message that names both the column and
   the parameter — is the simplest honest answer, and matches how the engine
   already treats a duplicate column name. It is also a compatibility change for
   any schema that declares such a table today (all of which are already
   unwritable if they carry a CHECK, so the blast radius is small).
2. **If it is allowed, which one wins for the bare spelling?** The column is the
   more natural reading inside a constraint, leaving `context.<name>` as the only
   way to reach the shadowed parameter. That is a real decision, not a detail —
   silently picking either one changes what an existing CHECK means.

Whichever is chosen, the failure must not be an internal scope-registration error
raised at write time.

## Coverage

Needs: a collision refused (or resolved) at create time; a CHECK reading the
qualified `context.<name>` under a collision; a column rename *into* a colliding
name; and the non-colliding case staying exactly as it is.
