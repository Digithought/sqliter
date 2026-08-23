---
description: A query with LIMIT always fetches one more row than it returns, which wastes a read on every such query and, when the thing being limited also writes rows, actually writes one row too many.
files:
  - packages/quereus/src/runtime/emit/limit-offset.ts   # the loop that pulls one row past the last it emits
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts   # BOUNDARY_ROWS = 2 encodes today's behaviour
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The wasted read is small and has been there since the beginning, and the write case needs an unusual query shape, so a maintainer could defer it; against that, changing the row counts later means revisiting every test that pinned the current numbers, and the fix is a few lines.
---

# `LIMIT n` consumes row `n + 1` before stopping

## What happens

The code that applies `LIMIT` loops over its input, emits rows until it has emitted enough,
and only then stops. Because the check happens at the top of the loop, it has already asked
the input for one more row by the time it decides to stop. So `limit 1` pulls two rows,
`limit 10` pulls eleven, and so on.

Two consequences:

**Wasted work on every LIMIT query.** One extra row is fetched and discarded. Normally
negligible, but it doubles the cost of the smallest possible read: the optimizer's new
"answer `min(c)` / `max(c)` by reading one row at the end of an index" rewrite is supposed
to touch a single row and touches two. The test for that rewrite currently pins the number
`2` and explains why.

**One extra row of writes, when the limited thing writes.** Quereus allows a data-modifying
statement to be used as a source. Verified on the memory backend:

```sql
create table t (k integer primary key, v integer);
create table src (k integer primary key);
insert into src values (1),(2),(3),(4);

select * from (insert into t select k, k*10 from src returning k) limit 1;
```

Returns one row, as asked — but leaves **two** rows in `t`. Neither reading of what this
query should do produces two: either the LIMIT stops the insert after one row (one row in
`t`), or the insert runs to completion and the LIMIT only trims the output (four rows in
`t`). Two is purely an artifact of the extra pull.

## Expected behaviour

`LIMIT n` must not ask its input for row `n + 1`. `LIMIT 0` must not ask for any row at
all. The row counts a query touches should equal the row counts it needs.

## Scope note

The concern is more general than this one operator: *anything* that stops early should not
consume past the last row it uses. `LIMIT` is the instance that was measured. Worth
checking the same way while fixing it: the ordinal-slice operator the optimizer can
substitute for a `LIMIT`, and `exists` / `IN` subqueries, which also stop as soon as they
have their answer. A shared regression test — "an early-stopping operator over a
row-counting source consumes exactly what it emits" — would cover the whole set rather than
just this site.

## Fallout to expect

Fixing this changes observed row counts, so tests that recorded the current behaviour need
updating in the same change. The one that names it explicitly is
`test/optimizer/minmax-index-boundary.spec.ts` (`BOUNDARY_ROWS = 2`, with a comment saying
why); a sweep for other work-counter assertions is part of the job.
