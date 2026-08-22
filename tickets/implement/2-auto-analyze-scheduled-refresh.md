---
description: Table statistics only ever refresh when someone types the ANALYZE command by hand, so they silently go stale and the query planner picks bad plans. Building on the change counters from the previous ticket, the engine now refreshes a table's statistics by itself once it has changed enough — in the background, so no write or query ever waits on it.
prereq: auto-analyze-commit-counters
files:
  - packages/quereus/src/core/database-auto-analyze.ts        # extended here — scheduler, guards, execution
  - packages/quereus/src/core/database.ts                     # ~1261 close(), drain hook, getAutocommit
  - packages/quereus/src/emit/ast-stringify.ts                # quoteIdentifier — building the ANALYZE text
  - packages/quereus/src/runtime/emit/analyze.ts              # READ ONLY — the flow being reused via db.exec
  - packages/quereus/src/planner/stats/analyze.ts             # READ ONLY — collectStatisticsFromScan, the O(n) cost being bounded
  - packages/quereus/src/planner/stats/table-cardinality.ts   # catalogRowCount — the row-limit gate input
  - packages/quereus/src/vtab/memory/table.ts                 # ~195-210 the connection-adoption comment behind the open-transaction rule
  - packages/quereus-store/src/common/store-table-base.ts     # ~1174 getStatistics, ~1206 saveStatistics — why no module exemption is needed
  - docs/sql-txn.md                                           # §9.5 ANALYZE — where auto-analyze gets documented
  - packages/quereus/test/auto-analyze-refresh.spec.ts        # NEW
difficulty: medium
---

# Auto-analyze, part 2: background statistics refresh

Part 1 left a per-table count of committed row changes and a staleness predicate that
only logs. This ticket turns a staleness crossing into an actual statistics refresh,
run off the write path.

## Execution: run the existing `ANALYZE`, do not reimplement it

The refresh executes `await db.exec('analyze <quoted schema>.<quoted table>')`.

That single decision removes most of the work the plan ticket anticipated:

- **No refactor of `runtime/emit/analyze.ts`.** The plan called for factoring the
  per-table flow (connect → collect → schema swap + notify → `saveStatistics` →
  disconnect) out of `emitAnalyze` so a scheduler could reuse it. Going through
  `db.exec` reuses it as-is, including the per-table `try` that logs and continues.
  It also avoids colliding with three other open tickets that touch that file
  (`bug-bare-analyze-only-covers-main`, `feat-store-index-derived-distinct-counts`,
  `bug-statistics-value-identity-uses-string-keys`).
- **Mutex serialization for free.** `db.exec` acquires the execution mutex
  (`database.ts` ~line 565), which is what serializes all statement execution. A
  scheduler calling `module.connect()` and scanning directly would run *outside* that
  mutex and race live statements. Since the refresh runs from a timer and not from
  inside a statement, acquiring the mutex can never deadlock — it merely queues.

Build the statement text with `quoteIdentifier` from `src/emit/ast-stringify.ts`
(the same helper `schema/constraint-builder.ts` uses for internal SQL). Confirm during
implementation that the parser accepts a quoted qualified target in `analyze
"main"."my table"` — if it does not, that is a real parser gap worth its own finding,
not a reason to hand-roll unquoted names.

The `ANALYZE` report rows are discarded.

### Why this cannot trigger itself

`emitAnalyze` writes statistics by swapping `TableSchema` and firing the **internal
catalog notifier** (`schemaManager.getChangeNotifier().notifyChange`), not the
data-change channel, and it performs no DML. So its own implicit transaction commits
with an empty change log, `getChangedRowCounts()` returns an empty map, and no counter
advances. Pin this with a test — a self-triggering loop here would spin forever.

## Scheduling

Extend `TableStalenessEntry` from part 1:

```ts
interface TableStalenessEntry {
	changedSinceAnalyze: number;
	analyzedRowCount: number | undefined;
	staleLogged: boolean;
	/** Armed debounce timer, if any. */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Resolves when the in-flight refresh for this table settles; undefined when idle. */
	running: Promise<void> | undefined;
	/** Epoch ms before which no refresh may start (duty-cycle cooldown / failure backoff). */
	nextEligibleAt: number;
	/** True once the oversize skip has been logged; cleared on a successful refresh. */
	oversizeLogged: boolean;
}
```

Module constants (not options — they have no realistic tuning story, and the plan
ticket asks to keep the option count honest):

