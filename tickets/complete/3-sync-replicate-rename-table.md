---
description: Renaming a table now replicates to other devices, and row data keeps flowing across the rename — including rows arriving in the very same sync batch as the rename.
files:
  - packages/quereus-sync/src/sync/protocol.ts                   # rename_table type; fromTable on SchemaMigration + SchemaChangeToApply; toSchemaChange
  - packages/quereus-sync/src/metadata/schema-migration.ts       # stored record layout gained a length-prefixed fromTable slot before the DDL
  - packages/quereus-sync/src/metadata/keys.ts                   # SYNC_METADATA_FORMAT_VERSION 4 → 5
  - packages/quereus-sync/src/sync/wire.ts                       # optional fromTable on SerializedSchemaMigration, both codec directions
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # mapSchemaMigrationType takes the whole event; recordSchemaMigration files fromTable
  - packages/quereus-sync/src/sync/change-applicator.ts          # computeBatchTableFates: rename = two existence steps; appliedDropKeys includes rename-away; reactive drain fires on rename
  - packages/quereus-sync/src/sync/store-adapter.ts              # decideRenameTable decision table; applySchemaChange scopes both names
  - packages/quereus-sync/src/sync/snapshot.ts                   # receiver record keeps fromTable
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # receiver record keeps fromTable
  - packages/quereus-sync/test/sync/_peer-harness.ts             # in-memory provider gained renameTableStores
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts   # the `rename to` describe — main e2e coverage
  - packages/quereus-sync/test/sync/drop-recreate-batch.spec.ts        # rename-away + re-create read-free coverage (added in review)
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts             # reactive drain on inbound rename (added in review)
  - packages/quereus-sync/test/sync/snapshot-ddl-causal-order.spec.ts  # create-then-rename bootstrap
  - packages/quereus-sync/test/metadata/schema-migration.spec.ts # stored-layout round-trips
  - packages/quereus-sync/test/wire.spec.ts                      # wire round-trips for fromTable
  - docs/sync-schema.md                                          # § Idempotent DDL + § What replicates rewritten for renames
  - docs/sync.md                                                 # metadata format version 5; SchemaMigration shape; reactive-drain triggers
  - docs/migration.md                                            # batch existence verdict + drain triggers
---

# Shipped: replicate `ALTER TABLE … RENAME TO`

Before this ticket a rename silently halted a table's replication: other devices kept
the old name and every later row change filed under a name they had never heard of.
Now the rename reaches every peer as its own migration type, and data written under the
new name lands — even in the same batch that carries the rename.

## What was built

- **`rename_table` migration type.** Keyed under the NEW name; carries the old name in
  a new optional `fromTable` field — on the wire (`SerializedSchemaMigration`,
  present-only JSON key), in storage (a 2-byte big-endian **byte**-length-prefixed slot
  inserted between the migration type and the DDL), and on `SchemaChangeToApply`.
  Origin side: `mapSchemaMigrationType` takes the whole schema-change event and maps
  `table`+`alter`+`oldObjectName` ⇒ `rename_table`.
- **Storage format bump 4 → 5.** The DDL was "rest of buffer", so the slot could not be
  appended; v4 metadata is refused at open (existing loud re-bootstrap posture).
- **Data routing.** `computeBatchTableFates` treats a rename as two existence steps at
  its own HLC: new name present, `fromTable` absent. Max-HLC-wins resolves chained
  rename, rename-then-drop, and rename-then-rename-back in one batch with no special
  cases. `appliedDropKeys` also counts an applied rename-away, so a name re-created
  after being renamed away resolves read-free.
- **Idempotent apply.** `decideRenameTable` (store-adapter): old present/new absent →
  execute; old absent/new present → already-applied; both → throw a conflict naming
  both tables; neither → converge with a warning; `fromTable` missing → undecidable,
  converge with a warning. The remote-event scope opens for BOTH names during exec.
