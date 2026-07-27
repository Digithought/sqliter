----
description: When a single database transaction touched the same row more than once, the sync bookkeeping for that transaction was computed as if the earlier touches had not happened — leaving records for rows that no longer exist and, in some cases, two index entries where there must be exactly one. Fixed by letting the capture path read the transaction's own pending writes.
prereq: sync-write-batch-op-order-guarantee, sync-inbound-batch-delete-blocks-same-batch-writes
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

# Implemented: local capture read-your-own-writes

Second (local-capture) half of `sync-delete-cleanup-misses-same-batch-writes`; the
inbound half landed as `sync-inbound-batch-delete-blocks-same-batch-writes`.

## What was wrong

`handleTransactionCommit` records one committed engine transaction into a single
`WriteBatch`, but every read it performed (prior column version, prior tombstone,
the delete cleanup's scan for a row's cell records) hit **committed** storage — so a
transaction's later events could not see its own earlier staged writes. A
transaction that touched one row twice (insert then delete, update then delete,
update then update, delete/reinsert/delete) leaked cell records for tombstoned rows
and, worse, could leave **two change-log entries for one key**, breaking
`collectChangesSince`'s documented invariant (at most one entry per key, HLC equal
to its record's).

## What changed

- **New module `staged-transaction-metadata.ts`** — a per-transaction overlay
  recording what the transaction has staged: live cell versions per column, a
  row-cleared flag (a delete staged removal of every cell), and the staged
  tombstone's HLC. Rows keyed by pk identity (same `encodePkIdentity` as the
  storage keys), `\0`-separated schema/table so dotted identifiers cannot collide.
  One instance per `handleTransactionCommit` call.
- **Capture reads overlay-first** (`recordDataEvent` / `recordColumnVersions`):
  the prior-version and prior-tombstone dedup lookups consult the overlay before
  committed storage, and every staged write is noted back into it. A cell staged
  as deleted reads as absent, so a reinsert-after-delete records no before-image
  (unchanged behaviour, now by design).
- **Delete cleanup stages into the transaction's batch.**
  `deleteRowVersionsAndLogEntries` (sync-context.ts) now takes a caller-supplied
  `WriteBatch` it does not write, plus optional `{ keepColumns, staged }`. Its
  column set is (committed scan) ∪ (overlay's live staged columns), skipping
  committed columns of a cleared row (their removals were already staged), using
  each column's overlay HLC where present so the right `cl:` entry dies. Staged-only
  cells get an explicit `cv:` delete via new
  `ColumnVersionStore.deleteColumnVersionBatch`. Relies on the WriteBatch
  later-op-wins ordering from `sync-write-batch-op-order-guarantee`.
- **Inbound caller unchanged in behaviour** (`change-applicator.ts`
  `commitChangeMetadata`): passes a fresh batch per winning delete and writes it
  itself, keeping `keepColumns`, passing no overlay (its metadata batch is already
  committed when cleanup runs).
- **Incidental hardening:** the whole transaction's metadata — including the delete
  cleanup — now lands in ONE atomic batch (previously the cleanup committed
  separately and *before* the main batch, so a crash between the two lost
  metadata, and a mid-`recordDataEvent` throw left committed cleanup behind).
- Removed the `KNOWN LIMITATION` block in sync-context.ts; updated `docs/sync.md`
  (§ Transaction-Based Change Grouping → new *Local capture reads its own writes*
  paragraph, plus the read-side dedup paragraph); rewrote the stale comment on the
  pinned reinsert test to describe the new mechanism.

## Validation

- `yarn workspace @quereus/sync run test` — 563 passing (549 before; +14 new).
- `yarn typecheck` — clean. `yarn test` (full workspace) — all suites green.
- New tests in `changelog-orphan-cleanup.spec.ts` → `same-transaction row reuse
  (read-your-own-writes)`: each of the ticket's four measured cases runs the same
  events as ONE transaction and as one-transaction-per-event on a twin manager,
  asserting identical HLC-independent state (cell values, before-image chains, raw
  `cl:` record count via `countChangeLog`, tombstone count) plus absolute counts.
  Also: a two-row transaction where only one row is deleted (no overlay bleed), a
  real column-name oracle case (`usersSchemaOracle`, exercising overlay key
  derivation with real names incl. delete cleanup), and a pinned emit-payload test
  (insert+delete transaction still reports one inline change per event, in order).
- New `staged-transaction-metadata.spec.ts` unit-tests the overlay in isolation
  (cleared-row semantics, re-stage after clear, row/table isolation, dotted-name
  non-collision).
- The pre-existing pinned test (reinsert after delete in one transaction, spec
  line ~150) stays green — now by design: the delete's staged removals are
  superseded by the reinsert's later staged puts.

## Notes for the reviewer (honest gaps / behaviour deltas)

- **Emitted payload delta for repeated updates (intentional):** the second update
  of one cell in a transaction now reports the first update's value/HLC as its
  before-image (`priorValue`/`priorHlc`) instead of the pre-transaction committed
  value — matching what separate transactions record and what is now persisted.
  The delete path's payload is unchanged (pinned by test). No test previously
  asserted the old prior, so nothing needed updating.
- `deleteRowVersionsAndLogEntries` no longer early-returns when the committed scan
  finds nothing, and the inbound caller now writes a batch even when it is empty —
  an empty `WriteBatch.write()` is a no-op on every backend.
- The overlay's `rowState` builds a fresh column→HLC map per delete event —
  negligible (bounded by columns the transaction staged for that row).
- Overlay row keys use `\0` separators, deliberately NOT the `schema.table:`
  convention `change-applicator.ts`'s in-memory grouping uses (that one tolerates
  dotted-identifier collisions; the overlay need not). Purely internal maps —
  no cross-module agreement required.
- Not exercised: a local transaction mixing DDL and repeated same-row DML (the
  overlay is orthogonal to `recordSchemaMigration`, which touches no per-row
  metadata), and custom-collation pk spellings colliding *within* one transaction
  (two spellings of one row collapsing to one overlay slot — the identity encoding
  under test elsewhere guarantees the keying agrees with storage, but no direct
  same-transaction test pins it).
