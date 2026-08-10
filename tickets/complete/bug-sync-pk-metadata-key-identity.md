description: The sync engine used to file its per-row bookkeeping under the literal spelling of a row's primary key, so two spellings of one row (upper vs lower case under a case-insensitive key, or "1 hour" vs "60 minutes") drifted apart forever and deleted rows could come back; it now files everything under the database's own notion of row identity, with the raw key carried separately.
files:
  - packages/quereus-sync/src/metadata/keys.ts                # encodePkIdentity, PkKeying, length-prefixed cv:/cl: layouts, fv:
  - packages/quereus-sync/src/metadata/pk-identity.ts         # keying resolution from TableSchema
  - packages/quereus-sync/src/metadata/column-version.ts      # ColumnVersion.pk in value; *ByIdentity get/set
  - packages/quereus-sync/src/metadata/tombstones.ts          # Tombstone.pk unconditional in value
  - packages/quereus-sync/src/metadata/change-log.ts          # ChangeLogEntry.identity
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # keying threading, format-version gate
  - packages/quereus-sync/src/sync/change-applicator.ts       # identity collapse keys; freshLocalTable read-skip
  - packages/quereus-sync/src/sync/snapshot.ts                # identity grouping; sender-identity metadata writes
  - packages/quereus-sync/src/sync/snapshot-stream.ts         # same, streamed
  - packages/quereus-sync/src/sync/store-adapter.ts           # groupChangesByRow keyed by pk identity
  - packages/quereus-sync/src/sync/protocol.ts, wire.ts       # pk + identity on the snapshot wire
  - packages/quereus-sync/src/create-sync-module.ts           # keyNormalizerResolver option
  - packages/quoomb-web/src/worker/quereus.worker.ts          # wires db.getKeyNormalizerResolver()
  - packages/quereus-sync/test/sync/pk-key-identity.spec.ts   # repro cases + snapshot-bootstrap regression
  - packages/quereus-sync/test/metadata/pk-identity.spec.ts   # keying-resolution unit tests (added in review)
  - packages/quereus-sync/test/sync/metadata-format-version.spec.ts # fv: gate tests (added in review)
  - docs/sync.md                                              # § Row identity vs. address, § Metadata format version
----

# Sync pk-identity keying — shipped

## What was broken

Sync keyed every per-row record (`cv:` column version, `tb:` tombstone, `cl:` change-log
entry) by `JSON.stringify(pk)` — the literal spelling of the primary key — while the rest
of the engine decides "same row?" after key-collation normalization and semantic key
transforms. Under a `text collate nocase` or `timespan` primary key, one row filed under
N identities: change logs carried duplicate rows, concurrent inserts of one row never
converged, and a delete under one spelling could not block a stale write under another
(permanent resurrection). `JSON.stringify` also throws on `bigint`, so any integer key
beyond 2^53 silently never replicated.

## What was built

**Identity/address split.** A record's key now holds the row's *identity* — the engine's
type-tagged `serializeKeyNullGrouping` string after per-column semantic transform
(TIMESPAN → seconds) and key-collation normalizer (nocase → lowercase) — which is lossy
and never decoded back. The raw primary key (the row's *address*) moved into the record
**value** (`ColumnVersion.pk`, `Tombstone.pk`, both required) and onto the snapshot wire.
The type-tagged numeric encoding fixes the bigint defect for free.

**Key layouts.** Identity freely contains `:` and `\0`, so `cv:` and `cl:` keys
length-prefix it (`{idLen}:{identity}`). `tb:` needs no prefix (identity is last).
Quarantine (`qt:`) keys switched to the raw identity encoding — no schema can exist for
an out-of-basis table, and `(hlc, type)` already makes them unique.

**Keying resolution** (`metadata/pk-identity.ts`): resolved per table from its
`TableSchema`, cached per schema *object* in a WeakMap. Hosts pass
`db.getKeyNormalizerResolver()` via the new `keyNormalizerResolver` option on
`createSyncModule`. No oracle at all (relay-only coordinator) → raw keying; oracle wired
but table unknown → throw.

**Format version.** `fv:` record, `SYNC_METADATA_FORMAT_VERSION = 2`. A replica with
existing identity but a missing/mismatched version is refused with a re-bootstrap
instruction; no rewrite pass (no backwards-compatibility requirement yet).

**Public surface.** `encodePK`/`decodePK` removed; replaced by `encodePkIdentity`,
`encodeRawPkIdentity`, `PkKeying`, `PkKeyingResolver`, `resolvePkKeying`,
`createPkKeyingResolver`, `makePkIdentityEncoder`, `SYNC_METADATA_FORMAT_VERSION`.

## Review findings

### Checked and clean

- **Key encoding and parsing.** The length-prefixed `cv:`/`cl:` layout is unambiguous:
  the prefix is the identity's UTF-16 code-unit count, parsing decodes the whole key and
  slices by code units, and the unpaired-surrogate fold to U+FFFD preserves that count.
  Scan-bound prefixes can't collide across identities (a different identity implies a
  different length prefix or different text). Reviewed `splitLengthPrefixedIdentity`'s
  rejection paths (non-numeric length, out-of-bounds slice, missing/extra remainder).
