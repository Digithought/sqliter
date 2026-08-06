<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-08-06T01:50:46.429Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\4-bug-schema-object-dependency-tracking.plan.2026-08-06T01-50-46-428Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Renaming or dropping something in the schema updates only some of the other objects that referred to it, and rewrites some things that were never references at all — so views, integrity rules and whole databases can silently stop working after an ordinary rename or drop.
files:
  - packages/quereus/src/schema/rename-rewriter.ts                  # renameTableInAst / renameColumnInAst / visitTableRename / tableReferencedInAst / columnReferencedInAst — the name walk shared by every arm
  - packages/quereus/src/runtime/emit/alter-table.ts                # propagateTableRenameInSchema (~2038), propagateColumnRenameInSchema (~2179), runDropColumn
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # propagateTableRenameToMaterializedViews / propagateColumnRenameToMaterializedViews
  - packages/quereus/src/runtime/emit/assertion-rename-helpers.ts   # propagateColumnRenameToAssertions
  - packages/quereus/src/runtime/emit/drop-column-guards.ts         # assertNoCheckConstraintNamesColumn — scans only the altered table's own CHECKs
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts       # assertNoAssertionDependsOn — direct references only
  - packages/quereus/src/runtime/emit/drop-table.ts                 # the drop guard call site
  - packages/quereus/src/schema/catalog-persistability.ts           # assertRenameDependentsPersistable — its view arm is scoped the same way
  - packages/quereus/src/core/database.ts                           # _homeSchemaPath — what an unqualified assertion name resolves against
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic
  - packages/quereus/test/logic/95-assertions.sqllogic
  - packages/quereus/test/logic/41.10.2-alter-drop-column-check-and-assertion.sqllogic
  - docs/sql-alter.md                                               # lines 19 / 29 enumerate what a rename propagates into
repro: verified
severity: corruption
likelihood: normal-use
tradeoffs: Building a real dependency graph is a large change to the schema layer, and each arm below can be patched on its own for a fraction of the effort — a maintainer may reasonably take the cheap per-arm fixes and leave the graph unbuilt.
----

# One weakness: schema dependencies are re-derived by walking names, not recorded

Every arm below is the same mechanism. When a schema object changes, the engine
finds the other objects that depended on it by **walking their stored SQL looking
for a matching name**, over a set of candidates chosen by hand at each call site.
There is no recorded "X depends on Y" edge anywhere.

That walk is wrong in three independent directions, and each direction produced a
separately-filed bug:

- **It under-reaches.** The candidate set is scoped to the changed object's own
  schema, and to one level of indirection, so dependents outside those bounds are
  never visited.
- **It over-matches.** The walk has no notion of scope, so a name that merely
  *looks* like the changed table — a `with`-clause name, a `new.`/`old.` row image —
  is rewritten too.
- **It is duplicated.** Each guard and each propagation site re-implements its own
  version of "does this body refer to that object", so a fix to one does not reach
  the others. `drop-column-guards.ts`, `assertion-drop-guard.ts`,
  `alter-table.ts` and `catalog-persistability.ts` each have their own.

## The invariant that retires the class

Record dependencies when an object is created, rather than re-deriving them by name
at change time:

- a resolved dependency edge per schema object (`view v` → `table main.t`, column
  set), captured at CREATE where the body is already being resolved for validation,
  and stored on the schema entry;
- rename/drop consult that edge set — every dependent, in every schema, at every
  depth — instead of walking candidate bodies;
- the AST rewriter becomes scope-aware (it must skip CTE-shadowed and row-image
  names) and is used only to rewrite the bodies the edge set already named.

That single change closes all five arms and makes a sixth hard to write.

## Arm 1 — rename propagation stops one level deep (verified, HEAD, memory module)

`ALTER TABLE t RENAME COLUMN x TO y` rewrites every view that reads `t.x`. That
rewrite also changes the name the view *publishes*. Nothing revisits the objects
reading the view.

