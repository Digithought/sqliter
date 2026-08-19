---
description: The debugging helper that traces how a query executes hangs forever instead of returning results, so anyone who calls it has to kill the process. Fix it and add a test that catches the same mistake in its sibling helpers.
files:
  - packages/quereus/src/func/builtins/explain.ts          # the deadlocking call site and the shared helper to extract
  - packages/quereus/src/core/database.ts                  # `_acquireExecMutex` / `_isExecuting` — the mutex being deadlocked on
  - packages/quereus/src/core/statement.ts                 # `iterateRowsWithTrace` — the mutex-free path row_trace already uses
  - packages/quereus/test/runtime/scalar-fusion.spec.ts    # carries a stale NOTE saying this cannot be tested; update it
  - docs/functions.md                                      # documents the five SQL-taking diagnostic TVFs
difficulty: easy
repro: verified
---

# `execution_trace()` deadlocks on every call

## What happens

`execution_trace('<any sql>')` never returns. On a fresh in-memory database:

```ts
const db = new Database();
for await (const r of db.eval("select count(*) as n from execution_trace('select 1')")) { /* never reached */ }
```

Confirmed by running it: a Mocha test with a 10 s timeout times out, with no
error and no output. `row_trace()`, which does nearly the same job, returns
normally.

## Root cause — one site

`packages/quereus/src/func/builtins/explain.ts:451`, inside the
`execution_trace` generator body:

```ts
for await (const row of db.eval('SELECT * FROM scheduler_program(?)', [sql])) {
```

Quereus serializes statement execution behind a single exec mutex
(`Database._acquireExecMutex`, `packages/quereus/src/core/database.ts:565`).
A table-valued function body runs *inside* the statement that called it, so the
mutex is already held. `db.eval` acquires the mutex again; the queued
acquisition can only be satisfied once the outer statement finishes, and the
outer statement cannot finish until this generator returns. Nothing throws — it
simply waits forever.

Nothing else in the function needs the mutex: `db.getPlan`, `db.prepare` and
`Statement.iterateRowsWithTrace` are all mutex-free
(`iterateRowsWithTrace` goes through `_iterateRowsRawInternal`, not
`_iterateRowsGenerator`, which is why `row_trace` works).

## The fix — collect the instruction listing in-process

The information `execution_trace` wants from `scheduler_program` is produced
synchronously from plan + emit + scheduler; routing it through SQL buys nothing
and costs the deadlock. Extract that work into one helper used by both
functions, so the two listings stay identical by construction (they must —
`execution_trace` joins its trace events against these addresses by index):

```ts
/** One row of the compiled instruction listing produced by collectSchedulerProgram. */
interface SchedulerProgramEntry {
	addr: number;
	dependencies: number[];
	description: string;
	isSubprogram: boolean;
	parentAddr: number | null;
}

function collectSchedulerProgram(db: Database, sql: string): SchedulerProgramEntry[]
```

The body is the existing `scheduler_program` generator body with `yield [...]`
tuples replaced by `entries.push({...})` — same `db.getPlan` →
`new EmissionContext(db, { fuseScalars: false })` → `emitPlanNode` →
`new Scheduler(...)` sequence, same sub-program address offset
(`scheduler.instructions.length + progIdx * 1000 + subI`), same
`INSTRUCTION_${i}` / `SUB_INSTRUCTION_${progIdx}_${subI}` fallback notes. It
throws rather than yielding an error row; each caller keeps the error handling
it already has (`scheduler_program` yields its `Failed to compile SQL:` row,
`execution_trace` logs and carries on with empty maps).

Then `scheduler_program` maps entries to its six-column tuples, and
`execution_trace` replaces the nested `db.eval` loop with:

```ts
for (const entry of collectSchedulerProgram(db, sql)) {
	instructionDependencies.set(entry.addr, entry.dependencies);
	instructionOperations.set(entry.addr, entry.description);
}
```

**Verified.** This exact change was applied to a scratch copy of `explain.ts`
and reverted before handoff. Result: the repro above completes in ~50 ms,
`packages/quereus/test/runtime/scalar-fusion.spec.ts` stays green (47 passing),
and the trace rows are meaningful rather than degraded — for
`execution_trace('select n + 1 from t where n > 2')` every row carried an
operation name and a dependency list resolved from the listing:

```
0 IndexScan(t)                  []
1 callback(>(compare-fast))     []
2 filter(n > 2)                 [0,1]
3 callback(+(numeric-fast))     []
4 project(1 cols)               [2,3]
5 block(1 stmts, result idx: 0) [4]
```

