---
description: Renaming a table now replicates to other devices, and row data keeps flowing across the rename — including rows arriving in the very same sync batch as the rename.
files:
  - packages/quereus-sync/src/sync/protocol.ts                   # rename_table type; fromTable on SchemaMigration + SchemaChangeToApply; toSchemaChange
  - packages/quereus-sync/src/metadata/schema-migration.ts       # stored record layout gained a length-prefixed fromTable slot before the DDL
  - packages/quereus-sync/src/metadata/keys.ts                   # SYNC_METADATA_FORMAT_VERSION 4 → 5
  - packages/quereus-sync/src/sync/wire.ts                       # optional fromTable on SerializedSchemaMigration, both codec directions
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # mapSchemaMigrationType takes the whole event; recordSchemaMigration files fromTable
  - packages/quereus-sync/src/sync/change-applicator.ts          # computeBatchTableFates: rename = two existence steps; appliedDropKeys includes rename-away; receiver record keeps fromTable
  - packages/quereus-sync/src/sync/store-adapter.ts              # decideRenameTable decision table; applySchemaChange scopes both names
  - packages/quereus-sync/src/sync/snapshot.ts                   # receiver record keeps fromTable
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # receiver record keeps fromTable
  - packages/quereus-sync/test/sync/_peer-harness.ts             # in-memory provider gained renameTableStores (was silently losing rows on rename)
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts   # the `rename to` describe — main e2e coverage
  - packages/quereus-sync/test/sync/snapshot-ddl-causal-order.spec.ts  # create-then-rename bootstrap
  - packages/quereus-sync/test/metadata/schema-migration.spec.ts # NEW: stored-layout round-trips
  - packages/quereus-sync/test/wire.spec.ts                      # wire round-trips for fromTable
  - packages/quereus-sync/test/sync/metadata-format-version.spec.ts    # v4 refused under v5
  - packages/quereus-sync/test/sync/schema-migration-object-kind.spec.ts  # rename_table → 'table'
  - docs/sync-schema.md                                          # § Idempotent DDL + § What replicates rewritten for renames
---

# Implemented: replicate `ALTER TABLE … RENAME TO`

Before this ticket a rename silently halted a table's replication: other devices kept
the old name and every later row change filed under a name they had never heard of.
Now the rename reaches every peer as its own migration type, and data written under the
new name lands — even in the same batch that carries the rename.

## What was built (per the implement ticket's design, no deviations)

- **`rename_table` migration type.** Keyed under the NEW name; carries the old name in
  a new optional `fromTable` field — on the wire (`SerializedSchemaMigration`,
  present-only JSON key), in storage (a 2-byte big-endian **byte**-length-prefixed slot
  inserted between the migration type and the DDL), and on `SchemaChangeToApply`.
  Origin side: `mapSchemaMigrationType` now takes the whole schema-change event and
  maps `table`+`alter`+`oldObjectName` ⇒ `rename_table` (the store module's
  `renameTable` is the only emitter that sets `oldObjectName`).
- **Storage format bump 4 → 5.** The DDL was "rest of buffer", so the slot could not
  be appended; v4 metadata is refused at open (existing loud re-bootstrap posture).
- **Data routing.** `computeBatchTableFates` treats a rename as two existence steps at
  its own HLC: new name present, `fromTable` absent. Max-HLC-wins resolves chained
  rename, rename-then-drop, and rename-then-rename-back in one batch with no special
  cases. `appliedDropKeys` also counts an applied rename-away, so a name re-created
  after being renamed away resolves read-free (its stranded old metadata belongs to
  the renamed-away incarnation).
- **Idempotent apply.** `decideRenameTable` (store-adapter): old present/new absent →
  execute; old absent/new present → already-applied; both → throw a conflict naming
  both tables (same posture as divergent `create_table`; the abort commits no
  metadata); neither → converge with a warning; `fromTable` missing → undecidable,
  converge with a warning. The remote-event scope opens for BOTH names during exec.
