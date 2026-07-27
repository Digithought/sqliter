description: When a single database transaction touched the same row more than once, the sync bookkeeping for that transaction was computed as if the earlier touches had not happened — leaving records for rows that no longer exist and, in some cases, two index entries where there must be exactly one. Fixed by letting the capture path read the transaction's own pending writes.
files:
  - packages/quereus-sync/src/sync/staged-transaction-metadata.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/src/metadata/column-version.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/sync/staged-transaction-metadata.spec.ts
  - docs/sync.md
----

# Complete: local capture reads its own writes

Second (local-capture) half of `sync-delete-cleanup-misses-same-batch-writes`; the
inbound half landed as `sync-inbound-batch-delete-blocks-same-batch-writes`.

## What shipped

`handleTransactionCommit` records one committed engine transaction into a single
`WriteBatch`, but every read it performed — the prior column version, the prior
tombstone, and the delete cleanup's scan for a row's cell records — hit *committed*
storage. A transaction's later events therefore could not see its own earlier staged
writes, so a transaction touching one row twice leaked cell records for tombstoned
rows and could leave two change-log entries for one key (breaking
`collectChangesSince`'s at-most-one-entry-per-key invariant).

- **New `staged-transaction-metadata.ts`** — a per-transaction overlay of what the
  transaction has staged: live cell versions per column, a row-cleared flag, and the
  staged tombstone's HLC. Rows keyed by the same pk identity the storage keys use,
  with `\0`-separated schema/table so dotted identifiers cannot collide. One instance
  per `handleTransactionCommit` call.
- **Capture reads overlay-first** in `recordDataEvent` / `recordColumnVersions`, and
  notes every staged write back into the overlay. A cell staged as deleted reads as
  absent, so a reinsert after a same-transaction delete records no before-image.
- **Delete cleanup stages into the transaction's batch.**
  `deleteRowVersionsAndLogEntries` takes a caller-supplied `WriteBatch` it does not
  write, plus optional `{ keepColumns, staged }`; its column set is
  (committed scan) ∪ (overlay's live staged columns), keyed by each column's staged
  HLC where one exists. Staged-only cells get an explicit `cv:` delete via the new
  `ColumnVersionStore.deleteColumnVersionBatch`. Relies on the batch later-op-wins
  ordering from `sync-write-batch-op-order-guarantee`.
- **Atomicity hardening (incidental):** the whole transaction's metadata, cleanup
  included, now lands in ONE batch. Previously the cleanup committed separately and
  earlier, so a crash between the two lost metadata and a mid-capture throw left the
  cleanup committed on its own.
- The inbound apply path keeps its previous behaviour (fresh batch per winning
  delete, written by the caller, `keepColumns` preserved, no overlay).
- `docs/sync.md` gained *Local capture reads its own writes* under § Write side and a
  cross-reference from the read-side dedup paragraph; the `KNOWN LIMITATION` block in
  `sync-context.ts` is gone.

## Review findings

### Correctness — nothing broken found

Traced every repeat-touch sequence by hand against the batch's later-op-wins
ordering: insert→delete, update→delete, update→update, delete→reinsert→delete,
update→delete→reinsert, insert→update→delete, and multi-row / multi-table mixes. In
every case the surviving `cv:` records, `cl:` entries and tombstone match what the
same statements produce as separate transactions, and every staged delete is issued
*after* the staged put it must beat. Also confirmed:

- The tombstone key (`tb:{schema}.{table}:{identity}`) carries no HLC, so a second
  same-transaction tombstone overwrites rather than accumulating — pinned by the
  tombstone-count assertions.
- `getPkKeying` is synchronous, so the overlay's constructor callback is sound.
- The inbound path's change (batch created and written by the caller instead of
  inside the helper) is granularity-identical to before. It loses only the
  `removed.size === 0` early return, i.e. one empty `WriteBatch.write()` per winning
  delete with no committed cells — a no-op on every backend.
- The emitted-payload delta the implementer flagged (a repeated same-cell update now
  reports the earlier same-transaction value as its before-image) is correct and
  matches both the persisted record and separate-transaction behaviour. Checked every
  `onLocalChange` consumer: `sync-client.ts` ignores the event body entirely and the
  quoomb-web worker reads only `changes.length`. Nothing reads the before-image.

### Fixed inline (minor)

- `recordColumnVersions`' three-state overlay lookup was written as
  `stagedCell !== undefined ? stagedCell ?? undefined : await …`, which reads as a
  puzzle. Rewritten as an explicit "null means staged-as-deleted" branch.
- **Test gap the handoff named:** added an overlay unit test for pk spellings that a
  non-identity key collation folds together — two spellings of one row must share one
  overlay slot, exactly as they share one storage key.
- **Test gap found in review:** every existing assertion was about *stored* state
  (`cv:` records, raw `cl:` counts). Added a peer-facing test — after a transaction
  that updates one cell twice and inserts-then-deletes another row,
  `getChangesSince` must hand the peer exactly one change per key, in `opSeq` order.
  That is the invariant the stored-state counts exist to protect, and it was only
  asserted indirectly.

### Major findings — none

No new `fix/`, `plan/`, or `backlog/` tickets. Nothing found that is wrong today or
wrong the moment a dormant path runs.

### Tripwires (parked in code, not ticketed)

- The overlay retains one `ColumnVersionData` — value *and* before-image — per staged
  cell for the transaction's life, roughly doubling capture's peak footprint (the
  `changes[]` array already holds one entry per fact). `NOTE:` on the class field in
  `staged-transaction-metadata.ts`, including which consumer needs the values and
  which needs only the HLC.
- The pre-existing `NOTE:` on `deleteRowVersionsBatch` (it fully deserializes each
  cell when the caller wants only the HLC prefix) was re-read and is still accurate;
  the new staged path adds no cell reads.

### Observations, deliberately not changed

- `deleteRowVersionsAndLogEntries`'s `rowCleared && !stagedColumns.has(column)` skip
  is defensive: no DML sequence reaches it today, because a reinsert after a
  same-transaction delete carries no `oldRow` and therefore re-stages every column.
  Were it to fire, the skipped `cl:` delete was already staged by the clear, so it is
  harmless either way. Left in place — it is documented, and it becomes load-bearing
  the moment a reinsert covers fewer columns than the committed record set.
- `recordColumnVersions` now takes nine positional parameters. Above what I would
  like, but it is a private method with a single call site and every parameter is
  distinctly typed; folding them into an options object is churn without a reader
  win.
- **Not tested, and no test needed:** a local transaction mixing DDL with repeated
  same-row DML. The overlay is orthogonal to `recordSchemaMigration` (which touches
  no per-row metadata) and all DDL is recorded before any DML, so there is no
  interaction to exercise.

### Docs

Read every file the change touched plus `docs/sync.md` end to end around the sync
write/read sections. Both edited passages describe the shipped behaviour accurately,
and the pseudocode's "all metadata for the transaction, atomically" claim is now
literally true. Grepped the repo for surviving references to the removed
`KNOWN LIMITATION` and to `sync-delete-cleanup-misses-same-batch-writes`: the only
stale copy is in `packages/quereus-sync/dist/` (a build artifact, regenerated on the
next build) — no source or doc references remain.

### Validation

- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` (full workspace) — all suites green, zero failing.
  `@quereus/sync` at 565 passing (563 from implement, +2 added in review).
- No pre-existing failures surfaced; `tickets/.pre-existing-known.md` untouched.
