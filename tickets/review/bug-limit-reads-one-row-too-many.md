---
description: A query with LIMIT used to read one more row than it returned; it now reads exactly what it returns, and a LIMIT placed over something that writes rows no longer cuts the writing short.
files:
  - packages/quereus/src/runtime/emit/limit-offset.ts               # the whole fix
  - packages/quereus/test/runtime/early-stop-consumption.spec.ts    # new — the generalized "consume what you emit" spec
  - packages/quereus/test/logic/13.13-limit-over-dml-subquery.sqllogic # new — LIMIT over a writing source, end to end
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts   # BOUNDARY_ROWS 2 -> 1, comment rewritten
  - docs/sql-select.md                                              # § Query expressions — drain rule now names LIMIT
repro: verified
difficulty: medium
---

# `LIMIT n` no longer consumes row `n + 1`

## What changed

`packages/quereus/src/runtime/emit/limit-offset.ts` tested its counter at the **top** of
the loop, so `for await` had already asked the source for one more row before the `break`
fired. Every `LIMIT n` pulled `n + 1` rows; `LIMIT 0` pulled one.

Two changes, both in that one file:

**Arm 1 — stop pulling at the last row emitted.** The limit test moved below the `yield`
(`yield row; if (++emitted >= limit) break;` — the shape `ordinal-slice.ts` already used),
and a `limit <= 0` early return before the loop so a zero limit never touches the source.
Row counts are now exactly `offset + limit`.

**Arm 2 — a LIMIT never truncates a writing source.** `subtreeHasSideEffects(plan.source)`
is evaluated once at emit time (the same gate `emitExists` / `emitScalarSubquery` use).
When it is true, the emitter stops *yielding* at the limit but keeps *consuming* the
source, so the DML underneath runs to completion. This is the option the fix ticket
recommended: it lines the FROM-subquery case up with the data-modifying-CTE case
(`13.6`), the scalar / `IN` / `EXISTS` cases, and PostgreSQL. A pure source pays nothing
for the gate — one subtree test at emit, not per row.

## Measured, before and after

Memory backend, table `t` with 4 rows, `rowsScanned` from `Statement.getWorkCounters()`:

| statement | returns | pulled BEFORE | pulled NOW |
|---|---|---|---|
| `select k from t limit 1` | 1 | 2 | 1 |
| `select k from t limit 2` | 2 | 3 | 2 |
| `select k from t limit 0` | 0 | 1 | 0 |
| `select k from t limit 2 offset 1` | 2 | 4 | 3 |

The write case from the fix ticket:

```sql
select * from (insert into dst select k, k*10 from src returning k) limit 1;
```

returns 1 row and now leaves **4** rows in `dst` (was 2 — an artifact of the extra pull,
defensible under no reading).

## How to exercise it

- `yarn workspace @quereus/quereus run test:single packages/quereus/test/runtime/early-stop-consumption.spec.ts`
  — the generalized spec. Drives a `CountingMemoryModule` table (`rowCounts` counts rows
  actually pulled through `query()`, at the engine-to-module boundary) through each
  early-stopping consumer and asserts **exact** equality, not a bound.
- `yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep 13.13`
  — the end-to-end semantics: rows returned *and* rows landed in the target table, for
  INSERT / UPDATE / DELETE bodies under `LIMIT 1`, `LIMIT 0`, and `LIMIT 2 OFFSET 1`.
- `yarn test` and `yarn lint` from the repo root. Both clean (10191 passing in
  `packages/quereus`, 0 failing; lint clean across all workspaces).

## Where the fix ticket's plan and reality diverged

**The ticket's expected count for `IN` was wrong, and the spec does not pin it.** The
ticket's table said `select 1 where 3 in (select k from counting)` should pull 3 (stop on
the matching row). Measured, it pulls all 6: an uncorrelated, read-only `IN` source takes
`runSetProbe` in `subquery.ts`, which materializes a lookup set once per execution and so
must read every row. That is a build, not an over-read. The spec therefore:

- pins the **correlated** `IN` (`where p.x in (select k from counting where p.x > 0)`) at
  3, which is the streaming path that genuinely short-circuits — the predicate references
  only the outer row, so it does not push down and shrink the scan; and
- adds an explicit contrast case pinning the uncorrelated form at the full 6, labelled
  "by design — do not fix this to 3", so a future reader does not re-file it.

A scalar subquery with `LIMIT 1` was added to the table (pulls 1) since it exercises the
fixed path through a different consumer.

**`OrdinalSlice` is still not covered**, as the ticket predicted: the memory backend
defers `supportsOrdinalSeek` (TODO near `src/vtab/memory/module.ts:574`), so there is no
honest way to drive it from a test module. Its early stop lives in its own emitter's
streaming guard and is unverified by this ticket.

## Known gaps — treat these as the review's starting points

- **Arm 2 is a semantics call, not a bug fix.** "A LIMIT over a writing source drains the
  write" is now pinned in three places (the new sqllogic file, one case in the new spec,
  `docs/sql-select.md`). If a reviewer disagrees with the choice, the disagreement is
  with the recommendation in the fix ticket, not with the code — the alternative (LIMIT
  truncates the insert) is a one-line change plus three test edits.
- **Negative and NULL limits were deliberately not touched.** `limit -1` and `limit null`
  still clamp to 0 (`limit = 0` when the value is negative or non-finite), which is what
  `94.1` and `104` pin today. Separate ticket: `backlog/bug-null-limit-returns-no-rows`.
  Note the interaction Arm 2 creates: `limit -1` over a **writing** source now drains and
  writes everything, where before it wrote one row. No test pins either answer; whichever
  way the negative-limit ticket lands should decide it.
- **Store mode was not run.** `yarn test:store` re-runs the logic corpus against the
  LevelDB store module and takes long enough to be out of scope for a ticket run. The new
  `13.13` file uses only plain tables and DML, so it should be backend-neutral, but that
  is reasoning, not a measurement.
- **Benchmarks were not run** (too slow for a ticket run). A grep of
  `packages/quereus/bench/suites/` found no SQL-level `LIMIT` workload that records work
  counters: the only `limit` hits are `parser.bench.mjs` (parse-only — its header states
  it declares no counters, since no `Database` is involved) and store-layer key-window
  options in `store.bench.mjs` (`{gte, lt, limit: 1}`), which are the store scan API, not
  `LimitOffsetNode`. So no reference baseline in `bench/reference/*.json` should move —
  unmeasured, but the grep is the whole surface.
- **`work-counter-tables.spec.ts` was confirmed, not assumed.** Its `limit 2` case asserts
  a range (`at.least(2)`, `lessThan(ROW_COUNT=5)`); the new count of 2 satisfies both. It
  is now pinned at its lower bound, so it no longer discriminates much — worth a look.
- **The `minmax-index-boundary` comment was rewritten, not renumbered.** It previously
  documented the over-read as expected behaviour and named this ticket. `BOUNDARY_ROWS` is
  now `1` and the comment explains why (the limit is tested after the yield).

## Tripwire parked

- `runtime/emit/limit-offset.ts` — a `NOTE:` at the drain branch: rows swallowed after the
  limit still travel the whole pipeline between the write and the LIMIT (projections,
  filters), so a `LIMIT 1` over a writing source pays for every row. Correct and
  unavoidable while the write must complete; the note names pushing the drain down to the
  mutation node as the fix *if* an expensive projection over a large DML ever profiles hot.
