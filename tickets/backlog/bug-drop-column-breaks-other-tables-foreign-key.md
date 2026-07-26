---
description: Dropping a column that another table's foreign key points at is allowed, and afterwards that other table can no longer be written to at all — every insert or update fails with a confusing "referenced column not found" error.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                     # runDropColumn — validates generated-column deps and partial-index predicates, but no cross-table check
  - packages/quereus/src/schema/table.ts                                 # resolveReferencedColumns — throws when the parent column name is gone
  - packages/quereus/src/planner/building/foreign-key-builder.ts         # buildChildSideFKChecks — the caller that raises
  - packages/quereus/test/logic/41.10-alter-drop-column-foreign-key.sqllogic  # child-side coverage; parent side has none
difficulty: medium
---

# DROP COLUMN of a parent column leaves the referencing table unusable

## Reproduction

```sql
pragma foreign_keys = true;
create table Parent (pid integer primary key, refd integer unique);
create table Child  (id integer primary key, c integer references Parent(refd));
insert into Parent values (1, 100);
insert into Child  values (1, 100);

alter table Parent drop column refd;   -- accepted, no error
insert into Child values (2, 100);     -- QuereusError: Referenced column 'refd' not found in table 'Parent'
```

The drop succeeds silently. From then on `Child` cannot be inserted into or updated —
the failure is raised while *building the plan*, before any row is touched, so the whole
table is effectively write-locked. `select` still works. The error names a column the
user just deliberately removed from a *different* table, giving no hint about what to do.

Confirmed on the memory module at commit `9807aed1`.

## Why it happens

A foreign key stores its parent columns as **names**, resolved against the parent's
current shape on every write (`resolveReferencedColumns`). That name resolution is what
makes the child-side renumbering fix safe — but nothing checks, at drop time, that some
other table still needs the name.

`DROP COLUMN` already refuses when the column is a primary-key column, when a generated
column's expression depends on it, and when a partial index's `WHERE` clause names it.
The cross-table foreign-key case is the one dependent it does not consider.

## Expected behavior — a decision is needed

Two defensible answers; pick one and apply it consistently:

- **Reject the drop** (SQLite's answer for the whole family) with a clear message naming
  the referencing table and constraint — e.g. *"Cannot drop column 'refd' from 'Parent':
  it is referenced by foreign key '\_fk\_child\_c' on table 'Child'"*, `StatusCode.CONSTRAINT`.
  Consistent with the existing partial-index and generated-column guards.
- **Drop the referencing key too**, matching the rule the engine applies on the child side
  (a key that loses a column it needs is removed, not narrowed). Cheaper for the user but
  silently weakens another table's constraints, which is harder to justify across tables
  than within one.

Whichever is chosen, the behavior belongs in `docs/sql-ddl.md` alongside the existing
`DROP COLUMN` rules, and needs cases in both memory and store modes (the store persists
the referencing table's DDL, so a bad state survives a reopen).

## Related

The same statement's *child*-side behavior — the dropped column being one the table's own
foreign key constrains — was fixed under `bug-drop-column-leaves-fk-child-index-dangling`.
This ticket is the mirror case and is genuinely separate: it lives in the engine's
`runDropColumn` validation, not in either virtual-table module.
