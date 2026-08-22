---
description: Review the newly added bookkeeping that counts how many rows each table has had changed since statistics were last collected for it, plus the four settings that control when those statistics count as out of date. It only counts and reports — nothing refreshes statistics yet.
files:
  - packages/quereus/src/core/database-auto-analyze.ts        # NEW — AutoAnalyzeManager, threshold policy
  - packages/quereus/src/core/database-transaction.ts         # getChangedRowCounts, context iface, commit hook
  - packages/quereus/src/core/database.ts                     # ctor, close(), recordCommittedChangeCounts, 4 options
  - packages/quereus/test/auto-analyze-counters.spec.ts       # NEW — 24 tests
  - docs/optimizer-costing.md                                 # new "Detecting that statistics have gone stale" section
  - docs/usage.md                                             # options table rows
difficulty: medium
---

# Review: auto-analyze part 1 — committed-mutation counters and threshold policy

## What landed

A per-table count of distinct rows changed by *committed* transactions, plus the
threshold policy that turns that count into a "statistics are stale" verdict. Nothing
collects statistics — crossing the threshold flips `isStale` and writes one debug log
line. Part 2 (`auto-analyze-scheduled-refresh`, already sitting in `implement/`) turns
that signal into a background refresh.

### The counting source

`TransactionManager.getChangedRowCounts(): Map<string, number>` sits beside the existing
`getChangedBaseTables()`. It sums `Map.size` over the per-transaction change log's base
layer and every live savepoint layer — no scan, no allocation beyond the result map.

The change log is maintained unconditionally on every write path today (the DML executor
calls `Database._recordInsert/_recordUpdate/_recordDelete` with no listener gate), so
nothing was added to the write path. The plan ticket's originally-preferred hook,
`DatabaseEventEmitter.onTransactionCommit`, was deliberately **not** used: registering
any transaction-commit listener flips `needsDataEvents()` true, which makes the DML
executor build a per-row event object including a full row copy on every write in the
database, buffered for the whole transaction. That cost is unacceptable for a
default-on feature that only wants a count.

### Where the reading happens

`commitTransaction()` calls `ctx.recordCommittedChangeCounts(() => this.getChangedRowCounts())`
immediately after the post-commit watcher block — inside the same window that block
already documents ("while the change log is still alive"), and before the `finally` that
clears the log. Wrapped in its own `try/catch`: bookkeeping must never fail a
transaction that has already committed.

The argument is a **thunk**, so with `auto_analyze` off `Database.recordCommittedChangeCounts`
early-returns and the counts map is never built.

Rollback needs no hook — `rollbackTransaction()` clears the change log without ever
calling this.

### The manager

`src/core/database-auto-analyze.ts`, modelled on `database-watchers.ts`: a class owned by
`Database`, constructed in the constructor (**after** `setupOptionListeners()`, since it
reads its thresholds from those options), subscribed to the schema-change notifier,
disposed from `Database.close()`.

Map keyed by the lowercased `schema.table` string the change log already uses. Entries
created lazily on first commit that touches the table; dropped on `table_removed`.
Deliberately does **not** react to `table_modified` (a statistics refresh fires that
event itself, so reacting would couple the manager to its own future output).

Threshold, exported as two pure functions so it is testable without a `Database`:

```
stale  ⟺  changedSinceAnalyze >= max(min_mutations, ratio × knownRowCount)
```

`knownRowCount` = the entry's `analyzedRowCount` when set, else `catalogRowCount(table) ?? 0`.
For a never-analyzed table that is 0, so the absolute floor governs — exactly the case
that matters (bulk-loading a fresh table).

### Options

Four registered in `setupOptionListeners()`, each with set-time validation that throws in
`onChange` so the options framework rolls the value back:

| option | type | default | validation |
| --- | --- | --- | --- |
| `auto_analyze` | boolean | `true` | — |
| `auto_analyze_min_mutations` | number | `500` | positive integer |
| `auto_analyze_ratio` | number | `0.2` | finite, `> 0` |
| `auto_analyze_row_limit` | number | `100000` | finite, `>= 0` (consumed by part 2) |

## Semantics a reviewer should re-derive independently

These are inherited from the change log rather than implemented here, which is precisely
why they are worth checking rather than trusting:

- **Coalesced.** Ten updates of one row ⇒ 1. Insert-then-delete of the same key in one
  transaction ⇒ the entry is removed from the log entirely ⇒ 0 (and no staleness entry is
  created at all).
- **PK relocation counts as 2.** `recordUpdate` splits a primary-key change into
  delete-of-old + insert-of-new. Intended and asserted, not accidental.
- **Rollback-safe by construction.** A rolled-back savepoint's layer is popped before the
  reading; an explicit `rollback` never reaches the hook.
