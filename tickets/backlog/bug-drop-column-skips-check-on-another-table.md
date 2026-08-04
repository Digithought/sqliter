---
description: Dropping a column is refused when a rule on the same table still mentions it, but not when the rule lives on a different table and reaches this column through a sub-query — and after such a drop, that other table can no longer be written to.
files:
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # assertNoCheckConstraintNamesColumn — scans only the altered table's own CHECKs
  - packages/quereus/src/runtime/emit/alter-table.ts          # runDropColumn — the guard call site
  - packages/quereus/src/schema/rename-rewriter.ts            # columnReferencedInAst — the unseeded probe a widened guard would use
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic  # same-table coverage; a widened guard belongs here
repro: verified
---

# DROP COLUMN only checks the altered table's own CHECK constraints

## What happens

`ALTER TABLE … DROP COLUMN` now refuses to drop a column that a CHECK constraint
**on that same table** still names, and likewise for an assertion body. It does not
look at CHECK constraints on **other** tables. A CHECK may contain a sub-query, so
another table's CHECK can legitimately name this table's column, and nothing stops
the drop.

Verified in-process at commit `8658cfdd` + the arm-A/arm-C guards:

```sql
create table T (id integer primary key, v integer);
insert into T values (1, 10);
create table X (id integer primary key, n integer, check (n < (select max(v) from T)));

alter table T drop column v;   -- accepted, no error
insert into X values (1, 1);   -- Column not found: v
```

`X` is now unwritable. Nothing in the failure message mentions `T`, the dropped
column, or the constraint that broke — the user has to work backwards from
`Column not found: v` to a table they did not alter.

## Why it was left out

The ticket that added the same-table guard (`bug-drop-column-skips-dependent-checks`)
scoped itself to arm A (a CHECK on the altered table) and arm C (an assertion body).
The cross-table arm is the same family and the same code site, but it needs a scan
that the same-table guard does not: every table in the schema, not one.

## Expected behavior

Refusing is the consistent answer — it is what the same-table CHECK arm, the
assertion arm, the generated-column guard and the partial-index guard all do, and a
CHECK expression has no "narrowed" form any more than those do. The message should
name the *other* table and its constraint, since that is the part the user cannot
guess: something in the shape of

```
Cannot drop column 'v' from 'T': it is referenced by CHECK constraint 'chk_x' on table 'X'
```

## What makes this awkward

- **Cost.** The same-table guard walks one table's constraint list. This arm walks
  every table's constraint list on every DROP COLUMN. No measurement has been taken
  of how that scales — a schema with many tables and many CHECKs is the case to
  measure before choosing between a scan and an index of "which constraints name
  which tables".
- **Which probe.** A foreign table's CHECK resolves *its own* unqualified names
  against *its own* table, so a reference to this table's column must be qualified or
  sit inside a sub-query naming this table. That is the unseeded walk
  (`columnReferencedInAst`), not the seeded one the same-table guard uses. Getting
  this wrong in either direction produces a false refusal (blocking a legal drop) or
  keeps the hole open.
- **Scope.** Same-schema only would match what the assertion arm does today; a
  cross-schema reference is the known gap tracked by
  `bug-rename-not-propagated-across-schemas`.

## Related

- `bug-drop-column-skips-dependent-checks` — the same-table CHECK + assertion arms (landed).
- `drop-column-guard-referencing-foreign-keys` — another table's FK pointing at the
  dropped column; same "the damage lands on a table the user did not alter" shape.
