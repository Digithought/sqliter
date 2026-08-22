---
description: A background statistics refresh that got skipped because a transaction happened to be open now retries itself a few times instead of being thrown away, so a table no longer ends up stuck with stale statistics.
files:
  - packages/quereus/src/core/database-auto-analyze.ts   # RefreshOutcome, refresh, start, applyOutcome, armDeferRetry, fireArmedRefresh, recordCommit, whenIdle
  - packages/quereus/test/auto-analyze-refresh.spec.ts   # `deferred refresh` describe group
  - docs/sql-txn.md                                      # §9.5 automatic-refresh bullet list
  - docs/optimizer-costing.md                            # "Detecting that statistics have gone stale"
difficulty: medium
---

# Deferred statistics refresh now retries itself

## What shipped

`AutoAnalyzeManager.refresh` refuses to run `ANALYZE` while a transaction is open,
because statistics collected mid-transaction would fold that transaction's
uncommitted rows into them. That refusal used to be a bare `return`: nothing was
rescheduled, and only the next commit touching that same table ever armed a new
timer. A table's crossing was therefore lost outright whenever its debounce timer
happened to fire during a write to some *other* table and that table was never
written again.

The change makes a refresh report how it ended — `type RefreshOutcome = 'analyzed'
| 'declined' | 'deferred' | 'failed'` — and gives `start` sole responsibility for
turning an outcome into a scheduling decision. A `deferred` outcome reschedules
itself on a geometric backoff (`AUTO_ANALYZE_DEFER_RETRY_MS = 250`, doubling) a
bounded number of times (`AUTO_ANALYZE_MAX_DEFER_RETRIES = 4`, ≈3.75 s of
patience), expressed through the existing `nextEligibleAt` / `armDelayMs`
machinery rather than a second timer concept. `declined` and `failed` schedule
nothing, exactly as before. `recordCommit` and a successful `analyzed` both refund
the retry budget. A new `@internal` test seam, `fireArmedRefresh(key)`, fires one
table's armed timer and resolves after that *single* attempt settles.

## Review findings

### Checked

Read the implement diff (`ef7ca09fc`) before the handoff summary, then the whole
of `database-auto-analyze.ts` in context. Specifically audited the retry state
machine for: entry-identity checks on `dispose()` and `drop table`; the give-up
path's `nextEligibleAt` reset; when the retry budget can be refunded; coalescing
against `evaluate`'s absorption rule; `whenIdle`'s settle-pass accounting against
the retry budget; and the accuracy of the diff's claims about which statements
open an implicit transaction. Also swept for docs the diff *should* have touched
(`docs/optimizer-costing.md`, `docs/usage.md`, `docs/module-authoring.md`).

### Minor — fixed in this pass

- **The `insert … values` claim was wrong, in three places.** The diff asserted
  that "a plain `select`, and an `insert … values` whose rows need no read, open no
  transaction". `runInsert` (`packages/quereus/src/runtime/emit/dml-executor.ts:1067`)
  calls `_ensureTransaction()` unconditionally before it consumes its first row, so
  *every* insert opens one. Verified by spying on `Database._ensureTransaction`:
  `insert … values` and `insert … select` both call it, `select` does not. Corrected
  in the `getAutocommit` doc comment, `docs/sql-txn.md` §9.5, and the test group's
  header comment. This also resolves the handoff's last known gap — the claim did
  not need a test, it needed correcting.

- **`docs/optimizer-costing.md` was never updated.** Its "Detecting that statistics
  have gone stale" section still described the deferral as applying to "an explicit
  transaction" and ending with "the next commit re-arms" — a verbatim description of
  the pre-ticket bug. Rewritten to cover the implicit-transaction case and the
  bounded retry.

- **New unhandled-rejection surface in `start`.** The diff replaced
  `.finally(clear)` with `.then(clear; applyOutcome)`. `applyOutcome` reaches
  `armDeferRetry` → `arm` → `_findTable`, and nothing awaits the promise in
  production, so a throw during rescheduling would surface as an unhandled rejection
  from a timer callback — process-fatal under Node's default. Added a trailing
  `.catch` that logs, and folded the two now-overlapping comments into one accurate
  statement.

