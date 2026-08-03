---
description: A view definition can name the schemas its tables live in. Reading such a view works, but updating or deleting through it can fail with "table not found" — the write forgets which schemas the definition asked for.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # buildViewMutation — the mapNestedSelects stamp (~117-128)
  - packages/quereus/src/parser/ast.ts                               # SelectStmt.storedHomeSchema / storedBodyCTEs — the existing lowering-only markers
  - packages/quereus/src/planner/building/select.ts                  # buildSelectStmt (~73-115) — consumes the markers, applies stmt.schemaPath after
  - packages/quereus/src/planner/stored-body-context.ts              # storedBodyContext — sets schemaPath to the home path
  - packages/quereus/test/view-home-schema.spec.ts                   # nearest existing coverage
  - packages/quereus/test/view-cte-isolation.spec.ts                 # the sibling fragment-resolution suite
repro: verified
---

# A view definition's own `with schema` clause is lost when writing through the view

A SELECT can end with a `with schema a, b` clause naming the schemas its unqualified
table names should be looked up in, and a view definition is a SELECT, so a view can
carry one. On **read** the clause is honoured. On **write** — an `update` / `delete` /
`insert` through the view — it is honoured for the definition's own `from` sources but
**not** for any sub-query inside the definition, so the write and the matching read
disagree about which tables exist.

## Reproduction (run on the current tree)

```sql
create table main.a (id integer primary key, x integer);
create table temp.t (id integer primary key);
insert into main.a values (1, 10);
insert into temp.t values (1);

create view main.vq as
  select id, x from a where id in (select id from t)
  with schema "temp", main;

select * from main.vq;              -- [{id: 1, x: 10}]  — `t` resolves in temp

update main.vq set x = 48 where id = 1;
```

fails with

```
Table 't' not found in schema path: main
  Did you mean: temp.t?
  Or add 'temp' to your WITH SCHEMA clause
```

`main.a` is unchanged. The suggestion is misleading: the definition *does* have a
`with schema` clause naming `temp`.

The same failure appears for a sub-query that reads a block defined in the definition's
own leading `with` clause:

```sql
create view main.vp as
  with c as (select id from t) select id, x from a where id in (select id from c)
  with schema "temp", main;
```

A definition with **no** sub-query is fine — `create view main.vz as select id, x from t
with schema "temp", main` updates correctly — which is what makes the failure look
arbitrary from outside.

## Root cause

One site: the marker `buildViewMutation` stamps on each definition fragment
(`planner/building/view-mutation-builder.ts`, the `mapNestedSelects` call). Writing
through a view is *lowered* into a plain statement against the base table, and pieces of
the definition are copied into it. Each copied piece is tagged with the view's **schema
name** (`AST.SelectStmt.storedHomeSchema`) so it re-enters the view's own naming
environment, and `buildSelectStmt` turns that tag into the view's *home* search path via
`storedBodyContext`. The definition's declared `with schema` path lives on the
definition's top-level SELECT node, which is not one of the copied pieces — so it is
never consulted for them. The definition's own `from` sources escape the bug only
because they are planned from that top-level node, which still carries the clause.

Note this is independent of the recently-landed carry of the definition's leading `with`
clause (`bug-view-write-body-cte-not-carried-into-lowering`) — the first reproduction
above has no `with` clause at all. It has been latent since the fragment tagging landed
(`bug-view-write-subquery-in-body-uses-caller-schema`).

## Expected behavior

A sub-query copied out of a view definition resolves its unqualified names exactly as it
does when the view is read: the definition's declared `with schema` path when it has one,
the view's home path otherwise. Both reproductions above should update the row, matching
what `select * from` the same view returns. A definition without a `with schema` clause
must keep today's home-path behaviour unchanged.

## Notes for the fix stage

- The definition's leading `with` clause is already carried onto each fragment as a
  second marker (`AST.SelectStmt.storedBodyCTEs`), stamped in the same place. The
  declared path is the same shape of problem and probably wants the same treatment —
  but check whether a third marker is the right answer or whether the two should be
  folded into one "carried definition environment" object, since they are always
  stamped and consumed together.
- Whichever way it goes, the carried path must apply **before** a fragment's own
  `with schema` clause (a fragment can have one, and it should still win) and before the
  carried `with` clause's definitions are built — those definitions resolve their own
  sources through the same path on the read path.
- `fix/bug-view-write-subquery-shadow-analysis-wrong-schema` is the *analysis*-side
  sibling of this: it resolves fragment `from` sources against one fixed schema rather
  than any path. The two answer the same question ("which path does this fragment
  resolve on") at different sites and should end up reading one answer, not two.
