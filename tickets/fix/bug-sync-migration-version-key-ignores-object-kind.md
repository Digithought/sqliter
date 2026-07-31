description: When syncing between devices, the record of "what version is this schema object at" is filed under just the object's name — so a table and an index that happen to share a name share one counter and can cancel each other's schema updates out.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration ~855)
  - packages/quereus-sync/src/metadata/schema-migration.ts (recordMigrationBatch, getCurrentVersion, buildSchemaMigrationKey)
  - packages/quereus-sync/src/sync/change-applicator.ts:171
  - packages/quereus-sync/src/sync/snapshot.ts:268
  - packages/quereus-sync/src/sync/snapshot-stream.ts:586
----

## What happens

Every schema change a device makes is recorded as a "migration" with a version
number, so peers can tell which schema changes they have already seen. Those
records are keyed by `(schema name, object name, version)` — with no component
saying *what kind of object* it is.

For a table migration the object name is the table name. For an index migration
it is the **index** name (`recordSchemaMigration` in sync-manager-impl.ts). So a
table named `orders` and an index named `orders` write into the same migration
stream and read the same "current version" counter.

Consequence: creating the index bumps the table's version, the table's next
migration lands at a version the peer may already believe it has applied, and a
schema change can be silently skipped on the receiving side.

Reachable today — nothing rejects `create index orders on …` when a table
`orders` exists.

## Expected behavior

The version counter and migration key should distinguish object kinds, so a
table and an index of the same name never share a stream.

Two plausible directions, worth weighing before implementing:

- **Widen the key** with an object-kind component. Contained to the sync
  package, but changes the on-disk migration key layout, so peers and existing
  local metadata need to agree on the new form.
- **Forbid the collision in the engine**, making index names share a namespace
  with table and view names inside a schema (this is what SQLite does). Simpler
  to reason about, and it also removes a class of confusing `drop index` /
  `drop table` ambiguity — but it is a user-visible restriction, and it does
  nothing for databases that already contain such a collision.

Note on the key layout, if the "widen the key" direction is chosen: the migration
key was reworked since this ticket was filed. Every variable-length component is
now written as `{length}:{text}` (`joinKeyParts` in
`packages/quereus-sync/src/metadata/keys.ts`), and the stored-format version
(`SYNC_METADATA_FORMAT_VERSION`) was raised to **3** for it. An object-kind
component should be added as one more length-prefixed part and the format version
raised to **4** — not to 3, which is taken.

Related but distinct: index-vs-index collisions on this same key are addressed by
enforcing per-schema index-name uniqueness (`index-names-unique-per-schema`).
This ticket is only about the cross-kind case that enforcement leaves open.
