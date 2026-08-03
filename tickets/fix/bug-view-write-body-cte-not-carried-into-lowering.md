---
description: A view that reads fine cannot be updated or deleted through when its definition uses a named sub-query block (a "with" clause) inside its filter — the write fails saying that block's name is not a table.
prereq: bug-view-write-subquery-in-body-uses-caller-schema
files:
  - packages/quereus/src/planner/mutation/single-source.ts          # analyzeView (~434) — where the body's where/lineage fragments are extracted
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation — the one funnel that prepares the body for lowering
  - packages/quereus/src/planner/building/select.ts                 # buildSelectStmt — where a marked fragment re-enters the body's environment
  - packages/quereus/src/planner/stored-body-context.ts             # the body's naming environment (schema path + CTE namespace)
  - packages/quereus/src/planner/building/with.ts                   # buildWithClause — how CTE definitions become plan nodes
repro: verified
---

# A body's own `with` clause does not travel with the fragments copied out of it

A write through a view is lowered into an ordinary statement against the base
table, and pieces of the view definition — its `where`, and each column's
defining expression — are copied into that lowered statement. Those pieces are
copied **without** the definition's own `with` clause, so a sub-select in them
that reads a body-local named sub-query has nothing to bind to.

Reproduced on the current tree, entirely within `main`:

```sql
create table main.a (id integer primary key, x integer);
create table main.b (id integer primary key);
insert into main.a values (1, 10);
insert into main.b values (1);
create view main.vc as with c as (select id from b) select id, x from a where id in (select id from c);

select * from main.vc;                  -- [{id:1, x:10}]  works
update main.vc set x = 99 where id = 1; -- QuereusError: Table 'c' not found in schema path: main
```

`view_info` reports the view as updatable, and the read works — the same
static-surface / behaviour disagreement the sibling home-schema ticket describes.

## Relationship to the sibling ticket

`bug-view-write-subquery-in-body-uses-caller-schema` (in `implement/`) makes each
copied sub-select re-enter the view's stored naming environment: home schema
path, caller CTE namespace cleared. That closes the *silent mis-bind* half of
this defect — after it lands, a caller CTE named `c` can no longer be picked up
by mistake — but the write still fails, because the body's own `c` was never
carried along. The marker mechanism that ticket introduces (an AST field on the
copied sub-select plus a context marker consumed in `buildSelectStmt`) is the
natural place to also carry the body's CTE definitions; design on top of it
rather than inventing a second channel.

## Expected behavior

A sub-select copied out of a view definition resolves a name against the
definition's own `with` clause first, exactly as the read does — so the update
above should change `a`'s row.

Failing that, the write must be **rejected with a clear diagnostic** naming the
unsupported shape (the substrate's existing structured mutation diagnostics —
see `mutation/mutation-diagnostic.ts` — rather than a bare "table not found"
leaking from name resolution), and `view_info` must not advertise such a view as
updatable. A confusing error on a view the tooling calls writable is the part
that must not survive.

## Notes for the fix stage

- Establish the blast radius first: which body shapes with a `with` clause even
  reach the lowering. A body whose FROM *source* is a CTE is already rejected
  (`nested-view` / non-table single source); this ticket is about a CTE read from
  a body sub-select, which slips past that gate.
- If carrying the definitions: each copied fragment that references a body CTE
  would build its own copy of that CTE's plan, so a CTE referenced from two
  fragments is planned twice. Decide whether that is acceptable or whether the
  definitions should be built once and shared.
- Recursive CTEs and a body CTE that shadows a real table name are the two shapes
  worth probing before committing to a design.
