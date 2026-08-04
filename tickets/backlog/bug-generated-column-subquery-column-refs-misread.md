----
description: A computed column whose formula looks up a value in another table is rejected, or wrongly reported as circular, whenever the formula mentions one of that other table's column names without spelling out which table it belongs to.
files:
  - packages/quereus/src/schema/table.ts   # extractGeneratedColumnDependencies (~line 1318) — the depth-blind AST walk; and the ADD COLUMN pre-flight sibling (~line 1417) with the same shape
  - packages/quereus/test/logic/41.14-alter-add-column-subquery-backfill.sqllogic   # arm 10 documents the qualified-name workaround
  - docs/sql-alter.md   # § ADD COLUMN carries a note describing the current limitation
repro: verified
difficulty: medium
----

# Generated-column dependency check misreads names inside subqueries

## What goes wrong

A `generated always as (<expr>)` column may contain a subquery that reads another table.
The engine works out which of the *own* table's columns that expression depends on, so it
can order the computations and detect genuine circular definitions. That analysis walks the
whole expression without tracking which table each name is bound to. Every bare (unqualified)
column name anywhere inside the expression — including deep inside a subquery, where it
plainly belongs to the subquery's own table — is read as a reference to the table being
defined.

Two user-visible consequences, both reproduced:

**1. False rejection.** A name that exists only on the other table is reported missing:

```sql
create table d (k integer, v integer);
create table t (
  id integer primary key,
  g  integer generated always as ((select v from d where d.k = id limit 1))
);
-- Error: Column 'v' referenced by generated column 'g' not found in table 't'
```

**2. False circularity.** Two generated columns whose subqueries each mention the *other's*
name — but bound to the other table, so no real dependency exists — are refused as a cycle:

```sql
create table d (a integer, b integer);
create table t (
  id integer primary key,
  a  integer generated always as ((select b from d limit 1)),
  b  integer generated always as ((select a from d limit 1))
);
-- Error: Cyclic dependency in generated columns: 'a', 'b'
```

A subtler third case follows from the same defect and was not separately reproduced: when a
bare inner name *coincides* with a real own-table column, the walk records a dependency edge
that does not exist. That cannot produce a wrong value on its own (it only over-constrains
the evaluation order), but it can produce a false cycle exactly as above.

## Why it happens

`extractGeneratedColumnDependencies` (`packages/quereus/src/schema/table.ts`) traverses the
generated expression's syntax tree and, for every `column` / `identifier` node, looks the
name up in the table being defined. It already skips a name qualified to a *different* table
(`d.v`) — its own comment says such names "belong to an outer scope (e.g. a scalar
subquery's source)" — but an unqualified name gets no such treatment, because the walk has
no notion of which scope it is currently inside. A near-identical walk in the `ALTER TABLE
ADD COLUMN` pre-flight in the same file has the same shape.

## Scope and workaround

Not specific to `ALTER TABLE` — `CREATE TABLE` rejects the identical expression, so both
declaration paths are affected. Qualifying the inner reference (`select d.v from d …`)
avoids it today, and `docs/sql-alter.md` § ADD COLUMN records that as the current
workaround; `test/logic/41.14-alter-add-column-subquery-backfill.sqllogic` arm 10 pins the
qualified form as working.

## Expected behaviour

The dependency analysis should only count names that actually bind to the table being
defined. A name resolved by an enclosed subquery's own sources is not a dependency of the
generated column on its own table, whether or not it is written with a qualifier, and must
neither be rejected as unknown nor contribute an edge to the cycle check. A genuine typo in
a name that binds to the defined table must still be rejected at declaration time, as it is
today — that behaviour is the reason the check exists and should not be lost.

## Found by

Review of `bug-alter-add-column-relation-default-fails-to-emit` (see
`tickets/complete/`), while probing whether that ticket's newly-exposed backfill
expressions handled correlated subqueries. They do; this is a separate, older defect in the
generated-column dependency analysis, independent of that fix.
