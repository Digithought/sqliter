---
description: Updating through a view fails with a confusing "column not found" error when one of the view's columns is computed by a sub-query that refers back to the view's own table by name.
files:
  - packages/quereus/src/planner/mutation/single-source.ts          # normalizeBaseRefs (~236), makeBaseQualifier / makeBaseQualifyScope (~266-312), SELF_ALIAS (~133)
  - packages/quereus/src/planner/mutation/scope-transform.ts        # transformExpr / transformScopedExpr — the descent both helpers ride
  - packages/quereus/test/view-home-schema.spec.ts                  # nearby write-through coverage
repro: verified
---

# A body lineage sub-select's base-table-name correlation dies on the lowered target alias

A view column may be computed by a correlated sub-select that reaches back to the
view's own source row. When the write-through lowering copies that expression
into the lowered UPDATE, the correlation only survives if it is re-pointed at the
lowered statement's target. Today an **unqualified** correlation is re-pointed and
a correlation qualified by the **base table's own name** is not, so the latter
fails to resolve.

Reproduced on the current tree, entirely within `main` — no schema path, no
caller CTE, nothing to do with
`fix/bug-view-write-subquery-in-body-uses-caller-schema`:

```sql
create table main.gt (id integer primary key, x integer);
create table main.gl (id integer primary key, lbl text);
insert into main.gt values (1, 10);
insert into main.gl values (1, 'one');
create view main.gv as select id, x, (select lbl from gl where gl.id = gt.id) as lbl from gt;

select * from main.gv;                          -- [{id:1, x:10, lbl:'one'}]  works
update main.gv set x = 77 where lbl = 'one';    -- QuereusError: gt.id isn't a column
```

The same view with the correlation written **unqualified** works today (rename
`gl.id` to `gl.gid` so the bare name is unambiguous, then `… where gid = id`):
the update succeeds. So the failure is specific to the qualifier spelling, not to
having a correlated sub-select at all.

## Why

The lowered UPDATE targets the base table under a synthesised collision-proof
correlation name, `__vm_self` (`SELF_ALIAS`, `mutation/single-source.ts`), so a
substituted base term inside a sub-select binds the outer target row rather than
re-binding to a same-named source in the sub-select's own FROM. Two helpers
prepare the copied lineage for that:

- `normalizeBaseRefs` strips a base-source qualifier (`gt.` / an alias) from a
  base-term reference — but it walks **top level only** (it calls `transformExpr`
  with no `descend`), so a reference inside the lineage's own sub-select keeps
  its `gt.` qualifier.
- `makeBaseQualifyScope` then re-qualifies base columns to `__vm_self` — but its
  substitution returns early for any reference that already carries a qualifier
  (`if (col.table) return undefined;`).

So `gt.id` reaches the lowered statement verbatim, where no source named `gt` is
in scope (the target is `gt as __vm_self`), and resolution fails.

## Expected behavior

A correlation inside a copied lineage sub-select that names the view's own base
source — by the table's name or by the body's alias for it — must bind the row
being updated, exactly as the unqualified spelling already does. `update main.gv
set x = 77 where lbl = 'one'` should update `gt`'s matching row.

References the sub-select's *own* FROM introduces must keep resolving locally —
that is what the existing scope-aware descent (`transformScopedExpr` /
`makeBaseQualifyScope`, and the shadow/taint model in `scope-transform.ts`) is
for, and it must not be weakened. A name that is both a base-source qualifier and
a local FROM alias inside the sub-select is the interesting case; innermost scope
wins, as elsewhere in this substrate.

## Notes for the fix stage

- Decide where the rewrite belongs: teach the base-qualifier scope to accept a
  base-source-qualified reference (mapping the qualifier to `__vm_self` when the
  qualifier is not shadowed by a local FROM alias), or make the qualifier strip
  scope-aware and let the existing unqualified path handle it. The first keeps
  one pass; the second reuses the machinery already proven for unqualified refs.
- Check the multi-source analogue (`makeSideQualifyScope` in
  `mutation/multi-source.ts`) for the same gap before choosing.
- Worth probing whether DELETE and RETURNING through such a view fail the same
  way, and whether an `insert` that evaluates the lineage (authored inverse
  puts) is affected.