```ts
const AUTO_ANALYZE_DEBOUNCE_MS = 50;
const AUTO_ANALYZE_DUTY_CYCLE = 10;
const AUTO_ANALYZE_FAILURE_BACKOFF_MS = 5000;
```

**Arming.** When `recordCommit` finds a table stale and the entry has neither a timer
nor a running refresh, arm one:
`delay = max(AUTO_ANALYZE_DEBOUNCE_MS, nextEligibleAt - Date.now())`.
Crossings that occur while a timer is armed or a refresh is running are absorbed — the
counter keeps climbing and the next arming picks up whatever is there. That is the
coalescing the plan ticket asked for: N commits of M rows each produce O(1) refreshes,
not O(N).

Call `timer.unref()` when it exists (`typeof timer.unref === 'function'`) so a pending
refresh never holds a Node process open. It does not exist in browsers, hence the guard.

**Running.** The task, in order:

1. Clear `timer`. If disposed, return.
2. **If an explicit transaction is open** (`!db.getAutocommit()`), return without
   touching the counter. The next commit re-evaluates the threshold, still finds it
   crossed, and re-arms — no wakeup is lost. This is the plan ticket's open
   "concurrent-transaction posture" question, resolved as *defer*: a memory table's
   `ANALYZE` adopts the registered connection **including its pending transaction
   layer** (`vtab/memory/table.ts` ~195-210), so refreshing mid-transaction would bake
   uncommitted rows into the statistics.
3. **Row-limit gate.** `knownRowCount = analyzedRowCount ?? catalogRowCount(schema) ?? 0`.
   If `knownRowCount > auto_analyze_row_limit`, log once (`oversizeLogged`) —
   *"statistics stale, table too large for auto-analyze — run ANALYZE manually"* — and
   return, leaving the counter alone.
4. Set `running`, snapshot `changedSinceAnalyze`, run the `ANALYZE`.
5. On success: `changedSinceAnalyze = max(0, changedSinceAnalyze - snapshot)`;
   `analyzedRowCount = catalogRowCount(refreshed schema)`;
   `staleLogged = oversizeLogged = false`;
   `nextEligibleAt = Date.now() + elapsedMs * AUTO_ANALYZE_DUTY_CYCLE`.
6. On failure: log and continue — a failed auto-analyze must never surface as an error
   on an unrelated user statement. Leave the counter (the staleness is real), and set
   `nextEligibleAt = Date.now() + max(AUTO_ANALYZE_FAILURE_BACKOFF_MS, elapsedMs * AUTO_ANALYZE_DUTY_CYCLE)`
   so a permanently-unreadable table cannot spin.
7. `finally`: clear `running`.

Subtracting a snapshot rather than zeroing the counter keeps any mutation that
committed between the arming and the refresh accounted for.

### Why the duty-cycle cooldown exists

Without it, a bulk load re-analyzes on a geometric ladder: refresh at 50k rows sets
`analyzedRowCount = 50k`, the next threshold is `0.2 × 50k = 10k` more rows, so the next
refresh scans 60k, then 72k, then 86k… Each scan is O(n) and they compound. Capping a
table's auto-analyze at `1 / AUTO_ANALYZE_DUTY_CYCLE` of wall-clock (10%) bounds the
background cost to a fixed fraction of one core regardless of write rate, without
needing to model the workload. Leave a `NOTE:` at the constant explaining the ladder it
prevents, so nobody removes it as "an unnecessary timer".

## Cost gating: the measured basis for `auto_analyze_row_limit`

`collectStatisticsFromScan` (`planner/stats/analyze.ts`) visits every row and, per
column, maintains a distinct-value `Set<string>`, min/max, and a 1000-value reservoir.
Measured on this machine (Windows 11, Node v24.2, memory backend, a four-column table
`(id integer primary key, a integer, b text, c real)`, timing `analyze t` only, driven
against the built `dist` through the public `Database` API):

| rows | `analyze` wall time |
| --- | --- |
| 1 000 | 5.4 ms |
| 10 000 | 14.6 ms |
| 100 000 | 131 ms |
| 200 000 | 335 ms |
| 500 000 | 1 146 ms |
| 1 000 000 | 3 637 ms |

