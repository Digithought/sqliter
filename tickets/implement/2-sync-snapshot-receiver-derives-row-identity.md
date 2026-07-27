description: When a device downloads a full copy of a synced database, it should work out for itself which rows are which, instead of taking the sender's word for it — because a relay server files rows differently and the downloaded bookkeeping ends up unreachable.
prereq: sync-snapshot-stream-sends-ddl-after-data
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts         # applySnapshotStream + streamSnapshotChunks
  - packages/quereus-sync/src/sync/snapshot.ts                # getSnapshot / applySnapshot
  - packages/quereus-sync/src/sync/protocol.ts                # Snapshot / chunk types
  - packages/quereus-sync/src/sync/wire.ts                    # serialized chunk shapes + codecs
  - packages/quereus-sync/src/metadata/keys.ts                # encodePkIdentity, PkKeying
  - packages/quereus-sync/src/metadata/column-version.ts      # setColumnVersionBatch / …ByIdentityBatch
  - packages/quereus-sync/src/metadata/tombstones.ts          # setTombstoneBatch / …ByIdentityBatch
  - packages/quereus-sync/src/metadata/change-log.ts          # recordColumnChangeBatch / …ByIdentityBatch
  - packages/quereus-sync/src/clock/hlc.ts                    # compareHLC
  - packages/quereus-sync/test/sync/pk-key-identity.spec.ts   # existing bootstrap coverage
  - packages/quereus-sync/test/sync/dotted-table-name.spec.ts # calls setColumnVersionByIdentityBatch directly
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts # stores serialized chunks at rest
  - docs/sync.md                                              # § Row identity vs. address
difficulty: hard
----

## Background a reader needs

Every synced row has two things attached to it:

- an **address** — the actual primary-key values, e.g. `['Apple']`;
- an **identity** — a derived string answering "is this the same row?", built by running
  each key value through the rules the database itself uses for equality. Under
  `collate nocase`, `'Apple'` and `'APPLE'` produce the same identity; for a `timespan`
  key, `'PT1H'` and `'PT60M'` do.

All of a row's per-row bookkeeping (which column was written when, whether the row was
deleted) is filed under the **identity**, so two spellings of one row cannot drift apart.
Deriving an identity requires the table's definition.

## What is wrong

On the snapshot (full-database bootstrap) path the receiver files incoming bookkeeping
under the **sender's** identity strings, taken verbatim off the wire, instead of deriving
its own. The delta path already derives locally — only snapshot trusts the sender.

That is fine while both sides hold the same table definition. It breaks when they do not:

- A **relay server has no table definitions at all.** `sync-coordinator` builds its sync
  engine with no `getTableSchema` oracle, so `createPkKeyingResolver` falls back to
  `RAW_PK_KEYING` — literal values, no case folding, no `timespan` normalization. It then
  serves those literal identities from its snapshot endpoint.
- A receiver that *does* hold the definition derives a different identity for the same
  row.

So after bootstrapping from a relay the receiver holds records filed under identities it
will never look up again. Every later lookup goes to the locally-derived identity, finds
nothing, and behaves as if the row had no history: a deletion carried in the snapshot
stops blocking a stale write, and last-writer-wins comparisons restart from scratch.

Only tables whose primary key needs normalization are affected — a `collate nocase` /
`collate rtrim` text key or a `timespan` key. Plain integer and `collate binary` text keys
derive the same string either way, which is why existing tests pass.

## Confirmed reproduction

Run against real engine peers plus a bare relay-shaped manager (no store adapter, no
schema oracle, no transaction source — exactly what `StoreManager.openStore` builds):

