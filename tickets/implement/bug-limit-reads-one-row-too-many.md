---
description: A query with LIMIT always fetches one more row than it returns, so it does extra work on every such query, and when the thing being limited also writes rows it writes a number of rows that matches neither of the two sensible answers.
files:
  - packages/quereus/src/runtime/emit/limit-offset.ts            # the loop that pulls one row past the last it emits — the whole fix lives here
  - packages/quereus/src/runtime/emit/ordinal-slice.ts           # same job, done right (`yield` then `if (++emitted >= limit) break`) — copy this shape
  - packages/quereus/src/runtime/emit/recursive-cte.ts           # also done right — its `tryYield` gate stops the recursion on the last needed row
  - packages/quereus/src/runtime/emit/subquery.ts                # `emitExists` shows the pure vs side-effecting split this fix needs (`subtreeHasSideEffects`)
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts # `BOUNDARY_ROWS = 2` and a comment naming this ticket; becomes 1
  - packages/quereus/test/vtab/_counting-memory-module.ts        # counts rows actually pulled out of a scan — the instrument for the new regression test
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic  # pins "LIMIT 0 does NOT skip the write" for a DML CTE — must still pass
  - packages/quereus/test/logic/13.11-unreferenced-dml-cte.sqllogic # same pin, prelude form
  - packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic # LIMIT/OFFSET edge cases — must still pass unchanged
  - docs/sql-select.md                                           # § Query expressions documents the full-drain rule for side-effecting inners
repro: verified
difficulty: medium
---

# `LIMIT n` consumes row `n + 1` before stopping

## Measured behaviour

Memory backend, table `t` with 4 rows, `rowsScanned` read from
`Statement.getWorkCounters()` after fully draining each statement:

| statement | rows returned | rows pulled off the scan |
|---|---|---|
| `select k from t limit 1` | 1 | **2** |
| `select k from t limit 2` | 2 | **3** |
| `select k from t limit 0` | 0 | **1** |
| `select k from t limit 2 offset 1` | 2 | **4** |

Every row count is one too high. Same run, the write case:

```sql
create table dst (k integer primary key, v integer);
create table src (k integer primary key);
insert into src values (1),(2),(3),(4);

select * from (insert into dst select k, k*10 from src returning k) limit 1;
```

returns 1 row and leaves **2** rows in `dst`.

## Root cause

`packages/quereus/src/runtime/emit/limit-offset.ts` tests the counter at the *top* of
the loop:

```ts
for await (const row of sourceRows) {
    if (skipped < offset) { skipped++; continue; }
    if (emitted >= limit) { break; }      // <- already pulled row n+1 to get here
    yield row;
    emitted++;
}
```

The `break` fires only after `for await` has asked the source for another row. `LIMIT 0`
still enters the loop once, so even a zero limit pulls a row.

Two other emitters in the same codebase already get this right and are the shape to copy:
`ordinal-slice.ts` (`yield row; if (++emitted >= bounds.limit) break;`, plus an
`if (bounds.limit <= 0) return;` guard before the loop) and `recursive-cte.ts` (its
`tryYield` gate returns "stop" on the row that satisfies the limit, not one row later).

## The two arms

### Arm 1 — stop pulling at the last row actually emitted

Move the limit test below the `yield`, and return before touching the source at all when
the effective limit is zero or less. Row counts then equal `offset + limit`, and `LIMIT 0`
touches nothing.

### Arm 2 — decide what a LIMIT over a *writing* source means

The `2 rows in dst` above is an artifact of the extra pull and is not defensible under any
reading. Arm 1 alone turns it into 1 (the insert stops when the LIMIT stops). That
contradicts semantics this engine has already pinned elsewhere:

- `test/logic/13.6-cte-dml-runs-once.sqllogic` — "LIMIT 0 does **not** skip the write":
  `with c as (insert into t14 (k) values (1) returning k) select k from c limit 0;`
  returns nothing and still leaves the row in `t14`. The comment there states the
  principle: *the statement named the insert, so the insert happens.* (That case survives
  Arm 1 by accident — the shared-CTE path buffers the body and drives it independently of
  the LIMIT — but the principle is the point.)
- `docs/sql-select.md` § Query expressions — a DML in scalar / `IN` / `EXISTS` position is
  **fully drained**, no short-circuit, gated on `physical.readonly === false`.
- PostgreSQL agrees: a data-modifying CTE runs to completion regardless of what the outer
  query consumes.

