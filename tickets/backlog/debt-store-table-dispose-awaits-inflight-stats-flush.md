description: When a table is closed, renamed or dropped, a statistics save that is already being written in the background is not waited for, so in rare timing it can land after the cleanup and leave a stale row count behind. Make the close wait for it.
files:
  - packages/quereus-store/src/common/store-table-base.ts   # trackMutation (queueMicrotask(flushStats)), flushStats, dispose — the one site
  - packages/quereus-store/src/common/store-module.ts       # tearDownTableStorage — the drop-side delete this can undo
  - packages/quereus-store/src/common/store-module-rename.ts # renameTable's stats re-key — same exposure
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Statistics are advisory and the next ANALYZE (or the next 100 mutations) reconciles the count, so a maintainer may reasonably judge the race not worth a lifecycle change to the table base class.
---

# A table's stats write is fire-and-forget, so cleanup can be overtaken by it

## What happens today

A store table counts its own row mutations. Every hundred mutations it starts saving the
count to disk *in the background* — the save is started and never tracked, so nothing can
wait for it:

- `StoreTableBase.trackMutation` sets a "flush pending" flag and starts the save with
  `queueMicrotask(() => this.flushStats())`. The returned promise is dropped.
- `flushStats` zeroes the buffered mutation counter **before** its first `await`, then
  writes the record.
- `StoreTableBase.dispose` — the last-chance flush run when a table is evicted, dropped or
  renamed — flushes only when that counter is still non-zero. A save already in flight has
  already zeroed it, so dispose sees nothing to do and returns while the write is still
  outstanding.

Consequence: the drop path deletes the table's statistics entry (added by
`bug-drop-table-leaves-stale-stats-entry`) and the in-flight write can then land *after*
the delete, re-creating the entry for a table that no longer exists — the exact residue
that fix removed. A table later created under the same freed name inherits it. The rename
path's re-key has the same exposure in the other direction (a write under the old key
landing after the re-key).

Only reachable on a provider whose write is genuinely asynchronous (LevelDB, IndexedDB):
with an in-memory store the microtask completes before anything else can run. Found by
reading the code during the review of the drop-side fix, not observed in a running system.

## What should be true

Disposing a table should mean its statistics record is settled: no write started by that
table can land after dispose returns. The natural shape is for the table to hold the
in-flight flush promise and for `dispose` to await it (in addition to the buffered-delta
flush it already does), rather than for each caller — drop, rename, close — to guess.

Fixing it at that one site retires the whole class: the drop delete, the rename re-key and
plain close all become ordered against the background save at once.

## How it would be confirmed

A test provider whose stats-store `put` resolves only when the test releases it: mutate
past the flush threshold, let the flush start, then drop the table and release the write —
today the entry reappears in the stats store after the drop completed.
