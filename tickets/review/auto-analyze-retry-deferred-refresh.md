---
description: A background statistics refresh that got skipped because a transaction happened to be open now retries itself a few times instead of being thrown away, so a table no longer ends up stuck with stale statistics.
files:
  - packages/quereus/src/core/database-auto-analyze.ts   # RefreshOutcome, refresh, start, applyOutcome, armDeferRetry, fireArmedRefresh, recordCommit, whenIdle
  - packages/quereus/test/auto-analyze-refresh.spec.ts   # new `deferred refresh` describe group
  - docs/sql-txn.md                                      # §9.5 automatic-refresh bullet list
difficulty: medium
---

# Deferred statistics refresh now retries itself

## What was wrong

`AutoAnalyzeManager.refresh` refuses to run `ANALYZE` while a transaction is open,
because statistics collected mid-transaction would include that transaction's
uncommitted rows. That refusal used to be a bare `return`: nothing was
rescheduled, and the only thing that ever armed a new timer was the next commit
touching that same table. So a table's crossing was lost outright whenever its
debounce timer happened to fire during a write to some *other* table, and that
table was never written again.

The window is wider than "someone typed `BEGIN`". `getAutocommit()` is also false
for the implicit transaction a *writing* statement opens: `update`, `delete`,
`insert … select`, and any DDL. Plain `select` and `insert … values` open none.

## What changed

**A refresh now reports how it ended** — `type RefreshOutcome = 'analyzed' |
'declined' | 'deferred' | 'failed'`. Every early return in `refresh` names one, and
`start` is the single place that turns an outcome into a scheduling decision. The
point of the union is that a deliberate refusal (`declined`: feature off, table
oversize, table gone) and a transient one (`deferred`) can no longer be spelled the
same way, so a future early return has to say which it is.

**A `deferred` outcome reschedules itself**, bounded and backed off:

- `TableStalenessEntry.deferRetries` counts retries spent on the current crossing.
- `AUTO_ANALYZE_MAX_DEFER_RETRIES = 4`, `AUTO_ANALYZE_DEFER_RETRY_MS = 250` doubling
  (250, 500, 1000, 2000 — about 3.75 s of patience). Expressed through the existing
  `nextEligibleAt` / `armDelayMs` machinery, not a second timer concept.
- Budget spent → the crossing is dropped exactly as before, and `nextEligibleAt` is
  zeroed so the spent backoff does not also delay whatever the next commit arms.
  `deferRetries` is deliberately left at the cap so the spent budget stays observable.
- `recordCommit` zeroes `deferRetries` for every table the commit touched; a
  successful `analyzed` zeroes it too.
- `start` clears `entry.running` **before** applying the outcome, because `arm`
  early-returns while a refresh is in flight — a retry armed ahead of that clear
  would be silently dropped.

**New `@internal` test seam.** `AutoAnalyzeManager.fireArmedRefresh(key)` fires one
table's armed timer immediately and resolves once that *single* attempt has settled.
See "Deviation from the ticket" below for why `_whenAutoAnalyzeIdle` could not do it.

**Docs.** `docs/sql-txn.md` §9.5's bullet went from "It is skipped while a
transaction is open" to "It is **delayed**…", describes the backoff and what happens
when the patience runs out, and corrects the claim that an ordinary statement always
opens an implicit transaction. The stale `NOTE:` in `database-auto-analyze.ts`
pointing at `tickets/fix/auto-analyze-lost-wakeup` is replaced by a description of
the retry; the neighbouring accepted-tradeoff NOTE (a `BEGIN` landing between the
autocommit check and the mutex acquisition) is unchanged and now carries an explicit
revisit condition.

## Deviation from the ticket — read this one

The ticket asserted no new test seam was needed: a user scalar function calling
`void db._whenAutoAnalyzeIdle()` from inside an `UPDATE` would do it. That seam does
fire the timer mid-statement correctly, but `whenIdle` **loops until nothing is
armed** — so driven from inside a statement it fires → defers → re-arms → fires …
and spends the entire retry budget in microtasks before the statement commits.
The crossing then ends up dropped, and the "eventually served" test the ticket asked
for fails against the *correct* implementation.

Rather than make that test timing-dependent (the alternative was real timers plus
polling, which races the 50 ms debounce against how long `db.exec('begin')` takes),
`fireArmedRefresh` fires exactly one attempt. It sits alongside the existing
`@internal` instrumentation the suite already uses (`getEntry`, `trackedTables`,
`refreshCount`, `whenIdle`) and adds no `Database` surface — tests reach it as
`db._autoAnalyze.fireArmedRefresh(...)`.

