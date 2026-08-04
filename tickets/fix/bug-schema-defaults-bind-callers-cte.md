----
description: A column's default value (or a check rule) written in a table's definition can accidentally read a temporary named result set that the surrounding query happened to give the same name, silently storing the wrong value.
files:
  - packages/quereus/src/planner/building/insert.ts             # createRowExpansionProjection call site + buildConstraintChecks/buildNotNullDefaults/buildChildSideFKChecks calls
  - packages/quereus/src/planner/building/update.ts             # passes its CTE-aware updateCtx to buildConstraintChecks — the same leak, one line
  - packages/quereus/src/planner/building/constraint-builder.ts
  - packages/quereus/src/planner/building/foreign-key-builder.ts
  - packages/quereus/src/planner/stored-body-context.ts         # the existing "clear the caller's namespace" helper
repro: verified
----

# A table's own DDL expressions can bind an enclosing statement's common table expression

## What goes wrong

A column `default`, a generated-column expression, a `check` constraint and a foreign-key
check are all written in the **table's definition**, not in the statement doing the write.
Their unqualified relation names should always mean real schema objects. Today they are
built on a planning context that still carries the *calling* statement's common table
expression definitions, so a caller can shadow a real table out from under someone else's
DDL — and the write silently stores a different value.

```sql
create table c (k integer primary key);
insert into c values (1), (2), (3);

create table p (id integer primary key);
insert into p values (10);

-- t's default is written against the real table c, which has 3 rows.
create table t (id integer primary key, w integer default (select count(*) from c));

with c as (select id from p),
     b as (insert into t (id) values (1) returning id)
select count(*) as n from b;

select id, w from t;
-- actual:   [{"id":1,"w":1}]   <- bound the caller's `c` (1 row from p)
-- expected: [{"id":1,"w":3}]   <- the real table c
```

No error, no warning — just a wrong stored value.

## Where it comes from

Quereus already has the right idea for view and materialized-view bodies:
`storedBodyContext` (`planner/stored-body-context.ts`) deliberately **clears** the caller's
common-table-expression namespace when re-entering a stored body, precisely so a caller
cannot shadow names inside DDL-authored SQL. Column defaults, generated columns, `check`
constraints and foreign-key checks are the same *kind* of thing — stored, schema-authored
SQL — but do not go through that clearing.

Concretely, in `buildInsertStmt` the schema-authored builds receive
`contextWithSchemaPath` / the incoming `ctx`, and **both inherit `ctx.cteNodes`** from any
enclosing statement. The statement's *own* leading `with` clause is already correctly kept
out of them (fixed by `bug-insert-stmt-context-not-threaded`, and pinned by a control case
in `test/logic/13.8-insert-with-clause-visibility.sqllogic`); it is only the **inherited**
definitions that still leak. `buildUpdateStmt` leaks a little more: it passes its
CTE-aware `updateCtx` to `buildConstraintChecks`, so an update leaks the statement's own
`with` clause into `check` constraints too.

The path became reachable when data-modifying common table expressions started inheriting
their siblings' definitions through the planning context
(`bug-dml-cte-body-cannot-see-sibling-cte`, completed).

## Expected behavior

Schema-authored expressions resolve their unqualified names exactly as they do on the read
path — against the schema, never against any statement's temporary named result sets,
whether declared by this statement or inherited from an enclosing one. A caller naming a
temporary result set `c` must not change what `default (select count(*) from c)` means.

The natural shape is a small "schema-authored context" helper that clears `cteNodes` (the
same thing `storedBodyContext` already does for view bodies), applied at the four
schema-authored call sites in `insert.ts` and the one in `update.ts`. Worth checking
`delete.ts` and the view-mutation lowering for the same pattern while in there.

## Scope note

Deliberately **out of scope** for `bug-insert-stmt-context-not-threaded` (now in
`review/`), which threaded the statement's *own* `with` clause into the *user-authored*
clauses only and left the schema-authored builds exactly as it found them. This ticket is
the other half: taking the inherited definitions back out of the schema-authored builds.
The two do not conflict.
