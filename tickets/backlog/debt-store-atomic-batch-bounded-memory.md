description: When the persistent store rewrites a whole table's rows in place (retyping a column, backfilling a NOT NULL default, re-keying), it must hold every changed row in memory at once to keep the change all-or-nothing; explore a way to keep it atomic without buffering the whole table.
files:
  - packages/quereus-store/src/common/store-table.ts   # mapRowsAtIndex (~553-570), rekeyRows (~594-632), migrateRows (~645-674)
  - packages/quereus-store/src/common/kv-store.ts       # WriteBatch, AtomicBatch, beginAtomicBatch
tradeoffs: There may be no fix: the single batch write is the only thing making these rewrites all-or-nothing, and any chunked alternative needs a rollback envelope the store does not have - so this is exploratory work that may conclude nothing can change.
----

# Store: bound the peak of in-place data-store rewrites without losing atomicity

Three store operations rewrite the **live data store in place**, each buffering
every changed row into one write batch before a single `batch.write()`:

- `StoreTable.mapRowsAtIndex` — `ALTER COLUMN … SET DATA TYPE` conversion and
  `SET NOT NULL` DEFAULT backfill.
- `StoreTable.migrateRows` — `ADD COLUMN` / `DROP COLUMN` layout migration.
- `StoreTable.rekeyRows` — `ALTER PRIMARY KEY` / `SET COLLATE` on a PK member
  (its pass-1 doubled peak is separately addressed by
  `store-rekey-peak-reduction`; the pass-2 write batch remains).

These run **after** `StoreModule.ddlCommitPendingOps` — the enclosing transaction
is already flushed and there is **no rollback envelope**. The single
`batch.write()` is the only thing making each rewrite all-or-nothing. A partial
chunked write here would be **silent corruption** (some rows migrated, some not,
no marker), so — unlike the index builds, which are derived state and are being
chunked in `store-stream-index-builds` — these cannot simply be chunk-flushed.

The peak is therefore O(changed rows) and, today, irreducible: keeping the write
atomic means holding it all before committing.

## Why this is a backlog item, not the streaming ticket

Bounding this peak needs a **capability that does not exist yet**, so it was
deliberately kept out of the first streaming pass:

- **`beginAtomicBatch` / `AtomicBatch` (`kv-store.ts`) does not help.** It exists
  to commit multiple stores of one provider atomically, but its implementations
  still accumulate every queued op in a JS-heap array — same memory profile as
  `WriteBatch`. It bounds nothing.
- A LevelDB write batch buffers in native (off-JS-heap) memory — a partial win at
  best, still unbounded and provider-specific.
- A genuinely bounded solution needs one of:
  - a **provider-level streaming atomic batch** that spills queued ops to disk
    while still committing all-or-nothing (new provider surface on every backend),
    or
  - a **write-ahead / journal recovery path** so a chunked in-place rewrite can be
    replayed-or-rolled-back after a crash (a recovery subsystem the store does not
    have today), or
  - a **rewrite-to-a-new-store-then-swap** approach (build the migrated table in a
    fresh store, then atomically swap it for the old one — needs an atomic
    store-swap primitive from the provider).

Each is a provider-capability and/or crash-recovery design, well beyond a
mechanical streaming change.

## What to decide when this is picked up

- Which of the three approaches (streaming atomic batch / journal / build-and-swap)
  fits the provider abstraction and the crash-safety bar the store wants.
- Whether the swap approach can reuse the existing store lifecycle
  (`getStore` / `deleteTableStores` / a rename-style relocation) rather than new
  provider surface.
- Whether this is worth doing at all before a real large-table workload shows the
  in-place rewrite peak as a problem — the index builds (the common large case:
  `CREATE INDEX`) are already handled by `store-stream-index-builds`, and full
  in-place column/PK rewrites of a huge table are rarer.

## Notes

Depends conceptually on the decomposed ALTER arms (`store-altertable-decompose`)
and follows the two streaming implement tickets (`store-stream-index-builds`,
`store-rekey-peak-reduction`) — but as a future concern, not active work. Promote
into `plan/` when a workload justifies it.