- **Bigint / blob / null / object key values.** `serializeKeyNullGrouping` tags each
  class (`n:` numeric — bigint and number share it, `x:` blob, `o:` canonical JSON,
  `N:` null-grouping), so every `SqlValue` a primary key can hold is encodable. Verified
  against `packages/quereus/src/util/key-serializer.ts` rather than assumed.
- **Ordering of transform-then-normalize** matches `makePkKeySerializer` in
  `@quereus/isolation` exactly, so the two layers cannot disagree on row identity today.
- **`freshLocalTable` read-skip.** Only reachable for a table known solely via the same
  batch's `create_table` (`!inBasis && batchCreated && !batchDropped`), and Phase 3's
  metadata commit runs after the DDL, so the keying resolves by the time it is needed.
  A batch-dropped table diverts to quarantine before any keying lookup.
- **`clearExistingMetadata`** scans only the `cv:`/`tb:`/`cl:` ranges, so a snapshot
  bootstrap cannot wipe the `fv:` version record and brick the replica on next open.
- **No leftovers.** No remaining `encodePK`/`decodePK`/`JSON.parse(rowKey)` call sites in
  source or docs; no sync SQL table-valued function parses metadata keys.
- **Host wiring completeness.** The only `createSyncModule` call sites are quoomb-web
  (wired to `db.getKeyNormalizerResolver()`), the coordinator (relay, intentionally raw),
  and two test harnesses. No host was missed.
- **Spec updates the handoff asked to sanity-check.** `unknown-table-disposition.spec.ts`
  actually *strengthened* (whole-table keyspace scans replaced two point lookups);
  `snapshot-bootstrap.spec.ts`, `wire.spec.ts`, and the metadata unit specs are faithful
  fixture reshapes with no loosened assertions.

### Fixed in this pass (minor)

- **Five type errors in `test/metadata/keys.spec.ts`** — `buildColumnVersionKey` /
  `buildChangeLogKey` were still being passed a `SqlValue[]` where the new signature takes
  an identity `string`. The tests passed anyway (they assert on a throw that fires first),
  but the calls were wrong. Replaced with `encodeRawPkIdentity([1])`.
  These slipped through because nothing type-checks this package's test files — the
  package's `tsconfig.test.json` is inert (the base config's `exclude: ["test"]` wins) and
  no script runs it. That is already tracked as `backlog/debt-sync-typecheck-test-files`;
  confirmed the same inert-config pattern exists in 11 other packages, which that ticket
  should widen to cover.
- **`docs/sync.md` `TableSnapshot` interface** still declared
  `columnVersions: Map<string, HLC>`. It was already stale before this change and is now
  doubly so (entries carry value + raw pk, and the map key changed meaning). Corrected.
- **Missing tests for the two brand-new mechanisms.** Added
  `test/metadata/pk-identity.spec.ts` (9 cases: nocase folding, binary case-sensitivity,
  timespan semantic collapse, per-position composite keys, numeric-class bigint, no-oracle
  raw fallback, unknown-table throw, WeakMap re-resolution after DDL replaces the schema
  object, encoder/resolver agreement) and `test/sync/metadata-format-version.spec.ts`
  (4 cases: fresh stamp, self-reopen, pre-versioning refusal, mismatched-version refusal).
  The format gate can refuse to open a replica and had zero coverage.
- **One missing regression** in `test/sync/pk-key-identity.spec.ts`: peer-to-peer snapshot
  bootstrap under a `collate nocase` key, asserting the receiver can find both a
  bootstrapped column version and a bootstrapped tombstone *by primary key under the other
  spelling*. This pins the sender-identity seam the handoff flagged, for the case where it
  is supposed to work.
