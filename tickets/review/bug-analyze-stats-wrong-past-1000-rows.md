description: The in-memory table backend used to guess its own column statistics from a 1000-row peek and hand them to the query planner as if it had read every row, so on larger tables the planner was told most rows were empty and that columns held far fewer different values than they did. It now reports only its row count and lets the existing full-scan collector do the rest.
files:
  - packages/quereus/src/vtab/memory/table.ts                          # getStatistics() — the fix
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # sampleColumnValues deleted; getBaseLayerStats reduced
  - packages/quereus/src/runtime/emit/analyze.ts                       # stale doc-comment claim corrected
  - packages/quereus/test/optimizer/analyze-stats-equivalence.spec.ts  # NEW — the general equivalence test
  - packages/quereus-store/test/analyze-stats-equivalence.spec.ts      # NEW — store-backend arm
  - packages/quereus/test/optimizer/statistics.spec.ts                 # comment on SizeOnlyStatsModule
  - docs/module-authoring.md                                           # the getStatistics contract
  - docs/progressive-optimizer.md                                      # stale MemoryTable claims
  - docs/sql-txn.md                                                    # the partial-answer protocol
repro: verified
----

# `ANALYZE` on a memory table no longer invents column statistics

## What changed

`MemoryTable.getStatistics()` (`packages/quereus/src/vtab/memory/table.ts:195`) is now three
lines: it returns the primary BTree's node count with an **empty** `columnStats`. The old body
derived every per-column figure from `sampleColumnValues(colIdx, 1000)` — a systematic sample
capped at 1000 non-null values — and reported it as a full read. `collectTableStatistics`
(`runtime/emit/analyze.ts`) reads a non-empty `columnStats` as "the module answered, skip the
scan", so past 1000 rows `ANALYZE` recorded exactly what the sample said: every un-sampled row
counted as a NULL, `distinctCount` saturated at 1000, and min/max were the sample's extremes.

With `columnStats` empty, `ANALYZE` falls through to `collectStatisticsFromScan`
(`planner/stats/analyze.ts`, unchanged — it was already correct) and gets exact figures over
every row. That is the same route the store backend has always taken.

Supporting changes:

- `MemoryTableManager.sampleColumnValues` — **deleted**. `getStatistics` was its only caller
  (confirmed by repo-wide search before removal).
- `MemoryTableManager.getBaseLayerStats` — reduced to `{ rowCount }`. Its per-index distinct
  count had no reader left. That count was *genuine*, not another instance of this bug (each
  secondary BTree keys on the index key, collecting all matching primary keys into one entry,
  so `getCount()` on it is a true distinct count); the doc comment at the site says so, in case
  someone revives it.
- Unused imports pruned from `table.ts` (`ColumnStatistics`, `buildHistogram`).
- The doc comment on `collectTableStatistics` no longer claims MemoryTable supplies per-index
  distinct counts.

## What to test / how to convince yourself

**Run the two new specs.** They are the deliverable as much as the fix is:

```
node packages/quereus/test-runner.mjs --grep "ANALYZE records what the data contains"
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/analyze-stats-equivalence.spec.ts" --reporter spec
```

They assert an **equivalence**, not fixed numbers: for each generated table, every figure
`ANALYZE` records must equal the same figure computed by plain SQL over the same table —
`rowCount` vs `count(*)`, `nullCount` vs `count(*) where c is null`, `distinctCount` vs
`count(distinct c)`, `minValue`/`maxValue` vs `min(c)`/`max(c)`. Adding a table shape is one
entry in the `COLUMNS` / `ROW_COUNTS` tables.

Axes covered on the memory side: row counts 0, 3, 999, 1000, 1001, 2500 (straddling the old
sample cap); columns that are all-null, some-null, and no-null; high and low cardinality;
integer and text; primary-key, plain, and secondary-indexed. Plus the pinned regression case
from the bug report — 5000 rows with `v` = 1..5000, whose old wrong values (distinct 1000,
nullCount 4000, max 4996) are named in the assertion messages. The store side runs 12 and 1200
rows plus the transaction case.

