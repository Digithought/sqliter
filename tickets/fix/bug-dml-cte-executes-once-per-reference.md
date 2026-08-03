---
description: A query can name a block that inserts, updates or deletes rows and returns them; if the query mentions that block twice, the write happens twice instead of once, which usually fails with a duplicate-key error and can otherwise silently double-apply the change.
files:
  - packages/quereus/src/planner/building/with.ts                     # buildCommonTableExpr (~104-145) — builds a DML-bodied CTE and picks its materialization hint
  - packages/quereus/src/planner/cache/materialization-advisory.ts    # the pass that decides which CTEs get buffered
  - packages/quereus/src/runtime/emit/cte.ts                          # emitCTE — buffers a materialized CTE once per statement execution
  - packages/quereus/src/planner/nodes/cte-node.ts                    # CTENode — carries the hint
repro: verified
difficulty: medium
---

# A data-modifying `with` block runs once per reference instead of once per statement

## What is wrong

SQL lets a `with` clause name a statement that changes rows and hands them back:

```sql
with c as (insert into t (k) values (1) returning k) select …
```

The write inside that block must happen **exactly once** for the statement, no matter
how many times the rest of the query names `c`. Today it happens once per reference.

## Reproduced on the current tree

Run against `main` at `44e5a624`:

```sql
create table t (k integer primary key);

with c as (insert into t (k) values (1) returning k)
select (select count(*) from c) as a, (select count(*) from c) as b;
```

→ `UNIQUE constraint failed: t PK.`, and `t` is left empty (the statement aborts).

The insert is attempted twice — once for each mention of `c`. With a primary key the
duplicate is caught, so the user sees a confusing error rather than wrong data. Without
one (a table with no unique constraint, or an `update` / `delete` block whose effect is
not idempotent) nothing catches it and the change is applied twice.

A block referenced exactly once behaves correctly today, which is why this has not
surfaced before.

## Expected behaviour

The write executes once; every reference to the block reads the same set of returned
rows. That is what a buffered (materialized) block already gives — the runtime buffers a
materialized common-table expression once per statement execution. A data-modifying block
therefore needs that buffering **unconditionally**, not as an optimization the planner may
decline: whether it is applied currently depends on a row-estimate heuristic, and the
correctness of a write must not.

## Why this is filed separately

Found while implementing `bug-view-write-body-cte-not-carried-into-lowering`, which made
writes through a view carry the view definition's own `with` blocks into the lowered
statement. That work rejects a data-modifying block in a view definition outright
(`unsupported-body-cte-dml`) precisely because this defect sits underneath it — but the
defect is reachable from an ordinary read query with no view involved, as the repro above
shows, so it is not a view concern and does not resolve at that ticket's code site.

## Notes

- Whether the same rule should extend to a data-modifying block that is referenced *zero*
  times is a real question this ticket should settle: today an unreferenced block never
  runs at all, and SQL implementations differ on whether it should.
- The nearby ticket `backlog/bug-cte-cache-gate-reads-unknown-as-empty` concerns the same
  buffering decision but for a different reason (the heuristic reads a missing row estimate
  as zero). Read it before touching the advisory pass — the two arms meet there even though
  this one is a correctness bug and that one is a performance one.
