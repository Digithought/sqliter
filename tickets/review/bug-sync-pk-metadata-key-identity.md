---
description: The sync engine used to file its per-row bookkeeping under the literal spelling of a row's primary key, so two spellings of one row (upper vs lower case under a case-insensitive key, or "1 hour" vs "60 minutes") drifted apart forever and deleted rows could come back; it now files everything under the database's own notion of row identity, with the raw key carried separately.
files:
  - packages/quereus-sync/src/metadata/keys.ts                # encodePkIdentity, PkKeying, length-prefixed cv:/cl: layouts, fv: + SYNC_METADATA_FORMAT_VERSION
  - packages/quereus-sync/src/metadata/pk-identity.ts         # NEW — keying resolution from TableSchema (mirrors isolation's makePkKeySerializer)
  - packages/quereus-sync/src/metadata/column-version.ts      # ColumnVersion.pk in value; *ByIdentity get/set
  - packages/quereus-sync/src/metadata/tombstones.ts          # Tombstone.pk unconditional in value; *ByIdentity get/set
  - packages/quereus-sync/src/metadata/change-log.ts          # ChangeLogEntry.identity (pk removed); *ByIdentity record/delete
  - packages/quereus-sync/src/sync/sync-context.ts            # SyncContext.getPkKeying
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # keying threading, format-version gate, resolveLogEntry/collectAllChanges/pruneTombstones
  - packages/quereus-sync/src/sync/change-applicator.ts       # identity collapse keys; freshLocalTable read-skip for batch-created tables
  - packages/quereus-sync/src/sync/snapshot.ts                # identity grouping; sender-identity metadata writes; pk in entries
  - packages/quereus-sync/src/sync/snapshot-stream.ts         # same, streamed
  - packages/quereus-sync/src/sync/store-adapter.ts           # groupChangesByRow keyed by pk identity
  - packages/quereus-sync/src/sync/protocol.ts                # ColumnVersionEntry.pk; 4-tuple chunk entries; tombstone-entry identity
  - packages/quereus-sync/src/sync/wire.ts                    # codec for the above
  - packages/quereus-sync/src/create-sync-module.ts           # keyNormalizerResolver option
  - packages/quereus-sync/src/index.ts                        # export surface (encodePK/decodePK removed)
  - packages/quoomb-web/src/worker/quereus.worker.ts          # wires db.getKeyNormalizerResolver()
  - packages/quereus-sync/test/sync/pk-key-identity.spec.ts   # NEW — the six repro cases
  - docs/sync.md                                              # § Row identity vs. address, § Metadata format version
difficulty: hard
---

# Sync pk-identity keying — implemented; review handoff

## What was broken (all reproduced, all now pinned by tests)

Sync keyed every per-row record (`cv:` column version, `tb:` tombstone, `cl:`
change-log entry) by `JSON.stringify(pk)` — the raw spelling — while the rest of
the engine decides "same row?" after key-collation normalization and semantic
key transforms. So under `text collate nocase` or `timespan` primary keys, one
row filed under N identities: change logs carried duplicate rows, concurrent
inserts of one row never converged, and a delete under one spelling could not
block a stale write under another (permanent resurrection). Additionally
`JSON.stringify` throws on `bigint`, so any integer pk beyond 2^53 silently
never replicated (the throw was swallowed in post-commit capture).

## What was built

**Identity/address split.** A record's key now holds the row's *identity* — the
engine's type-tagged `serializeKeyNullGrouping` string after per-column semantic
transform (TIMESPAN → seconds) and key-collation normalizer (nocase → lowercase)
— which is lossy and never decoded back. The raw pk (the row's *address*, any
spelling from the equivalence class) moved into the record **value**
(`ColumnVersion.pk`, `Tombstone.pk` — both required) and onto the snapshot wire.
The type-tagged numeric encoding fixes the bigint defect for free (`5n` ≡ `5`).

