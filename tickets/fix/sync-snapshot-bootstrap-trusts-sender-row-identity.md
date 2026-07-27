description: When a new device downloads a full copy of a synced database, it files the bookkeeping for each row under whatever the sender thought that row's identity was. If the sender and receiver disagree about which spellings of a key mean the same row — which they do whenever the sender is a relay server, because a relay has no table definitions — the downloaded bookkeeping becomes unreachable, and the two sides can silently drift apart afterwards.
files:
  - packages/quereus-sync/src/sync/snapshot.ts             # applySnapshot — files metadata under ts.identity / versionKey prefix
  - packages/quereus-sync/src/sync/snapshot-stream.ts      # applySnapshotStream — same, streamed
  - packages/quereus-sync/src/sync/protocol.ts             # SnapshotTombstone.identity, SnapshotColumnVersionsChunk entries
  - packages/quereus-sync/src/metadata/pk-identity.ts      # createPkKeyingResolver — no-oracle => RAW_PK_KEYING
  - packages/sync-coordinator/src/service/store-manager.ts # relay createSyncModule call — no getTableSchema oracle
  - packages/sync-coordinator/src/service/coordinator-service.ts # getSnapshotStream
  - packages/quereus-sync/test/sync/pk-key-identity.spec.ts # existing peer-to-peer bootstrap coverage
  - docs/sync.md                                           # § Row identity vs. address
difficulty: hard
----

## Background a reader needs

Every synced row has two things attached to it:

- an **address** — the actual primary-key values, e.g. `['Apple']`;
- an **identity** — a derived string that answers "is this the same row?", built by
  running each key value through the rules the database itself uses for equality.
  Under `collate nocase`, `'Apple'` and `'APPLE'` produce the *same* identity. For a
  `timespan` key, `'PT1H'` and `'PT60M'` produce the same identity.

Sync files all of a row's per-row bookkeeping (which column was written when, whether
the row was deleted) under the **identity**, so that two spellings of one row cannot
drift apart. Deriving an identity requires the table's definition — you cannot know a
column is `collate nocase` without it.

## What is wrong

When one replica sends another a **full snapshot** (the "give me the whole database"
bootstrap path), the receiver writes the incoming bookkeeping under the **sender's**
identity strings, taken verbatim off the wire. It does not re-derive them locally.

That was a deliberate choice: mid-bootstrap the receiving table may not exist yet — its
definition arrives inside the same snapshot — so there is often nothing local to derive
from. When both sides hold the same table definition, both compute the same identity and
everything lines up.

The problem is the case where they *don't*:

- **A relay server has no table definitions at all.** `sync-coordinator` creates its
  sync engine without a table-definition source, so it falls back to keying rows by
  their literal values with no case-folding and no `timespan` normalization. It then
  serves those literal-value identities out of its snapshot endpoint.
- A receiver that *does* have the table definition would have derived a *different*
  identity for the same row (`'Apple'` folds to lowercase; `'PT1H'` becomes seconds).

So after bootstrapping from a relay, the receiver holds bookkeeping filed under
identities it will never look up again. Every later lookup goes to the correct
(locally-derived) identity, finds nothing, and behaves as if the row had no history:
a deletion that arrived in the snapshot stops blocking a stale write (the row can come
back), and last-writer-wins comparisons start from scratch.

This only bites tables whose primary key needs normalization — a `collate nocase` or
`collate rtrim` text key, or a `timespan` key. Plain integer and `collate binary` text
keys derive the same string either way, which is why the existing tests pass.

## Reproduction sketch

1. Two peers, both with `create table t (k text collate nocase primary key, v text)`.
2. Peer A writes `('apple','v1')`, then deletes it. Relay R (no table definitions)
   receives both changes and stores them under literal identities.
3. Fresh peer B bootstraps from **R's** snapshot stream, not A's.
4. On B, `tombstones.getTombstone('main','t',['apple'])` returns nothing — the record
   is there, filed under the un-folded identity.
5. A stale write for `'APPLE'` older than the deletion now resurrects the row on B.

The all-peer version of this (`test/sync/pk-key-identity.spec.ts`, "snapshot bootstrap
files metadata the receiver can find by pk") passes, because both peers derive
identically. The relay-as-sender variant is the one to add.

## Expected behavior

A receiver must end a bootstrap with bookkeeping filed under identities *it* will look
up. Approaches worth weighing (this is the research part of the ticket):

- **Re-derive on the receiver whenever it can.** Each snapshot entry already carries the
  row's raw address, so once the table's definition is installed the receiver can compute
  its own identity and ignore the sender's. The open question is ordering: table
  definitions and row bookkeeping arrive interleaved in the stream, so this may mean
  buffering a table's entries until its definition lands, or a re-key pass at table end.
- **Refuse the mismatch loudly.** Have the sender declare how it keyed (derived vs
  literal) and have a receiver that keys differently reject the snapshot rather than
  quietly corrupt itself. Safe, but leaves relay bootstrap unusable.
- **Give the relay real table definitions.** It already replicates every `create table`
  as a schema migration, so it may be able to answer identity questions without a store.
  This would also fix the separate, already-documented limitation that relay-side
  conflict resolution splits two spellings of one row.

Whatever is chosen must keep working for the fresh-replica case where the table does not
exist until the snapshot's own `create table` runs.

## Related

- `backlog/feat-sync-client-snapshot-bootstrap` wires the sync client to actually request
  snapshots from the coordinator. That is the change that turns this from a defect on a
  served-but-unconsumed endpoint into one on a live user path.
- `docs/sync.md` § *Row identity vs. address* documents the current sender-trust rule and
  must be updated with whatever replaces it.
