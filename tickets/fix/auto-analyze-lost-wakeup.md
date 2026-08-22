---
description: Background statistics refreshes are sometimes silently dropped instead of retried, so a table that should get fresh statistics can end up never getting them until someone writes to it again.
files:
  - packages/quereus/src/core/database-auto-analyze.ts   # `refresh` early returns, `start`, `arm`, `evaluate`
  - packages/quereus/test/auto-analyze-refresh.spec.ts   # existing suite; needs a seam it does not have yet
  - docs/sql-txn.md                                      # §9.5 bullet describing the skip
repro: static
difficulty: medium
---

# A skipped automatic statistics refresh is abandoned, not rescheduled

## What happens

Tables now refresh their own statistics in the background: enough committed row
changes arm a short timer, and the timer runs `ANALYZE` for that table.

Before it runs `ANALYZE`, the refresh checks that no transaction is open — collecting
statistics inside someone's transaction would fold their uncommitted rows into the
result. When that check says "a transaction is open", the refresh returns and **nothing
is scheduled to try again**. The drift counter is left where it was, so the crossing is
still true; but the only thing that ever re-arms a timer is the *next commit on that
table*. If the writes have stopped, there is no next commit, and the table keeps its old
statistics indefinitely.

Two things make this more reachable than "the user left a `BEGIN` open":

- The check is `getAutocommit()`, which is also false for the **implicit,
  single-statement transaction every ordinary statement runs inside**
  (`database-transaction.ts` sets `isAutocommit = false` for `beginTransaction('implicit')`
  as well as `'explicit'`). The engine is heavily asynchronous, so a timer firing while
  any statement is mid-execution reads `false`.
- The timer fires 50 ms after the crossing. A workload that finishes a batch of writes
  and immediately runs a query — a very ordinary shape — can have that one query be
  what the timer lands inside.

The feature switch (`auto_analyze` turned off between arming and firing) is the same
shape but benign: turning it back on and writing again is the documented recovery.

## Why it is not visible today

Every test in `test/auto-analyze-refresh.spec.ts` reaches the refresh through
`Database._whenAutoAnalyzeIdle()`, which fires armed timers *from the test's own stack*
— outside any statement — so `getAutocommit()` is always true there. The "defers while
an explicit transaction is open" test asserts the deferral happens, and then supplies a
commit that re-arms; nothing asserts what happens when no such commit arrives.

## Expected behaviour

A crossing that has been detected should end in one of exactly two states, and it should
not be possible to write a new early return that ends in neither:

- **served** — `ANALYZE` ran and the counter was reduced by what it covered; or
- **declined on purpose** — the table is over `auto_analyze_row_limit`, the table is
  gone, the feature is off, or the database is being torn down. No retry wanted.

"A transaction was open at the moment the timer fired" is neither of those. It is a
*transient* condition and should reschedule itself, with two properties:

- **Bounded.** A user who parks an explicit transaction open for an hour must not cost a
  wakeup every few seconds forever, per stale table. A small retry budget that resets on
  the next commit is enough — after it is spent, fall back to today's behaviour of
  waiting for a write.
- **Backed off.** The retry delay should not be the 50 ms debounce; a statement that is
  in flight now is likely still in flight in 50 ms.

## Shape of the fix

The root cause is one code site — the early returns in `AutoAnalyzeManager.refresh` all
spell "give up" the same way, as a bare `return`, so the difference between *declined*
and *deferred* exists only in the reader's head. Prefer making that distinction part of
the type rather than fixing the one instance:

```ts
/** Why a scheduled refresh ended. `deferred` is the only outcome that wants a retry. */
type RefreshOutcome = 'analyzed' | 'declined' | 'deferred' | 'failed';
```

`refresh` returns one; `start` is the single place that decides what an outcome means for
scheduling (re-arm with backoff for `deferred`, drop for `declined`, existing failure
backoff for `failed`). A new early return then has to name its outcome, and the
"abandoned crossing" bug class stops being writable.

## What the tests need that they do not have

Reproducing this needs the timer to fire *while a statement is in flight*, which
`_whenAutoAnalyzeIdle` cannot express — it is defined as firing timers from the caller's
stack. Expect to add a seam for it (e.g. driving the schedule from inside a statement's
own execution, or a test-only hook that runs the armed callback at a chosen moment).
That seam is most of the work; budget for it.

Worth covering once the seam exists:

- A crossing whose timer fires mid-statement is eventually served, with no further
  writes to the table.
- The retry budget is finite: an explicit transaction held open does not produce
  unbounded retries.
- A commit arriving during the retry window still coalesces into one refresh, not two.
