---
description: Changing a table's primary key part-way through a transaction leaves the change notifications for earlier writes identifying their rows by the old primary key, so a listener — or a synced device — files those rows under the wrong identity.
prereq:
files:
  - packages/quereus/src/core/database-events.ts                  # add rekeyBatchedDataEvents beside renameBatchedEvents (~line 877)
  - packages/quereus/src/runtime/emit/alter-table.ts              # runAlterPrimaryKey (~line 1421) — both arms need the call
  - packages/quereus/src/util/comparison.ts                       # sqlValueIdentical (line 348), for the update-image tie-break
  - packages/quereus/test/alter-table-events.spec.ts              # engine auto-event path cases
  - packages/quereus-store/test/alter-events.spec.ts              # store path cases (the only path where the rows also survive)
  - docs/usage.md                                                 # § Subscribing to Data Changes, the as-of-delivery paragraphs (~line 350)
  - docs/module-authoring.md                                      # § Row-Shape and Table-Name Contract Across Mid-Transaction ALTER (~line 1175)
difficulty: medium
---

# The defect

A change-notification event (`DatabaseDataChangeEvent`) carries a `key` field: the
primary-key values that identify the row the event describes. Quereus promises that
everything a commit delivers describes the table **as it is at delivery** — row images are
rewritten to the post-ALTER column layout, and the table name is rewritten across a
mid-transaction rename.

`key` is not. `ALTER TABLE … ALTER PRIMARY KEY` changes which columns identify a row, but
events the transaction already recorded keep the key values of the *retired* primary key.

## Reproduced

Store-backed table (`packages/quereus-store`, in-memory KV provider — the path where the
rows also survive the ALTER, so the mismatch is fully live):

```sql
create table t (a integer not null, b integer not null, v text, primary key (a)) using store;
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
commit;
```

Committed table contains `(1, 9, 'x')` under primary key `(a, b)`. Delivered event:

```json
{ "type": "insert", "tableName": "t", "key": [1], "newRow": [1, 9, "x"], "remote": false }
```

`key` is `[1]` — one value for a two-column key. Correct is `[1, 9]`.

Narrowing is broken symmetrically: a table keyed `(a, b)` re-keyed to `(a)` delivers
`key: [1, 9]` where `[1]` is correct.

Also reproduced, same shape, on `update` (delivered `key: [1]`, both row images `[1,9,…]`),
on `delete` (delivered `key: [1]`, `oldRow: [1,9,'x']`), and for events sitting in an open
savepoint layer at ALTER time — so the fixup must walk the base batch **and** every open
layer, exactly as the rename relabel does.

## Why it matters

`key` is how a consumer addresses the row. An incremental cache keys its entries by it; the
sync engine records it as the row identity in its change log (`recordDataEvent` in
`packages/quereus-sync/src/sync/sync-manager-impl.ts`). A key of the wrong arity is not
merely stale, it is unmatchable — the consumer cannot pair it with any row the table now
contains, so the write is dropped or lands under a phantom identity, and every later write
to the same row arrives under the new key looking like a different row. The commit reports
success.

# The fix

Add a third batched-event fixup to `DatabaseEventEmitter`, alongside the existing
`remapBatchedDataEvents` (row shape) and `renameBatchedEvents` (table name):

```ts
/**
 * Re-derive the `key` of every BATCHED data event for one table from the event's own
 * row image, after a mid-transaction ALTER TABLE … ALTER PRIMARY KEY.
 * `oldPkIndices` / `newPkIndices` are column indices into the row images as they stand
 * NOW (an ALTER PRIMARY KEY changes no column, and any earlier ALTER in the same
 * transaction already remapped the images).
 */
rekeyBatchedDataEvents(
    schemaName: string,
    tableName: string,
    oldPkIndices: readonly number[],
    newPkIndices: readonly number[],
): void
```

Shape it on `renameBatchedEvents`: early-return when not batching (in autocommit the
earlier events were already delivered under the key the table had at the time, which is
correct), reuse the existing `namesTable()` matcher and `allDataEventStores()` enumeration,
synchronous, no per-event `try` — it reads no schema and evaluates no expression, it only
projects values already present in the row image.

**Which image to project from.** Pick the image the event's producer used to compute the
existing `key`, so this change is neutral with respect to the open question of which key an
`update` event carries (see *Sibling ticket* below):

- `insert` → `newRow`
- `delete` → `oldRow`
- `update` → project both images through `oldPkIndices` and compare to the recorded `key`
  with `sqlValueIdentical`; use whichever image matches. If both match (the ordinary case —
  the update did not touch a PK column) or neither does, fall back to `newRow ?? oldRow`.

Leave `key` untouched (and log at warn) when the event has no `key`, has no usable image,
or when any `newPkIndices` entry is out of bounds for that image — the same best-effort
stance `remapBatchedDataEvents` takes toward historical row images.

**Where to call it.** `runAlterPrimaryKey` (`alter-table.ts:1421`) has two arms and *both*
need it:

