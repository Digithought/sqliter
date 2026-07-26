---
description: Dropping a column that a CHECK rule mentions is allowed, and afterwards the table can no longer be written to — every insert fails complaining about a column that no longer exists.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # runDropColumn — has guards for generated columns and partial-index predicates, none for CHECK
  - packages/quereus/src/planner/building/constraint-builder.ts       # buildConstraintChecks — where the unresolvable column raises
  - packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic  # §7a covers a CHECK surviving an UNRELATED drop only
difficulty: medium
---

# DROP COLUMN of a column named by a CHECK leaves the table unusable

## Reproduction

```sql
create table T (id integer primary key, a integer, b integer, check (b > a));
insert into T values (1, 1, 2);

alter table T drop column a;   -- accepted, no error
insert into T values (2, 5);   -- error: column 'a' not found (raised at plan build)
```

The drop is accepted; afterwards every insert (and any update that re-checks the
constraint) fails while the plan is being built, because the CHECK expression still names
the removed column. `select` still works, so the table is readable but not writable.

Confirmed on the memory module at commit `9807aed1`.

## Why it happens

`DROP COLUMN` validates several dependents already — it refuses to drop a primary-key
column, a column a generated column's expression depends on, and a column named in a
partial index's `WHERE` clause. A CHECK constraint's expression is the same kind of
dependent and is not examined; the constraint is carried through the drop verbatim by both
modules and only fails later, at statement-build time.

## Expected behavior — a decision is needed

- **Reject the drop** with a clear message naming the constraint, `StatusCode.CONSTRAINT` —
  directly parallel to the existing partial-index guard, and to what SQLite does. This is
  the more likely right answer: a CHECK is user-authored logic, and dropping it as a side
  effect of removing one of its inputs quietly discards a rule the user wrote.
- **Drop the CHECK along with the column**, matching what the engine does for a UNIQUE
  constraint and a foreign key over the dropped column.

Either way `docs/sql-ddl.md`'s `DROP COLUMN` section should state the rule, and the case
needs coverage in both memory and store modes (the store persists the table's DDL, so a
broken constraint survives a reopen).

## Note on scope

A CHECK that does *not* name the dropped column already survives correctly — that is
covered by `41.4-alter-add-column-constraints.sqllogic` §7a. Only the case where the
expression names the dropped column is broken.
