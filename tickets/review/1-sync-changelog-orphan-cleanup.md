description: Deleting a synced row used to leave dead entries in the index that tracks recent changes, so that index grew forever with every delete a device performed; entries are now removed at the moment the data they point at is removed.
files:
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/metadata/keys.ts
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/metadata/column-version.spec.ts
  - docs/sync.md
difficulty: medium
----

## Background in one paragraph

`@quereus/sync` keeps three key-value structures side by side: `cv:` holds the current
value + timestamp of every live cell, `tb:` holds one record per deleted row, and `cl:`
is an **index** whose keys sort by timestamp so a peer asking "give me everything after
time X" can range-scan instead of reading the whole database. `cl:` entries are pure
pointers — `resolveLogEntry` looks up the `cv:`/`tb:` record an entry names and returns
`null` (entry skipped) when it is gone. `cl:` is read by exactly one function,
`collectChangesSince`; full sync and snapshots read `cv:`/`tb:` directly.

Nothing removed a `cl:` entry when its target died, so `cl:` grew with the replica's
**lifetime delete volume** instead of with the data it actually stores. A workload that
repeatedly inserts and deletes one row grew the index without bound. Beyond storage,
every stale entry costs one key-value lookup per delta scan before being discarded.

## What changed

One shared helper, `deleteRowVersionsAndLogEntries` (`sync/sync-context.ts`), removes a
row's column versions and the change-log entries indexing them in a single `WriteBatch`.
It is called from both delete paths so they stay symmetric:

| path | site | who runs it |
|---|---|---|
| local DML capture | `recordDataEvent`, `sync-manager-impl.ts` | any replica doing its own writes |
| inbound apply | `commitChangeMetadata`'s `deleteWinners` loop, `change-applicator.ts` | a relay/coordinator, almost exclusively |

Third leak, separate site: `SyncManagerImpl.pruneTombstones` now parses each expiring
tombstone's key and deletes that pk's `delete` change-log entry in the same batch it
already had open. That sweep **is** wired in production — `quoomb-web`'s
`sync-maintenance.ts` calls it.

Supporting change: `ColumnVersionStore.getRowVersions` recovered each column's name by
splitting the key at its **last** colon. A column name may legally contain a colon, and
the recovered name is fed straight back into `buildChangeLogKey` to locate that column's
entry — a wrong name deletes a key that does not exist and orphans the real one. It now
strips the exact known prefix (`buildColumnVersionRowPrefix`, new in `keys.ts`, also used
by the scan-bounds builder so the two cannot drift). `deleteRowVersionsBatch` was added
alongside; the pre-existing `deleteRowVersions` delegates to it and is now unused by the
sync write paths.

Documentation: `docs/sync.md` gains an "Entries die with their target" subsection under
the change-log discussion. `ChangeLogStore.pruneEntriesBefore` gains a doc comment saying
it is intentionally unwired, what would have to land first (`SyncManager.canDeltaSync`
enforcement, which the coordinator does not currently invoke), and the backlog slug
`feat-sync-changelog-horizon-pruning`. `TombstoneStore.deleteTombstone` and
`TombstoneStore.pruneExpired` gain `NOTE:` comments — neither has a production caller, and
either would need the same paired change-log cleanup if wired up.

## How to validate

`yarn workspace @quereus/sync run test` — 488 passing. `yarn test` (whole monorepo) —
7329 + all other suites passing, 0 failing. `yarn build` and `yarn typecheck` clean.

New suite: `packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts` (5 tests).
It counts **raw `cl:` key-value records** rather than going through
`changeLog.getAllChanges()`, deliberately: it is a storage-growth test, and
`getAllChanges` silently skips entries its key parser cannot decode, which would hide the
very thing under test. Scenarios and their measured pre-fix counts:

| scenario | pre-fix | post-fix |
|---|---|---|
| 5 insert→delete cycles on one 3-column row | 4, 7, 10, 13, 16 (grows forever) | 1 after each cycle, 0 after prune |
| 20 distinct rows inserted then deleted | 80, still 80 after prune | 20, then 0 after prune |
| relay applying 10 upstream inserts then 10 deletes | 40, still 40 after prune | 10, then 0 after prune |
| 2 live rows kept while an unrelated row churns | 9 (3 orphans) | 6 — and `getChangesSince(peer, sinceHLC)` returns a byte-identical result before and after the unrelated row's whole insert→delete→prune lifecycle |
| a column literally named `a:b` | 2 (the `a:b` entry orphaned) | 1, then 0 after prune |

Also two units in `test/metadata/column-version.spec.ts` covering column-name recovery
for a name containing a colon and for a primary-key value containing one.

**Each of the three fix sites was verified to be individually load-bearing**: I
temporarily reverted each one and confirmed the suite fails with the expected counts,
then restored it. The pre-fix column above is measured, not asserted from the ticket.

Manual sanity check worth doing: with a real `quoomb-web` database, run the maintenance
sweep after some delete traffic and confirm the `cl:` key count tracks live rows.

## Known gaps — please look at these

- **Pre-existing orphans are not swept.** This stops accumulation going forward; it does
  not clean a database that already leaked. Cleanup keys off versions that still exist,
  so an entry whose target was deleted before this change will never be found by it. A
  database in the field keeps its existing garbage forever. No repair path was written —
  worth a decision on whether one is needed (a one-shot sweep would be straightforward:
  iterate `cl:`, drop every entry that resolves to `null`).
- **A colon in a column name breaks other things this ticket did not fix.**
  `parseColumnVersionKey` and `parseChangeLogKey` split at the last colon and cannot be
  fixed the same way (they get only raw key bytes, with no primary key to anchor on).
  Consequences are real and silent: the cell is skipped by full sync and by snapshots,
  and `clearNonPreservedMetadata` can *delete* it while applying an incoming snapshot.
  Filed as `backlog/bug-sync-colon-in-column-name-drops-cell`; a `NOTE:` at
  `parseColumnVersionKey` points there. **Reviewer judgement wanted on whether that
  deserves to jump the queue** — it is data loss, just data loss that needs an unusual
  column name to trigger.
- **The local path's atomicity is unchanged, not improved.** `deleteRowVersionsAndLogEntries`
  runs in its own batch, awaited *before* the transaction's outer batch (tombstone +
  new delete entry) is written — exactly where the old `deleteRowVersions` call sat. A
  crash in that window loses the row's versions without recording a tombstone. That
  window predates this ticket and I deliberately did not close it: folding the versions
  into the outer batch would change what a delete-then-reinsert of the same key inside
  one transaction sees (the reinsert's `getColumnVersion` would still observe the
  pre-delete version and record it as the new cell's before-image). Flagging rather than
  silently changing behaviour.
- **Tripwires parked in code, not filed as tickets** (per the workflow's rule):
  - `column-version.ts`, `deleteRowVersionsBatch` — delete now fully deserializes each
    cell (a JSON parse of the value) to recover a 30-byte timestamp. If deleting wide
    rows or rows with large blob cells shows up as slow, read only the timestamp prefix.
  - `tombstones.ts`, `deleteTombstone` and `pruneExpired` — no production callers today;
    if either is wired up it needs the same paired change-log cleanup.
- **Not tested: a crash between the two batches.** There is no fault-injection harness for
  partial batch writes in this package, so the atomicity claims in the comments are
  argued, not exercised.
- **Not tested: the LevelDB-backed store path.** All new tests use `InMemoryKVStore`, like
  the rest of the sync suite. The code is store-agnostic (plain batch/iterate), but that
  is an assumption, not a measurement.
- Pre-existing, untouched: `packages/quereus-sync/test/metadata/column-version.spec.ts`
  imports `encodeSqlValue` without using it. The package's `tsconfig.json` excludes
  `test/`, so nothing typechecks these spec files.