**Key layouts.** Identity freely contains `:` and `\0`, so `cv:` and `cl:` keys
length-prefix it (`{idLen}:{identity}`), making the identity/column split
unambiguous (parse functions return the identity string instead of a pk).
`tb:` needs no prefix (identity is the last component). `qt:` quarantine keys
switched to the raw identity encoding (bigint-safe; no schema can exist for an
out-of-basis table; `(hlc, type)` already makes them unique).

**Keying resolution** (`metadata/pk-identity.ts`, mirrors
`@quereus/isolation`'s `makePkKeySerializer` so the two layers can't disagree):
resolved per table from its `TableSchema` via `pkKeyCollationName` +
`semanticKeyTransform` + a `KeyNormalizerResolver`, cached per `TableSchema`
*object* in a WeakMap (DDL registers a fresh frozen schema, so invalidation is
free). Hosts pass `db.getKeyNormalizerResolver()` via the new
`keyNormalizerResolver` option on `createSyncModule` (wired in quoomb-web and
the test harness); absent, a built-ins-only resolver is used which throws on
custom collation names rather than mis-keying. No-schema behavior:

- **no oracle at all** (relay-only coordinator) → raw keying, stable for the
  deployment's whole life (an oracle can never appear later);
- **oracle wired, table unknown** → throw (a raw fallback would orphan
  everything already filed the moment the schema appears). The apply path never
  hits this for out-of-basis tables — they divert to quarantine first.

**Threading.** The three metadata stores take a `PkKeyingResolver` at
construction, so their public pk-taking methods kept their signatures. New
`*ByIdentity` variants serve callers that hold a parsed key instead of a pk:
`resolveLogEntry` (pk now comes from the resolved record, per the ticket),
`pruneTombstones` (schema-free delete of the paired `cl:` entry), and the
snapshot appliers. In-memory grouping keys switched to identity too:
`commitChangeMetadata`'s in-batch collapse and the store adapter's
`groupChangesByRow` (which also crashed on bigint pks before).

**Snapshot wire.** `versionKey` is now `${identity}:${column}`; entries carry
the raw pk explicitly (`ColumnVersionEntry.pk`, 4-tuple streamed entries,
`identity` on tombstone entries). The receiver files bootstrapped metadata under
the **sender's** identity verbatim — mid-bootstrap the receiving table may not
exist yet (its schema arrives in the same snapshot), so no local keying can be
resolved; the replicated schema makes both sides' identities agree.

**Batch-created tables.** Phase-1 resolution for a table that exists only via
the same batch's `create_table` now runs read-free (`freshLocalTable` in
`resolveChange`): it has no local schema (no keying) and no local metadata, so
every change resolves as a first write; Phase 3 commits metadata after the DDL
has executed.

**Format version.** `fv:` record, `SYNC_METADATA_FORMAT_VERSION = 2`.
`SyncManagerImpl.create` writes it on a fresh replica and throws (with a
re-bootstrap instruction) when a replica has existing identity but a
missing/mismatched version. No rewrite pass, per the ticket's recommended
default and the no-backcompat posture. Documented in docs/sync.md.

**Public surface.** `encodePK`/`decodePK` removed from exports; replaced by
`encodePkIdentity`, `encodeRawPkIdentity`, `PkKeying`, `PkKeyingResolver`,
`resolvePkKeying`, `createPkKeyingResolver`, `makePkIdentityEncoder`,
`SYNC_METADATA_FORMAT_VERSION`.

## Validation done

- `packages/quereus-sync/test/sync/pk-key-identity.spec.ts` — the ticket's five
  repro cases plus the bigint case. **All six failed on main** (verified before
  the fix: 2-identities-per-row, resurrection, both non-convergences, bigint row
  never arriving) and all pass now.
- `yarn workspace @quereus/sync test`: 521 passing, 0 failing (was 422/95 before
  spec updates; every previously-passing test still passes).
