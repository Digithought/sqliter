description: The debugging helper that traces how a query executes hangs forever instead of returning results, so anyone who calls it has to kill the process.
files: packages/quereus/src/func/builtins/explain.ts
repro: verified
----

# `execution_trace()` deadlocks on every call

`execution_trace('<any sql>')` is one of the built-in diagnostic table-valued
functions (alongside `query_plan`, `scheduler_program`, and `row_trace`). It is
meant to run the given SQL with instruction-level tracing switched on and return
one row per traced event.

It never returns. Reproduced on a fresh in-memory database:

```ts
const db = new Database();
for await (const r of db.eval("select count(*) as n from execution_trace('select 1')")) { /* never reached */ }
```

The call hangs indefinitely (a Mocha test times out at 10s; there is no error).
`row_trace()` — which does nearly the same job — works fine, so the two can be
compared directly.

## Why it happens

Quereus serializes statement execution behind a single execution mutex. The
statement that invokes `execution_trace` is already holding that mutex when the
function body runs, and the body's first step is to issue *another* top-level
query (`db.eval('SELECT * FROM scheduler_program(?)')`) to collect instruction
dependency information. That inner query waits for the mutex the outer statement
will not release until the function returns.

`row_trace()` does not do this — it only prepares and runs the traced SQL through
the low-level iteration path, which does not take the mutex.

## Expected behaviour

`execution_trace('select 1')` returns its trace rows and completes, like
`row_trace` does.

Whoever picks this up will need to decide how the scheduler-program information
should be gathered from inside a statement that already holds the mutex — reuse
the same low-level path `row_trace` uses, gather the information without a
nested top-level query, or drop that enrichment step. Note that the surrounding
code already treats the scheduler-program lookup as best-effort (it is wrapped
in a try/catch that logs a warning and carries on), so removing it is a live
option.

## Not related to the concurrent-read work

Found while reviewing `readConcurrency: 'committed'`, but it predates that
change and reproduces with no options passed at all. The concurrent-read
eligibility gate now refuses every table-valued function, so `execution_trace`
always takes the ordinary serialized path — where it has always deadlocked.
