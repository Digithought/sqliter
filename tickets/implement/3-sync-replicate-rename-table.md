---
description: Renaming a table currently stops that table syncing altogether — the other devices keep the old name and silently stop receiving its rows. Make the rename reach them, and keep the data flowing across it.
prereq: sync-replicate-alter-table-ddl
files:
  - packages/quereus-sync/src/sync/protocol.ts                   # SchemaMigrationType, SchemaMigration, migrationObjectKind, toSchemaChange, SchemaChangeToApply
  - packages/quereus-sync/src/metadata/schema-migration.ts       # StoredMigration + serialize/deserializeMigration, listAllMigrations
  - packages/quereus-sync/src/metadata/keys.ts                   # SYNC_METADATA_FORMAT_VERSION (line 70)
  - packages/quereus-sync/src/sync/wire.ts                       # SerializedSchemaMigration (line 140) + (de)serializeSchemaMigration
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # mapSchemaMigrationType (~116), recordSchemaMigration (~857)
  - packages/quereus-sync/src/sync/change-applicator.ts          # computeBatchTableFates (~110)
  - packages/quereus-sync/src/sync/store-adapter.ts              # decideSchemaChange, applySchemaChange
  - packages/quereus-sync/test/sync/_peer-harness.ts             # relayAll
  - packages/quereus-sync/test/sync/metadata-format-version.spec.ts
  - packages/quereus-sync/test/sync/schema-migration-object-kind.spec.ts
  - docs/sync-schema.md                                          # § What replicates
difficulty: hard
---

# Replicate `ALTER TABLE … RENAME TO`

## Why this one is different

A rename is the worst of the alterations, because it silently halts **data**
replication as well as diverging the shape. Measured on two real store-backed peers via
`relayAll`: after `a` renames `orders` → `orders2` and inserts one row, `b` reports
`{ applied: 1, skipped: 1, conflicts: 2, unknownTable: 2 }` and its `orders` keeps only
its pre-rename row. Every later row change on `a` is filed under a table name `b` has
never heard of.

Two separate things are missing, and fixing only the first still loses the rows:

1. **The receiver cannot tell what was renamed.** The migration names one table. After
   ticket 1 the *event* carries `oldObjectName`, but the migration record has nowhere to
   put it.
2. **Rows arriving under the new name are diverted before the rename runs.** The
   applicator decides whether a row's table is known in Phase 1b, from the local basis
   plus `computeBatchTableFates` — and that function only looks at `create_table` /
   `drop_table`. The rename DDL does not execute until Phase 2. So in the very batch
   that carries the rename, every row for the new name takes the unknown-table
   disposition (quarantined, or dropped) instead of landing.

## Design

### A. A migration type that names both tables

Add `rename_table` to `SchemaMigrationType`, and one optional field to the migration
record — on the wire, in storage, and in `SchemaChangeToApply`:

```ts
export interface SchemaMigration {
  readonly type: SchemaMigrationType;
  readonly schema: string;
  readonly table: string;        // the table's name AFTER this migration
  /** rename_table only: the name it had before. */
  readonly fromTable?: string;
  readonly ddl: string;
  readonly hlc: HLC;
  readonly schemaVersion: number;
}
```

`migrationObjectKind('rename_table')` is `'table'`.

**Key the migration on the NEW name.** Every subsequent alteration of the renamed table
also keys on the new name, so the object's version stream stays contiguous where the
table actually lives. The cost is that the rename itself starts a fresh counter under the
new name (version 1 if nothing was ever named that) — harmless, and the same thing
already happens when a dropped name is reused.

**Storage layout + format version.** `serializeMigration` currently ends with the DDL as
"rest of buffer", so a new field cannot simply be appended. Insert a length-prefixed slot
before the DDL:

```
HLC(30) | schemaVersion(4, BE) | typeLen(1) | type | fromLen(2, BE) | fromTable | ddl
```

`fromLen == 0` means absent. This is an incompatible layout change: bump
`SYNC_METADATA_FORMAT_VERSION` from 4 to 5. A replica with v4 metadata already refuses to
start and must re-bootstrap from a peer (`sync-manager-impl.ts` ~253) — that is the
intended, loud behaviour, and `metadata-format-version.spec.ts` covers it.

`SerializedSchemaMigration` (wire JSON) gains an optional `fromTable`, so a peer that
omits it deserializes to `undefined` and a `rename_table` without it is treated as
undecidable (see the decision table below).

### B. Recording it at the origin

`mapSchemaMigrationType` currently takes `(objectType, type)`. It cannot distinguish a
rename from any other `alter` on those two fields alone, so change it to take the whole
`DatabaseSchemaChangeEvent` and add one rule ahead of the existing ones:

> `objectType === 'table' && type === 'alter' && oldObjectName !== undefined`
> ⇒ `rename_table`.