- `yarn test` (all workspaces): green — quereus 7329, store 1076, isolation 312,
  sync-coordinator 134 (exercises the no-oracle relay path end to end), rest green.
- `yarn build`, `yarn typecheck`, `yarn workspace @quereus/quereus run lint`: clean.
- `store-adapter-pk-collation.spec.ts` (store-side keying pin): passes.

Spec updates the reviewer should sanity-check rather than trust: fixtures in
`snapshot-bootstrap.spec.ts`, `store-adapter-seam.spec.ts`, `wire.spec.ts`,
`dotted-table-name.spec.ts` (synthetic snapshot chunks → 4-tuples + identities),
`unknown-table-disposition.spec.ts` ("no metadata written" probes became
keyspace scans — pk-based lookups on a schemaless table now throw by design),
and the three metadata unit specs (store ctors take a keying resolver; the
tombstone "fixed 38-byte head" test became "payload always present").

## Known gaps / judgment calls for review

- **Sender-identity trust on the snapshot wire.** Bootstrapped metadata files
  under the sender-computed identity. If sender and receiver ever key
  differently (a custom collation registered with different normalizers on the
  two sides), post-bootstrap pk-based lookups would miss the bootstrapped
  records. This is the same "both sides must agree on key encoding" requirement
  the store's data keys already carry, but it is new for sync metadata and worth
  a reviewer's eye. The alternative (receiver-side re-derivation) fails on fresh
  bootstrap, where the table's schema arrives inside the same snapshot.
- **Stale metadata for a drop→recreate-in-one-batch table.** `freshLocalTable`
  skips Phase-1 metadata reads for tables created by the same batch. If a
  previously-dropped table left metadata behind and is recreated by an inbound
  batch, that stale metadata is not consulted for LWW/tombstone gating in that
  batch (it belongs to the old incarnation, and its identities may not match the
  new schema anyway). Worth a think about whether drop_table should purge the
  table's `cv:`/`tb:`/`cl:` ranges — if so, that is a new ticket, not a tweak.
- **Local capture of a table dropped before the async capture runs** now throws
  inside `handleTransactionCommit` (logged + error event, whole transaction's
  capture lost) where it previously recorded orphan metadata under fallback
  `col_N` names. Deliberate (no sound identity exists), but it is a behavior
  change on a race path.
- **Stub-schema tolerance.** `resolvePkKeying` degrades a pk position to the
  identity normalizer when `primaryKeyDefinition` or a column's `logicalType` is
  absent — real schemas always carry both; this exists for the many test oracles
  that stub minimal schemas. A reviewer may prefer a loud throw + stub fixes.
- **Coordinator (no-oracle) metadata still keys raw**, so two spellings of one
  row file separately *on the relay*. Peers with schemas converge regardless
  (relay metadata is an index, and each peer resolves conflicts under its own
  identity), and the coordinator suite passes — but relay-side LWW between two
  spellings remains spelling-split there. Pre-existing conceptual limitation,
  now documented rather than fixed.
- **Colon-in-column-name** (`backlog/bug-sync-colon-in-column-name-drops-cell`):
  the length-prefixed layout incidentally makes the `cv:`/`cl:` *storage* parses
  colon-safe; the remaining surface is the snapshot `versionKey` last-colon
  split (and the same split in the appliers). That backlog ticket is narrower
  now but still real — do not retire it, just re-scope it when it is picked up.
- **Unpaired-surrogate string pk values** fold to U+FFFD in key bytes (was
  JSON-escaped before): a theoretical cross-value identity collision between two
  pks differing only in a lone surrogate. Rejecting them would make such rows
  unsyncable; documented at `assertKeyableIdentifiers` in keys.ts.

## Tripwires recorded

- `store-adapter.ts` (row-grouping site): keying resolved fresh per table per
  apply invocation; if apply batches get hot, cache per `TableSchema` object
  like `metadata/pk-identity.ts` does. NOTE comment at the site.
