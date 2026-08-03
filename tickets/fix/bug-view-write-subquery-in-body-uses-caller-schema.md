---
description: Updating or deleting through a view whose definition contains a sub-select fails with a "table not found" error, or quietly changes the wrong number of rows, because that sub-select is looked up in the writer's schema instead of the view's own.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildBaseOp (~1276) — plans the lowered base statement on the caller's context
  - packages/quereus/src/planner/mutation/scope-transform.ts        # transformScopedExpr / transformScopedQuery / cloneExpr — where body-derived fragments are copied into the base statement
  - packages/quereus/src/planner/mutation/single-source.ts          # filterPredicate (body WHERE) + writableSites base-term exprs
  - packages/quereus/src/planner/mutation/body-context.ts           # the existing home-path gate — covers the body PLAN, not the lowered statement
  - packages/quereus/test/view-home-schema.spec.ts                  # where the write-through home-schema cases are pinned
repro: verified
---

# A sub-select inside a view definition is resolved on the writer's schema path

A view's definition is stored, so every unqualified table name in it belongs to
the view's own schema first — its "home schema". Reads follow that rule, and as
of `bug-view-write-through-ignores-home-schema` the *plan* of the body during a
write does too.

But a write through a view is not executed as the body plan. It is **lowered**
into an ordinary INSERT / UPDATE / DELETE against the base table, and pieces of
the view definition are copied into that lowered statement: the view's own
`where` clause, and the expression behind each view column. That lowered
statement is then planned against the **caller's** schema path
(`buildBaseOp`). Any *table name inside a sub-select* in those copied pieces is
therefore looked up on the caller's path, not the view's.

A plain column reference survives this because the lowering already rewrites it
to a fully-resolved base column. A sub-select does not — its `from` names ride
through verbatim.

## Two symptoms, one cause

**Arm 1 — hard failure for a view outside `main`.** The lookup misses entirely:

```sql
create table temp.a (id integer primary key, x integer);
create table temp.b (id integer primary key);
create view temp.va as select id, x from a where id in (select id from b);

update temp.va set x = 99 where id = 1;   -- Table 'b' not found in schema path: main
delete from temp.va where id = 1;         -- Table 'b' not found in schema path: main
insert into temp.va (id, x) values (2, 20);  -- OK (the insert path does not copy the predicate)
```

`select * from temp.va` works. `view_info('va')` reports
`is_updatable = YES, is_deletable = YES`. So the static surface and the read
both promise a write that then throws — the same surface/behaviour disagreement
the earlier ticket fixed for simpler bodies.

Reproduced (verified, current tree) for every writable body shape, so it is not
specific to the simple single-table case: single-source view, join-bodied view,
membership set-op view, and a view whose `from` is fully qualified but whose
sub-select is not (`select id, x from temp.qa where id in (select id from qb)`)
— that last one shows the failure comes from the copied predicate, not from
planning the body.

It also fires when the *user's* clause mentions a view column whose defining
expression is a correlated sub-select:

```sql
create view temp.gv as select id, x, (select lbl from gl where gl.id = gt.id) as lbl from gt;
update temp.gv set x = 77 where lbl = 'one';   -- Table 'gl' not found in schema path: main
```

**Arm 2 — silent wrong row set, even in `main`.** When the caller's path *does*
reach a same-named table, no error is raised and the write simply affects the
wrong rows:

```sql
create table main.lt (id integer primary key, x integer);
create table main.ls (id integer primary key);
insert into main.lt values (1, 10);
insert into main.ls values (1);
create table temp.ls (id integer primary key);          -- empty, same name
create view main.lv as select id, x from lt where id in (select id from ls);

pragma schema_path = 'temp,main';
select * from main.lv;                    -- [{id:1, x:10}]  (read binds main.ls)
update main.lv set x = 99 where id = 1;   -- reports success
select * from main.lt;                    -- [{id:1, x:10}]  — nothing was updated
```

The read saw the row; the write matched nothing, because the copied
`id in (select id from ls)` bound `temp.ls`. Nothing is reported. This arm is
**pre-existing** — verified by disabling the home-path swap from
`bug-view-write-through-ignores-home-schema` and re-running: identical outcome.
That ticket did not cause it and does not cover it.

## Expected behavior

- A table name inside a sub-select that came from the view's stored definition
  resolves on the view's home-schema path (its schema first, then the database
  default path) — exactly like every other name in that definition, and exactly
  like the read.
- The writing statement's *own* sub-selects keep resolving on the caller's path.
  A user's `where id in (select id from side)` must still bind the caller's
  `side`, and an `insert … select` source must still bind the caller's tables.
  Both are pinned today in `test/view-home-schema.spec.ts`.
- An ephemeral DML target — a CTE name or an inline `update (select …) as v`
  — is part of the caller's statement, not a stored object, so *all* of its
  names stay on the caller's path. Also already pinned there.

## Why the existing gate does not extend to this

`bodyPlanningContext(ctx, view)` swaps the schema path for the *whole* planning
context. The lowered base statement is a mix — caller-authored clauses and
definition-derived fragments in one AST — so no single path is correct for it.
The resolution has to be decided per fragment, at the point the definition's
expressions are copied (the `scope-transform.ts` clone/substitute helpers are
the one place every such copy passes through), rather than by swapping the
context around the plan.

Whichever approach is chosen, the caller-path cases above must stay green.