- **Receiver re-relay integrity.** All three receiver-side record sites (wire apply,
  whole snapshot, streaming snapshot) carry `fromTable` into local storage.
- **Reactive drain on rename** (added in review). An applied `rename_table` now triggers
  the same low-latency held-change drain as an applied `create_table`, for its new name.

## Validation

`yarn build`, `yarn test` (full workspace, all green — quereus-sync 719 passing),
`yarn lint`, `yarn typecheck` — all clean after the review pass. `yarn docs:check` fails
on a pre-existing, already-tracked word-count ratchet (see findings).

## Known gaps and caveats

- **Stranded CRDT metadata** (`bug-sync-rename-and-pk-change-strand-crdt-metadata`,
  backlog): per-row bookkeeping stays keyed under the old name on every peer. Two
  consequences were appended to that ticket: a from-zero delta re-pull diverts
  pre-rename facts to the unknown-table disposition, and a snapshot taken after the
  rename ships pre-rename rows under the retired name. NOT fixed here.
- **Two rename shapes misroute batch data** — found in review, verified, filed as
  `tickets/fix/sync-rename-batch-existence-verdict-wrong.md`. See findings below.
- **Mobile backends lose rows on rename** — found in review, appended as a second arm to
  `bug-store-rename-silently-loses-rows-without-provider-hook`. See findings below.
- **Wire protocol version not bumped.** `fromTable` is additive-optional JSON, so
  same-version peers are unaffected and PROTOCOL_VERSION stays 1.
- **`decideRenameTable` checks presence, not shape**: it never compares the renamed
  table's definition against the origin's — a shape divergence would already have been
  surfaced by the `create_table`/alteration paths.

## Review findings

### Checked

Read the implement diff (`d2973a94`) before the handoff summary. Covered: the stored
record layout and its offset arithmetic; the wire codec both directions; the
origin-side event mapping and every `oldObjectName` emit site in the repo; the receiver
decision table; the batch existence verdict and all three of its readers (row admission,
`freshLocalTable`, reactive drain); all three receiver record sites; the coordinator and
sync-client passthrough (opaque — no change needed); `renameTableStores` implementations
across every shipped storage backend; case-sensitivity of the batch map keys against the
engine's case-insensitive catalog; the docs the change touched and the ones it did not.
Ran `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` — all clean.

### Major — filed as tickets

- **Two rename shapes misroute a batch's row data** →
  `tickets/fix/sync-rename-batch-existence-verdict-wrong.md` (repro: verified, both
  arms reproduced against real two-peer harnesses). One site, two symptoms, so one
  ticket with two arms:
  - *Receiver wedges.* The batch verdict asserts a rename's new name will exist, but the
    receiver declines to apply the rename when it dropped the old table locally (or when
    `fromTable` is absent). Rows for the new name still route there, storage throws
    `Table not found for external write`, the batch aborts with the watermark
    unadvanced, and the identical batch re-throws on every later sync — that peer's
    changes are stuck behind it indefinitely.
  - *Deleted row resurrected.* Rename-away-and-back in one batch trips the
    "brand-new table" verdict, so the batch's rows resolve read-free past a stored
    tombstone. Control run (same sequence minus the two renames) correctly discards the
    write; with the renames the deleted row comes back under default
    `allowResurrection: false`.

  Not fixed inline: reconciling the structural pre-DDL verdict with the catalog-based
  rename decision is a design call, not a local patch. `NOTE:` left at
  `computeBatchTableFates` and a caveat added to `docs/sync-schema.md` /
  `docs/migration.md` so the next reader meets it at the site.

- **Two shipped mobile storage backends silently empty a table on rename** → appended as
  a second arm to `bug-store-rename-silently-loses-rows-without-provider-hook` (the root
  cause is that ticket's existing site — the hookless `if` in
  `store-module-rename.ts`). `quereus-plugin-react-native-leveldb` and
  `quereus-plugin-nativescript-sqlite` implement `deleteTableStores` but not
  `renameTableStores`. That ticket asserted no shipped configuration loses data today;
  corrected. Replicating renames escalates it — a rename typed on a laptop now empties
  the table on every mobile peer, with no error at either end.