Linear to ~100k, then superlinear as the per-column distinct sets outgrow cache and
provoke GC (the 1M case peaked around 1.4 GB heap). **`auto_analyze_row_limit = 100000`
is the knee**: ~130 ms is a tolerable one-off latency injection, and the next decade of
the curve is not. Reproduce by timing `analyze t` against a table of each size; the
numbers above are the acceptance basis, not a promise about other machines.

**No module-capability exemption in v1.** The plan ticket proposed exempting modules
whose `getStatistics()` returns complete statistics. No shipped module does: the store
backend deliberately returns an **empty** `columnStats`
(`quereus-store/src/common/store-table-base.ts` ~1174, whose doc comment explains that
reporting its persisted snapshot would turn every `ANALYZE` into a no-op re-save), and
the memory backend does the same (`vtab/memory/table.ts` ~207). So the exemption would
be dead code. Gate purely on the row count and leave a `NOTE:` recording that a module
reporting complete statistics should be exempted if one ever appears.

A module that supports neither `getStatistics()` nor `query()` needs no handling here —
`collectStatisticsFromScan` already returns `undefined` and `emitAnalyze` records
nothing.

## Determinism seam for tests

Async fire-and-forget is untestable without a seam, and sleeping in tests is a flake
factory. Add to `AutoAnalyzeManager`:

```ts
/** Resolve once no table has an armed timer or an in-flight refresh. Any armed timer
 *  is fired IMMEDIATELY (cooldown bypassed) rather than waited out. */
whenIdle(): Promise<void>
```

Implementation: loop — collect entries with `timer` or `running`; return when none; for
each armed entry clear the timer, zero `nextEligibleAt`, start the task; `await` every
`running` promise; repeat. Bound the loop (say 10 passes) and log loudly if it does not
settle, so a future self-trigger regression fails visibly instead of hanging the suite.

Expose as `Database._whenAutoAnalyzeIdle(): Promise<void>`, marked `@internal`.

`whenIdle` deliberately does **not** bypass the open-transaction deferral — a test that
wants a refresh must be in autocommit, which is what real callers face.

## Database close

`Database.close()` (~line 1261) already disposes the assertion evaluator, watcher
manager and materialized-view manager. Extend the auto-analyze `dispose()` from part 1
to: set a `disposed` flag, `clearTimeout` every armed timer, and leave in-flight
refreshes to fail harmlessly (`db.exec` throws once the database is closed; the failure
path already logs and continues). A queued task must never produce an unhandled
rejection — every scheduled call must be `void`-prefixed with its own `.catch`, or
`async` with a total `try/catch`.

## Documentation

Extend `docs/sql-txn.md` §9.5 (`ANALYZE`, ~line 403) with an *Automatic statistics
refresh* subsection: what triggers it, the four options and their defaults, that it runs
in the background and is skipped for tables above `auto_analyze_row_limit`, that it is
deferred while an explicit transaction is open, and that staleness counting restarts
when the process does.

Do **not** write the user-facing "you should run ANALYZE" guidance here — that is
`debt-docs-analyze-guidance`'s scope (`docs/usage.md`, the READMEs). Link, do not
duplicate. Also avoid repeating the bare-`ANALYZE`-covers-all-schemas inaccuracy flagged
by `bug-bare-analyze-only-covers-main`; auto-analyze always targets one named table, so
the question does not arise.

## Edge cases & interactions

- **Self-trigger loop.** The refresh's own commit must advance no counter. Pin it: after
  a refresh, `whenIdle()` settles in one pass and the counter does not climb.
- **Bulk load / thundering herd.** N commits past the threshold produce O(1) refreshes,
  not O(N). Pin with a counting probe on the refresh entry point.
- **Explicit transaction open when the timer fires.** No refresh; counter intact; the
  next commit re-arms. There is a narrow race — a `begin` landing between the
  `getAutocommit()` check and `exec`'s mutex acquisition — whose worst outcome is
  statistics that include uncommitted rows. Accept it: that is exactly what a user
  typing `begin; insert …; analyze;` gets today, and the store's `saveStatistics`
  already carries an accepted-tradeoff `NOTE:` for the persisted half of the same
  situation. Add a `NOTE:` at the check recording the race and why it is tolerated.
- **DROP TABLE mid-schedule.** The timer may fire after the table is gone. `db.exec`
  raises; the failure path logs and continues; the `table_removed` listener from part 1
  drops the entry and must also clear any armed timer.
