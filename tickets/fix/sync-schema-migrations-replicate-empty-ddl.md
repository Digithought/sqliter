description: Only "create table" actually replicates between synced devices — dropping a table, adding or dropping an index, and altering a table all replicate as empty instructions that silently do nothing on the receiving device, so devices quietly end up with different schemas.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts (schema events at ~lines 695, 827, 1063, 1140, 1739, 1837, 1926, 1975 — only the create-table one sets `ddl`)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration ~line 729 — `ddl: ddl || ''`)
  - packages/quereus-sync/src/sync/store-adapter.ts (applySchemaChange ~line 344 — `db.exec('')` is a silent no-op)
  - packages/quereus/src/schema/ddl-generator.ts (generateTableDDL / generateIndexDDL — canonical DDL available for the create paths)
  - packages/quereus/src/core/database-events.ts (DatabaseSchemaChangeEvent — `ddl?: string`)
  - docs/sync.md (§ schema migrations)
difficulty: medium
----

## What happens

The sync engine replicates schema changes by shipping the DDL text that the
originating device recorded for each change, and replaying it on the receiving
device. The text comes from the `ddl` field of the schema-change event the
storage module emits.

Only one of those events sets `ddl`: the create-table one
(`generateTableDDL(reconciledSchema)`, `store-module.ts` ~line 700). Every other
schema event — drop table, create index, drop index, and all four table-alter
paths — emits no `ddl` at all. `recordSchemaMigration` stores `ddl: ddl || ''`,
so an empty string goes on the wire, and the receiver runs `db.exec('')`, which
was confirmed to be a silent no-op (no error, no effect).

Net result: a device can drop a table, and its peers keep that table forever,
with no error anywhere.

## Reproduced

Two real-engine peers (`makePeer` from
`packages/quereus-sync/test/sync/_peer-harness.ts`), relaying the full changeset
including schema migrations:

```
peer A and peer B both have `orders`
peer A: create index idx_note on orders (note)
peer A: drop table orders
relay A -> B

wire payload:
  { type: 'create_table', table: 'orders',   ddl: 'CREATE TABLE "main"."orders" (...) USING store' }
  { type: 'add_index',    table: 'idx_note', ddl: '' }
  { type: 'drop_table',   table: 'orders',   ddl: '' }

result: applied 2, skipped 1, no errors
peer B still has `orders`:  true
```

The relay reports success. Nothing was replicated.

## Why it matters

This is the silent counterpart to the "table already exists" bug
(`bug-sync-create-table-replication-not-idempotent`, which is the loud one). A
device that migrates its schema — drops a retired table, adds an index, adds a
column — believes the change has propagated. It has not. The peers diverge with
no signal, and the divergence is discovered later as confusing data or
constraint behavior rather than as a sync error.

Note that the unknown-table machinery in `change-applicator.ts` reasons about the
batch's `drop_table` migrations to decide what is in basis, so the *metadata*
side of a drop is partially honored while the actual table is left in place —
worth checking during the fix whether that produces any additional inconsistency.

## Expected behavior

Every schema change that sync claims to replicate should carry enough
information for the receiver to actually apply it, or should be explicitly and
loudly declared unsupported — not quietly dropped.

Open questions for the fix stage to settle:

- Should the DDL text be attached at the storage-module event sites (the way
  create-table already does), or reconstructed in the sync layer from the change
  type plus the object name? Drops are trivially reconstructable (`drop table X`
  / `drop index X`); index creates need the index definition; alters need the
  specific alteration, which the current event does not describe at all (it
  reports only "table X was altered").
- The alter case may not be expressible as replayable DDL from the current event
  shape at all. If so, decide whether the event needs to carry the alteration, or
  whether alter replication is declared unsupported and made to fail loudly
  instead of silently.
- Whatever lands must be idempotent on the receiver — the sibling ticket
  `bug-sync-create-table-replication-not-idempotent` is adding that machinery for
  create/drop of tables and indexes; this ticket should reuse it rather than
  re-derive it.
- The engine also has a `memory` virtual-table module; check whether its schema
  events have the same gap before deciding where the fix belongs.

## Out of scope

Making the alter/migration story fully convergent across concurrently-diverging
peers. This ticket is about the changes reaching the peer at all.
