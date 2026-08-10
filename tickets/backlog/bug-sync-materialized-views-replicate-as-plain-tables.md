description: A materialized view — a table whose contents the engine keeps up to date from a query — appears on other synced devices as an ordinary empty table that never updates, because the instruction sent over the wire leaves out the query that defines it.
files:
  - packages/quereus-store/src/common/store-module.ts:695 (the create-table schema event)
  - packages/quereus/src/schema/ddl-generator.ts (generateTableDDL vs generateMaintainedTableDDL)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration)
  - docs/sync-schema.md (§ What replicates)
difficulty: medium
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Only affects databases that both use materialized views and sync, and replicating a derivation means peers re-run maintenance over source tables they may not have - refusing to replicate maintained tables at all is a defensible alternative.
----

## What is wrong

Quereus supports a *maintained table* — a real table whose rows the engine
derives from a query and keeps current as the sources change. It is what backs
`create materialized view`, and it is stored as an ordinary store-backed table
plus a recorded derivation.

Sync replicates a schema change by shipping the SQL text that produced it and
re-running that text on the receiving device. For a table create, the store
module renders that text with `generateTableDDL`, which emits only the column
shape — a plain `create table`. The `maintained as <query>` part of the
definition is rendered by a *different* generator (`generateMaintainedTableDDL`,
which the catalog persistence path does use), and the schema event never calls
it.

So a device that creates a materialized view ships its peers a plain table of
the same name and columns. The peers end up with a table that has no derivation:
it starts empty, never refreshes, and diverges from the origin permanently.
Neither side reports anything.

The mismatch predates the drop/index DDL work — `create table` has always been
the one migration carrying real text — so this is a long-standing gap rather
than a regression.

## First thing to check

Confirm the failure actually reaches a peer before designing a fix: create a
store-backed materialized view on one peer, relay to another, and see whether a
`create_table` migration is recorded for it at all. Nothing in the sync
manager's schema-event recording filters maintained tables out today, but the
basis machinery (which decides what data is in scope for sync) may make the
question moot in practice — derived rows arguably should not replicate as row
changes even if the *definition* should.

That question — should a materialized view replicate as a definition the peer
re-derives locally, or not replicate at all — is the real decision here, and it
should be answered before any code changes. Both are defensible; silently
shipping a hollow plain table is not.

## Expected behavior

Whichever answer is chosen, a peer must not end up holding a table that looks
ordinary but is permanently stale:

- If maintained tables replicate: the wire text must be the maintained form, so
  the receiver reconstructs the derivation and maintains the table itself.
- If they do not: the create event for a maintained table should not be recorded
  as a replicable migration at all, and `docs/sync-schema.md` § What replicates should
  say so.
