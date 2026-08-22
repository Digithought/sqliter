---
description: The engine has no idea how much a table has changed since anyone last collected statistics for it, so it can never decide the statistics are out of date. This adds that bookkeeping — a cheap per-table count of committed row changes — plus the settings that will control it. It only counts and reports; refreshing statistics comes next.
files:
  - packages/quereus/src/core/database-auto-analyze.ts            # NEW — staleness bookkeeping + threshold policy
  - packages/quereus/src/core/database-transaction.ts             # ~51 context iface, ~241 commitTransaction, ~625 getChangedBaseTables
  - packages/quereus/src/core/database.ts                         # ~211 ctor, ~294-430 option registration, ~1261 close()
  - packages/quereus/src/core/database-watchers.ts                # ~93 schema-listener + dispose pattern to copy
  - packages/quereus/src/planner/stats/table-cardinality.ts       # catalogRowCount() — the known-row-count source
  - packages/quereus/src/schema/change-events.ts                  # TableRemovedEvent — the drop hook
  - packages/quereus/src/util/qualified-name.ts                   # splitBaseKey()
  - packages/quereus/test/auto-analyze-counters.spec.ts           # NEW
difficulty: medium
---

# Auto-analyze, part 1: committed-mutation counters and threshold policy

Part 1 of two. This ticket lands the bookkeeping and the settings; it deliberately
performs **no statistics collection**. When a table crosses the staleness threshold it
writes a debug log line and nothing else. Part 2 (`auto-analyze-scheduled-refresh`)
turns that signal into an actual background refresh. Splitting this way keeps the
subtle part — what counts as a change, and when a count is discarded — under its own
focused tests.

## Why the obvious hook point is the wrong one

The plan ticket named `DatabaseEventEmitter.onTransactionCommit` as the preferred place
to count committed mutations. **Do not use it.** `needsDataEvents()`
(`database-events.ts` ~line 490) returns true as soon as *any* transaction-commit
listener is registered, and the DML executor consults it three times
(`runtime/emit/dml-executor.ts` lines 1070, 1350, 1538) to decide whether to build a
`DatabaseDataChangeEvent` per mutated row — including a full copy of the row
(`[...storedRow]`). Those events are then buffered for the whole transaction and
flushed at commit. Registering one listener would add a per-row allocation and an
unbounded per-transaction buffer to **every write in the database**, forever, purely so
we could count. Unacceptable for a feature that ships on by default.

## The counting source that is already free

`Database._recordInsert` / `_recordUpdate` / `_recordDelete` (`database.ts` ~1898)
delegate to `TransactionManager.recordInsert/recordUpdate/recordDelete`
(`database-transaction.ts` ~567). The DML executor calls them **unconditionally** — no
listener gate — so the change log is already maintained on every write path today. It
is a `Map<tableKey, Map<encodedPk, CapturedRow>>` per savepoint layer, where `tableKey`
is a lowercased `schema.table`.

So the per-table count of committed changed rows is the **size** of each table's inner
map, summed across the base layer and every live savepoint layer. `Map.size` is O(1),
so the whole reading is O(tables × layers) — no scan, no allocation of note.

Add to `TransactionManager`, next to the existing `getChangedBaseTables()` (~line 625):

```ts
/** Per-table count of distinct changed primary keys across the base layer and every
 *  live savepoint layer. Cheap: one `Map.size` read per table per layer. */
getChangedRowCounts(): Map<string, number>
```

Semantics this inherits from the change log, and which the tests must pin:

- **Coalesced.** Ten updates to one row count as one. An insert followed by a delete of
  the same key nets to zero entries and counts as zero. This is a *distinct rows
  touched* measure, which is the right input to a staleness heuristic.
- **Rollback-safe for free.** A rolled-back savepoint's layer is popped
  (`rollbackToSavepoint`, ~line 827), so its rows are gone before we look.
- **Approximate across layers.** The same key changed in two live savepoint layers is
  counted twice. Fine — this is a heuristic, not an invariant. Say so at the site.

## Where the reading happens

`TransactionManager.commitTransaction()` (~line 241) already has exactly the right
window, and already documents it: *"Fire post-commit watchers while the change log is
still alive."* `runPostCommitWatchers()` runs inside the `try` after
`commitSucceeded = true`; `clearChangeLog()` runs in the `finally`. Insert the counter
update immediately after the post-commit watcher block, wrapped in its own `try/catch`
the same way — a bookkeeping error must never fail a committed transaction.

Extend the `TransactionManagerContext` interface (~line 51) with one method, passing a
**thunk** so the counts map is never materialized when the feature is off:

