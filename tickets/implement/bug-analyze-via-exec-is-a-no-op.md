---
description: Running the "collect table statistics" command through the engine's fire-and-forget execution API does nothing at all — no error, no statistics — so queries keep being planned as if the database had never been measured. Make the command do its work whether or not anyone reads the report it returns.
files:
  - packages/quereus/src/runtime/emit/analyze.ts            # the whole fix lives here
  - packages/quereus/src/util/working-table-iterable.ts     # existing array-backed AsyncIterable<Row>; reuse, don't re-invent
  - packages/quereus/src/runtime/types.ts                   # asRun / OutputValue — why a non-generator `run` is legal
  - packages/quereus/src/planner/building/analyze.ts        # unchanged by this fix; read for context
  - packages/quereus/test/logic/11.4-hash-join-side-swap.sqllogic          # comment references this ticket; update it
  - packages/quereus/test/materialized-view-diagnostics.spec.ts            # line ~474, comment documents the old workaround
  - packages/quereus/test/logic/07.7.4-where-conjunct-ordering.sqllogic    # its ANALYZE was inert; re-check
  - packages/quereus/test/logic/108-cardinality-estimation.sqllogic        # its ANALYZE was inert; re-check
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic       # its ANALYZE was inert; re-check
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic  # its ANALYZE was inert; re-check
difficulty: easy
repro: verified
---

# Make `ANALYZE` collect statistics under every entry point

## Confirmed behaviour at HEAD

Three ways of issuing the same statement, memory backend, clean tree:

| how it runs | statistics installed? |
| --- | --- |
| `await db.exec('analyze')` | **no** — `TableSchema.statistics` stays `undefined` |
| `await db.exec('create …; insert …; analyze; select 1;')` (one batch) | **no** |
| `for await (const _ of db.eval('analyze')) {}` | yes — `rowCount = 4` |

No error is raised in the failing cases. The only symptom is that plans do not change.

## Why

`emitAnalyze` (`runtime/emit/analyze.ts`) builds its `run` as an **async generator**.
Connecting to each table, collecting statistics and writing them back onto the schema all
happen inside the generator body, which does not execute until something iterates it.

Under `Database.exec`, nothing does. Each statement in an `exec` batch is planned as its
own one-statement block; `emitBlock` makes every statement a parameter of the block
instruction and returns the last statement's *value*, which for a relational statement is
the un-consumed async iterable; `_executeSingleStatement` runs the scheduler and then
drops the block's result on the floor.

`db.eval` works only because its caller iterates the rows.

The same gap makes `db.exec` skip a `select`'s work entirely — verified: a `select`
calling a user scalar function that throws raises nothing under `exec` and the function is
called **zero** times, while the same statement under `eval` throws on the first row. That
broader behaviour is a separate design question and is filed as
`backlog/bug-exec-never-runs-row-returning-statements`; it is explicitly **not** in scope
here.

## The decision: make the statement self-executing

The source ticket left the choice open between fixing `ANALYZE` and making `exec` drain
the block result. **Fix `ANALYZE`.** Reasons:

- `ANALYZE` genuinely returns rows — one `(table, rows)` row per analyzed table — so the
  `SinkNode` wrap that `INSERT`/`UPDATE`/`DELETE` and the setter form of `PRAGMA` use is
  not available: it would collect the statistics and throw the report away.
- Doing the work eagerly is *correct at every entry point* — `exec`, `eval`, `prepare`,
  nested-in-a-block, mid-batch — instead of correct only at the one that happens to
  iterate. A user should not have to know the statement is implemented as a generator.
- The blast radius is one function. Measured: with the change prototyped in place, the
  whole `@quereus/quereus` suite (8608 tests) and `@quereus/isolation` (374 tests) pass
  with zero failures. Nothing depends on `ANALYZE` being lazy.
- Changing what `exec` does with a row-returning statement is a semantics change to the
  public API with reach well past this bug. It deserves its own deliberate decision, not
  to be smuggled in as a bug fix.

Nothing about laziness buys `ANALYZE` anything: the report is one row per table, it is
produced only after that table's scan has already completed, and the statement has no
useful partial state.

## Shape of the change

`emitAnalyze`'s `run` becomes a plain async function that does the work and returns an
already-populated async iterable:

```ts
const run = async (rctx: RuntimeContext): Promise<AsyncIterable<Row>> => {
    const report: Row[] = [];
    …                                    // unchanged body; `yield [name, rowCount]`
    …                                    // becomes `report.push([name, rowCount])`
    return new WorkingTableIterable(report);   // or whatever the shared helper ends up named
};
```