- **No test let a retry fire from its own production `setTimeout`** (the handoff's
  first known gap). Added `serves the retry from its own production timer`: defer
  once, `rollback` so no commit can re-arm, then poll for the statistics. Costs
  265 ms. Mutation-checked — deleting `this.arm(key, entry)` from `armDeferRetry`
  fails it, taking the group from 5 failures to 6.

- **The budget/settle-pass coupling was a doc comment only** (second known gap).
  Exported `AUTO_ANALYZE_IDLE_MAX_PASSES` and added a test asserting
  `AUTO_ANALYZE_MAX_DEFER_RETRIES + 2 <= AUTO_ANALYZE_IDLE_MAX_PASSES`, so raising
  the budget fails with an explanation instead of failing `spends a bounded budget`
  with only a warning in the log.

- **The spec's header comment was stale.** It claimed every test drives the
  schedule through `_whenAutoAnalyzeIdle()` and that nothing sleeps — already untrue
  before this diff (`refreshes from the production timer` polls) and more so after.
  Rewritten to name both real-timer tests and why they exist.

### Major — none filed

Not an empty category by omission. The retry state machine was audited point by
point and each concern resolved in the code's favour:

- `dispose()` / `drop table` during a deferred refresh cannot resurrect an entry —
  `armDeferRetry` checks entry identity and `arm` re-checks `disposed` and the
  table.
- The budget refund cannot land while a transaction is still open: `recordCommit`'s
  only caller is inside `commitTransaction`
  (`packages/quereus/src/core/database-transaction.ts:302`), not on savepoint
  release, so a long transaction cannot keep refunding its own deferrals. The
  "bounded patience" claim holds.
- `whenIdle` needs `retries + 2` passes (initial attempt, one per retry, one to
  observe nothing armed) = 6 of 10. Confirmed by tracing the promise ordering:
  `applyOutcome` runs before the awaited `run` resolves, so a retry is armed by the
  time the next pass looks.
- Clearing `entry.running` before `applyOutcome` is required, not incidental — `arm`
  early-returns while a refresh is in flight.

### Conditional — parked as tripwires, not tickets

- `armDeferRetry`'s give-up zeroes `nextEligibleAt`, which is safe only because
  every refresh arrives through `arm` and `arm`'s timer cannot fire before that
  deadline. A future path that starts a refresh without going through `arm` would
  silently discard a live duty-cycle cooldown. `NOTE:` at the site.
- The retry constants are unmeasured. Related measurement taken during review: a
  400-row memory-backed `insert … values` runs to completion without a single
  `setTimeout(0)` callback firing, so the mid-statement wakeup this ticket fixes
  mostly affects store-backed workloads and explicit `BEGIN`s rather than
  memory-backed ones. `NOTE:` at `AUTO_ANALYZE_DEFER_RETRY_MS`, with what to measure
  before raising the retry count.

### Considered and declined

- The accepted-tradeoff `NOTE:` at the `getAutocommit()` check (a `begin` landing
  between the check and `exec`'s mutex acquisition) states its revisit condition as
  "statistics polluted by uncommitted rows show up in practice". Nothing has tripped
  it. Left alone, not re-litigated.
- `fireArmedRefresh` as new `@internal` surface: kept. It is the minimal seam, sits
  alongside `getEntry` / `trackedTables` / `refreshCount` / `whenIdle`, adds nothing
  to `Database`, and the alternative the handoff described is a timing-dependent
  test.
- File size: `database-auto-analyze.ts` is 715 lines and roughly half comment. Not
  filed — the functions are short and single-purpose (`start`, `applyOutcome`,
  `armDeferRetry`, `refresh` decompose cleanly) and the comments carry decision
  history rather than restating code, which is the file's established style.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsconfig.test.json`
  type pass).
- `yarn test` (repo root, all workspaces) — exit 0, 5m10s.
- `packages/quereus/test/auto-analyze-refresh.spec.ts` — 31 passing.
- Mutation check on the review's own new test, described above.