### Minor — fixed in this pass

- **Reactive drain never fired on a rename.** The post-commit drain triggered on applied
  `create_table` only, so rows held under a name a rename brings into existence waited
  for the periodic sweep. Fixed in `change-applicator.ts`; new test in
  `sync-drain-e2e.spec.ts` (verified to fail without the fix).
- **Untested `appliedDropKeys` rename arm.** The read-free path for a name re-created
  after being renamed away was implemented but had no coverage. Added a test to
  `drop-recreate-batch.spec.ts` alongside the drop/re-create sibling (verified to fail
  when the arm is disabled).
- **Wrong emit-site claim.** `mapSchemaMigrationType`'s doc comment and
  `docs/sync-schema.md` both said `oldObjectName` is set by exactly one site, the store
  module. There are three (`store-module-rename.ts`, the memory module, and the engine's
  own `runRenameTable` tail). Corrected both — the claim would have led a reader to think
  memory-backed renames produce no `rename_table`.
- **`docs/sync.md` was left stale by the implement pass.** It still declared the sync
  metadata format version as **4** after the bump to 5, and its `SchemaMigration`
  interface listing omitted `rename_table`, `alter_column`, and `fromTable`. Updated,
  along with the reactive-drain trigger list there and in `docs/migration.md`, and the
  batch existence-verdict description in both.
- **Stale self-referential line count.** The `NOTE:` in `change-applicator.ts` claiming
  1144 lines now reads 1204 (`wc -l`).

### Tripwires — parked, not ticketed

None. Two candidates were considered and rejected as not genuinely conditional: the
`fromTable` slot's 2-byte length prefix (a >64KB table name is not a reachable
condition, and the adjacent 1-byte migration-type prefix has the same unguarded shape),
and the mixed-build case where an old receiver has no rename idempotency arm — that is
already governed by the strict-equality `PROTOCOL_VERSION` note in `wire.ts`, and its
data-routing half turned out to be a real defect, so it went into the fix ticket instead.

### Not found / explicitly clear

- **Wire and snapshot producer paths.** Both snapshot forms and the delta path serialize
  through `serializeSchemaMigration`, so `fromTable` rides along everywhere; the
  coordinator and sync-client treat changesets opaquely and needed no change.
- **Case sensitivity.** The batch map keys are case-sensitive strings while the catalog
  is not, which looked like a mismatch. Probed with `alter table ORDERS rename to
  Orders2`: `fromTable` comes back catalog-normalized and the new name's casing matches
  the data changes', so the keys line up. No defect.
- **Storage layout.** The offset arithmetic round-trips correctly, including multi-byte
  names, an empty DDL, and a DDL whose leading bytes duplicate `fromTable`; the
  implement pass's own tests cover these and they hold.
- **Source hygiene.** No file grew past its neighbours' norms; `change-applicator.ts` at
  1204 lines is the largest touched and already carries a documented split seam. Comment
  density is high but load-bearing throughout — no prose blocks standing in for a named
  function.
- **`docs/sync-schema.md` § Schema Change Types** documents a `SchemaChangeType` union
  (with `create_view` / `create_trigger` etc.) that does not match `SchemaMigrationType`
  at all. Pre-existing drift describing the largely-unused `schema-version.ts` module,
  already covered by `debt-sync-schema-version-store-unused-and-ambiguous`; untouched by
  this diff, so left alone.

### Pre-existing failure

`yarn docs:check` fails on the word-count ratchet for `docs/sync.md` and
`docs/schema.md`. Already listed in `tickets/.pre-existing-known.md` against the
in-flight `debt-docs-size-ratchet-red-again`, so not re-reported. `docs/sync.md` was
1,006 words over at HEAD; this review's accuracy fixes added 101 more.
