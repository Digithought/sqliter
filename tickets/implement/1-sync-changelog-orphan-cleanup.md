description: When a synced row is deleted, the internal index that tracks recent changes keeps dead entries for that row forever, so the index grows with every delete a database ever performs instead of staying proportional to the data actually stored.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/metadata/change-log.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/metadata/keys.ts
  - packages/quereus-sync/test/metadata/change-log.spec.ts
  - packages/quereus-sync/test/sync/sync-manager.spec.ts
difficulty: medium
----

## What the change log is

`@quereus/sync` keeps three parallel KV structures under one store:

| prefix | store class | holds |
|--------|-------------|-------|
| `cv:`  | `ColumnVersionStore` | current value + HLC for every live cell |
| `tb:`  | `TombstoneStore`     | one record per deleted row |
| `cl:`  | `ChangeLogStore`     | an **index**: HLC-ordered pointers into `cv:` / `tb:` |

`cl:` keys sort by HLC (`cl:` + wallTime + counter + siteId + opSeq + type + table + pk + column),
so a peer that says "give me everything after HLC X" can range-scan forward instead of
scanning the whole database. That is the **only** consumer of `cl:` — verified:

- `getChangesSince(peer, sinceHLC)` → `collectChangesSince` → `changeLog.getChangesSince` (`sync-manager-impl.ts:973`) — **the one reader**.
- `getChangesSince(peer)` with **no** `sinceHLC` → `collectAllChanges` (`sync-manager-impl.ts:1065`) scans `cv:` and `tb:` directly. Does **not** touch `cl:`.
- Snapshots (`getSnapshot` / `getSnapshotStream`) also read `cv:` / `tb:` directly.

So `cl:` is a derived index over live `cv:`/`tb:` records. Every `cl:` entry that points at a
record which no longer exists is pure garbage: `resolveLogEntry` (`sync-manager-impl.ts:1008`)
already returns `null` for it and the scan skips it. Deleting such entries cannot change any
output — that is what makes this fix provably lossless.

## The defect

The engine is careful to keep `cl:` deduped on **overwrite** — a column write deletes the
prior `(pk, column)` entry (`sync-manager-impl.ts:828`, `change-applicator.ts:769`), and a new
tombstone deletes the prior `pk` delete entry (`sync-manager-impl.ts:772`,
`change-applicator.ts:750`). Repeated *updates* therefore do not accumulate.

Nothing does the equivalent on **delete**. Three leaks:

1. **Local delete orphans the row's column entries.** `recordDataEvent`
   (`sync-manager-impl.ts:783`) calls `columnVersions.deleteRowVersions(...)`, dropping every
   `cv:` record for the row, but leaves each corresponding `cl:` column entry behind. One
   orphan per column of every deleted row, permanently.

2. **Applied (inbound) delete orphans them identically.** `change-applicator.ts:709` calls the
   same `deleteRowVersions` with no `cl:` cleanup. This is the path a `sync-coordinator`
   relay runs almost exclusively.

3. **Tombstone pruning orphans the delete entry.** `pruneTombstones`
   (`sync-manager-impl.ts:1271`) deletes expired `tb:` records but not the matching `cl:`
   delete entry. One orphan per delete the replica has ever seen, forever.

Net effect: `cl:` size tracks *lifetime delete volume*, not live data size. A workload that
repeatedly inserts and deletes the same single row grows the change log without bound.

Beyond storage, orphans cost read time: `collectChangesSince` iterates them and issues a
`cv:`/`tb:` KV lookup per entry (via `resolveLogEntry`) before discarding each one, so every
delta-sync scan gets slower as the garbage accumulates.

## Reproduction

Measured with a scratch spec (`packages/quereus-sync/test/metadata/changelog-growth-repro.spec.ts`,
deleted after measuring — re-add the assertions as the regression tests below). Run via
`node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js <file>`
from the repo root. Counts came from `manager.changeLog.getAllChanges()`:

```
insert→delete cycles on ONE 3-column pk, count after each cycle:
  [4, 7, 10, 13, 16]          # +3 per cycle, forever — single row, unbounded growth
  pruneTombstones() removed 1 tombstone -> change log still 16

20 distinct 3-column rows, each inserted then deleted:
  80 entries (= 20 x (3 columns + 1 delete))
  after pruneTombstones() -> still 80

relay that only applies inbound changes, 10 rows inserted+deleted upstream:
  10 entries
  after pruneTombstones() -> still 10
```

Every one of those 16 / 80 / 10 entries resolves to `null` and is dead weight.

## Fix

Delete the `cl:` entries at the moment their target dies. No sweep, no timer, O(1) amortized
against work already being done.

