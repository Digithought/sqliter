---
description: The storage backends each described a primary-key-changing update differently, so an app listening for changes could not tell which row moved. They now all follow one written-down rule, every backend was changed to match, and the review pass added the missing cross-backend and ordering tests.
files:
  - docs/usage.md                                                  # the contract, § Subscribing to Data Changes
  - docs/module-authoring.md                                       # producer obligation
  - docs/module-events.md                                          # key field comment + re-key rule
  - docs/store.md                                                  # store hook doc points at the contract
  - docs/memory-table.md                                           # REVIEW — how the memory log's key is now derived
  - docs/sync.md                                                   # REVIEW — a PK move tombstones the old identity
  - packages/quereus/src/runtime/emit/dml-executor.ts              # engine auto path + relocation tripwire
  - packages/quereus/src/vtab/memory/layer/manager.ts              # memory native: eventKeyFromImage
  - packages/quereus/src/vtab/memory/layer/transaction.ts          # PendingChange.pk removed
  - packages/quereus/src/core/database-events.ts                   # selectKeySourceImage follows the contract
  - packages/quereus/src/core/database-transaction.ts              # REVIEW — tripwire on the change log's coarser split
  - packages/quereus-store/src/common/store-table.ts               # store update arm splits on pkChanged
  - packages/quereus-store/src/common/store-table-base.ts          # REVIEW — emitOrQueueDataChange helper
  - packages/quereus-store/src/common/store-table-constraints.ts   # REVIEW — routed through the helper
  - packages/quereus/test/data-event-key-contract.spec.ts          # engine auto + memory native (20 tests)
  - packages/quereus-store/test/data-event-key-contract.spec.ts    # store, with and without an emitter (11 tests)
  - packages/quereus-sync/test/sync/pk-changing-update.spec.ts     # sync end-to-end (4 tests)
---

# What shipped

One rule, written into `docs/usage.md` § Subscribing to Data Changes and repeated as a producer
obligation in `docs/module-authoring.md`:

1. **`key` is the primary key projected out of the event's own row image** — `newRow` for an
   `insert` and an `update`, `oldRow` for a `delete`. An update keys by its *post*-image.
2. **An `update` never moves a row.** A key change that *relocates* the row — its key values
   differ under the primary key's own comparator, which is per-column collation- and type-aware,
   not byte identity — is delivered as a `delete` at the old key then an `insert` at the new key,
   in that order. A rewrite that leaves the row in place (a `NOCASE` `'apple'` → `'APPLE'`) stays
   one `update`, keyed by the post-image.

Documented costs: a relocating update carries no `changedColumns` and no "same row" link, and
**ordering is guaranteed but adjacency is not**.

All three producers the ticket named now follow it — the engine's auto-event path
(`emitAutoUpdateEvents`, wired into the plain UPDATE arm, the INSERT/REPLACE arm, and the UPSERT
`DO UPDATE` arm), the store module (its update arm splits on the existing `pkChanged`), and the
memory module (the delivered `key` is projected from the change's own image at commit rather than
replayed from a key each write recorded). Sync needed no production change; it now sees
`delete` + `insert` and writes a tombstone for the retired identity.

Two pieces of machinery that existed only because the producers disagreed were deleted rather
than left as traps: `PendingChange.pk` with the whole ALTER-PRIMARY-KEY re-key of the memory
event log, and `DatabaseEventEmitter.selectKeySourceImage`'s two-image tie-break.

# Review findings

## Checked, nothing wrong

- **Every in-tree data-event producer, not just the three the ticket named.** Enumerated all
  `emitDataChange` / `queueEvent` call sites across the repo. Two more exist:
  `StoreBackingHost.toDataChangeEvent` (materialized-view maintenance writes) and
  `emitEffectiveChanges` in the sync store adapter (applying remote changes). Both already
  satisfy both clauses *by construction* — each keys from `newRow ?? oldRow`, and each produces
  an `update` delta only after reading the existing row **at the new row's own encoded key**, so
  neither can express a relocation. No producer was missed. The IndexedDB cross-tab broadcaster
  is a pure relay, and `quereus-isolation` has no data-event surface at all.
- **Event batching cannot undo the split.** `DatabaseEventEmitter` flushes its batch in
  insertion order with no coalescing pass, so a `delete [2]` queued after an `insert [2]` in the
  same transaction survives intact. Previously unpinned — now pinned by a new test on all three
  producers (below).
