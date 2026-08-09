---
description: A query can name a block that inserts, updates or deletes rows; if the rest of the query never mentions that block, the write is silently skipped, where other SQL databases would still perform it.
prereq: bug-dml-cte-executes-once-per-reference
files:
  - packages/quereus/src/planner/building/with.ts     # buildWithClause / buildCommonTableExpr — builds the block, returns it in a lookup map
  - packages/quereus/src/planner/building/select.ts   # buildFrom — the only thing that pulls a block into the plan, via the lookup map
  - packages/quereus/src/planner/nodes/sink-node.ts   # SinkNode — consumes a relation for its side effects; plausible anchor
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Naming a data-modifying with-block and then never referencing it is as likely to be an authoring mistake as an intention, so a maintainer might reject the statement instead of executing the block.
---

# An unreferenced data-modifying `with` block is dropped instead of executed

## What happens

```sql
create table t (k integer primary key);
with c as (insert into t (k) values (1) returning k) select 42 as x;
```

Returns `x = 42`, and `t` is left **empty**. The insert never ran.

Verified on `main` at `ec951582`: the optimized plan for that statement contains no CTE node at
all.

## Why

A `with` block only enters the plan when something reads it. `buildWithClause` builds each block
and puts it in a name-to-node lookup map; `buildFrom` pulls a block out of that map when the query
names it. A block nobody names is simply never attached to anything, so it is never planned and
never executed. For a `select`-bodied block that is exactly right — computing it would be pure
waste. For a block that writes rows, the write is the point.

## What other engines do

SQLite and PostgreSQL both execute a data-modifying `with` block regardless of whether the outer
query reads it — the write is a stated effect of the statement, not an optimization the engine may
skip. Quereus should match.

## Expected behaviour

Executing a statement whose `with` clause contains an `insert`, `update` or `delete` block
performs that block's write exactly once, whether or not the rest of the statement names the
block. When the block *is* named, nothing about the existing behaviour changes.

## Notes

- The sibling ticket `bug-dml-cte-executes-once-per-reference` fixes the *referenced* case (the
  write currently happens once per mention). It deliberately leaves this one alone because it
  resolves at a different site: that ticket is about buffering a node that is already in the plan,
  this one is about getting a node into the plan at all. It does add a regression guard that the
  zero-reference case keeps returning its scalar result without error, so expect to update that
  guard's expectation here.
- `SinkNode` (`planner/nodes/sink-node.ts`) already exists to consume a relation purely for its
  side effects and report a row count. Anchoring an unreferenced data-modifying block under one,
  sequenced ahead of the outer query, looks like the shortest path — but that has not been tried,
  and the ordering question (does the block's write have to be visible to the outer query's own
  reads?) needs answering before anyone commits to a design.