- **Receiver re-relay integrity.** All three receiver-side record sites (wire apply,
  whole snapshot, streaming snapshot) carry `fromTable` into local storage — without
  this a relayed rename went out undecidable to third peers (caught during
  implementation; pinned by the three-peer test).

## Validation

`yarn build`, `yarn test` (full workspace: all suites green, quereus-sync 717
passing), `yarn lint`, `yarn typecheck` — all clean.

Key scenarios pinned in `schema-alter-replication.spec.ts` § `rename to`:

- DDL-only rename replicates; receiver DDL identical (`generateTableDDL`).
- **Headline:** pre-rename row synced, then rename + post-rename insert delivered as
  one incremental batch — receiver reads both rows out of the new table,
  `unknownTable` 0, old name gone.
- Rename inside one transaction with writes: every wire fact files under the new name
  (the engine's `renameBatchedEvents` relabel), and the row lands.
- Every `decideRenameTable` row, incl. the yes/yes throw (names both tables, nothing
  half-applied) and the `fromTable`-absent undecidable converge.
- Chained rename / rename-then-drop / rename-then-rename-back in one batch.
- Same batch twice (version guard) and independent identical renames both directions
  (already-applied arm).
- Three-peer relay keeps `fromTable` decidable downstream.
- Snapshot bootstrap: create-then-rename replays in causal order, both snapshot forms
  (`snapshot-ddl-causal-order.spec.ts`).
- Stored-layout round-trips incl. a multi-byte-character `fromTable` (byte-counted
  length prefix) and a ddl that begins with the same bytes as `fromTable`
  (`test/metadata/schema-migration.spec.ts`); wire JSON round-trips with
  absent-stays-absent; v4 metadata refused; `migrationObjectKind('rename_table')`.

## Known gaps and caveats (deliberate, for the reviewer)

- **Stranded CRDT metadata** (`bug-sync-rename-and-pk-change-strand-crdt-metadata`,
  backlog): per-row bookkeeping stays keyed under the old name on every peer. Two
  consequences observed here and APPENDED to that backlog ticket: a from-zero delta
  re-pull diverts pre-rename facts (still filed under the old name) to the
  unknown-table disposition, and a snapshot taken after the rename ships pre-rename
  rows under the retired name, so a fresh bootstrap only gets post-rename rows. NOT
  fixed here — `NOTE:` at `decideRenameTable` and a caveat in `docs/sync-schema.md`.
  The headline test relays the pre-rename row *before* the rename batch for exactly
  this reason, and the snapshot test inserts only post-rename data.
- **Held/quarantined changes under the old name stay held until the periodic sweep.**
  The reactive drain fires on applied `create_table` only, not on rename — accepted by
  the implement ticket as-is.
- **Test harness change:** the sync peer harness's in-memory provider previously
  omitted the optional `renameTableStores` hook, so a rename silently emptied the
  table (pre-existing `bug-store-rename-silently-loses-rows-without-provider-hook`,
  backlog). Added the hook to the harness (that ticket explicitly asked for this
  half); the root cause — the store module's silent skip when the hook is absent —
  remains open there, and I noted the harness half done on that ticket.
- **Wire protocol version not bumped.** `fromTable` is additive-optional JSON, so
  same-version peers are unaffected and PROTOCOL_VERSION stays 1. A mixed-version
  wrinkle exists: an old-build receiver seeing `rename_table` hits its default
  `execute` arm — fine when the old name exists, but a peer that already renamed
  locally re-fails the exec (no idempotency arm on old builds). Conditional on
  running mixed builds; not ticketed (tripwire only — the strict-equality
  PROTOCOL_VERSION note in `wire.ts` already governs deliberate wire breaks).
- **`decideRenameTable` checks presence, not shape**: it never compares the renamed
  table's definition against the origin's. A shape divergence would have already been
  surfaced by the `create_table`/alteration paths, so the rename adds no new check.

## Review findings

(to be filled by the review stage)