**The in-transaction arm is covered on both backends** and is worth a second look, because the
mechanism differs from what the ticket predicted. `getBaseLayerStats()` reads the committed
layer only, so before this change `ANALYZE` inside an open transaction recorded the
pre-transaction size (2 instead of 102 in the ticket's measurement). It is right now — verified,
not assumed: the spec opens a transaction, inserts past the committed size, runs `ANALYZE`, and
requires the recorded `rowCount` to equal `select count(*)` as the connection sees it. Note the
`ANALYZE` emitter calls `module.connect()` for a *fresh* vtab instance rather than reusing the
statement's connection, so "the scan sees the open transaction's uncommitted rows" is an
empirical result here, not something the code obviously guarantees. **If you want one thing to
probe, probe that** — see "Known gaps" below.

**Manual smoke:**

```sql
create table t (id integer primary key, g integer, v integer) using memory;
-- insert 5000 rows, v = 1..5000, g = i % 7
analyze t;
-- recorded v: distinctCount 5000, nullCount 0, min 1, max 5000   (was 1000 / 4000 / 1 / 4996)
```

## Validation run

- `yarn test` (whole workspace): **green** — 9983 + 420 + 179 + 89 + 78 + 89 + 1846 + 736 + 85 +
  31 + 34 + 134 + 22 mocha passing, 25 pending, plus the vitest packages (119 / 64 / 68). No
  failures, no pre-existing failures surfaced.
- `yarn workspace @quereus/quereus run lint`: clean (eslint + `tsconfig.test.json` type pass).
- `yarn workspace @quereus/store run typecheck`: clean (covers the new store spec).
- Not run: `yarn test:store` (LevelDB arm) — the store logic is exercised in-process by the new
  spec via `InMemoryKVStore`, and the LevelDB re-run is a slow release-prep pass.

No existing test moved. The `getStatistics` protocol tests in `optimizer/statistics.spec.ts`
assert only `rowCount` for `MemoryTable`, and `SizeOnlyStatsModule` reads `rich.rowCount` off
the real `getStatistics()`, which still answers.

## Known gaps — treat these as the starting points, not settled

- **`SizeOnlyStatsModule` is now behaviourally identical to a plain memory table.** Kept, with a
  comment saying it pins the size-only *protocol* rather than the memory backend, so it is not
  deleted as redundant. A reviewer may reasonably judge that comment insufficient and want the
  test restructured around a non-memory stub.
- **`distinctCount` on a mixed-type column is not asserted, deliberately.** The scan keys its
  distinct sets by `String(value)`, so a column holding both the integer `1` and the text `'1'`
  counts them as one value while SQL's `count(distinct)` counts two. Every generated column in
  the new specs is single-typed. This is a real pre-existing question about what `distinctCount`
  should mean for a mixed-type column — it is called out in the spec's header comment, and it is
  *not* something this ticket decided. If a reviewer thinks it is a defect, it is a separate one.
- **The in-transaction arm rests on an empirical observation, not a guarantee.** As above: the
  `ANALYZE` emitter connects a fresh vtab, and the tests show that instance's scan sees the open
  transaction's uncommitted rows. Nothing in `runtime/emit/analyze.ts` states this as a contract,
  and I did not trace *why* the fresh connection observes them. If that behaviour is incidental,
  the transaction tests would be pinning luck.
- **`ANALYZE` on a memory table is now O(n) where it was O(sample).** Intended — that is what
  `ANALYZE` means, and `getStatistics()` has no planning-time caller (`runtime/emit/analyze.ts`
  is the only one in the engine). But it is a real behaviour change for anyone running `ANALYZE`
  in a hot loop on a large memory table, and nobody measured the wall-clock delta. The 5000-row
  case runs in ~300ms including the inserts, which is the only datapoint I have.
- **Histogram quality is unchanged but differently sourced.** The scan builds histograms from up
  to 1000 reservoir-sampled values (`Math.random()`-driven), where the old memory path used a
  deterministic systematic sample. Histograms drive selectivity estimates only, and nothing
  asserts on them in the new specs — a plan-shape regression that only a histogram change could
  cause would not be caught here. The whole-workspace run includes the plan-shape suites and
  they did not move.
- **Cheap exact per-column statistics remain unbuilt.** Deriving distinct counts from index
  metadata instead of scanning is `feat-store-index-derived-distinct-counts` (backlog); this
  ticket was correctness only and deliberately did not attempt it.

## Docs corrected

- `docs/module-authoring.md` § Statistics — added the rule the memory backend broke: report a
  column statistic only if it is exact over every live row the connection can see; a sample is
  not an answer. Plus the note that an implementation blind to uncommitted rows must decline
  (`return undefined`) while a transaction is open, as `IsolatedTable` does.
- `docs/progressive-optimizer.md` — the two claims that `MemoryTable` supplies distinct-value
  estimates from BTree metadata, and that tier selection queries modules for stats availability.
  The latter is now marked **not yet implemented** (nothing consults `getStatistics()` during
  planning) with the intended design kept below the marker. A third stale claim at the runtime
  overlay section ("when a vtab module provides exact metadata … those stats are preferred") was
  found during the sweep and corrected too.
- `docs/sql-txn.md` § ANALYZE — replaced the two-case summary with the full four-case protocol
  (full answer / partial answer / decline / no hook), which is what the fix relies on.
