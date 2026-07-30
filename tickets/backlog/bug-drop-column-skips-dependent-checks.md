---
description: Dropping a column is allowed even when a rule elsewhere still depends on it, and afterwards a table can no longer be written to at all — sometimes a different table than the one that was altered.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # runDropColumn — guards primary-key, generated-column and partial-index dependents; nothing else
  - packages/quereus/src/planner/building/constraint-builder.ts       # buildConstraintChecks — where the unresolvable CHECK column raises
  - packages/quereus/src/schema/table.ts                              # resolveReferencedColumns — throws when the parent column name is gone
  - packages/quereus/src/planner/building/foreign-key-builder.ts      # buildChildSideFKChecks — the caller that raises
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic   # §7a covers a CHECK surviving an UNRELATED drop only
  - packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic # child-side coverage; parent side has none
  - docs/sql-alter.md                                                 # DROP COLUMN restrictions — line 71 is factually wrong (see below)
  - docs/sql-ddl.md                                                   # DROP COLUMN section — the rule chosen here belongs here too
difficulty: medium
---

# DROP COLUMN validates only some dependents, leaving tables unwritable

## Root cause (one bug, two symptoms)

`runDropColumn` in `packages/quereus/src/runtime/emit/alter-table.ts` validates a fixed,
incomplete set of dependents: it refuses to drop a primary-key column, a column a generated
column's expression depends on, and a column named in a partial index's `WHERE` clause.
Every other kind of dependent survives the drop verbatim and only fails much later, at
plan-build time, when something tries to write the table.

Two such dependents are known broken, and they need different work:

- a **CHECK expression on the same table** — table-local, easy to detect;
- a **foreign key in a different table pointing at the dropped column** — needs a
  schema-wide scan of other tables' parent references, medium difficulty.

In both cases the drop is accepted with no error, `select` keeps working, and every insert
or update afterwards fails while the plan is being built — before any row is touched — so
the table is effectively write-locked. In the foreign-key case the write-locked table is a
**different** table from the one the user altered, and the error names a column the user
just deliberately removed elsewhere, giving no hint about what to do.

Both were confirmed on the memory module at commit `9807aed1`.

## Arm A — CHECK constraint on the same table

```sql
create table T (id integer primary key, a integer, b integer, check (b > a));
insert into T values (1, 1, 2);

alter table T drop column a;   -- accepted, no error
insert into T values (2, 5);   -- error: column 'a' not found (raised at plan build)
```

The constraint is carried through the drop verbatim by both modules and raises in
`buildConstraintChecks`. A CHECK expression is the same kind of dependent as a generated
column's expression, and is simply not examined.

**Decision needed — pick one:**

- **Reject the drop** with a clear message naming the constraint, `StatusCode.CONSTRAINT` —
  directly parallel to the existing partial-index guard, and to what SQLite does. This is
  the more likely right answer: a CHECK is user-authored logic, and dropping it as a side
  effect of removing one of its inputs quietly discards a rule the user wrote.
- **Drop the CHECK along with the column**, matching what the engine does for a UNIQUE
  constraint and for the table's own foreign key over the dropped column.

**Scope note:** a CHECK that does *not* name the dropped column already survives correctly —
covered by `41.4-alter-add-column-constraints.sqllogic` §7a. Only the case where the
expression names the dropped column is broken.

## Arm B — another table's foreign key pointing at the dropped column

```sql
pragma foreign_keys = true;
create table Parent (pid integer primary key, refd integer unique);
create table Child  (id integer primary key, c integer references Parent(refd));
insert into Parent values (1, 100);
insert into Child  values (1, 100);

alter table Parent drop column refd;   -- accepted, no error
insert into Child values (2, 100);     -- QuereusError: Referenced column 'refd' not found in table 'Parent'
```

A foreign key stores its parent columns as **names**, resolved against the parent's current
shape on every write (`resolveReferencedColumns`). That name resolution is what makes the
child-side renumbering fix safe — but nothing checks, at drop time, that some *other* table
still needs the name. Detecting this requires scanning the whole schema for parent
references to the table being altered, which is why this arm is the harder half.

**Decision needed — pick one, consistently with Arm A:**

- **Reject the drop** (SQLite's answer for the whole family) with a message naming the
  referencing table and constraint — e.g. *"Cannot drop column 'refd' from 'Parent': it is
  referenced by foreign key '\_fk\_child\_c' on table 'Child'"*, `StatusCode.CONSTRAINT`.
  Consistent with the existing partial-index and generated-column guards.
- **Drop the referencing key too**, matching the rule the engine applies on the child side
  (a key that loses a column it needs is removed, not narrowed). Cheaper for the user but
  silently weakens *another* table's constraints, which is harder to justify across tables
  than within one.

**Related:** the same statement's *child*-side behavior — the dropped column being one the
table's own foreign key constrains — was fixed under
`bug-drop-column-leaves-fk-child-index-dangling`. Arm B is the mirror case and lives in the
engine's `runDropColumn` validation, not in either virtual-table module.

## Documentation is currently wrong — fixing it is in scope

`docs/sql-alter.md` line 71 currently ends the DROP COLUMN section with:

> A foreign key in *another* table pointing **at** the dropped column is unaffected by this
> rule: it resolves the parent column by name at enforcement time.

That claim was **verified empirically false** — name resolution at enforcement time is
exactly what makes the referencing table unwritable, not what saves it. Correcting that
sentence to state whichever rule this ticket settles on is part of this ticket's scope, not
a follow-up.

`docs/sql-ddl.md`'s DROP COLUMN section should state the resulting rule alongside the
existing restrictions.

## Coverage

Both arms need cases in **memory and store modes**. The store persists table DDL, so a
broken constraint (Arm A) or a broken referencing table (Arm B) survives a reopen.
