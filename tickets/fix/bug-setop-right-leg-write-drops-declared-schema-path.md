---
description: A view can name the schemas its tables should be looked up in. When such a view is built from two queries combined with `union`, updating through it works for the first query but fails with "table not found" for the second — the second half forgets which schemas the definition asked for.
files:
  - packages/quereus/src/planner/mutation/set-op.ts                   # rightBranchSelect (~646-657) and leftBranchSelect (~602-606) — the asymmetry; buildBranch (~660-713) assembles the branch view-like
  - packages/quereus/src/planner/mutation/body-context.ts             # bodyPlanningContext — where a branch body acquires its planning path
  - packages/quereus/src/planner/building/select-compound.ts          # the read path, which threads the declared path into both legs through the context
  - packages/quereus/test/view-home-schema.spec.ts                    # `reaches the LEFT leg of a membership set-op definition that declares a path` — the passing half; the right-leg case belongs beside it
  - docs/view-updateability.md                                        # § Schema resolution during write-through
repro: verified
difficulty: medium
---

# A set-operation view's non-leading legs lose the definition's declared `with schema` path on write

A `select` can end in `with schema a, b`, naming the schemas its unqualified table names
resolve against. When the select is a set operation (`union` / `intersect` / `except`), the
clause binds to the **whole compound** and the parser attaches it to the leading leg's
statement node — legs after the first never carry it themselves.

On **read** that is fine: the compound builder plans both legs under one context that
already has the declared path, so every leg sees it.

On **write** each leg is lowered separately, through its own synthetic branch view-like
whose body is that leg's statement. The left branch's body is a spread of the compound's
root node, so it keeps the declared path by accident. The right branch's body is a spread of
the right operand, which never had it — so that branch plans on the view's plain home path
and any unqualified name that only the declared path reaches fails to resolve.

## Reproduction

Verified on the current tree.

```sql
create table main.sl (id integer primary key, x integer);
create table main.sr (id integer primary key, x integer);
create table temp.ok (id integer primary key);
insert into main.sl values (1, 10);
insert into main.sr values (2, 20);
insert into temp.ok values (1), (2);

create view main.sv as
  select id, x from sl
  with schema "temp", main
  union exists left as inl, exists right as inr
  select id, x from sr where id in (select id from ok);

select * from main.sv;                                -- both rows — the read is fine
update main.sv set x = x + 1 where inr = true;
```

```
Table 'ok' not found in schema path: main
  Did you mean: temp.ok?
  Or add 'temp' to your WITH SCHEMA clause
```

The suggestion is misleading — the definition does name `temp`.

Moving the same sub-query to the **left** leg makes the identical statement succeed, which is
what makes the failure look arbitrary from outside:

```sql
create view main.sv2 as
  select id, x from sl where id in (select id from ok)
  with schema "temp", main
  union exists left as inl, exists right as inr
  select id, x from sr;

update main.sv2 set x = x + 1 where inl = true;                     -- works
```

## Why it happens

`analyzeSetOpBranches` (`planner/mutation/set-op.ts`) splits the compound into two branch
view-likes:

- `leftBranchSelect(sel)` spreads the compound's **root** node, dropping only `compound` /
  `orderBy` / `limit` / `offset` — so `schemaPath` survives into the left branch body, and
  `buildSelectStmt` applies it when the branch is planned.
- `rightBranchSelect(compound.select)` spreads the **right operand**, whose `schemaPath` the
  parser deliberately suppresses (`isCompoundSubquery` in `parser.ts` — the clause belongs
  to the compound, like a trailing `order by`). So the right branch body has no path of its
  own, and `bodyPlanningContext` → `storedBodyContext` gives it the plain home path.

Nothing about the branch's *fragments* is at fault — the fragment marker
(`AST.StoredBodyEnv`, delivered by `bug-view-write-body-schema-path-not-carried`) is inert
inside a branch body, because that body's context already is the home environment. The
missing piece is the branch **body**'s own path.

The same asymmetry should be checked for the flag-less predicate-honest set-op path, which
builds its legs from `shape.legSelects` in `buildFlaglessLeg` (same file) — legs 2..n there
come from the same suppressed-clause operands.

One tempting shortcut does **not** work. The right operand node does carry a stamped
`storedBodyEnv` (whose `schemaPath` is the declared path), so it looks like the fragment
marker could simply be honoured even when the at-home guard says "no swap needed". It
cannot: that guard is also what stops a sub-select nested inside a fragment that has its
*own* `with schema` clause from having the body's declared path re-imposed over the
enclosing fragment's — which is the read path's precedence, and is pinned by
`lets a fragment sub-select's OWN 'with schema' outrank the carried path` in the same spec.
The branch **body**'s own path is the thing to fix.

## Expected behavior

Every leg of a set-operation view resolves its unqualified names on the definition's declared
`with schema` path when it has one, exactly as the read of the same view does — regardless of
which leg the name sits in. A definition with no `with schema` clause keeps today's home-path
behaviour byte-for-byte.

## Tests

`packages/quereus/test/view-home-schema.spec.ts` already pins the left-leg half, in
`a view definition carries its declared 'with schema' path into write-through lowering` →
`reaches the LEFT leg of a membership set-op definition that declares a path`, whose comment
names this ticket. The right-leg case belongs directly beside it. Worth covering both the
`exists`-membership shape above and the flag-less literal-discriminator shape, and both
`update` and `delete`.
