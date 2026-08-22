---
description: Table statistics now refresh by themselves in the background once a table has changed enough, instead of only when someone types the ANALYZE command by hand. No write or query waits on the refresh.
files:
  - packages/quereus/src/core/database-auto-analyze.ts             # the whole feature — scheduler, guards, refresh
  - packages/quereus/src/core/database.ts                          # ~2670 _whenAutoAnalyzeIdle (new), doc tweak on _autoAnalyze
  - packages/quereus/test/auto-analyze-refresh.spec.ts             # NEW — 23 tests
  - packages/quereus-store/test/stats-persistence.spec.ts          # +1 test — automatic refresh survives a reopen
  - docs/sql-txn.md                                                # §9.5 "Automatic statistics refresh" (new subsection)
  - docs/optimizer-costing.md                                      # ~146 replaced the "manager only records the crossing" paragraph
  - docs/usage.md                                                  # ~636, ~639 auto_analyze / auto_analyze_row_limit rows
  - docs/module-authoring.md                                       # ~1017 getStatistics/saveStatistics can be called with no user statement
difficulty: medium
---

# Auto-analyze part 2 — background statistics refresh (complete)

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

Statement text is built with `quoteIdentifier` (`emit/ast-stringify.ts`). The parser
accepts a quoted qualified target, covered by two tests: a table named `"order by"` and
one in the `temp` schema.

**Scheduling.** `TableStalenessEntry` gained `timer`, `running`, `nextEligibleAt`,
`oversizeLogged`. A crossing arms a debounce timer (50 ms). Crossings arriving while a
timer is armed or a refresh is running are absorbed — `evaluate` returns at its first
line — so N commits past the threshold cost O(1) refreshes. The timer is `unref()`'d
where that method exists.

The refresh task, in order: disposed check → `auto_analyze` re-read (so switching the
feature off after arming abandons the refresh) → open-transaction skip → row-limit gate
→ `ANALYZE` → snapshot-subtract the counter, record `analyzedRowCount`, set the
duty-cycle cooldown. Failure logs, leaves the counter, and sets a backoff of at least
5 s. The whole body is one `try/catch`, so `running` never rejects and no scheduled task
can produce an unhandled rejection.

Three module constants, no new options: `AUTO_ANALYZE_DEBOUNCE_MS = 50`,
`AUTO_ANALYZE_DUTY_CYCLE = 10`, `AUTO_ANALYZE_FAILURE_BACKOFF_MS = 5000`. The cooldown
arithmetic is an exported pure function, `armDelayMs`, for the same reason
`stalenessThreshold` / `isStaleCount` are — it is otherwise observable only through
timing.

**Test seam.** `AutoAnalyzeManager.whenIdle()` / `Database._whenAutoAnalyzeIdle()`
(`@internal`) fires any armed timer immediately, zeroes the cooldown, awaits every
in-flight refresh, and repeats — bounded at 10 passes, then logs loudly rather than
hanging. It deliberately does **not** bypass the open-transaction skip.

**Teardown.** `dispose()` sets a `disposed` flag and clears every armed timer.
`table_removed` now clears the timer before dropping the entry.

**Decisions recorded in code, not just here:**

- *A hand-typed `ANALYZE` does not reset the counter.* The reset path keys off this
  manager's own refresh only — the alternative (reacting to `table_modified`) would
  re-couple the manager to the channel the refresh itself fires, and `table_modified`
  cannot distinguish "an ANALYZE succeeded" from "someone ran ALTER TABLE". Cost: after a
  manual `ANALYZE` of an already-over-threshold table, one redundant background rescan,
  after which the counter is back in step. Written out at the `table_removed` listener,
  and now pinned by a test.
- *No module-capability exemption.* Both shipped backends deliberately return an empty
  `columnStats`, so an exemption for "modules that report complete statistics" would be
  dead code. `NOTE:` at `rowLimit()`.