- **The `eventKeyFromImage` bounds guard is the right guard.** The handoff called its "no usable
  image ⇒ no key + warn" branch untested and left it there. I checked the sharper question —
  whether a pending-change image left at the *retired* arity could pass the bounds check and
  silently project the **wrong column**. It cannot: only ADD COLUMN's reshape can throw, and ADD
  COLUMN appends without shifting existing key indices, so a stale short image still projects
  correct values; DROP COLUMN's reshape is a pure filter that cannot throw. The one shape that
  reaches the fallback (ADD COLUMN whose backfill failed, followed by an ALTER PRIMARY KEY onto
  that new column in the same transaction) degrades exactly as documented. Branch stays untested;
  the reasoning above is why that is acceptable rather than merely unexamined.
- **The re-pinned ALTER PRIMARY KEY specs strengthen their assertions.** Both previously learned
  the producer's arbitrary choice from a baseline run and asserted only self-consistency; both
  now assert concrete keys on both halves of the split. Not a weakening.

## Found and fixed in this pass

- **Cross-substrate agreement was untested and unmentioned.** A store table registered *without*
  an event emitter has no native event path, so the **engine's** auto path produces its events —
  while the store still decides which writes physically move a row, from its encoded data key.
  Two independent constructions answering the same question, with no test and no note. Added two
  tests (`data-change event key contract — store module with no emitter`) pinning agreement in
  both directions, and extended the `primaryKeyRelocated` tripwire to name the store substrate
  alongside the memory one.
- **Test gaps closed** on all three producers: the delete arm of clause 1 on its own; a multi-row
  relocating update (`update t set a = a + 10`), which pins that each row splits separately in row
  order; and a relocating update *twice over the same row inside one explicit transaction*, which
  is the sharpest available check of the ordering-without-adjacency promise. That last one closes
  a gap the handoff named as open. Spec counts: engine/memory 14 → 20, store 6 → 11.
- **DRY.** The implement pass introduced a local `emitOrQueue` closure in the store's update arm
  while four other store emit sites kept the same copy-pasted "queue if in a transaction, else
  emit" branch. Hoisted it to `StoreTableBase.emitOrQueueDataChange`; all five sites now route
  through it, so the two arms cannot drift.
- **Docs.** `docs/sync.md` — the handoff judged it out of scope; I disagree and updated it. A
  PK-changing update now burns a tombstone where none appeared before, which is exactly what a
  sync integrator reading the tombstone/TTL section needs to know. `docs/memory-table.md` — not
  flagged by the handoff, but it documents the pending-change log the change restructured and
  still implied the log carries a key. Now states the positive rule: a `PendingChange` records
  only images, and the delivered key is projected from them at commit through the delivery-time
  schema — which is also why `prepareRekeyedPrimaryKeyColumns` needs no event-log arm.

## Filed as new tickets

None. Nothing major surfaced — no correctness defect was found in the production change itself.
Everything above was either already correct, or small enough to fix in this pass.

## Tripwires parked

- `primaryKeyRelocated` in `packages/quereus/src/runtime/emit/dml-executor.ts` — the existing
  NOTE (engine comparators vs. the memory substrate's) extended to cover the store substrate,
  which reaches the same path whenever a store table carries no emitter.
- `TransactionManager.recordUpdate` in `packages/quereus/src/core/database-transaction.ts` — new
  NOTE. The transaction **change log** also splits a key-changing update into delete + insert,
  but decides "changed" by `encodeKeyTuple` identity, which is collation-blind. So a `NOCASE`
  case-only rewrite splits there while the `onDataChange` channel keeps it one in-place update.
  Harmless for that log's purpose (it drives re-evaluation; naming both key spellings is
  over-broad, never wrong), and entirely pre-existing — parked at the site rather than filed.

## Known gaps carried forward

Unchanged from the handoff and still accepted: statement-level `update or replace` is unreachable
in this dialect (the REPLACE ordering case is reached through a declared
`primary key (a) on conflict replace`); the `selectKeySourceImage` warning path is unreachable
from any in-tree module; and `quereus-isolation` was reasoned about rather than exercised — it
has no emitter of its own, confirmed by search this pass.

# Validation

- `yarn test` — all workspaces green: quereus 8186 passing / 13 pending, store 1237, sync 643,
  plugin-loader 96, everything else unchanged. Zero failures.
- `yarn test:store` — 8178 passing / 21 pending, zero failures.
- `yarn lint` — clean. `yarn typecheck` — clean. `npx tsc -b tsconfig.build.json` — clean.
- No pre-existing failures surfaced.