- **Approximate across layers, on purpose.** The same key changed in two *live* savepoint
  layers counts twice. Deduplicating would cost a full key scan; the consumer is a
  heuristic. Documented at the site.

## Validation

`packages/quereus/test/auto-analyze-counters.spec.ts` — 24 tests, all passing.
Full suite: `yarn build`, `yarn lint`, `yarn test` all green
(`@quereus/quereus`: 10029 passing, 25 pending, 0 failing).

Covered: accumulation across autocommit statements / one multi-row statement / an
explicit transaction / a released savepoint; empty commit creates no entry; rolled-back
transaction and rollback-to-savepoint; all three coalescing cases; drop-then-recreate;
missing-table entry drop; cross-schema key collision (`main.t` vs `temp.t`); the
feature-off path asserting the thunk is never invoked and that re-enabling starts from
zero; threshold math as pure functions across never-analyzed / small-analyzed /
large-analyzed / custom-parameter cases; end-to-end `isStale` crossing with
`staleLogged` flipping once; option validation with rollback for all three numeric
options.

### Known gaps — treat the tests as a floor

- **Untested write paths that should count.** Materialized-view backing writes reach
  `_recordInsert` through `database-materialized-views.ts`, and the external/sync ingest
  path records at `database-external-changes.ts` ~188 then commits through the same
  manager. Both are argued correct from the call graph; neither has a test in this spec.
  Worth a reviewer confirming at least the MV backing case, since a backing table
  crossing the threshold means part 2 will eventually `ANALYZE` it.
- **`analyzedRowCount` is dead in part 1.** Nothing writes it — no refresh exists yet — so
  the "analyzed" branch of `knownRowCount` is exercised only by the pure-function tests,
  never end-to-end. Part 2 populates it.
- **`staleLogged` never clears in part 1.** There is no reset path yet (part 2 resets the
  counter when a refresh succeeds). Consequence: once a table crosses, it logs once and
  then stays stale forever with a monotonically growing counter. Intended for this
  ticket, but it means a long-running process with `auto_analyze` on and no part 2 keeps
  one small entry per written table, growing without bound in `changedSinceAnalyze`.
  Entries themselves are bounded by table count.
- **`isStale` has a side effect.** When the table is gone it deletes the entry and returns
  false. Deliberate (the ticket asked for "skip and drop rather than throw") and tested,
  but a predicate that mutates is unusual enough to be worth a second opinion on the
  shape.
- **No test that the commit-hook `try/catch` actually protects the commit.** The catch is
  there and mirrors the watcher block above it; nothing forces a throw through it.
- **Option validation is tested through `db.setOption`, not `pragma`.** See findings below
  for why.

## Review findings

- The `pragma` emitter wraps *any* `setOption` failure into `Unknown pragma: <name>`, so
  `pragma auto_analyze_ratio = -1` reports a name problem for what is a value problem.
  Pre-existing and applies equally to every already-validated option
  (`default_collation`, `ddl_transaction_policy`,
  `materialized_view_rebuild_row_threshold`). The site is **already claimed** by
  `tickets/backlog/debt-audit-contextual-keyword-value-positions.md` (its third bullet),
  so no new ticket was filed; the new tests validate through `db.setOption` to assert the
  real error text.
- Tripwire parked as a `NOTE:` on the `entries` map in
  `packages/quereus/src/core/database-auto-analyze.ts`: staleness does not survive a
  process restart, so a table that drifted while the process was down looks fresh until it
  drifts again. States what would change if it ever matters (persist the counter beside
  the statistics entry).
- Accepted-tradeoff `NOTE:` parked at the `auto_analyze` option registration in
  `packages/quereus/src/core/database.ts`: default-on was weighed against default-off and
  chosen deliberately, with the revisit condition stated. A future reviewer should not
  re-litigate it without that condition having tripped.
- Cross-layer double-counting is documented at `getChangedRowCounts` in
  `packages/quereus/src/core/database-transaction.ts` as a deliberate approximation with
  its cost rationale.

## Docs

- `docs/optimizer-costing.md` — new "Detecting that statistics have gone stale" section,
  placed between the base-table row-estimate and module-size paragraphs it follows from.
- `docs/usage.md` — the four options added to the Available Options table.

## Downstream

`tickets/implement/2-auto-analyze-scheduled-refresh.md` declares
`prereq: auto-analyze-commit-counters` and extends this same module in place. It expects
to add `inFlight` / `timer` / `nextEligibleAt` / `running` to `TableStalenessEntry`, a
reset path that clears `changedSinceAnalyze` and `staleLogged` on a successful refresh,
and a writer for `analyzedRowCount`. Nothing here should be reshaped in a way that makes
those additions awkward.
