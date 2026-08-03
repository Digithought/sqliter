---
description: Writing through a view can wrongly reject the statement, or change the wrong rows, when a sub-query in the statement (or in the view's own definition) reads a table that lives in a schema other than the default one.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts        # tableSourceColumnNames (~466), collectFromColumnNames (~426)
  - packages/quereus/src/schema/manager.ts                          # getTable (~1653) / getView (~758) — both ignore a schema path
  - packages/quereus/src/planner/mutation/single-source.ts          # makeBaseQualifier (~266), makeViewColumnDescend (~418) — the two callers that pass the caller's context
  - packages/quereus/test/view-home-schema.spec.ts                  # nearby write-through coverage
repro: verified
---

# The write-through sub-query analysis looks up tables in the wrong schema

Before a write through a view can be lowered onto its base table, the planner
analyses every sub-query in the statement to decide, for each column reference
inside it, whether that reference belongs to the sub-query's own `from` sources
or is a reference reaching *outward* to the view's row. Getting that wrong
either aborts the statement or silently rewrites it to mean something else.

The analysis answers "which columns does this `from` source have?" by looking the
source's name up in **one fixed schema** — the connection's current schema,
normally `main`. It consults neither the session's schema search path nor, for a
piece of the view's own definition, the schema the view lives in. So the moment
the real source lives anywhere else, the analysis is working from the wrong
table's column list (or from no table at all) while the query actually executes
against the right one.

Both failures below are reproduced on the current tree.

## Arm 1 — a sub-query in the user's own statement is wrongly rejected

The table is perfectly resolvable; it is just reached through the session schema
path rather than sitting in `main`:

```sql
pragma schema_path = 'temp,main';
create table temp.t (id integer primary key, x integer);
create table temp.side (tag text primary key, id integer);
create view temp.v as select id, x from t;

update temp.v set x = 99 where exists (select 1 from side where side.id = id and x > 0);
```

fails with

```
cannot write through view 'v': the reference 'id' inside a subquery cannot be
proven correlated to the view because the subquery's source columns are not
statically resolvable (a 'select *' / table-valued function / unresolved
source); qualify the reference with its base table or alias, or restructure the
predicate
```

`temp.side` is not a `select *`, not a table-valued function and not unresolved —
the same statement with every object in `main` succeeds. The diagnostic is
telling the user to restructure a predicate that is fine.

## Arm 2 — a sub-query inside the view's definition changes meaning

Here the analysis reaches a *different* table of the same name and concludes the
opposite of the truth, so the lowered statement is rewritten wrongly:

```sql
create table temp.gt (id integer primary key, x integer);
create table temp.gl (id integer primary key, lbl text);
create table main.gl (gid integer primary key, lbl text);   -- same name, no `id`
create table main.side (tag text primary key);
insert into temp.gt values (1, 10), (2, 20);
insert into temp.gl values (1, 'one'), (2, 'two');
insert into main.side values ('one');
create view temp.gv as select id, x, (select lbl from gl where id = 1) as lbl from gt;

select id, x, lbl from temp.gv;
-- [{id:1,x:10,lbl:'one'}, {id:2,x:20,lbl:'one'}]   — `id` reads temp.gl's `id`

update temp.gv set x = 77 where exists (select 1 from side where side.tag = lbl);
-- QuereusError: Scalar subquery returned more than one row
```

The read binds `id` to `temp.gl.id`, so the sub-query returns one row. The
lowering, having sized up `gl` as `main.gl` (which has no `id`), decides `id`
must be an outward reference to the row being updated and re-points it at the
update target — the lowered predicate becomes `(select lbl from gl where
__vm_self.id = 1)`, which is no longer single-row. With a slightly different
column layout the same mis-decision produces no error at all, only a different
row set than the matching read.

## Root cause

One site: the `from`-source column lookup that feeds the analysis,
`tableSourceColumnNames` in `planner/mutation/scope-transform.ts`. It calls
`schemaManager.getTable(schemaName, name)` / `getView(schemaName, name)`, and
both of those fall back to the connection's **current schema** when the name is
unqualified (`schema/manager.ts`) — they take no search path. When the lookup
misses, the analysis marks the scope unresolvable and Arm 1's rejection follows;
when it hits the wrong same-named object, Arm 2's silent mis-rewrite follows.

The two callers that reach it — `makeBaseQualifier` and `makeViewColumnDescend`
in `mutation/single-source.ts` — both hand it the **caller's** planning context.
That is right for the user's own clauses (which should follow the session path,
once the lookup honours a path at all) but wrong for a fragment copied out of the
view's definition, which must follow the view's home schema path, exactly as the
already-landed `bug-view-write-subquery-in-body-uses-caller-schema` made the
*plan-time* resolution of those fragments do. That fix moved plan time to the
home path and left this analysis behind, so the two now disagree.

## Expected behavior

The analysis must resolve a `from` source's identity the same way the executing
plan does:

- a source named in the user's own clauses resolves through the session schema
  path (and any statement-level `with schema`), not through one fixed schema;
- a source named inside a fragment copied out of the view's definition resolves
  through the **view's** home schema path;
- a genuinely unresolvable source (`select *`, a table-valued function, an
  unknown name) keeps today's conservative treatment — that path is correct and
  must not be weakened.

Arm 1's statement should update the matching rows. Arm 2's update should affect
the same rows the matching `select` returns.

## Notes for the fix stage

- The two view-mutation sibling defects `bug-view-write-lineage-subquery-base-table-qualifier`
  and `bug-view-write-body-cte-not-carried-into-lowering` live in the same
  descent machinery but at different sites (qualifier spelling and the body's own
  `with` clause respectively); check for overlap before choosing where the
  resolution knob goes.
- Whatever carries the "which path do I resolve on" answer has to survive into
  the analysis the same way the plan-time answer does — the landed fix marks the
  AST node (`AST.SelectStmt.storedBodyEnv`, an `AST.StoredBodyEnv` carrying the
  home schema, the body's declared `with schema` path, and the body's own leading
  `with` clause) rather than swapping the context, because the lowered statement
  mixes caller-authored and definition-derived fragments in one tree. The analysis
  walks that same tree, so the whole naming environment is already there to read
  off one field.
- Worth checking whether the same fixed-schema lookup hurts the multi-source
  (join-body) analogue in `mutation/multi-source.ts`, which shares the descent.