```ts
const a = await makePeer('A');
const b = await makePeer('B');
const relayMgr = await SyncManagerImpl.create(
  new InMemoryKVStore(), undefined, DEFAULT_SYNC_CONFIG, new SyncEventEmitterImpl(),
);

await a.db.exec(`create table t (k text collate nocase primary key, v text) using store`);
await localWrite(a, `insert into t values ('Apple', 'v1')`);
await localWrite(a, `insert into t values ('Banana', 'v2')`);
await localWrite(a, `delete from t where k = 'BANANA'`);

await settle();
await relayMgr.applyChanges(await a.manager.getChangesSince(relayMgr.getSiteId()));

const chunks = [];
for await (const c of relayMgr.getSnapshotStream()) chunks.push(c);
await b.manager.applySnapshotStream(toStream(chunks));
```

Observed on B today:

| probe | result |
| --- | --- |
| `select k, v from t` | `[{ k: 'Apple', v: 'v1' }]` — row data is fine |
| `columnVersions.getColumnVersion('main','t',['APPLE'],'v')` | `undefined` |
| `columnVersions.getColumnVersion('main','t',['Apple'],'v')` | `undefined` |
| `tombstones.getTombstone('main','t',['banana'])` | `undefined` |
| `tombstones.getTombstone('main','t',['Banana'])` | `undefined` |

Both spellings miss, because B derives `'apple'` / `'banana'` while the relay filed
`'Apple'` / `'Banana'`. Feeding B a stale column write for `['BANANA']` dated well before
the delete then resurrects the row: `select k, v from t` returns
`[{ k: 'Apple', v: 'v1' }, { k: 'BANANA', v: 'resurrected' }]`.

## Chosen approach: the receiver derives, always

Of the three directions the fix ticket raised, take **re-derive on the receiver**.
Rationale: identity is a *local* derivation, and the wire already carries the raw pk
(the address) on every entry. The delta path already works this way, so this makes the
two ingress paths agree instead of adding a second rule.

The ordering objection ("the table may not exist yet mid-bootstrap") is what the prereq
ticket removes: once schema migrations precede table data in the stream, the table exists
by the time its rows arrive. The non-streaming `applySnapshot` never had the problem —
its `commitMetadata` runs after `applyDataToStore`, which applies DDL first.

Rejecting the snapshot on a keying mismatch was considered and dropped: it leaves relay
bootstrap permanently unusable. Giving the relay real table definitions is a genuinely
useful separate change (it would also fix relay-side conflict resolution splitting two
spellings of one row) but it is not needed for correctness here and should not be bundled.

### 1. Stop putting the sender's identity on the wire

Leaving the field there invites the same trust bug to grow back. Remove it:

- `SnapshotColumnVersionsChunk.entries` — currently
  `Array<[versionKey, HLC, SqlValue, SqlValue[]]>` where `versionKey` is
  `` `${identity}:${column}` ``. Replace with an explicit record per entry:
  `ReadonlyArray<{ column: string; hlc: HLC; value: SqlValue; pk: SqlValue[] }>`.
  This also removes the consumer's `versionKey.lastIndexOf(':')` split, which mis-parses
  any column name containing a colon (`create table t ("a:b" text)` is legal SQL).
- `SnapshotTombstoneChunk.entries[].identity` — remove.
- `SnapshotTombstone.identity` (non-streaming) — remove.
- `TableSnapshot.columnVersions` — a `Map` keyed `` `${identity}:${column}` ``. Replace
  with `ReadonlyArray<{ column, hlc, value, pk }>`; the map key was only ever a grouping
  device and the receiver now regroups by its own identity.
- Mirror all of the above in `wire.ts`'s `Serialized*` shapes and both codec directions.

`TableSnapshot.rows` is already dead on the apply side (`applySnapshot` rebuilds rows from
`columnVersions` and ignores it) and its producer fills it from an arbitrary map iteration
order. Leave it alone here, but do not thread it into anything new.

### 2. Gate the wire format, loudly

The coordinator's S3 snapshot store (`s3-snapshot-store.ts`) persists **serialized chunks
at rest**. An old stored snapshot deserialized by new code would read the packed
`identity:column` string as a column name — silent corruption, not a visible failure.

