---
description: The sync engine files its per-row bookkeeping under the exact spelling of a row's primary key, so re-saving a row under an equivalent spelling of the same key can make sync treat one row as two — losing a conflict resolution or resurrecting a deleted row.
files:
  - packages/quereus-sync/src/metadata/keys.ts             # encodePK / decodePK, cv: and tb: key builders
  - packages/quereus-sync/src/sync/store-adapter.ts        # where PK values enter sync from the store
  - packages/quereus/src/util/key-serializer.ts            # serializeKey + key normalizers (the engine's identity encoder)
  - packages/quereus/src/util/comparison.ts                # semanticKeyTransform
  - packages/quereus-store/src/common/store-table.ts       # resolvePkKeyCollations / resolvePkKeyTransforms (the storage-side rule)
difficulty: medium
---

# Sync's per-row metadata keys use raw values, not the engine's key identity

## Background

Everywhere else in the engine, "is this the same row?" is answered by running each
primary-key value through two normalizations before comparing:

- the column's **key collation** — under `collate nocase`, `'apple'` and `'APPLE'`
  are one key;
- the column's **semantic key transform** — for a duration column, `'PT1H'` and
  `'PT60M'` are one key (both are 60 minutes).

The in-memory backend, the persistent store, and the transaction isolation layer all
follow this rule.

`quereus-sync` does not. `encodePK` in `packages/quereus-sync/src/metadata/keys.ts` is
literally `JSON.stringify(pk)` on the raw values, and that string is what identifies a
row in sync's two per-row bookkeeping records:

- `cv:<schema>.<table>:<pk>:<column>` — the per-column version stamp that decides which
  side wins a conflict;
- `tb:<schema>.<table>:<pk>` — the tombstone that records a delete.

## Expected problem

Two writes to what the database considers one row can be filed under two different
sync identities. Believed reachable two ways:

- `create table t (k text collate nocase primary key, ...)` — write via `'apple'`,
  update via `'APPLE'`.
- `create table t (d timespan primary key, ...)` — write via `'PT1H'`, update via
  `'PT60M'`. (This one became reachable when the persistent store started collapsing
  equal-elapsed spellings onto one physical row.)

Consequences to check for, in rough order of severity: a delete that fails to
replicate because the peer's tombstone is filed under the other spelling; a conflict
resolved against a stale column version because the newer stamp is under the other
spelling; unbounded metadata growth as spellings accumulate.

## Not yet reproduced

This was found by reading, during review of `duration-json-semantic-ordering-store`
(whose handoff explicitly listed sync as unexamined). All sync tests pass today, which
is consistent with no test using a collated or duration primary key. First task is to
write the failing test — two peers, a collated text primary key, an update issued under
a different case — and confirm the symptom before changing anything.

## Expected behavior

Sync's row identity must match the database's: a row addressed by any equivalent
spelling of its primary key resolves to one sync identity, one tombstone, and one set
of column versions. The engine already exports the pieces (`serializeKey` with the
per-column key normalizers, plus `semanticKeyTransform`); the question the fix needs to
answer is how existing metadata keys migrate, or whether they can simply be re-derived.
