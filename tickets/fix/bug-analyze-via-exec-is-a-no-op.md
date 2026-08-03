---
description: Running the "collect table statistics" command through the engine's fire-and-forget execution API does nothing at all — no error, no statistics — so queries keep being planned as if the database had never been measured.
files:
  - packages/quereus/src/planner/building/analyze.ts        # builds the ANALYZE statement; returns a bare node with nothing to force execution
  - packages/quereus/src/planner/building/pragma.ts         # line ~27: the same class of statement, solved by wrapping in a SinkNode
  - packages/quereus/src/runtime/emit/analyze.ts            # the work lives inside an async generator body
  - packages/quereus/src/runtime/emit/block.ts              # a block returns the last statement's value; nothing drains it
  - packages/quereus/src/core/database.ts                   # `exec` (~line 746) runs the scheduler and discards the block result
  - packages/quereus/test/logic.spec.ts                     # the sqllogic harness runs setup statements through `exec`
difficulty: medium
repro: verified
---

# `ANALYZE` does nothing when run through `Database.exec`

## What is wrong

`await db.exec('analyze')` returns successfully and collects **no statistics**. Every
query planned afterwards still sees the un-measured defaults. There is no error and no
warning; the only symptom is that plans do not change.

The same statement run through `db.eval` / `db.prepare` + iterate **does** work.

Verified at HEAD on the memory backend:

```ts
await db.exec('create table s (id integer primary key, k integer)');
await db.exec('insert into s values (1,2),(2,1),(3,2),(4,1)');
await db.exec('analyze');
db.getPlan('select * from s');   // IndexScan still reports rows: 0 (the "never analyzed" value)
```

Replacing the third line with `for await (const _ of db.eval('analyze')) {}` makes the
same plan report `rows: 4`.

## Why

`emitAnalyze` (`runtime/emit/analyze.ts`) is an **async generator**: connecting to each
table, collecting its statistics and writing them back onto the schema all happen inside
the generator body, which only runs while something iterates it.

Nothing iterates it under `exec`:

- `buildAnalyzeStmt` returns a bare `AnalyzePlanNode`.
- `emitBlock` makes every statement a parameter of the block instruction and returns the
  *last* statement's value — for a relational statement, that value is the un-consumed
  async iterable.
- `Database.exec` runs the scheduler and then discards the block's result without
  draining it.

DML avoids this because `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt` wrap
their result in a `SinkNode`, whose emitter drains the source. `buildPragmaStmt` does the
same thing for the *setting* form of a pragma, with the comment "wrap with SinkNode to
ensure execution" — that is exactly the guard `ANALYZE` is missing.

## The unsettled part

`ANALYZE` is not purely a command: it also **returns rows** — one `(table, rows)` row per
analyzed table — which is a genuinely useful result when a user runs it as a query. So it
cannot simply be wrapped in a `SinkNode` the way an INSERT is; that would collect the
statistics but throw the report away.

So the decision the fix has to make is *which layer* takes responsibility:

- **Make the statement self-executing.** Give `ANALYZE` a form that does its work whether
  or not the rows are consumed (e.g. collect eagerly and then yield the already-computed
  report), so it behaves correctly under every entry point. Narrow blast radius; leaves
  the general "`exec` discards the last statement's rows" behavior alone.
- **Make `exec` drain the block result.** More general — it fixes this statement and any
  future one with the same shape — but it changes what `db.exec('select …')` means (today
  it plans and emits the query but never runs it), so it needs a deliberate look at what
  else depends on that.

Please pick one and say why in the implement ticket; both are defensible and the choice
should not be made silently.

## Why it matters beyond the API call

Several test files run a bare `ANALYZE;` as a setup statement, which the sqllogic harness
executes through `db.exec` — so those `ANALYZE` lines are currently inert and the files
are asserting against un-analyzed plans:

- `packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic`
- `packages/quereus/test/logic/108-cardinality-estimation.sqllogic`
- `packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic`
- `packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic`

(`11.4-hash-join-side-swap.sqllogic` works around this today by writing each `ANALYZE` as
its own block with an expected result, which forces the harness to drain it. That
workaround can be removed once this is fixed, and the four files above should be re-checked
— each was written believing statistics were present, and at least one of them exists
specifically to pin a statistics-driven plan choice.)

`packages/quereus-isolation/test/isolation-layer.spec.ts:4964` also calls
`await adb.exec('analyze')` and is silently getting nothing.

The behavior is already known in one spot —
`packages/quereus/test/materialized-view-diagnostics.spec.ts:474` carries the comment
"`db.exec` would not pull the analyze generator's rows" — but as a local workaround, not
as a tracked defect.

## Expected behavior

`await db.exec('analyze')` (and `analyze <table>`) collects and installs table statistics,
exactly as `db.eval('analyze')` does today. A user should not have to know that the
statement is implemented as a generator to make it take effect.

## Things worth checking while reproducing

- Whether any other statement type has the same shape (work inside an un-sunk generator).
  `pragma` handles its setter form explicitly; the rest of the `buildStatement` switch in
  `planner/building/block.ts` has not been audited for this.
- Whether the store backend behaves the same (it should — the gap is above the module
  layer, in statement execution).