`oldObjectName` comes from ticket 1 and is set by exactly one emit site (the store
module's `renameTable`), so the discriminator is unambiguous. `recordSchemaMigration`
then files under `event.objectName` (the new name) with `fromTable: event.oldObjectName`.

### C. Keeping the rows flowing

Teach `computeBatchTableFates` about renames. It already walks every migration in the
batch and keeps the max-HLC create/drop step per table; extend it so a `rename_table`
contributes **two** steps at its own HLC:

- the new name becomes **present**;
- `fromTable` becomes **absent**.

Order still comes from the existing max-HLC-wins comparison, so a
`rename → rename back` or `rename → drop` sequence in one batch resolves correctly
without special-casing. A `rename_table` whose `fromTable` is missing contributes only
the "new name present" half.

That is all the data path needs. Phase 1b then reports the new name as `known`, and
because `inBasis` is still false for it, the existing `freshLocalTable` branch resolves
those rows read-free — which is right: the receiver has no metadata under the new name
(see the caveat below).

### D. Applying it idempotently

`decideSchemaChange` gains a `rename_table` arm, reading the local catalog for both
names:

| old present | new present | verdict |
|---|---|---|
| yes | no | `execute` |
| no | yes | `already-applied` — the rename already happened here |
| yes | yes | **throw a conflict** naming both tables: renaming would collide with a table that already exists, and silently keeping either shape would record "converged" for a divergence that is not. Same posture as a divergent `create_table`. |
| no | no | converge with a warning — there is nothing to rename, consistent with `drop_index`'s absent-owner arm |
| `fromTable` absent | — | converge with a warning; the migration is undecidable |

`applySchemaChange` must open the remote-event scope (ticket 2) for **both** names —
the emitted event names the new one, but scoping the old one too costs nothing and
protects against a module that announces under the pre-rename name.

## Edge cases & interactions

- **Rename, then write, in one relay** — the headline case. Assert the row lands in
  `b.orders2`, and that `ApplyResult.unknownTable` is 0.
- **Rename in the same transaction as writes to the table.** The engine's
  `renameBatchedEvents` already relabels batched data events to the new name before
  commit, so all of the transaction's facts file under the new name and share one HLC
  base with the migration (DDL takes the lower `opSeq`). Pin it.
- **Rename A→B on one peer, B created independently on the other** — the `yes/yes` row.
  Must throw, naming both, and must not half-apply.
- **Rename A→B then B→C**, relayed as one batch: HLC ordering replays both, fates leave
  only `C` present.
- **Rename A→B then drop B** in one batch: fates leave both absent; rows for either name
  divert.
- **Rename then rename back** (A→B→A) in one batch: `A` present, `B` absent.
- **A batch containing only the rename, delivered twice** — second pass absorbed by the
  version guard; and delivered to a peer that already renamed — absorbed by
  `already-applied`.
- **Snapshot bootstrap replay.** A fresh peer replays every migration in HLC order:
  `create table orders`, then `rename_table` to `orders2`. `snapshot-ddl-causal-order.spec.ts`
  is the existing guard for that ordering; extend it rather than writing a parallel one.
- **CRDT metadata is stranded by the rename.** Sync's per-row bookkeeping (`cv:`, `tb:`,
  `cl:`) is keyed by table name, so both origin and receiver abandon it at the old name
  and start empty at the new one — later conflict resolution and tombstone blocking lose
  their history for that table. Pre-existing for a purely local rename; this ticket makes
  it happen on every peer. Explicitly **not** fixed here; filed as
  `bug-sync-rename-and-pk-change-strand-crdt-metadata`. Put a `NOTE:` naming that slug at
  the `rename_table` arm of `decideSchemaChange`, and say so in `docs/sync-schema.md` so
  a reader is not surprised by an old delete failing to block a replayed insert.
- **Store-and-forward / quarantine holds under the old name.** A peer that quarantined
  rows for `orders` before the rename arrived still holds them under that key. The
  reactive drain fires on applied `create_table`, not on rename, so they stay held until
  the periodic sweep. Acceptable; state it in the ticket's handoff rather than widening
  scope.

## Tests

Extend `packages/quereus-sync/test/sync/schema-alter-replication.spec.ts` (created by
ticket 2) with a `rename to` block:

- `b` has `orders2` and no `orders` after `relayAll`, and
  `generateTableDDL` matches on both peers.
- **The data assertion this ticket exists for**: `a` renames, inserts a row into
  `orders2`, relays once; `b` reads that row out of `orders2`, and the `ApplyResult`
  reports `unknownTable: 0`. Pin the pre-rename row survives the rename on `b` too.
- Rename inside one transaction with writes to the same table.
- Each row of the decision table in § D, including the `yes/yes` conflict (message names
  both tables) and the undecidable `fromTable`-absent case.
- Chained rename, rename-then-drop, and rename-then-rename-back within one batch,
  asserted through `computeBatchTableFates` behaviour (the resulting table set on `b`).
- `metadata-format-version.spec.ts`: v4 metadata is refused under v5.
- `schema-migration-object-kind.spec.ts`: `rename_table` → `'table'`.
- Round-trip specs for the new stored layout (`serializeMigration` /
  `deserializeMigration` with and without `fromTable`, including a `fromTable`
  containing multi-byte characters so the 2-byte length prefix is exercised in bytes,
  not code units) and for the wire JSON.
- `snapshot-ddl-causal-order.spec.ts`: create-then-rename replays in order.

## TODO

- `protocol.ts`: add `rename_table`; add `fromTable?` to `SchemaMigration` and
  `SchemaChangeToApply`; carry it in `toSchemaChange`; extend `migrationObjectKind`.
- `schema-migration.ts`: add `fromTable?` to `StoredMigration`; change the record layout
  to insert the length-prefixed slot before the DDL; carry it through `listAllMigrations`.
- `keys.ts`: bump `SYNC_METADATA_FORMAT_VERSION` to 5.
- `wire.ts`: optional `fromTable` on `SerializedSchemaMigration`, both directions.
- `sync-manager-impl.ts`: `mapSchemaMigrationType` takes the event and detects the
  rename via `oldObjectName`; `recordSchemaMigration` files under the new name with
  `fromTable`.
- `change-applicator.ts`: `computeBatchTableFates` handles `rename_table` as two steps.
- `store-adapter.ts`: `rename_table` arm in `decideSchemaChange`; scope both names in
  `applySchemaChange`; `NOTE:` the stranded-metadata slug.
- Tests as above.
- `docs/sync-schema.md` § What replicates: `RENAME TO` now replicates and data flows
  across it; note the metadata-strand caveat and the format bump.
- `yarn build`, `yarn test`, `yarn lint`.
