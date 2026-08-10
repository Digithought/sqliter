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
----

## What shipped

`@quereus/sync` keeps three key-value structures side by side: `cv:` holds the current
value + timestamp of every live cell, `tb:` holds one record per deleted row, and `cl:`
is an index whose keys sort by timestamp so a peer asking "give me everything after
time X" can range-scan instead of reading the whole database. `cl:` entries are pure
pointers — `resolveLogEntry` returns `null` (entry skipped) when the record an entry
names is gone. `cl:` is read by exactly one function, `collectChangesSince`; full sync
and snapshots read `cv:`/`tb:` directly.

Nothing removed a `cl:` entry when its target died, so `cl:` grew with the replica's
lifetime delete volume instead of with the data it stores.

One shared helper, `deleteRowVersionsAndLogEntries` (`sync/sync-context.ts`), now
removes a row's column versions and the change-log entries indexing them in a single
`WriteBatch`, called from both delete paths:

| path | site |
|---|---|
| local DML capture | `recordDataEvent`, `sync-manager-impl.ts` |
| inbound apply | `commitChangeMetadata`'s `deleteWinners` loop, `change-applicator.ts` |

`SyncManagerImpl.pruneTombstones` (wired in production via `quoomb-web`'s
`sync-maintenance.ts`) additionally deletes each expiring tombstone's `delete`
change-log entry in the batch it already had open.

Supporting change: `ColumnVersionStore.getRowVersions` recovered each column's name by
splitting the key at its last colon; a column name may legally contain a colon, and a
wrong name deletes a key that does not exist while orphaning the real one. It now
strips the exact known prefix (`buildColumnVersionRowPrefix`, new in `keys.ts`, shared
with the scan-bounds builder so the two cannot drift).

Docs: `docs/sync.md` gained an "Entries die with their target" subsection.
`ChangeLogStore.pruneEntriesBefore`, `TombstoneStore.deleteTombstone` and
`TombstoneStore.pruneExpired` gained comments recording that they are unwired and what
would have to land with them.

## Review findings

### Verification run

`yarn build`, `yarn typecheck`, `yarn lint` — all clean. `yarn test` (whole monorepo) —
green, 0 failing, 4m42s. `@quereus/sync` alone: **489 passing** (488 handed off + 1
added below). No pre-existing failures surfaced, so no `.pre-existing-error.md` was
written.

I re-derived the implementer's claims rather than taking them: read the full diff
before the handoff summary, traced every remaining caller of the touched functions, and
built throwaway specs to confirm (not argue) the two defects below. Both scratch specs
were deleted after use.

### Confirmed correct

- **The prefix-strip fix is sound, including its edge cases.** I checked that
  `buildColumnVersionScanBounds`'s `[prefix, prefix+1)` range genuinely admits only
  keys of the target row (walked the byte comparisons for primary keys that are
  prefixes of one another, and for values containing `]`, `"` and `:`), and that
  `prefix.length` is a safe slice offset under `TextDecoder` for non-BMP characters and
  lone surrogates (both round-trip to the same UTF-16 code-unit count).
