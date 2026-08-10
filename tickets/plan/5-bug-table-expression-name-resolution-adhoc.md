description: Expressions written into a table's own definition — a computed column's formula, a CHECK rule — have their column names worked out by hand-rolled scanning instead of by the engine's normal name resolution, so perfectly legal spellings are rejected, misread as circular, or make the table impossible to write to.
files:
  - packages/quereus/src/planner/building/insert.ts               # createGeneratedColumnProjection (~224) — registers bare column names only
  - packages/quereus/src/planner/building/alter-table.ts          # ~295-330 — the ADD COLUMN backfill build, fails the same way
  - packages/quereus/src/planner/building/update.ts               # ~150-240 — the UPDATE path, which DOES accept the qualified form
  - packages/quereus/src/schema/table.ts                          # extractGeneratedColumnDependencies (~1318) — the depth-blind AST walk; ADD COLUMN pre-flight sibling (~1417) has the same shape
  - packages/quereus/src/planner/building/constraint-builder.ts   # ~84 registers the bare parameter name, ~130/~147 register the bare column name, into the same scope
  - packages/quereus/src/planner/scopes/registered.ts             # ~45 — the throw
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic   # arm 10 documents the qualified-name workaround
  - docs/sql-alter.md                                             # § ADD COLUMN carries a note describing the current limitation
  - docs/sql-ddl.md                                               # § 2.6.2 Mutation Context — documents both parameter spellings as supported
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Each arm has a documented workaround (spell the name the other way), so a maintainer may reasonably treat this as a documentation problem; routing these expressions through the real scope machinery is a bigger change than three targeted patches.
----

# Table-attached expressions resolve names by hand instead of through a scope

An expression that lives *in the schema* — a `generated always as (…)` formula, a
`check` constraint, a column `default` — has to be analysed at CREATE time (to order
computations and detect cycles) and rebuilt at write time (to compute the value). At
both points the engine builds a **flat set of bare column names** and matches against
it, rather than resolving through the query scope machinery that every other
expression in the engine goes through.

Three consequences, all verified, all resolving at that decision.

## The invariant that retires the class

Resolve table-attached expressions through the same scope objects the planner already
builds for a query over that table: qualified names bind to the table, subquery bodies
resolve against the subquery's own source, and the mutation-context namespace is a
distinct scope rather than more entries in the column scope. Once names come from a
scope, "which table does this name belong to" stops being a question each call site
answers for itself.

## Arm A — a generated column that qualifies its own table's column (verified)

```sql
create table z (
  id integer primary key,
  a  integer,
  g  integer generated always as (z.a * 2) stored
);
-- accepted

insert into z (id, a) values (1, 1);
-- Error: z.a isn't a column
```

The table can never hold a row. `alter table z add column h integer generated always
as (z.a + 1)` fails identically. Removing the `z.` prefix makes everything work, and
nothing warns at declaration time — `extractGeneratedColumnDependencies` lets the
qualified form through. `createGeneratedColumnProjection` registers bare column names
only; the UPDATE path (`building/update.ts`) *does* accept the qualified form, so the
same expression works or not depending on which statement reaches it.

## Arm B — a generated column whose subquery names another table's columns (verified)

The dependency walk descends the whole expression without tracking which table each
name is bound to, so every bare name — including deep inside a subquery, where it
plainly belongs to the subquery's own table — is read as a reference to the table
being defined.

*False rejection:*

```sql
create table d (k integer, v integer);
create table t (
  id integer primary key,
  g  integer generated always as ((select v from d where d.k = id limit 1))
);
-- Error: Column 'v' referenced by generated column 'g' not found in table 't'
```

The same walk also reports false circularity when the inner table's column name
happens to match another generated column on the outer table. Spelling every inner
name qualified is the documented workaround
(`41.14-alter-add-column-subquery-backfill.sqllogic` arm 10, and a note in
`docs/sql-alter.md`).

## Arm C — a mutation-context parameter sharing a column name (verified)

Quereus lets a table declare per-statement parameters alongside its columns
(`docs/sql-ddl.md` § 2.6.2 Mutation Context), readable from CHECK constraints and
defaults, and documents **both** the qualified spelling (`context.tenant_id`) and the
bare one (`tenant_id`) as resolving.

`constraint-builder.ts` registers the bare parameter name (~84) and the bare column
names (~130/~147) into the **same** scope. If a parameter's name matches one of the
table's own columns, `CREATE TABLE` is accepted and then every insert, update and
delete on that table fails with the internal duplicate-registration throw from
`scopes/registered.ts` (~45) — a message that names neither the parameter nor the
column.

## Notes for whoever picks this up

- Arms A and B are both about generated columns and both bottom out in
  `schema/table.ts`; they are the natural first slice.
- Arm C is the only arm that is a hard "table is unwritable" with no workaround other
  than renaming the parameter, but it needs a decision on which spelling wins when the
  two collide — document it either way.
- The create-time half of this belongs in the same pre-flight as the sibling ticket
  `bug-ddl-accepts-definitions-that-break-first-write`.