```ts
/** Called after a successful commit, before the change log is cleared. The callback
 *  materializes per-table committed row counts only if a consumer wants them. */
recordCommittedChangeCounts(counts: () => Map<string, number>): void;
```

`Database`'s implementation returns immediately when `auto_analyze` is off, otherwise
calls `this.autoAnalyze.recordCommit(counts())`.

Rollback needs no hook at all: `rollbackTransaction()` clears the change log without
ever calling this.

The **sync/external-change ingest path also commits through this manager**
(`database-external-changes.ts` calls `db._commitTransaction()` at lines 266 and 272,
having recorded its changes at line 188), so remotely-applied rows are counted too —
correct, they are real committed mutations.

## The new module: `src/core/database-auto-analyze.ts`

Lives in `src/core/` alongside its siblings (`database-watchers.ts`,
`database-assertions.ts`, `database-materialized-views.ts`) because it is engine
lifecycle plumbing, not planner logic. Copy the shape of `database-watchers.ts`: a
class owned by `Database`, constructed in the `Database` constructor, subscribed to the
schema-change notifier, disposed from `Database.close()`.

```ts
interface TableStalenessEntry {
	/** Distinct rows changed by committed transactions since the last successful
	 *  statistics refresh. */
	changedSinceAnalyze: number;
	/** rowCount recorded by the last refresh this process observed; undefined = never. */
	analyzedRowCount: number | undefined;
	/** True once this crossing has been logged; cleared when the counter resets. */
	staleLogged: boolean;
}
```

Part 2 adds the scheduling fields (`inFlight`, `timer`, `nextEligibleAt`, `running`).
Keep the interface in this file so part 2 extends it in place.

Keyed by the lowercased `schema.table` string the change log already uses — no
re-derivation, no second key convention.

Public surface for this ticket:

- `recordCommit(counts: Map<string, number>): void` — add each count to its entry
  (creating entries lazily), then evaluate the threshold for each table touched.
- `isStale(key: string): boolean` — the threshold predicate, reachable from tests.
- `dispose(): void` — unsubscribe the schema listener, clear the map.

### Threshold policy

```
stale  ⟺  changedSinceAnalyze >= max(min_mutations, ratio × knownRowCount)
```

`knownRowCount` = the entry's own `analyzedRowCount` when set, else
`catalogRowCount(tableSchema) ?? 0` (`planner/stats/table-cardinality.ts`, which reads
`statistics?.rowCount ?? estimatedRows`). For a never-analyzed table that is `0` —
`SchemaManager` hardcodes `estimatedRows` to 0 at create — so the absolute floor
governs, which is exactly the case that matters: bulk-loading rows into a fresh table
trips `min_mutations` long before any percentage of zero could.

Precedent for the defaults: SQL Server auto-update-stats uses 500 + 20% of rows;
PostgreSQL autoanalyze uses 50 + 10%.

When a table is stale, this ticket only logs (`createLogger('core:auto-analyze')`).
The counter is **not** reset — part 2 resets it when a refresh actually succeeds. Log
once per crossing, not once per commit, or a busy table floods the log: that is what
`staleLogged` is for.

### Entry lifecycle

- Created lazily on the first commit that touches the table.
- **Dropped on `table_removed`** from the schema-change notifier
  (`schema/change-events.ts`), so a table re-created under a dropped name starts clean.
  Subscribe exactly as `database-watchers.ts` ~line 93 does.
- **Do not react to `table_modified`.** Statistics refreshes themselves fire
  `table_modified` (see `runtime/emit/analyze.ts` ~line 140), so acting on it would
  couple this module to its own future output.
- Nothing persists. After a restart the store backend's persisted statistics still
  exist, but staleness accumulation restarts from zero — so a table that drifted while
  the process was down looks fresh until it drifts again. Accepted for v1 (a restart is
  rare relative to the mutation threshold). Leave a `NOTE:` at the site saying what
  would change if it ever matters (persist the counter beside the stats entry).

## Options

Register in `Database.setupOptionListeners()` (`database.ts` ~294-430), following the
`materialized_view_rebuild_row_threshold` entry as the model for a numeric option with
set-time validation — an invalid value throws in `onChange` and the options framework
rolls the value back.

| option | type | default | meaning |
| --- | --- | --- | --- |
| `auto_analyze` | boolean | `true` | Feature switch. When off, no counting happens at all. |
| `auto_analyze_min_mutations` | number | `500` | Absolute floor; positive integer. |
| `auto_analyze_ratio` | number | `0.2` | Fraction of known row count; finite and `> 0`. |
| `auto_analyze_row_limit` | number | `100000` | Consumed by part 2; register here so all four land together. Finite and `>= 0`. |