- *The duty-cycle cooldown and the geometric ladder it prevents.* `NOTE:` at the constant.
- *The open-transaction race* (a `begin` landing between the `getAutocommit()` check and
  `exec`'s mutex acquisition). Accepted; `NOTE:` at the check with the reason.
- *`auto_analyze_row_limit = 0` means no cap*, per the option's own documentation — the
  gate is `limit > 0 && known > limit`.

## Validation

Run at review, after the review's own edits:

| command | result |
| --- | --- |
| `yarn build` | clean |
| `yarn lint` | clean |
| `yarn test` | `@quereus/quereus` **10055 passing, 25 pending, 0 failing** (10051 at handoff; +4 from this pass). Every other workspace passes; `@quereus/store` 1906 |

No test outside the auto-analyze suites changed. Log written to
`tickets/.logs/auto-analyze-scheduled-refresh.test.log` (git-ignored, runner-pruned).

The store-mode `[TransactionCoordinator] … committed out from under it` warnings the
implement pass measured as pre-existing were not re-litigated; nothing was filed then and
nothing is filed now.

## Review findings

### Read first, handoff second

The implement diff (`d83240734`) was read before the handoff summary, then every file it
touched plus the ones it should have touched (`docs/module-authoring.md`, `docs/store.md`,
`docs/sql.md`, `docs/todo.md`) were read against the new reality. Behavioural claims were
re-derived from `database-transaction.ts`, `database.ts` `close()` / `exec()`, and
`table-cardinality.ts` rather than taken from the ticket.

### Major — one ticket filed

**A skipped refresh is abandoned, not rescheduled** → `tickets/fix/auto-analyze-lost-wakeup.md`.

The open-transaction check uses `getAutocommit()`, which `database-transaction.ts` sets
false for the **implicit single-statement transaction too**, not only for an explicit
`BEGIN`. Because the refresh fires from a 50 ms timer into a heavily asynchronous engine,
it can land mid-statement in a database nobody opened a transaction on, and the early
return schedules nothing — only the *next commit on that table* ever re-arms. Writes that
stop right after a crossing therefore leave that crossing unserved.

Climbing the architecture ladder before filing: the instance is one early return, but the
class is "every early return in `refresh` spells give-up identically, so *declined* and
*deferred* are distinguishable only in the reader's head". The ticket asks for the
representation change — `refresh` returns a `RefreshOutcome`, `start` is the single place
that maps an outcome to a scheduling decision — so a future early return has to name its
outcome and the bug class stops being writable. It also flags that the real cost is the
test seam: `_whenAutoAnalyzeIdle` fires timers from the caller's stack by definition, so
it cannot express "the timer fires while a statement is in flight".

This is why the suite could not have caught it, and why the implement pass's own
gap list did not name it — every test drives the schedule from outside a statement.

### Minor — fixed in this pass

- **`evaluate`'s absorb comment was wrong.** It claimed "the arming that follows the
  refresh picks up whatever is there by then"; nothing re-evaluates when a refresh
  settles. Rewritten to say what actually happens and to name the cost (a burst that
  stops right after a refresh leaves a still-over-threshold counter with nothing
  scheduled).
- **`AutoAnalyzeManagerContext.getAutocommit`'s doc understated the condition** — the
  parenthetical made the implicit-transaction case look incidental. Restated, with why it
  matters for a timer-driven caller.
- **A failed automatic `ANALYZE` logged at the base namespace**, next to routine debug
  output, while `warnLog` already existed in the file and was used for exactly one other
  condition. Moved to `warnLog`.
- **`docs/sql-txn.md` §9.5 said "deferred while an explicit transaction is open"** — both
  halves inaccurate (it is also the implicit one, and it is a skip rather than a
  deferral). Corrected, including the consequence.
- **`docs/module-authoring.md` was never updated**, though it is the file a module author
  reads before implementing `getStatistics()` / `saveStatistics()` — hooks this change
  made callable with no user statement in flight, for a table nobody asked about. One
  sentence added at the statistics section, pointing at §9.5.

### Minor — test gaps closed in this pass (+4 tests)

Three of these were named as gaps in the handoff; the first was not, and was the largest.

- **The production timer was never allowed to fire.** Every test reached the refresh via
  `_whenAutoAnalyzeIdle`, which clears the timer and calls `start` directly — so a broken
  arming (never scheduled, NaN delay, callback that never calls `start`) would have left
  the entire suite green. Added the one test that lets `arm`'s own `setTimeout` run,
  polling on the *statistics* rather than on `refreshCount()` (the counter is bumped
  before `ANALYZE` is awaited, so polling it would race the collection).
- **The duty-cycle cooldown was never observed** — the handoff's own "biggest gap".
  Closed in two halves: extracted the delay arithmetic as `armDelayMs` and tested it
  directly (the test reads the debounce off the function rather than restating `50`), and
  added an assertion that a successful refresh actually records a cooldown. Deleting the
  `nextEligibleAt` assignment now fails a test.
- **The redundant rescan a manual `ANALYZE` creates was unpinned.** Added a test for
  hand-analyzing a table that is *already* over the threshold: exactly one wasted
  background rescan, counter back to 0, and no repeat.

### Checked, found nothing

- **Dotted and quoted identifiers.** `splitBaseKey` splits on the first dot only, so a
  table named `"a.b"` round-trips; a dotted *schema* name is already the subject of
  `bug-core-fq-name-split-mis-routes-dotted-table-names` and needs no second ticket.
- **Self-triggering.** `ANALYZE` performs no DML and publishes through the catalog
  notifier, so its implicit commit advances no counter — confirmed by reading
  `recordCommittedChangeCounts`'s gate and the existing test.
- **Unhandled rejections and process handles.** `refresh` is one total `try/catch`, so
  `entry.running` cannot reject; `dispose()` clears every armed timer, and timers are
  `unref()`'d where the method exists.
- **Entry lifetime.** `dropEntry` clears the timer before deleting, and a refresh whose
  table was dropped mid-flight detects it via the `entries.get(key) !== entry` identity
  check rather than resurrecting a dead entry.
- **Layering.** `core/` importing `quoteIdentifier` from `emit/ast-stringify.js` is the
  same direction `database.ts` already takes; not worth a seam.
- **File size.** `database-auto-analyze.ts` is 548 lines (`wc -l`), roughly half of it
  comment. Every function is short and single-purpose, so no split was warranted; the
  comment density is high but each block earns its place by recording a decision.

### Considered and declined

- **`close()` does not wait for an in-flight refresh.** `close()` sets `isOpen = false`
  first, so a not-yet-started refresh fails fast at `checkOpen()`; a refresh already
  inside `exec` can interleave with `disconnectAllConnections()`. Not filed: `close()`
  does not acquire the execution mutex, so *any* in-flight statement already races
  teardown — this is pre-existing engine behaviour, not something this change introduced,
  and the refresh's own `catch` means the interleaving logs rather than escapes. Making
  `dispose()` await would also let a long `ANALYZE` block `close()`.
- **`AutoAnalyzeManager.isStale` has no production caller** now that `evaluate` computes
  the threshold inline (it needs the number for its log line). Left as introspection API
  from part 1; it is three lines and both counter suites use it.

### Tripwires — parked in code, not filed

Two inherited from the implement pass, verified still accurate and still at their sites:

- **A never-analyzed table's first automatic refresh is not size-gated** (the gate reads
  the *known* count, which is 0 until something analyzes). The obvious tightening —
  using `changedSinceAnalyze` as a size proxy — deadlocks. `NOTE:` at the gate in
  `database-auto-analyze.ts`; also stated in `docs/sql-txn.md` §9.5 and the
  `auto_analyze_row_limit` row of `docs/usage.md`.
