---
description: Table statistics now refresh by themselves in the background once a table has changed enough, instead of only when someone types the ANALYZE command by hand. No write or query waits on the refresh.
files:
  - packages/quereus/src/core/database-auto-analyze.ts             # the whole feature — scheduler, guards, refresh
  - packages/quereus/src/core/database.ts                          # ~2670 _whenAutoAnalyzeIdle (new), doc tweak on _autoAnalyze
  - packages/quereus/test/auto-analyze-refresh.spec.ts             # NEW — 19 tests
  - packages/quereus-store/test/stats-persistence.spec.ts          # +1 test — automatic refresh survives a reopen
  - docs/sql-txn.md                                                # §9.5 "Automatic statistics refresh" (new subsection)
  - docs/optimizer-costing.md                                      # ~146 replaced the "manager only records the crossing" paragraph
  - docs/usage.md                                                  # ~636, ~639 auto_analyze / auto_analyze_row_limit rows
difficulty: medium
---

# Auto-analyze part 2 — background statistics refresh (review)

Part 1 shipped a per-table count of committed row changes plus a staleness predicate that
only wrote a log line. This ticket makes a crossing actually refresh the table's
statistics, off the write path.

## What shipped

**Execution.** The refresh runs `db.exec('analyze "<schema>"."<table>"')` — the ordinary
statement path. Nothing in `runtime/emit/analyze.ts` was refactored or touched. Two
consequences that are the reason for the choice: there is one implementation of
"collect and record statistics for a table", and the refresh acquires the same execution
mutex every statement uses, so it queues behind user work instead of racing it. It is
started from a timer, never from inside a statement, so it cannot deadlock on that mutex.

Statement text is built with `quoteIdentifier` (`emit/ast-stringify.ts`). **The parser
does accept a quoted qualified target** — verified directly (`analyze "main"."my table"`
against the built `dist`, and covered by two tests: a table named `"order by"` and one in
the `temp` schema). No parser gap to report.

**Scheduling.** `TableStalenessEntry` gained `timer`, `running`, `nextEligibleAt`,
`oversizeLogged`. A crossing arms a debounce timer (50 ms). Crossings arriving while a
timer is armed or a refresh is running are absorbed — `evaluate` returns at its first
line — so N commits past the threshold cost O(1) refreshes. The timer is `unref()`'d
where that method exists.

The refresh task, in order: disposed check → `auto_analyze` re-read (so switching the
feature off after arming abandons the refresh) → open-transaction defer → row-limit gate
→ `ANALYZE` → snapshot-subtract the counter, record `analyzedRowCount`, set the
duty-cycle cooldown. Failure logs, leaves the counter, and sets a backoff of at least
5 s. The whole body is one `try/catch`, so `running` never rejects and no scheduled task
can produce an unhandled rejection.

Three module constants, no new options: `AUTO_ANALYZE_DEBOUNCE_MS = 50`,
`AUTO_ANALYZE_DUTY_CYCLE = 10`, `AUTO_ANALYZE_FAILURE_BACKOFF_MS = 5000`.

**Test seam.** `AutoAnalyzeManager.whenIdle()` / `Database._whenAutoAnalyzeIdle()`
(`@internal`) fires any armed timer immediately, zeroes the cooldown, awaits every
in-flight refresh, and repeats — bounded at 10 passes, then logs loudly rather than
hanging. It deliberately does **not** bypass the open-transaction deferral. No test in
either new suite sleeps.

**Teardown.** `dispose()` sets a `disposed` flag and clears every armed timer.
`table_removed` now clears the timer before dropping the entry.

**Decisions recorded in code, not just here:**

- *A hand-typed `ANALYZE` does not reset the counter.* The reset path keys off **this
  manager's own refresh only** — the alternative (reacting to `table_modified`) would
  re-couple the manager to the channel the refresh itself fires, and `table_modified`
  cannot distinguish "an ANALYZE succeeded" from "someone ran ALTER TABLE". Cost: after a
  manual `ANALYZE` of an already-over-threshold table, one redundant background rescan,
  after which the counter is back in step. Written out at the `table_removed` listener.
- *No module-capability exemption.* Both shipped backends deliberately return an empty
  `columnStats`, so an exemption for "modules that report complete statistics" would be
  dead code. `NOTE:` at `rowLimit()`.
