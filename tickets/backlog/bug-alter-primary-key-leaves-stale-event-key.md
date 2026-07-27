---
description: Changing a table's primary key part-way through a transaction leaves the change notifications for earlier writes identifying their rows by the old primary key, so a listener — or a synced device — files those rows under the wrong identity.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAlterPrimaryKey (~line 1375) — no batched-event fixup at all
  - packages/quereus/src/core/database-events.ts            # remapBatchedDataEvents rewrites rows, never `key`
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAddColumn / runDropColumn / runAlterColumn remap sites (~377, 549, 936, 1188)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # recordDataEvent — consumes `key` as row identity
  - docs/usage.md                                           # § the as-of-delivery event contract
  - docs/module-authoring.md                                # § Row-Shape and Table-Name Contract Across Mid-Transaction ALTER
difficulty: medium
---

# What happens

A change-notification event carries a `key` field — the primary-key values that
identify the row it describes. Quereus promises that everything a commit delivers
describes the table **as it is at delivery**: the row images are rewritten to the
post-ALTER column layout, and (as of `rename-table-mid-transaction-leaves-stale-event-table-name`)
the table name is rewritten across a mid-transaction rename.

`key` is not. `ALTER TABLE … ALTER PRIMARY KEY` part-way through a transaction
changes which columns identify a row, but the events the transaction already
recorded keep the key values of the *old* primary key.

## Reproduced

On a plain `new Database()` (engine auto-event path), with an `onDataChange`
listener subscribed:

```sql
create table t (a integer not null, b integer not null, v text, primary key (a));
begin;
insert into t values (1, 9, 'x');
alter table t alter primary key (a, b);
commit;
```

The single delivered event is:

```json
{ "type": "insert", "tableName": "t", "key": [1], "newRow": [1, 9, "x"] }
```

`key` is `[1]` — the retired single-column key. The committed table's primary key
is `(a, b)`, so the correct identity for that row is `[1, 9]`.

## Why it matters

`key` is what a consumer uses to address the row: an incremental cache keys its
entries by it, and the sync engine records it as the row identity in its change
log (`recordDataEvent`). A key of the wrong arity is not merely stale, it is
unmatchable — the consumer cannot pair it with any row the table now contains, so
the write is dropped or lands under a phantom identity. Every subsequent write to
the same row arrives under the new key and looks like a different row.

The window is narrow (one transaction that both writes and re-keys), but it is
reachable from ordinary SQL with no module involvement, and it fails silently:
the commit reports success.

## Expected

An event a commit delivers carries the key values of the primary key the table
has **at delivery** — the same as-of-delivery rule already applied to `oldRow` /
`newRow` / `changedColumns` / `tableName`. For the case above that is `[1, 9]`,
re-derived positionally from the event's own row image against the new primary-key
column indices.

Both PK-changing arms need this: the native module re-key and the table-rebuild
fallback in `runAlterPrimaryKey`. Worth checking at the same time whether the
memory module's own pending-change log (which stamps `tableName` at commit and so
needs no rename fixup) stamps `key` at write time or at commit — the two producer
paths may need different fixes, exactly as they did for row shape.

## Scope note

Found during the review of `rename-table-mid-transaction-leaves-stale-event-table-name`
while auditing the sibling fixups. It is **not** a regression from that ticket —
`key` has never been rewritten by any ALTER arm. A rename correctly leaves `key`
alone (it moves no value), so that ticket's `renameBatchedEvents` is not the place
to fix this.