- the native module re-key arm — **after** `module.alterTable(...)` returns and before
  `schema.addTable(updatedTableSchema)`. The "after" matters: the store module's
  `alterPrimaryKeyChange` calls `ddlCommitPendingOps()`, which flushes its queued write
  events into the engine batch *during* that call, so they must already be in the batch when
  the walk runs. Same ordering rationale as `runRenameTable`'s relabel, which carries the
  comment worth mirroring.
- the rebuild fallback — after `rebuildTableWithNewShape(...)` returns.

Old indices come from `tableSchema.primaryKeyDefinition`, new from the `newPkDef` the arm
already builds. Both are indices into the current column layout, because ALTER PRIMARY KEY
changes no column; `rebuildMemoryTable` remaps PK indices onto its surviving-column list,
but for this arm the surviving list is every column in order, so the indices are unchanged.

## Not in scope, checked

- **No other ALTER arm moves a key value.** `ALTER COLUMN … SET DATA TYPE` on a primary-key
  column is rejected outright (`Cannot SET DATA TYPE on PRIMARY KEY column 'a'`);
  `ADD`/`DROP`/`RENAME COLUMN` shift column *indices* but not the key *values*, and the
  recorded `key` is a value list, so it stays correct (verified on the store path). `SET
  COLLATE` on a PK column already has a case in `alter-table-events.spec.ts` pinning that no
  remap is needed. So `ALTER PRIMARY KEY` is the only arm that needs this.
- **The maintenance-collision channel needs no equivalent.** Every structural ALTER on a
  maintained table is rejected up front (`alter-table.ts:89`), so a materialized view's
  primary key can never change mid-transaction.
- **Cross-connection batches are out of reach**, as they are for the rename relabel: the
  event emitter is per-`Database`. Under `quereus-isolation` the case is moot anyway — a
  connection with staged rows is refused the ALTER outright
  (`isolation-module.ts:1336`).

# Test plan

`packages/quereus-store/test/alter-events.spec.ts` is the **primary** home: it is the only
path where the row survives the ALTER, so `key` and the committed row can be asserted
together. Cases: widening `(a) → (a, b)`, narrowing `(a, b) → (a)`, an `update` crossing the
re-key, a `delete` crossing it, and an event recorded inside an open savepoint layer.

`packages/quereus/test/alter-table-events.spec.ts` gets the engine auto-event path cases
(same engine code, different producer). **Assert the delivered `key` only, not row
survival** — on the memory rebuild path the transaction's own rows are silently discarded,
which is the sibling ticket below. Leave a `NOTE:` in the spec naming that slug, mirroring
how the rename spec parks its deferred row assertion.

Mutation-check the walk: disabling `rekeyBatchedDataEvents` must fail the new cases and
nothing else.

# Docs

- `docs/usage.md` § *Subscribing to Data Changes* — the `key` row of the field table and the
  as-of-delivery paragraphs (~line 350) currently say only row images and `tableName` are
  as-of-delivery, and explicitly say a rename leaves `key` alone. Extend: `key` is
  as-of-delivery too, carrying the primary key the table has at delivery; a rename still
  leaves it alone (it moves no value), an `ALTER PRIMARY KEY` rewrites it.
- `docs/module-authoring.md` § *Row-Shape and Table-Name Contract Across Mid-Transaction
  ALTER* (~line 1175) — same addition, plus the same split of responsibility the section
  already states for row shape and table name: events in the engine's batch are fixed by the
  engine; a module holding its own queue across the ALTER must re-derive `key` itself.

# Sibling tickets filed alongside this one

- `fix/bug-alter-primary-key-mid-transaction-loses-memory-rows` — on the memory module (a
  plain `new Database()`), an `ALTER PRIMARY KEY` inside a transaction silently discards
  every row that transaction wrote. Independent of this ticket and far more severe; do not
  try to fix it here.
- `fix/bug-update-event-key-disagrees-across-producers` — the three producers disagree about
  which primary key an `update` event's `key` carries when the update itself changes the PK.
  The image-matching rule above is deliberately neutral to that question.

# TODO

- Add `rekeyBatchedDataEvents` to `DatabaseEventEmitter`, reusing `namesTable()` and
  `allDataEventStores()`; document the image-selection rule in its doc comment.
- Call it from both arms of `runAlterPrimaryKey`, with the ordering comment.
- Confirm `tableSchema` inside `runAlterPrimaryKey` is the live schema at run time, not a
  stale build-time snapshot — a second ALTER earlier in the same transaction must not leave
  the PK indices pointing at the wrong columns. If it is stale, resolve the live table from
  the catalog the way `runSetMaintained` does, and say so in the handoff.
- Store-path cases in `packages/quereus-store/test/alter-events.spec.ts` (widen, narrow,
  update, delete, savepoint layer) asserting both the delivered `key` and the committed row.
- Engine auto-event-path cases in `packages/quereus/test/alter-table-events.spec.ts`, key
  assertions only, with the `NOTE:` pointing at the memory row-loss slug.
- Mutation-check: disable the walk, confirm exactly the new cases fail.
- Update `docs/usage.md` and `docs/module-authoring.md` as described.
- `yarn build`, `yarn lint`, `yarn test` from the repo root.