**Recommendation: make `LIMIT` match that contract.** When the source subtree has side
effects (`PlanNodeCharacteristics.subtreeHasSideEffects(plan.source)`, the same gate
`emitExists` uses), keep consuming the source after the limit is reached — just stop
yielding. The ticket's example then writes all 4 rows and returns 1, `LIMIT 0` over a
writing source writes 4 and returns none, and the FROM-subquery case lines up with the CTE
case, the subquery case, and PostgreSQL. Pure sources take the Arm 1 fast path and stop
early.

The alternative (Arm 1 for every source, so the LIMIT truncates the insert) is defensible
in isolation but leaves four sites in this engine giving three different answers for the
same question. If it is chosen anyway, say so in `docs/sql-select.md` and update the 13.6
comment, because it contradicts what is written there today.

Note the gate is a *subtree* test, so a `LIMIT` over a pure scan pays nothing: one
`subtreeHasSideEffects` call at emit time, not per row.

## Fallout to expect

- `test/optimizer/minmax-index-boundary.spec.ts` — `BOUNDARY_ROWS = 2` becomes `1`; the
  comment above it (lines ~65–80) names this ticket and must be rewritten, not just
  renumbered.
- `test/runtime/work-counter-tables.spec.ts` asserts *ranges*
  (`at.least(2)` / `lessThan(ROW_COUNT)`) for `select a from t limit 2`, so it survives —
  confirm rather than assume.
- `test/logic/94.1-limit-offset-edge-cases.sqllogic` and the limit/offset block in
  `test/logic/104-emit-mutation-kills.sqllogic` pin result *rows*, not row counts. They
  must pass unchanged. **Do not "fix" the negative/NULL-limit cases here** — that is a
  separate semantics question, filed as `backlog/bug-null-limit-returns-no-rows`.
- `packages/quereus/bench/reference/*.json` pin work counters. A grep found no SQL-level
  `LIMIT` workload in `bench/suites/`, so no baseline should move; confirm with a grep
  before concluding, and do not run the bench suite (too slow for a ticket run).

## The generalized test the ticket asks for

An early-stopping operator over a row-counting source should consume exactly what it emits.
`test/vtab/_counting-memory-module.ts` already exposes `rowCounts` (rows actually pulled
through `query()`), and six specs under `test/vtab/` use it. Add one spec — suggested
`test/runtime/early-stop-consumption.spec.ts` — that drives a counting table through each
early-stopping consumer and asserts `rowsPulled === rowsNeeded`:

| consumer | expected pulls |
|---|---|
| `select … from counting limit 2` | 2 |
| `select … from counting limit 2 offset 1` | 3 |
| `select … from counting limit 0` | 0 |
| `select exists (select 1 from counting)` | 1 |
| `select 1 where 3 in (select k from counting)` (match on row 3) | 3 |

The survey behind this ticket read the other early-stopping emitters:
`ordinal-slice.ts`, `recursive-cte.ts`, and both the `EXISTS` and `IN` paths in
`subquery.ts` all stop on the row they need — `limit-offset.ts` is the only site that
over-reads. The value of the spec is that it keeps being true, so write it against the
consumers as a set rather than against `LIMIT` alone. `OrdinalSlice` is not reachable from
the memory backend (`vtab/memory/module.ts` defers `supportsOrdinalSeek`, see the TODO
near line 574) — leave it out of the table rather than faking a module for it.

## Verifying

```
node --import ./packages/quereus/register.mjs packages/quereus/<scratch>.ts
```
runs a plain TypeScript script against the engine, which is how the numbers above were
produced (write the scratch file under the scratchpad, not into the package). Then
`yarn test` for the suite.

## TODO

- [ ] Fix the loop in `runtime/emit/limit-offset.ts`: `yield` first, then break when the
      limit is reached; return before iterating when the effective limit is `<= 0`.
- [ ] Add the side-effecting-source branch (Arm 2): after the limit is reached, keep
      draining the source without yielding when
      `PlanNodeCharacteristics.subtreeHasSideEffects(plan.source)`.
- [ ] Update `test/optimizer/minmax-index-boundary.spec.ts` — `BOUNDARY_ROWS = 1` and
      rewrite the explanatory comment (it currently documents the bug as expected).
- [ ] Add `test/runtime/early-stop-consumption.spec.ts` covering the consumer table above.
- [ ] Add a sqllogic case for a LIMIT over a DML FROM-subquery, pinning whichever Arm-2
      answer is chosen (rows returned *and* rows landed in the target table).
- [ ] Update `docs/sql-select.md` § Query expressions so the drain rule names `LIMIT` over
      a writing source alongside the scalar / `IN` / `EXISTS` cases.
- [ ] Sweep for other assertions that pinned the old counts: `grep -rn "rowsScanned\|rowCounts" packages/quereus/test`
      and `grep -rn "limit" packages/quereus/bench/suites`.
- [ ] `yarn test` and `yarn lint` from the repo root.