Deleting the enrichment step instead (the option the incoming ticket floated)
is *not* preferred: it is what populates `operation` and `dependencies`, two of
the nine columns the function advertises, and keeping it costs nothing once the
nested query is gone.

## Also at this site: two `console.warn` calls

`execution_trace` reports both its failure paths with `console.warn`
(explain.ts:461 and :484) while the module already has
`const log = createLogger('func:builtins:explain')` at the top and every other
diagnostic in the file uses it. `console.warn` is not viable on all the targets
this engine claims (browser, React Native, edge) and cannot be filtered by
namespace. Route both through `log`. Do not silence them — they are the only
signal that the enrichment or the traced execution failed.

## Guarding the class, not just the instance

The mistake generalizes: *any* TVF body issuing a nested top-level query
deadlocks the same way, silently. Two cheap guards, both in scope here:

**A test over all five SQL-taking diagnostic TVFs.** They are `query_plan`,
`scheduler_program`, `stack_trace`, `execution_trace`, `row_trace` — each takes
one SQL string and each is a candidate for this bug. A spec that runs every one
of them end-to-end through `db.eval` with a short per-case timeout (a few
seconds is ample — the whole set ran in under 100 ms above) turns a future
regression from an unattributable hang into a named failing test. Put it
somewhere a reader will look for it, e.g.
`packages/quereus/test/core/diagnostic-tvfs.spec.ts`, and assert at least one
row back from each rather than merely "did not hang".

**A `NOTE:` at the seam.** A short comment where the TVF body starts, saying
that a TVF body runs inside the calling statement and therefore under the exec
mutex, so it must use `db.getPlan` / `db.prepare` /
`Statement.iterateRowsWithTrace` and never `db.eval` / `db.exec`. That is the
one fact whose absence caused this.

A general engine-level guard — making `db.eval` throw instead of hang when the
mutex is already held — was considered and rejected: the mutex exists precisely
so that a *different* concurrent caller can wait, and telling "nested inside the
holder" apart from "legitimately queued behind it" needs async-context tracking
(`AsyncLocalStorage`), which is not available on the browser and React Native
targets this engine supports. Not worth opening as its own ticket.

## Stale NOTE to update

`packages/quereus/test/runtime/scalar-fusion.spec.ts:766` currently reads:

> `execution_trace()` itself cannot be exercised end-to-end here — the TVF
> deadlocks on the exec mutex regardless of fusion … tracked as
> `tickets/backlog/bug-execution-trace-hangs-forever`

Both halves go stale with this fix, and the ticket path it cites has already
moved. The two tests that NOTE guards (`_emitUnfused=true traces the full
sub-program instruction graph`, `a default statement actually runs the fused
form`) stay — they pin the mechanism directly. Replace the NOTE with the
end-to-end assertion it was standing in for: `execution_trace` on
`'select n + 1 from t where n > 2'` reports `+(numeric-fast)` and no
`fused(` operation. The `this.timeout(20_000)` on that describe block was set
for a deadlock-adjacent worst case and can come down.

## Not caused by the concurrent-read work

Found while reviewing `readConcurrency: 'committed'`, but it predates it and
reproduces with no options passed. The concurrent-read eligibility gate refuses
every table-valued function, so `execution_trace` always took the ordinary
serialized path — where it has always deadlocked.

## TODO

- Add `SchedulerProgramEntry` + `collectSchedulerProgram(db, sql)` to
  `packages/quereus/src/func/builtins/explain.ts`, lifted from the existing
  `scheduler_program` generator body.
- Rewrite `scheduler_program`'s body to map entries onto its six-column tuples,
  keeping its existing `Failed to compile SQL:` error row.
- Replace the nested `db.eval('SELECT * FROM scheduler_program(?)', [sql])` in
  `execution_trace` with a direct `collectSchedulerProgram` call; keep the
  surrounding try/catch best-effort.
- Route the two `console.warn` calls in `execution_trace` through the module's
  `log`.
- Add the `NOTE:` at the TVF-body seam recording that TVF bodies run under the
  exec mutex and must not issue nested top-level queries.
- Add `packages/quereus/test/core/diagnostic-tvfs.spec.ts` covering all five
  SQL-taking diagnostic TVFs end-to-end through `db.eval`, each with a short
  timeout and a non-empty result assertion.
- Update the stale NOTE and add the end-to-end `execution_trace` assertion in
  `packages/quereus/test/runtime/scalar-fusion.spec.ts`; lower the 20 s
  describe-block timeout.
- Check `docs/functions.md`'s `execution_trace(sql)` entry still describes
  actual behaviour; correct it if not.
- Run `yarn test` and `yarn lint` from the repo root.