- **ALTER TABLE mid-schedule.** The refresh runs against the reshaped table, which is
  correct. Column statistics left stale by ALTER are
  `bug-alter-column-leaves-stale-column-statistics`'s problem — do not fix it here.
- **Plan-cache churn.** Every refresh fires `table_modified`, invalidating cached plans
  for that table. Threshold + debounce + duty cycle bound the frequency; a test under
  sustained writes should show refresh count growing far slower than commit count.
- **Database close with a timer armed** ⇒ no unhandled rejection, no open handle.
- **`pragma auto_analyze = false` mid-flight.** An armed timer should check the option
  when it fires and abandon.
- **Two tables tripping at once** ⇒ two independent entries, each with its own timer and
  cooldown; neither blocks the other.
- **Views.** `table_removed`/entry creation must never target a plain view — the
  `ANALYZE` emitter skips `isView` tables, but do not arm a timer for one either. A
  materialized view is a real backing table and is refreshed like any other.
- **Existing test suites.** `auto_analyze` defaults on, so refreshes can now fire during
  any test that writes more than `auto_analyze_min_mutations` rows, changing plans
  mid-suite. Run the full suite and treat any perturbation as a real finding. Setting
  `pragma auto_analyze = false` inside the **plan/optimizer** harnesses
  (`test/plan/`, `test/optimizer/`) is legitimate — those tests hold statistics constant
  as the variable under test — but it must be an explicit, commented harness setting, not
  a silently loosened assertion, and never applied to `test/logic/`.

## Test strategy

New Mocha spec `packages/quereus/test/auto-analyze-refresh.spec.ts`, using
`_whenAutoAnalyzeIdle()` rather than sleeps.

- Write past the threshold → `await _whenAutoAnalyzeIdle()` → `TableSchema.statistics`
  is populated, `rowCount` matches the real count, `lastAnalyzed` is set (and advances
  on a second refresh).
- Rollback past the threshold → no refresh.
- `pragma auto_analyze = false` → no refresh however many rows are written.
- Row limit: `pragma auto_analyze_row_limit = 10` with a table known to be larger →
  counter stays high, statistics unchanged, the skip logged exactly once.
- Coalescing: many small commits well past the threshold → refresh count stays O(1).
  Instrument by counting refresh entries, not by timing.
- No self-trigger: after a refresh settles, a second `_whenAutoAnalyzeIdle()` returns
  immediately and no counter advanced.
- Explicit transaction open when the task fires → deferred; after `commit` and a drain,
  the refresh happens.
- `drop table` with a timer armed → no throw, entry and timer gone.
- `close()` with a timer armed → no unhandled rejection; the process can exit.
- Store path: run `yarn test:store` to confirm the persisted-statistics interplay
  (refresh → `saveStatistics` → reopen sees fresh statistics), since that package is
  where `saveStatistics` actually writes.

## TODO

- [ ] Extend `TableStalenessEntry` with `timer`, `running`, `nextEligibleAt`,
      `oversizeLogged`; add the three module constants with the duty-cycle `NOTE:`.
- [ ] Arm a debounce timer from `recordCommit` when a table trips and nothing is
      pending; guard `unref()` for non-Node hosts.
- [ ] Implement the refresh task in the order given above: dispose check →
      open-transaction defer → row-limit gate → `db.exec('analyze …')` →
      snapshot-subtract, `analyzedRowCount` update, cooldown → failure backoff.
- [ ] Build the statement text with `quoteIdentifier`; verify the parser accepts a
      quoted qualified `ANALYZE` target and report it as a finding if it does not.
- [ ] Add `AutoAnalyzeManager.whenIdle()` and `Database._whenAutoAnalyzeIdle()`
      (`@internal`), with the bounded settle loop.
- [ ] Extend `dispose()` to clear armed timers and set a disposed flag; make sure no
      scheduled task can produce an unhandled rejection.
- [ ] Clear any armed timer in the `table_removed` handler from part 1.
- [ ] Add `NOTE:` comments at: the open-transaction race, the absent module-capability
      exemption, and the duty-cycle constant.
- [ ] Document in `docs/sql-txn.md` §9.5; do not duplicate `debt-docs-analyze-guidance`.
- [ ] Write `test/auto-analyze-refresh.spec.ts` covering everything under *Test
      strategy*.
- [ ] `yarn build`, `yarn lint`, `yarn test`, then `yarn test:store`. Any test that
      changes behavior because refreshes now fire is a finding to report, not to silence.