- **Every refresh invalidates cached plans for that table.** Intended, and bounded by
  threshold + debounce + duty cycle. Parked in `docs/sql-txn.md` §9.5 rather than as a
  code `NOTE:`, since it has no single code site.

Nothing new was demoted to a tripwire this pass: the one conditional-looking concern
(the abandoned crossing) is wrong *now*, on a live path, not "only if X later", so it
became a ticket instead.

### Gaps that remain, honestly

- **The coalescing assertions are still upper bounds** (`<= 4` for 25 commits, `<= 8` for
  the materialized-view case), because the exact count depends on how many 50 ms debounce
  windows the commits span on the machine. A scheduler that refreshed per crossing lands
  at ~23 and is caught; a change that merely doubled the refresh rate is not.
- **The failure backoff is untested** — forcing an `ANALYZE` to fail from outside needs a
  seam that does not exist. Same for `whenIdle`'s 10-pass bailout and the `unref`-absent
  branch (no non-Node host in the test matrix).
- **The accepted `begin`-versus-mutex race is untested**, as designed — it is a `NOTE:`.
- **The auto-analyze specs always run on the memory backend**, even under
  `yarn test:store`, because they construct `new Database()` directly. Store coverage of
  this feature is the single test in `packages/quereus-store/test/stats-persistence.spec.ts`.
- **The `auto_analyze_row_limit = 100000` default was not re-measured**, in either pass.