**Default-on is a deliberate call, made here and not left to the implementer.** The
documented failure mode (`debt-docs-analyze-guidance`: three of four real user
performance reports resolved to statistics never having been collected) is precisely
users who never learn `ANALYZE` exists — an off-by-default feature helps none of them.
The decline argument (a maintainer might prefer default-off for zero behavior change)
was weighed and rejected because part 2's blast radius is bounded by the row limit, the
duty-cycle cooldown, and the open-transaction deferral. Record this as a `NOTE:` at the
`auto_analyze` registration so a future reviewer does not re-litigate it.

Toggling `auto_analyze` from off to on mid-session starts counting from zero rather
than reconstructing missed mutations. Say so in the option description.

## Edge cases & interactions

- **Rollback must not count.** Both an explicit `rollback` and a rolled-back savepoint.
  The change log gives this for free; a test must pin it, because "for free" is exactly
  the kind of property a later refactor silently breaks.
- **Coalescing.** `insert` then `delete` of the same key in one transaction ⇒ zero.
  `update` × 10 of one row ⇒ one.
- **Primary-key relocation** is recorded as delete-of-old + insert-of-new
  (`recordUpdate`, ~line 604), so it counts as two changed rows. Correct and intended;
  assert it so the behavior is documented rather than accidental.
- **Materialized-view backing writes** reach `_recordInsert` through
  `database-materialized-views.ts` ~line 755. A backing table is a real table and its
  rows are real mutations — count them.
- **Table dropped between commit and lookup.** `recordCommit` looks up the
  `TableSchema` to read `knownRowCount`; the table may already be gone. Skip and drop
  the entry rather than throwing.
- **Cross-schema name collisions.** `main.t` and `temp.t` are distinct keys. Pin it.
- **`auto_analyze = false`** ⇒ `recordCommittedChangeCounts` must not even build the
  map. Assert the thunk is never invoked.
- **Empty commit.** A transaction that changed nothing produces an empty map; no
  entries created. (`commitTransaction` runs for empty transactions too.)
- **Close.** `dispose()` from `Database.close()` must unsubscribe the schema listener —
  otherwise the notifier retains the manager for the life of the notifier.

## Test strategy

New Mocha spec `packages/quereus/test/auto-analyze-counters.spec.ts` (unit-level; the
policy is not expressible in `.sqllogic`). Reach the manager through an `@internal`
accessor on `Database` rather than exporting engine internals.

- Counter accumulation across several autocommit statements; across one explicit
  transaction; across a savepoint that is released.
- Rollback of an explicit transaction ⇒ counter unchanged.
- Rollback to a savepoint ⇒ only the surviving layer's rows counted.
- Insert-then-delete same key ⇒ 0. Ten updates of one row ⇒ 1. PK relocation ⇒ 2.
- Threshold math as a pure-function test: never-analyzed (floor governs), analyzed
  small table (floor still governs), analyzed large table (ratio governs), custom
  `min_mutations` / `ratio` values.
- `drop table` clears the entry; re-creating the name starts at zero.
- `pragma auto_analyze = false` ⇒ no entries created, thunk never invoked.
- Two schemas, same table name ⇒ two entries.
- Option validation: negative `min_mutations`, zero/negative `ratio`, non-finite values
  all throw and roll the option value back.

## TODO

- [ ] Add `TransactionManager.getChangedRowCounts(): Map<string, number>` beside
      `getChangedBaseTables()`, summing `Map.size` over the base layer and every
      savepoint layer. Document the cross-layer double-count as deliberate.
- [ ] Extend `TransactionManagerContext` with
      `recordCommittedChangeCounts(counts: () => Map<string, number>): void`.
- [ ] Call it in `commitTransaction()` right after the post-commit watcher block,
      inside its own `try/catch`, before the `finally` that clears the change log.
- [ ] Create `src/core/database-auto-analyze.ts`: `AutoAnalyzeManager` with the
      staleness map, `recordCommit`, `isStale`, the `table_removed` subscription, and
      `dispose()`. Modelled on `database-watchers.ts`.
- [ ] Instantiate in the `Database` constructor; `dispose()` from `Database.close()`
      alongside the other manager disposals.
- [ ] Implement `Database.recordCommittedChangeCounts` — early-return when
      `auto_analyze` is off so the thunk never runs.
- [ ] Register the four options with set-time validation; add the default-on rationale
      as a `NOTE:` at the `auto_analyze` registration.
- [ ] Add a `NOTE:` where the counters live recording that staleness does not survive a
      restart, and what would change if that ever matters.
- [ ] Write `test/auto-analyze-counters.spec.ts` covering everything under *Test
      strategy*.
- [ ] `yarn build`, `yarn lint`, `yarn test` — all green before handing off.