**Local delete** — `recordDataEvent`, `sync-manager-impl.ts` around line 783. Before
`deleteRowVersions`, read the row's versions and drop each column's log entry:

```ts
const rowVersions = await this.columnVersions.getRowVersions(schemaName, tableName, pk);
for (const [column, version] of rowVersions) {
  this.changeLog.deleteEntryBatch(batch, version.hlc, 'column', schemaName, tableName, pk, column);
}
await this.columnVersions.deleteRowVersions(schemaName, tableName, pk);
```

`ColumnVersionStore.getRowVersions` (`column-version.ts:188`) already exists and returns
`Map<column, ColumnVersion>`. It derives the column name by splitting the `cv:` key at the
last `:` — the same string `buildChangeLogKey` was given, so the keys round-trip. Add a test
for a column name containing a `:` if `assertKeyableIdentifiers` does not already forbid one;
if it does forbid it, say so in a comment rather than testing it.

**Applied delete** — `change-applicator.ts` around line 709, same treatment inside the
`deleteWinners` loop. That loop is already async and already outside the main batch, so it
needs its own `WriteBatch` (or fold the log deletes into a batch written alongside the
version deletes). Keep the two deletions in one batch so a crash cannot drop the `cv:`
records while leaving the `cl:` entries.

**Tombstone prune** — `pruneTombstones`, `sync-manager-impl.ts:1271`. It already iterates
`tb:` with a batch open; parse the key and delete the paired log entry:

```ts
const parsed = parseTombstoneKey(entry.key);   // keys.ts:302 — returns { schema, table, pk }
if (parsed) {
  this.changeLog.deleteEntryBatch(batch, tombstone.hlc, 'delete', parsed.schema, parsed.table, parsed.pk);
}
```

`buildAllTombstonesScanBounds` / `parseTombstoneKey` are both already imported or trivially
importable there.

## What this fix deliberately does not do

After the above, `cl:` size is bounded by *live* cells plus *live* tombstones — i.e. by
dataset size, which is what an index over that data should cost. It is no longer a leak.

`ChangeLogStore.pruneEntriesBefore` (`change-log.ts:129`) — the horizon-style pruner the
original bug report pointed at — stays **uncalled**. Its logic is correct (`cl:` key byte
order is wallTime, counter, siteId, opSeq, which is exactly `compareHLC`'s field order, so
its early `break` is sound), but wiring it to a wall-clock horizon is a *behaviour* change,
not a leak fix: it would drop index entries for cells that are still live, which is only safe
if the server refuses delta sync for a too-old `sinceHLC`. `SyncManager.canDeltaSync` exists
for that check but **no production caller invokes it** — the coordinator's `get_changes`
handler (`packages/sync-coordinator/src/server/websocket.ts:193`) passes `sinceHLC` straight
through. Filed separately as `backlog/feat-sync-changelog-horizon-pruning`.

Do not delete `pruneEntriesBefore`; add a doc comment at its definition recording (a) that it
is intentionally unwired, (b) the `canDeltaSync`-enforcement precondition, and (c) the backlog
slug. Its existing test in `change-log.spec.ts` stays.

## TODO

- Add `getRowVersions`-driven `cl:` column-entry cleanup to `recordDataEvent`'s delete branch (`sync-manager-impl.ts` ~783), inside the same `WriteBatch`.
- Add the same cleanup to the `deleteWinners` loop in `change-applicator.ts` ~709; keep the `cv:` deletes and `cl:` deletes in one batch.
- Add paired `cl:` delete-entry removal to `pruneTombstones` (`sync-manager-impl.ts:1271`) via `parseTombstoneKey`.
- Add a doc comment on `ChangeLogStore.pruneEntriesBefore` explaining why it is unwired, naming the `canDeltaSync` precondition and the `feat-sync-changelog-horizon-pruning` backlog slug.
- Regression tests in `packages/quereus-sync/test/` asserting the change log returns to **zero** entries after: (a) N insert→delete cycles on one pk + `pruneTombstones`; (b) N distinct rows inserted then deleted + `pruneTombstones`; (c) a relay that only ran `applyChanges` for upstream insert+delete traffic + `pruneTombstones`. Use the counts in *Reproduction* as the pre-fix baseline.
- Add a test that a **live** row's `cl:` entries survive all of the above, and that `getChangesSince(peer, sinceHLC)` still returns the same ChangeSets before and after a delete+prune of unrelated rows.
- Note in the handoff: `TombstoneStore.pruneExpired` (`tombstones.ts:172`) and `TombstoneStore.deleteTombstone` (`tombstones.ts:136`) have **no production callers** either — out of scope here, but if either is wired up later it needs the same paired `cl:` cleanup. Consider a `NOTE:` comment at those two definitions.
- Run `yarn workspace @quereus/sync run test` and `yarn build`.