- **No missed cleanup site.** Both snapshot-apply paths (`applySnapshot` and
  `applySnapshotStream` via `clearExistingMetadata`) wipe `cv:`, `tb:` and `cl:`
  wholesale and rebuild, so they cannot orphan. Every other `cl:` deletion
  (`commitDeleteMetadata`, `commitColumnMetadata`, `recordDataEvent`'s dedup) already
  pairs with its record.
- **No resource leak in the early return.** `deleteRowVersionsAndLogEntries` abandons
  its batch unwritten when a row has no versions; both `WriteBatch` implementations
  (`InMemoryKVStore`, `LevelDBWriteBatch`) are plain operation arrays with no native
  handle, so nothing needs releasing.

### Major — filed as new tickets

- **`fix/sync-delete-cleanup-misses-same-batch-writes` — reachable data loss.** The
  cleanup scans committed store state, so it is blind to writes still pending in its
  caller's own batch. Reproduced against `main`, twice:
  - *Inbound:* `commitChangeMetadata` flushes its batch and then runs the cleanup, so
    the cleanup deletes cell records that same batch just wrote. Since `applyChanges`
    commits every ChangeSet it is handed in one go, a relay that receives
    "delete row 1" and "re-create row 1" together — routine on catch-up — ends with
    **zero** cells for row 1, discarding a re-insert that already won conflict
    resolution.
  - *Local:* `recordDataEvent` is the mirror image — its outer batch flushes after the
    cleanup runs — so a transaction that writes a row and then deletes it leaves three
    live cell records behind permanently. That is the same unbounded-growth failure
    this ticket set out to close, still open on the same-transaction path.

  Not a regression: the previous `deleteRowVersions` scanned identically. Filed to
  `fix/` rather than `backlog/` because the inbound half is silent data loss with an
  ordinary trigger. `sync-context.ts` carries a `KNOWN LIMITATION` comment naming the
  slug.
- **`backlog/debt-sync-changelog-orphan-repair-sweep`** — the implementer's own
  flagged gap (databases that already leaked keep their garbage forever, because
  cleanup keys off records that still exist). Filed as `debt-` rather than `fix-`:
  nothing is incorrect, the cost is storage plus a small per-scan overhead.
- **`backlog/debt-sync-typecheck-test-files`** — `packages/quereus-sync/tsconfig.json`
  excludes `test/` and the `typecheck` script uses that config, so no spec file in this
  package is ever type-checked, against the convention `AGENTS.md` states and
  `plugin-loader` follows. I measured the gap with a throwaway config: the *only*
  blockers are 13 unused declarations (`TS6133`) across three spec files — no real type
  errors — so it is a short mechanical cleanup. Two of those unused bindings
  (`changeLogAfterFirst`, `deleteHlc` in `sync-protocol-e2e.spec.ts`) may be missing
  assertions rather than clutter; the ticket says so.

### Reviewer judgement requested by the handoff

The implementer asked whether `bug-sync-colon-in-column-name-drops-cell` should jump
the queue. **No** — it stays in `backlog/`. It is data loss, but it needs a quoted
identifier containing a colon to trigger, and no such schema exists in this repo or its
tests. The same-batch bug above needs no unusual input at all, so it takes priority.

### Minor — fixed in this pass

- **Dead code removed.** `ColumnVersionStore.deleteRowVersions` had zero callers left
  anywhere (src, tests, other packages) — the handoff described it as "unused by the
  sync write paths", but it was unused outright, surviving only to carry a comment
  telling readers not to use it. Deleted; `deleteRowVersionsBatch` remains and is used.
- **Fabricated symbol name corrected.** Both the handoff and
  `backlog/bug-sync-colon-in-column-name-drops-cell` cited
  `clearNonPreservedMetadata` in `snapshot-stream.ts`. No such symbol exists anywhere in
  the repository; the real function is `clearExistingMetadata`. The described behaviour
  is accurate — only the name was wrong. Fixed in the backlog ticket so the next agent
  is not sent hunting.
- **Unused import removed** — `encodeSqlValue` in
  `test/metadata/column-version.spec.ts`, the one the handoff flagged.

### Test coverage — one gap closed, one deferred

The implementer's five scenarios are good storage-growth tests and their counting
strategy (raw `cl:` records rather than `getAllChanges`, which would hide unparseable
entries) is the right call. What they did not cover was *interaction within a single
transaction*, which is exactly where the defect above lives.

Added `keeps a reinsert that follows a delete of the same row in one transaction` to
`changelog-orphan-cleanup.spec.ts`. This pins the ordering that **does** work today
(cleanup runs before the outer batch lands, so a following reinsert survives) and is
therefore a guard rail for the fix ticket: the opposite ordering must be repaired
without breaking this one. The two failing orderings are deliberately *not* added as
skipped or failing tests — the fix ticket owns them, and this pass leaves the suite
green.

Deferred, and honestly untestable here: the crash-between-batches atomicity claims
(no fault-injection harness for partial batch writes exists in this package) and the
LevelDB-backed store path (all sync tests use `InMemoryKVStore`). I read
`LevelDBWriteBatch` and confirmed the code's store-agnostic assumption holds for it,
but that is a code read, not a measurement.

### Tripwires — noted, not ticketed

The implementer parked two, and I left both where they are: `deleteRowVersionsBatch`
fully deserializes each cell to recover a timestamp (`column-version.ts`), and
`TombstoneStore.deleteTombstone` / `pruneExpired` have no production callers but would
need paired change-log cleanup if wired (`tombstones.ts`). Both are correctly
conditional — neither is wrong today. I added none of my own.

### Explicitly checked, nothing found

- Error handling: the one new failure branch (`pruneTombstones`'s unparseable-key
  `console.warn`) is reachable only via a `.` in a schema name or a `:` in a table name,
  degrades to leaving one orphan, and logs. Correct.
- Type safety: no `any`, no inline `import()`, no silently eaten exceptions in the
  diff.
- Source hygiene: functions are short and single-purpose; the new helper composes
  rather than inlining. Comment density is high but each comment states a
  non-obvious invariant. `sync-manager-impl.ts` remains oversized at ~1300 lines —
  pre-existing, untouched by this diff, and not worth a ticket on its own.
- Docs: `docs/sync.md`'s new subsection matches the shipped code, including which
  function runs at which site. No other doc referenced the changed functions.