**The budget-burning behaviour of `whenIdle` is kept and asserted on purpose** (test:
`spends a bounded budget and then gives up`) — it is what makes the budget observable
without sleeping.

## Use cases to exercise

- **The original bug.** Cross the threshold on table `t`, then run an `UPDATE` on a
  *different* table during which `t`'s timer fires. Never write `t` again. `t`'s
  statistics must still get collected.
- **A parked transaction.** `begin`, leave it open, let the retries run out. Nothing
  stays armed, nothing spins, the drift counter is untouched, and the next commit
  that touches the table starts a fresh crossing with a full budget.
- **Coalescing is unaffected.** A commit arriving while a retry timer is armed is
  absorbed into it — one refresh, not two.
- **`declined` still does not retry.** `pragma auto_analyze = false` between arming
  and firing must schedule nothing. Same for an oversize table and a dropped table.
- **Teardown.** `dispose()` / `drop table` during a deferred refresh must not
  resurrect the entry. (`armDeferRetry` checks entry identity; `arm` re-checks
  `disposed` and the table.)

## Validation performed

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsconfig.test.json`
  type pass).
- `yarn workspace @quereus/quereus run test` — 10061 passing, 25 pending, 0 failing.
- `yarn test` (repo root, all workspaces) — clean, 8m56s.
- **Mutation check.** Flipping the deferral's outcome from `'deferred'` back to
  `'declined'` (i.e. reintroducing the bug) fails 5 of the 6 new tests. The suite
  actually pins the behaviour rather than passing vacuously.

## Known gaps — the reviewer should push here

- **No test lets the retry fire from its own production `setTimeout`.** Every new
  test drives the schedule through `fireArmedRefresh` or `_whenAutoAnalyzeIdle`, both
  of which zero `nextEligibleAt` and fire immediately. `backs off geometrically`
  asserts the *arithmetic* landing in `nextEligibleAt`, and the pre-existing
  `refreshes from the production timer` test covers `arm`'s real timer for the
  ordinary path — but the composition (retry armed → real timer fires ~250 ms later →
  serves it) is inferred, not executed. Adding it means a polling test in the
  ~500 ms range; judged not worth the wall-clock, but it is a genuine hole.
- **The `whenIdle` pass-budget coupling is a comment, not an assertion.**
  `AUTO_ANALYZE_MAX_DEFER_RETRIES (4) + 2 <= AUTO_ANALYZE_IDLE_MAX_PASSES (10)` is
  stated in both constants' doc comments and enforced only indirectly (if it were
  violated, `spends a bounded budget` would see a timer still armed and fail).
  Raising the budget past 8 would break the settle loop with only a warning in the
  log. A static assertion, or exporting `AUTO_ANALYZE_IDLE_MAX_PASSES` and checking
  the inequality in a test, would make it self-enforcing.
- **The retry constants are not tuned against a real workload.** 250 ms doubling ×4
  is reasoning, not measurement: nothing here measured how long a typical `UPDATE`
  holds an implicit transaction. If the first retry usually lands inside the same
  statement, the budget is being spent on wakeups that could never have succeeded.
- **`fireArmedRefresh` is new public-ish surface on the manager.** It is `@internal`
  and test-only, but it is real API. If the reviewer prefers no new seam, the
  alternative is the timing-based test described above.
- **`entry.nextEligibleAt = 0` on give-up assumes the duty-cycle cooldown has already
  elapsed.** It has, in every path reviewed: a timer only fires *after* its cooldown,
  and `whenIdle` zeroes it anyway. But it is an assumption, not an invariant the code
  checks — a future path that starts a refresh without going through `arm` would
  silently lose a cooldown.
- **`insert … values` opening no implicit transaction is asserted only indirectly.**
  The new mid-statement test asserts `!db.getAutocommit()` holds during an `UPDATE`;
  nothing pins the `select` / `insert … values` half of the table in the ticket, which
  the `AutoAnalyzeManagerContext.getAutocommit` doc comment now states as fact.

## Tripwires noticed and parked

None new. The existing accepted-tradeoff `NOTE:` at the `getAutocommit()` check (a
`BEGIN` landing between the check and the mutex acquisition) was rewritten in place
and now carries a revisit condition; it was not re-litigated.