```sql
create table w3 (id integer primary key, x integer);
create view v1 as select id, x from w3;
create view v2 as select id, x from v1;
alter table w3 rename column x to y;   -- succeeds
-- v1 body becomes: select id, y from w3   (correct)
-- v2 body unchanged: select id, x from v1 (now broken)
select * from v2;                       -- fails
```

With an assertion in place of `v2`, every later write to the database fails.

Sites: `propagateColumnRenameInSchema` (single-pass view / MV / assertion loops),
`renameColumnInAst` (rewrites against ONE renamed table, not a chain),
`propagateColumnRenameToMaterializedViews`, `propagateColumnRenameToAssertions`.

## Arm 2 — rename does not reach dependents in other schemas (verified)

`propagateTableRenameInSchema` (~2038) and `propagateColumnRenameInSchema` (~2179)
are scoped to the renamed table's **own** schema for view bodies, materialized-view
bodies, and (once `implement/bug-table-rename-breaks-dependent-assertions` lands)
assertion bodies. Foreign keys, CHECK expressions and partial-index predicates
already walk every schema — so the inconsistency is inside one statement.

An object in schema A referring to a table in schema B keeps the old name after B's
rename and silently stops working. `assertRenameDependentsPersistable`
(`catalog-persistability.ts`) has its view arm scoped the same way and widens with
the same fix.

## Arm 3 — rename over-matches names that are not references (verified, commit `4e66323f`)

`visitTableRename` (`rename-rewriter.ts`) has no scope tracking at all. Inside a
stored view or assertion body, a `with` clause named `zap` shadows a real table
`zap`; `ALTER TABLE zap RENAME TO zap2` rewrites the shadowed reference too, so the
body is left reading the *real* table under its new name and the CTE it declared
goes unused. The same over-match hits the `new.`/`old.` row-image prefixes.
`assertion-drop-guard.ts` inherits it as a *false refusal*.

The column walker already covers the row-image scope cases
(`41.10.2-alter-drop-column-check-and-assertion.sqllogic` §13/§14); the table walker
does not.

## Arm 4 — DROP COLUMN only checks the altered table's own CHECKs (verified, `8658cfdd` + arm-A/arm-C guards)

```sql
create table T (id integer primary key, v integer);
insert into T values (1, 10);
create table X (id integer primary key, n integer, check (n < (select max(v) from T)));
alter table T drop column v;   -- accepted, no error
insert into X values (1, 1);   -- Column not found: v
```

`X` is now unwritable, and the message names neither `T`, the dropped column, nor
the constraint that broke. `assertNoCheckConstraintNamesColumn` scans only the
altered table's own CHECK constraints; a CHECK may contain a subquery, so another
table's CHECK can legitimately name this column. `columnReferencedInAst` is the
probe a widened guard would use.

## Arm 5 — the assertion drop guard misses two kinds of reference (verified, HEAD, memory module)

`assertNoAssertionDependsOn` refuses a drop when an assertion body **names the
dropped object directly**. Two references defeat it:

*Through a view:*

```sql
create table t (x integer primary key);
create view v as select * from t;
create assertion av check (not exists (select 1 from v where x < 0));
create table other (i integer primary key);
drop table t;                     -- OK — the assertion names `v`, not `t`
insert into other values (1);
-- Table 't' not found in schema path: main
```

*From another schema:* an assertion living outside the dropped table's schema is
not consulted at all. `_homeSchemaPath` (`core/database.ts`) is what the bare name
resolves against.

After either drop, **every write to the whole database** fails with an error that
mentions the assertion nowhere.

## Notes for whoever picks this up

- Arms 4 and 5 are guards (refuse the statement); arms 1–3 are rewrites (fix up
  dependents). A dependency edge set serves both, but they can land in either order.
- Arm 3 is the only arm where the current behavior is *too eager*; do not "fix" it
  by widening the walk further.
- `docs/sql-alter.md` lines 19 and 29 enumerate what a rename is documented to
  propagate into and needs updating with whatever lands.
