---
description: A query can define several named blocks up front and have later ones use earlier ones. That works when the later block only reads data, but fails with "table not found" as soon as the later block inserts, updates or deletes.
files:
  - packages/quereus/src/planner/building/with.ts     # buildCommonTableExpr — passes the CTE lookup map to the SELECT branch only
  - packages/quereus/src/planner/building/insert.ts   # buildInsertStmt — no parameter for an inherited CTE scope
  - packages/quereus/src/planner/building/update.ts   # buildUpdateStmt — same
  - packages/quereus/src/planner/building/delete.ts   # buildDeleteStmt — same
repro: verified
difficulty: medium
---

# A data-modifying `with` block cannot see its sibling blocks

## What happens

A `with` clause may define several named blocks; a later block may name an earlier one.
That holds while the later block only reads:

```sql
with a as (select id from p),
     b as (select count(*) as n from a)          -- reads sibling `a`
select n from b;                                  -- → 2, fine
```

The moment the later block writes, the same reference fails:

```sql
with a as (select id from p),
     b as (insert into q select id + 10, 1 from a returning id)
select count(*) as n from b;
-- QuereusError: Table 'a' not found in schema path: main
```

Verified on `main` at `925fdae4` for all three writing forms — `insert`, `update`
(`set v = (select count(*) from a)`) and `delete` (`where id in (select id from a)`) —
each with the same error.

A writing block *can* use a `with` clause of its own, so the failure is specifically
about inheriting the enclosing clause's blocks:

```sql
with b as (insert into q select id + 10, 1 from (with z as (select id from p) select id from z) returning id)
select count(*) as n from b;                      -- fine
```

## Why

`buildCommonTableExpr` (`planner/building/with.ts`) dispatches on the block's body kind.
The `select` branch hands the already-built sibling blocks down:

```ts
case 'select':
    query = buildSelectStmt(cteContext, cte.query, existingCTEs) as RelationalPlanNode;
```

The three writing branches call `buildInsertStmt(cteContext, cte.query)` /
`buildUpdateStmt` / `buildDeleteStmt` with no equivalent argument — and those builders
have no parameter to receive one. The sibling names are simply never in scope, so a
table reference falls through to ordinary schema lookup and reports a missing table.

## Expected behaviour

Every block in a `with` clause sees the blocks defined before it, whether its body
reads or writes. A writing block's own nested `with` clause keeps shadowing an
enclosing block of the same name, as it does today.

Once a writing block can read a sibling, one ordering question follows and needs an
answer as part of this work: if block `b` reads block `a`, and `a` also writes, does
`b` observe `a`'s write? Under the engine's read-your-own-writes model the answer is
presumably yes, but nothing pins it today.

## Related, not the same

- `bug-insert-with-clause-not-visible-in-returning` — a `with` clause on a *statement*
  is invisible to that statement's own `returning` clause. Same family (a CTE scope
  not reaching every part of a DML build), different site: that one is inside
  `buildInsertStmt`, this one is the dispatch in `buildCommonTableExpr` that never
  offers a scope at all. Fixing this one likely wants the parameter that ticket's fix
  would also benefit from, so they are worth sequencing together.
- `bug-unreferenced-dml-cte-never-runs` — also in `with.ts`, but about `buildWithClause`
  never attaching an unreferenced writing block to the plan. Independent of this.