Add `snapshotFormat: number` to `SnapshotHeaderChunk` (and the same field to the
non-streaming `Snapshot`), export a `SNAPSHOT_WIRE_FORMAT_VERSION` constant, and have
`applySnapshotStream` / `applySnapshot` throw on a missing or mismatched value before
touching local state — the same posture as the existing `fv:` metadata-format gate in
`SyncManagerImpl.create`. Document the recovery (regenerate the snapshot) alongside it.

### 3. Derive locally, and reconcile collapses by timestamp

`SyncContext.getPkKeying(schema, table)` + `encodePkIdentity(pk, keying)` is the local
derivation. In practice, switch the three snapshot write sites from the
`…ByIdentityBatch` setters to the pk-taking ones, which derive internally:

| now | use |
| --- | --- |
| `columnVersions.setColumnVersionByIdentityBatch` | `setColumnVersionBatch` |
| `changeLog.recordColumnChangeByIdentityBatch` | `recordColumnChangeBatch` |
| `tombstones.setTombstoneByIdentityBatch` | `setTombstoneBatch` |

**A straight substitution is not enough.** A relay keys raw, so it can hold *two* records
for what the receiver considers one row (`'apple'` and `'APPLE'`). Once the receiver
collapses them, a naive write loop resolves the collision by batch order — the last entry
written wins regardless of its timestamp. That is not last-writer-wins, and it also emits
two change-log entries pointing at one surviving cell record, so `resolveLogEntry` yields
the same change twice from `getChangesSince`.

So reconcile before writing: for each `(local identity, column)` keep the entry with the
greatest `hlc` (`compareHLC` in `clock/hlc.ts`), and write exactly one column-version,
one change-log entry, and one data change for it. The winning entry's `pk` is the row
address to apply. Same rule for tombstones: one tombstone per local identity, greatest
`hlc` wins.

Practically this means accumulating a table's entries before writing them:

```ts
// per table, keyed by the RECEIVER's derived identity
Map<string, { pk: SqlValue[]; cells: Map<string, { hlc: HLC; value: SqlValue }> }>
```

`applySnapshotStream` already buffers `rowColumns` / `rowPks` per table across a whole
table section, so this is the same order of memory it already uses — fold the two
together rather than adding a third map, and write the accumulated table at `table-end`
(saving the resume checkpoint there, as `flushMetadataBatch` does today).

Tombstone chunks arrive in their own section grouped by `(schema, table)`, contiguous
because the producer's `tb:` scan is key-sorted. Accumulate per table, flush when the
chunk's table changes and at `footer`. Add a `NOTE:` at that site recording that the
flush-on-table-change is only correct because of that contiguity.

`applySnapshot` (non-streaming) needs the same reconciliation over `TableSnapshot`
entries, inside `commitMetadata`.

### 4. Retire what becomes dead

After this, `setColumnVersionByIdentityBatch`, `recordColumnChangeByIdentityBatch` and
`setTombstoneByIdentityBatch` have no production callers left (grep confirms the snapshot
paths are the only ones). Delete them and update
`test/sync/dotted-table-name.spec.ts:147`, which calls the first directly. Keep
`ChangeLogStore.deleteEntryByIdentityBatch` — the tombstone GC sweep in
`sync-manager-impl.ts` still uses it.

## Cases that must keep working

- **Fresh replica whose table only exists because of the snapshot's own `create table`.**
  Guaranteed by the prereq ticket's chunk reordering; assert it with a test that
  bootstraps a fresh peer.
- **A relay applying a snapshot** (the S3 restore path, `StoreManager.onStoreCreated`).
  It has no schema oracle, so `getPkKeying` returns `RAW_PK_KEYING` and the derived
  identity equals the raw one — consistent with how the same relay keys its delta
  ingress. Nothing special needed, but do not let the no-oracle case throw.
- **A table in the snapshot with no local definition and no `create table` migration.**
  `createPkKeyingResolver` throws for a wired-oracle receiver. That is the right outcome
  and not a regression: such a snapshot already fails at `applyDataToStore` with
  `Table not found for external write`.

