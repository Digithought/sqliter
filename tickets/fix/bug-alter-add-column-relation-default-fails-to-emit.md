---
description: Adding a column to an existing table fails outright when the column's default value is written as a query over another table — the statement errors instead of filling the new column in.
files:
  - packages/quereus/src/planner/nodes/alter-table-node.ts   # AlterTableNode.getRelations() exposes only the table reference
  - packages/quereus/src/planner/building/alter-table.ts     # where the backfill / per-row CHECK expressions are built
  - packages/quereus/src/runtime/emit/alter-table.ts         # where emit blows up on the un-rewritten subtree
repro: verified
---

# ALTER TABLE ADD COLUMN rejects any default or generated expression that reads a table

## What happens

The same default expression that works fine in `create table` fails in
`alter table … add column`:

```sql
create table d (k integer primary key);
insert into d values (1);

-- works: the value is computed and stored
create table a4 (id integer primary key, w integer default (select count(*) from d));
insert into a4 (id) values (1);          -- w = 1

-- fails
create table a1 (id integer primary key);
insert into a1 (id) values (1);
alter table a1 add column w integer default (select count(*) from d);
```

Observed errors, at `faf2d501`, on a fresh in-memory `Database`:

| statement | error |
| --- | --- |
| `add column w integer default (select count(*) from d)` | `No emitter registered for Aggregate` |
| `add column w integer default ((select k from d limit 1))` | `RetrieveNode for table 'd' was not rewritten to a physical access node. This indicates the virtual table module has no supported access method (neither supports() nor getBestAccessPlan()).` |
| `add column g integer generated always as ((select count(*) from d))` | `No emitter registered for Aggregate` |

The table is left unchanged (a following `select w from a1` reports `Column not found: w`),
so it fails cleanly — but it fails.

Both messages are the signature of a plan subtree that the optimizer never visited: the
expression stays logical, and emit then meets a logical node it has no emitter for.

## Why (likely)

`AlterTableNode` (`planner/nodes/alter-table-node.ts`) overrides `getRelations()` to return
only its `TableReferenceNode`. The ADD COLUMN backfill expression — `action.backfill.node`,
an already-built `ScalarPlanNode` — is reachable only through the action union, so it is not
an optimizer-visible child. Nothing rewrites its relational subtree to physical, and
`emitAlterTable` calls `emitCallFromPlan` on it as-is.

`action.checks.predicates[].node` (the per-row CHECK enforcement an ADD COLUMN with a
non-foldable default runs) is reached the same way and looks like the same problem, though
it was not separately reproduced.

**Scope correction (added during the review of `bug-column-default-ignores-owning-table-schema`):**
a CHECK on an ADD COLUMN is enforced by *two* different mechanisms, and only one of them is
in this ticket's blast radius.

- The **bulk** enforcement over the rows already in the table — `validateBackfillAgainstChecks`
  in `runtime/emit/alter-table.ts` — re-prepares the constraint's own SQL text as an ordinary
  `select … where not (<check>)` statement. That is a normal planned statement, so a CHECK
  reading another table works there today; verified with
  `alter table t add column x integer default 0 check ((select count(*) from c) = 3)`, which
  correctly accepts and rejects. It is unaffected by this bug.
- The **per-row** predicates (`action.checks.predicates[].node`) only exist when there IS a
  per-row backfill — i.e. exactly the non-foldable DEFAULT / GENERATED case this ticket is
  about — so they cannot be exercised until the emit problem is fixed. When it is, add an arm
  for a relation-reading CHECK alongside the relation-reading default.

Both of those sites now carry the owning-table schema narrowing (the review wrapped the
compiled predicates via `schemaAuthoredContext` and pinned the bulk scan's schema path), so
neither needs revisiting for schema resolution — only for emit.

This is the same *shape* as the already-completed
`bug-dml-side-expressions-invisible-to-optimizer`, which fixed it for `DmlExecutorNode`'s
`ON CONFLICT` expressions by exposing them as optimizer-visible children. That ticket is a
good reference for what the fix looks like here.

## Expected behaviour

`alter table t add column w <type> default (<expr>)` and the `generated always as` form
accept exactly what the equivalent `create table` + `insert` accepts, including an
expression that reads another table, and backfill every existing row with the computed
value. Same for the per-row CHECK enforcement that runs alongside the backfill.

## Notes

- Found while working `bug-column-default-ignores-owning-table-schema`; the two are
  independent (that one is about *which* schema an unqualified name in such an expression
  resolves against, this one about the expression not running at all on the ALTER path).
  There is one interaction worth knowing: that ticket applies its schema-path narrowing to
  the ALTER build site too, and explicitly cannot test that arm until this bug is fixed. A
  test added here for a relation-reading ALTER default should also cover the non-default
  schema case (an unqualified name in an `alter table temp.t add column …` default must
  resolve against `temp`), which would close that gap.
- No `.sqllogic` coverage exists for a relation-reading ADD COLUMN default today, which is
  how this stayed hidden. `test/logic/13.9-schema-authored-cte-isolation.sqllogic` is the
  nearest sibling for how these expressions get exercised.
