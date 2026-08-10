---
description: Seven different places in the engine each hand-assemble the same "how to run a query" bundle before running one, and they have quietly drifted apart — some remember to reuse table connections and clean them up, some don't.
files:
  - packages/quereus/src/runtime/types.ts                                  # RuntimeContext type — the shape being hand-built
  - packages/quereus/src/core/database.ts                                  # _executeSingleStatement (~line 828) — context + drain + disconnect teardown
  - packages/quereus/src/core/statement.ts                                 # _iterateRowsRawInternal (~line 348) — the fullest version of the same shape
  - packages/quereus/src/core/database-assertions.ts                       # ~line 499 — no scanConnections, partial drain (returns on first row)
  - packages/quereus/src/core/database-materialized-views-apply.ts         # ~line 354 — no scanConnections, collects all rows
  - packages/quereus/src/core/database-materialized-views-analysis.ts      # ~line 516 — scalar, sync
  - packages/quereus/src/runtime/deferred-constraint-queue.ts              # ~line 153 — no scanConnections
  - packages/quereus/src/planner/analysis/const-evaluator.ts               # ~lines 44, 160 — scalar, sync
  - packages/quereus/src/core/derived-row-validator.ts                     # ~line 179 — scalar
difficulty: medium
tradeoffs: The seven sites are each correct today, so this buys uniformity and drift-resistance rather than fixing a live bug; a maintainer may reasonably prefer to leave working code alone until a real defect lands on one of them.
---

# Every `scheduler.run` caller hand-builds its own execution context

## What the duplication is

Running a compiled query needs an execution context — a plain object naming the database,
the bound parameters, the row/table scratch maps, the tracer, the metrics flag, the abort
signal, and (optionally) a cache of connected virtual-table instances so a repeated inner
scan connects once instead of once per outer row.

Nothing in the engine builds that object for you. Seven call sites each write the object
literal out by hand, then each decide for themselves what to do with what `scheduler.run`
returns (ignore it, drain it, collect it, yield it, cast it to a scalar):

| site | builds the connection cache? | tears it down? |
| --- | --- | --- |
| `statement.ts` `_iterateRowsRawInternal` | yes | yes |
| `database.ts` `_executeSingleStatement` | yes (added by ticket `exec-drains-row-returning-statements`) | yes |
| `database-assertions.ts` | no | n/a |
| `database-materialized-views-apply.ts` | no | n/a |
| `deferred-constraint-queue.ts` | no | n/a |
| `database-materialized-views-analysis.ts` | no (scalar, no scan) | n/a |
| `const-evaluator.ts` (×2) | no (scalar, no scan) | n/a |
| `derived-row-validator.ts` | no (scalar, no scan) | n/a |

## Why it is worth retiring

The three "no" rows that *do* iterate rows (assertions, materialized-view apply, deferred
constraints) are still **correct** — when no connection cache is present the scan emitter
falls back to owning each connection's connect/disconnect itself. They just don't get the
reuse, and nobody at those sites made that call deliberately; the field is simply missing.

That is the drift pattern: a field added to the context type reaches whichever literals
someone remembered to update. It has already happened once — the `exec` fix had to add the
cache and its teardown by copying `statement.ts`. Every new field will cost the same
seven-site sweep, and a missed site fails silently rather than loudly.

## Shape of the fix

One constructor for the context (defaults filled in, connection cache always present) and
one small set of result helpers covering the four things callers actually do with a run
result: discard it, drain it, collect it, or take it as a scalar. The connection-cache
teardown belongs inside the drain/collect helpers, so no caller can forget the `finally`.

Points to settle while doing it, not before:

- The scalar sites (`const-evaluator`, materialized-view analysis) run **synchronously** and
  must keep doing so — they throw if the plan turns out to be async. Whatever helper covers
  them cannot be `async`.
- `database-assertions.ts` stops draining after the first row (that's its whole purpose:
  "does this query return anything?"). A collect-everything helper would change its cost
  profile on a large violation set — it needs the early-exit form.
- `deferred-constraint-queue.ts` mutates two context fields (`activeConnection`,
  `tableNameRemap`) per entry and reuses one context across many runs. A constructor that
  hands back a frozen object would break it.

## Evidence

Counted with:

```
grep -rn "RuntimeContext = {" packages/quereus/src/    # 7 hand-built literals + the type decl
grep -rn "scheduler.run(" packages/quereus/src/        # 8 call sites (7 outside scheduler.ts)
```
