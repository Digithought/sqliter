description: Only "create table" actually travels between synced devices — dropping a table, adding an index, or changing a column reaches other devices as an empty instruction that silently does nothing, so their schemas quietly drift apart.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts (the schema events; only the create-table event at ~line 700 sets `ddl`)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (`recordSchemaMigration` ~line 729 — stores `ddl: ddl || ''`)
  - packages/quereus-sync/src/sync/store-adapter.ts (`applySchemaChange` / `decideSchemaChange` — the receiving end)
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts (already drives the receiving branches with synthetic real DDL)
  - docs/sync.md (§ Schema Synchronization → Idempotent DDL application)
difficulty: medium
----

## What happens today

Quereus sync replicates schema changes by shipping the DDL text of each change to
every peer and re-running it there. That works for `create table`: the store
module attaches the table's canonical DDL to the schema-change event it emits, so
the migration goes onto the wire with a real statement attached.

Every other schema event the store module emits carries **no** DDL. The sync
manager records those migrations with an empty string, the receiving peer runs
that empty string, and nothing at all happens. The migration is nevertheless
counted as applied and its metadata is committed, so from sync's point of view
the peers are converged — while in fact only one of them has the change.

Affected, as far as we know: `drop table`, `create index`, `drop index`, and the
column-level alterations (`add column`, `drop column`, `alter column`).

## Why it matters

A user who drops a table on their laptop still has it on their phone. An index
created on one device is missing on the others, so the same query is fast in one
place and slow in another. Column changes are worse: the two devices end up
interpreting the same replicated rows under different column layouts, with no
error anywhere to say so.

## Expected behavior

Each replicated schema change should carry a statement that reproduces it on the
receiver, so that a peer which applies every migration it receives ends up with
the same schema as the origin.

## Notes for whoever picks this up

- The **receiving** side is already written and tested for real (non-empty) DDL —
  see `decideSchemaChange` in `store-adapter.ts` and the synthetic-migration
  cases in `schema-replication-idempotency.spec.ts`. It applies replicated DDL
  idempotently and reports a same-name/different-definition collision as an
  error. So the work here is mostly on the emitting side.
- Watch the naming asymmetry: for an index migration the sync record's `table`
  field holds the **index** name, not the owning table's.
- `packages/quereus/src/schema/ddl-generator.ts` already produces canonical,
  session-independent DDL for tables and indexes (`generateTableDDL`,
  `generateIndexDDL`) — the same functions the create-table path uses.
- Column-level changes have no canonical generator today and may need a different
  approach than "ship a statement" (the whole-table DDL is one option, an
  `alter table` rendering is another). Worth deciding deliberately rather than by
  default.
- Once real DDL starts flowing, re-verify the whole path end-to-end with the
  `relayAll` helper in `packages/quereus-sync/test/sync/_peer-harness.ts` — it
  relays the full changeset including schema migrations.