## Verification

- The relay-as-sender reproduction above, promoted to a spec: after bootstrap, both
  `getColumnVersion('main','t',['APPLE'],'v')` and `getTombstone('main','t',['banana'])`
  must resolve, and a stale pre-delete write for `['BANANA']` must **not** resurrect the row.
- A collapse spec: a raw-keying relay holding both `'apple'` and `'APPLE'` cell records
  for the same column, with different HLCs, must bootstrap into exactly one receiver
  record carrying the later value — and `getChangesSince` on the receiver must emit that
  change once, not twice.
- The `timespan` variant of the same (`'PT1H'` vs `'PT60M'`), since it exercises the
  semantic-transform half of the keying rather than the collation half.
- Existing `test/sync/pk-key-identity.spec.ts` "snapshot bootstrap files metadata the
  receiver can find by pk" must still pass; its comment claiming the receiver files under
  the sender's identity verbatim is now wrong and must be rewritten.

## TODO

### Phase 1 — protocol and wire

- [ ] Replace the packed `versionKey` tuple in `SnapshotColumnVersionsChunk.entries` with
      `{ column, hlc, value, pk }` records; drop `identity` from `SnapshotTombstoneChunk`
      entries, `SnapshotTombstone`, and `TableSnapshot.columnVersions` (array of records).
- [ ] Add `snapshotFormat` + exported `SNAPSHOT_WIRE_FORMAT_VERSION`; make both apply
      paths throw on missing/mismatched format before mutating local state.
- [ ] Update `wire.ts` serialized shapes and both codec directions.
- [ ] Update the producers (`getSnapshot`, `streamSnapshotChunks`) to emit the new shapes.

### Phase 2 — receiver-side derivation

- [ ] `applySnapshotStream`: accumulate each table's entries keyed by the receiver-derived
      identity, HLC-max per `(identity, column)`, write column versions / change-log
      entries / data changes at `table-end`, keeping the checkpoint save there.
- [ ] `applySnapshotStream`: accumulate tombstones per `(schema, table)`, HLC-max per
      identity, flush on table change and at `footer`; add the contiguity `NOTE:`.
- [ ] `applySnapshot`: same reconciliation inside `commitMetadata`.
- [ ] Switch all six write sites to the pk-taking setters; delete the three now-unused
      `…ByIdentityBatch` setters and fix `dotted-table-name.spec.ts`.

### Phase 3 — tests and docs

- [ ] Add the relay-as-sender bootstrap spec (metadata findable, no resurrection).
- [ ] Add the two-spellings-collapse spec (one record, later HLC wins, emitted once).
- [ ] Add the `timespan` variant.
- [ ] Rewrite the stale comments asserting sender-identity trust in `snapshot.ts`,
      `snapshot-stream.ts`, `protocol.ts`.
- [ ] `docs/sync.md` § *Row identity vs. address*: replace the final sender-trust
      paragraph with the receiver-derives rule, and document the snapshot wire-format gate
      next to § *Metadata format version*.
- [ ] Run `yarn workspace @quereus/sync test`, `yarn build`, `yarn typecheck`.

## Notes for whoever picks this up

- `tickets/backlog/bug-sync-colon-in-column-name-drops-cell` describes the colon-splitting
  family of bugs. Its `parse*Key` half is already fixed (the key layout length-prefixes the
  identity now), and Phase 1 here removes the snapshot half. That ticket is stale — it
  still describes the old `JSON.stringify(pk)` key format — and wants re-triage rather than
  work, but do not edit it from this ticket; the backlog is the human's queue.
- Per-table accumulation on the receiver is bounded by the largest table's live cell count,
  the same bound `applySnapshotStream` already carries. `tickets/backlog/debt-sync-s3-snapshot-in-memory`
  tracks the broader whole-snapshot-in-memory concern on the coordinator side.
