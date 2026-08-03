---
description: A query can silently return wrong answers from a view: if the query defines a temporary named result set (a `with` clause) that happens to share a name with one of the tables the view reads, the view quietly reads that instead of the real table.
files:
  - packages/quereus/src/planner/building/select.ts        # ~443 the view branch — passes the caller's `cteNodes` into the stored body plan
  - packages/quereus/src/planner/mutation/body-context.ts  # bodyPlanningContext — swaps the schema path but keeps the caller's CTE scope
  - packages/quereus/src/planner/mutation/single-source.ts # ~462 analyzeView plans the body on that context
  - packages/quereus/test/view-home-schema.spec.ts         # where stored-body isolation is pinned today
repro: verified
---

# A caller's `with` clause leaks into a stored view body

## What happens

A view's stored body is supposed to bind the same objects on every reference —
that is the whole point of storing it. Today the *reading statement's* common
table expressions are in scope while the body is planned, so a CTE whose name
matches one of the body's source names shadows the real table.

Verified against `main` at commit `4afccc77`:

```sql
create table main.lt (id integer primary key, x integer);
insert into main.lt values (1, 10);
create view main.lv as select id, x from lt;

select * from lv;
-- [{"id":1,"x":10}]   correct

with lt as (select 1 as id, 999 as x) select * from lv;
-- [{"id":1,"x":999}]  WRONG — the view read the caller's CTE, not main.lt
```

No error, no warning: the caller silently gets a different relation than the
view defines. Any query that happens to name a CTE after a table some view
reads is affected, however unrelated the two are.

The write path is affected by the same leak, though it fails loudly rather than
silently:

```sql
with lt as (select 1 as id, 999 as x) update lv set x = 5 where id = 1;
-- error: cannot write through view 'lv': view body operator 'CTEReference'
--        is not updateable in phase 1
```

That write should simply have updated `main.lt`. The error names an internal
plan operator the user never wrote, so it is also unactionable as a message.

A materialized view is **not** affected — reading one reads its backing table,
so no body re-plan happens on the read path.

## Why it is the same root cause as the schema-path rule

The engine already has a rule that a stored body resolves against its **own**
home schema, not the caller's (`docs/schema.md` § "Stored bodies resolve against
their home schema", `docs/sql-views.md` § Home-schema resolution). That rule
exists precisely so the caller's naming environment cannot change what a stored
body binds. The CTE namespace is the other half of that naming environment and
was never isolated. Both the read path (`building/select.ts`, which passes the
caller's `cteNodes` straight into the body plan) and the write path
(`mutation/body-context.ts`, which rewrites the schema path but hands back the
caller's scope otherwise) inherit it.

The body's **own** leading `with` clause must keep working — a view defined as
`create view v as with c as (…) select … from c` is legal and common. Only the
*caller's* CTEs must be invisible.

## Expected behaviour

- A stored view / materialized-view body binds only: its own `with` clause, and
  schema objects resolved on its home path. A caller CTE of any name is
  invisible to it.
- `with lt as (…) select * from lv` returns the same rows as `select * from lv`.
- `with lt as (…) update lv set x = 5 where id = 1` succeeds and writes
  `main.lt`, identically to the same update without the `with` clause.
- The caller's own `where` / `set` / `returning` expressions and an
  `insert … select` source keep seeing the caller's CTEs — same boundary the
  home-path rule already draws.

## Notes

- Also check the ephemeral write targets (`with c as (…) update c …` and
  `update (select …) as v …`). Those bodies are part of the caller's statement,
  so they *must* keep the caller's CTEs in scope — the fix must not isolate
  them. `bodyPlanningContext` already distinguishes them via `view.ephemeral`.
- Worth pinning both directions in `test/view-home-schema.spec.ts`: a caller CTE
  that must not leak in, and a body-local `with` clause that must still resolve.