This is type-legal without any assertion beyond the existing `asRun`: `OutputValue` is
`MaybePromise<RuntimeValue>` and `RuntimeValue` includes `AsyncIterable<Row>`, so an
`async` `run` returning an async iterable conforms (see the `asRun` doc comment in
`runtime/types.ts`).

Everything else stays: `buildAnalyzeStmt` still returns a bare `AnalyzePlanNode` with no
`SinkNode`; the plan node, its type, and the emitted row shape are unchanged; the
per-table `try`/`catch` still logs and continues past a failing table; `vtab.disconnect()`
still runs in `finally`. The early `return` on a missing schema returns an empty report
instead of ending the generator.

**Do not add a private array-to-`AsyncIterable<Row>` helper** —
`src/util/working-table-iterable.ts` already is exactly that. Reuse it; if its
CTE-flavoured name reads wrong at this call site, rename/generalise it there rather than
keeping two copies.

## Audit: is any other statement shaped the same way?

Checked every statement-level emitter reachable from the `buildStatement` switch in
`planner/building/block.ts`. `ANALYZE` is the only one whose side effects sit inside an
un-drained async generator:

- `APPLY SCHEMA`, `REFRESH MATERIALIZED VIEW`, and the DDL emitters use a plain `async`
  `run`, so their work happens when the scheduler evaluates the instruction.
- `PRAGMA` in its setter form is wrapped in a `SinkNode` by `buildPragmaStmt`.
- `DIFF SCHEMA` / `EXPLAIN SCHEMA` are generators but are pure read-only reports — nothing
  is lost when nobody reads them.

So this ticket needs no sibling fix. The general trap remains for any *future* relational
statement with side effects — that is the backlog ticket's problem, not this one's.

## The four inert `ANALYZE` setup statements

`07.7.4-where-conjunct-ordering`, `108-cardinality-estimation`,
`11.3-index-nested-loop-join` and `53.3-materialized-view-constraint-only-ddl` each run a
bare `ANALYZE;` as a setup statement, which the sqllogic harness sends through `db.exec` —
so those lines have been doing nothing. All four still pass with the fix in place, which
means none of them was *depending* on the difference. Worth a read anyway: at least
`108-cardinality-estimation` exists specifically to pin a statistics-driven estimate, and a
file that passes identically with and without statistics may not be asserting what its
author intended.

`11.4-hash-join-side-swap.sqllogic` writes each `ANALYZE` as its own block with an expected
result. That is **not** merely a workaround to delete — the expected result is also the
assertion that the row counts the whole file depends on actually landed, and without it
every case in the file could pass vacuously. Keep the structure; only the explanatory
comment (which says a bare `ANALYZE` in a setup block collects nothing, and names this
ticket) needs rewriting.

## TODO

- Rewrite `emitAnalyze`'s `run` in `packages/quereus/src/runtime/emit/analyze.ts` as an
  eager `async` function returning `Promise<AsyncIterable<Row>>`, accumulating the report
  rows and returning them via the shared array-backed iterable helper.
- Reuse `src/util/working-table-iterable.ts` for that iterable; generalise its name there
  if it reads badly at this site. Do not introduce a second copy.
- Add a regression spec asserting `await db.exec('analyze')` installs statistics — read
  them back off the schema (`db.schemaManager._findTable('s', 'main')?.statistics`) rather
  than inferring from a plan, so the test fails for the right reason. Cover the
  `analyze <table>` single-table form too, and a mid-batch `analyze` in a multi-statement
  `exec` string.
- Keep a case asserting `db.eval('analyze')` still yields one `(table, rows)` row per
  analyzed table, so the eager rewrite cannot quietly drop the report.
- Update the comment block above the `ANALYZE` lines in
  `test/logic/11.4-hash-join-side-swap.sqllogic` — keep the per-`ANALYZE` blocks and their
  expected results, restate why (they assert the statistics landed), and drop the reference
  to this ticket.
- Update the comment at `test/materialized-view-diagnostics.spec.ts:474` that explains
  `db.exec` would not pull the analyze generator's rows.
- Re-read the four sqllogic files listed above now that their `ANALYZE` really runs;
  strengthen any whose assertion turns out not to discriminate between analyzed and
  un-analyzed plans, or add a line saying it deliberately does not.
- Check `packages/quereus-isolation/test/isolation-layer.spec.ts:4964`
  (`await adb.exec('analyze')`) — it was silently collecting nothing; confirm what it is
  meant to assert now that the call has an effect.
- Grep the docs for `ANALYZE` (`docs/optimizer.md`, `docs/sql.md`) and correct anything
  that describes the statement as lazy or generator-driven.
- Run `yarn test`, `yarn lint`, `yarn typecheck` from the repo root and report the results
  honestly in the review handoff.