- **Cross-reference comment** added to `makePkKeySerializer` in
  `packages/quereus-isolation/src/overlay-rows.ts` pointing at the sync copy of the same
  rule, so the existing one-way pointer becomes two-way.

Sync suite: 521 → 535 passing, 0 failing.

### Filed as tickets (major)

- **`fix/sync-snapshot-bootstrap-trusts-sender-row-identity`** — a snapshot receiver files
  bookkeeping under the *sender's* identity verbatim. The handoff flagged this as a
  custom-collation edge case; it is broader than that. The `sync-coordinator` relay has no
  table definitions, so it keys rows literally, and it serves snapshot streams. A
  schema-bearing peer bootstrapping from a relay files nocase/rtrim/timespan-keyed rows
  under identities it will never look up again — reintroducing exactly the resurrection
  and non-convergence this ticket fixed. Reachable today via the coordinator's snapshot
  endpoint; becomes a live user path once `backlog/feat-sync-client-snapshot-bootstrap`
  lands.
- **`fix/sync-commit-capture-lost-when-table-dropped-in-same-transaction`** — the handoff
  noted that local capture for a table dropped before the async capture runs now throws.
  Tracing it: the throw is caught only at the top of `handleTransactionCommit`, so it
  discards the *entire transaction's* bookkeeping — other tables' row changes and the
  schema migrations included. A transaction that updates `a` and `b` then drops `a` never
  replicates any of it. Previously survivable (placeholder column names). The
  drop→recreate stale-metadata question the handoff raised is folded into this ticket.
- **`backlog/debt-share-row-identity-rule`** — the row-identity recipe is now written out
  in full in two packages (`makePkKeySerializer` in isolation, `resolvePkKeying` +
  `encodePkIdentity` in sync). They must agree or the two layers disagree about which rows
  are the same row. Mitigated with cross-reference comments; the real fix is one shared
  implementation in `@quereus/quereus`.

### Recorded as tripwires (conditional — no ticket)

- **Metadata size growth**: the raw primary key is now repeated in *every* cell record of
  a row, so metadata grows with (key width × column count). Fine at current scale; the
  escape hatch (one per-row identity→key record) is noted as a `NOTE:` comment on the
  `ColumnVersion` interface in `metadata/column-version.ts`.
- **Per-apply keying resolution** in `sync/store-adapter.ts` (implementer's `NOTE:`,
  verified present at the row-grouping site): the keying is re-derived per table per apply
  invocation rather than cached per schema object. Only matters if apply batches get hot.

### Accepted as-is (judgment calls from the handoff, re-examined)

- **Coordinator relay keys raw.** Correct in isolation — a relay has no table definitions,
  and raw keying there is stable for the deployment's life since an oracle can never
  appear later. The relay-side conflict-resolution split between two spellings of one row
  is a pre-existing conceptual limitation, now documented. Its *interaction* with snapshot
  bootstrap is the ticket above.
- **Stub-schema tolerance** in `resolvePkKeying` (`primaryKeyDefinition ?? []`, missing
  `logicalType` → identity normalizer). `primaryKeyDefinition` is non-optional on
  `TableSchema`, so this is unreachable for a real schema and exists purely for test
  oracles that stub minimal shapes. Left alone rather than converted to a throw: the loud
  version would break a large number of unrelated test oracles for no production benefit.
- **Unpaired-surrogate key values** folding to U+FFFD (theoretical collision between two
  keys differing only in a lone surrogate). Rejecting them would make such rows unsyncable;
  documented at `assertKeyableIdentifiers`.
- **`bug-sync-colon-in-column-name-drops-cell`** (backlog) is narrower now — the
  length-prefixed layout makes the `cv:`/`cl:` *storage* parses colon-safe — but the
  snapshot `versionKey` last-colon split still mis-parses a column name containing `:`.
  Confirmed the ticket is still valid; left in place, to be re-scoped when picked up.

## Validation

- `yarn build` — clean.
- `yarn typecheck` — clean.
- `yarn lint` — clean.
- `yarn test` (all workspaces) — green: quereus 7329, quereus-sync 535, store 1076,
  isolation 312, sync-coordinator 134, rest green. No pre-existing failures surfaced.