- *The duty-cycle cooldown and the geometric ladder it prevents.* `NOTE:` at the constant.
- *The open-transaction race* (a `begin` landing between the `getAutocommit()` check and
  `exec`'s mutex acquisition). Accepted; `NOTE:` at the check with the reason.
- *`auto_analyze_row_limit = 0` means no cap*, per the option's own documentation — the
  gate is `limit > 0 && known > limit`, not the bare comparison the implement ticket
  wrote. Test: `honors auto_analyze_row_limit = 0 as "no cap"`.

## Validation

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn lint` | clean |
| `yarn test` | `@quereus/quereus` **10051 passing, 25 pending, 0 failing** (10032 before). Every other workspace passes; `@quereus/store` 1906 (1905 before) |
| `yarn test:store` | **10043 passing, 33 pending, 0 failing** |

**No existing test changed behavior.** `auto_analyze` defaults on and refreshes now
really fire, so this was the main risk. Nothing in `test/plan/`, `test/optimizer/` or
`test/logic/` needed an `auto_analyze = false` harness setting, and none was added.

**The store-mode `[TransactionCoordinator] … committed out from under it` warnings are
pre-existing, measured not assumed.** Store logic tests emit 15 of them. I re-ran the
same suite with `auto_analyze`'s default temporarily flipped to `false` and got the same
15, then restored the default. They come from the store's documented DDL-commit /
savepoint interaction (`quereus-store/src/common/transaction.ts` ~356, ~388), which
auto-analyze never enters — it does no DDL and defers while any transaction is open.
Nothing filed.

## Use cases to exercise

The behavioral claims worth re-deriving rather than taking from this handoff:

- **It refreshes at all.** `pragma auto_analyze_min_mutations = 3`, write 3 rows, and
  statistics appear on the `TableSchema` with the right `rowCount`, real per-column
  distinct counts, and a `lastAnalyzed` stamp — without anyone typing `ANALYZE`.
- **It refreshes off the write path.** No `insert`/`update`/`select` awaits the refresh;
  the only way to observe one deterministically is `_whenAutoAnalyzeIdle()`.
- **It does not refresh when it should not**: after a rollback past the threshold; with
  `auto_analyze` off; with `auto_analyze` switched off after the timer armed; for a table
  above `auto_analyze_row_limit`; while an explicit transaction is open; after the table
  is dropped.
- **A refresh cannot trigger itself.** After one settles, the counter is 0 and a second
  `_whenAutoAnalyzeIdle()` returns without another refresh. A regression here spins
  forever, so it is the single highest-value assertion in the suite.
- **Bulk load does not become a rescan treadmill.** 25 single-row commits past the
  threshold produce a handful of refreshes, not 23.
- **Materialized views.** An MV's backing writes are counted like any table's, and a
  full-rebuild MV's delta is the whole reshuffled result — so its counter can climb far
  faster than its source's. Sustained small writes to the source must not produce a
  refresh per statement.
- **Store path.** An automatic refresh (no manual `ANALYZE` anywhere) reaches
  `saveStatistics` and its numbers survive a genuine reopen —
  `quereus-store/test/stats-persistence.spec.ts`, "persists statistics an AUTOMATIC
  refresh collected".
- **Process hygiene.** Closing a database with a timer armed produces no unhandled
  rejection and leaves no handle holding the process open.

## Known gaps — treat the tests as a floor

These are real holes, not hedging. Each is a place the suite would not catch a regression.

- **The duty-cycle cooldown is never observed doing its job.** `whenIdle()` zeroes
  `nextEligibleAt` by design, so no test watches a cooldown actually defer an arming.
  Deleting `nextEligibleAt`'s assignment in the success path would leave every test
  green. The coalescing tests bound refresh *count*, which the debounce alone can explain.
  This is the biggest gap.
- **"The oversize skip is logged exactly once" is asserted through the `oversizeLogged`
  flag, not by counting log lines.** No logger spy exists in this suite. The flag is what
  guards the log, so the assertion is one indirection away from the claim.
- **The coalescing assertions are upper bounds** (`<= 4` for 25 commits, `<= 8` for the
  MV case), because the exact count depends on how many 50 ms debounce windows the
  commits span on the machine. A scheduler that refreshed per crossing lands at ~23 and
  is caught; a change that merely doubled the refresh rate is not.
- **"Keeps mutations that commit while the refresh is in flight"** drives the interleaving
  by calling `recordCommit` directly rather than by racing a real commit. It pins the
  snapshot-subtract arithmetic, not a genuine concurrent commit.
- **The accepted open-transaction race is not tested** — reproducing it needs a hook
  between the `getAutocommit()` check and `exec`. It is a `NOTE:`, nothing more.
- **The redundant-rescan case the manual-`ANALYZE` decision creates is not pinned.** The
  test only covers a manual `ANALYZE` below the threshold. Nothing asserts what happens
  when a user hand-analyzes a table that is *already* over it (expected: one wasted
  background rescan, then self-corrected).
- **`whenIdle()`'s 10-pass bailout is never exercised**, and neither is the `unref()`
  absence branch (there is no non-Node host in the test matrix).
- **The auto-analyze specs always run on the memory backend**, even under
  `yarn test:store` — they construct `new Database()` directly. Store coverage of this
  feature is the single new test in the store package.
- **The `auto_analyze_row_limit = 100000` default was not re-measured this pass.** The
  rows→milliseconds table in the implement ticket is inherited from that ticket's own
  measurement; I did not reproduce it.

## Tripwires parked in code

- **A never-analyzed table's first automatic refresh is not size-gated.** The gate reads
  the *known* row count, which is 0 for a table nobody has analyzed (`SchemaManager`
  hardcodes `estimatedRows` to 0), so a table bulk-loaded to 10M rows in a single
  transaction gets one unbounded scan before `analyzedRowCount` starts gating the rest.
  The obvious tightening — using `changedSinceAnalyze` as a size proxy — **deadlocks**: a
  table skipped as oversize never resets its counter and would be skipped forever.
  `NOTE:` at the gate in `database-auto-analyze.ts`, and stated plainly in
  `docs/sql-txn.md` §9.5 and the `auto_analyze_row_limit` row of `docs/usage.md`.
- **Every refresh fires `table_modified` and so invalidates cached plans for that table.**
  Intended — new statistics should change plans — and bounded by threshold + debounce +
  duty cycle. Documented in `docs/sql-txn.md` §9.5 rather than as a code `NOTE:`, since it
  has no single code site.

## Review findings

_(to be filled by the review pass)_
