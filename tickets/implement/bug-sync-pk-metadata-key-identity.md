---
description: When a table's primary key can be spelled more than one way for the same row (upper vs lower case under a case-insensitive key, or "1 hour" vs "60 minutes" for a duration), the sync engine files its bookkeeping under each spelling separately, so two copies of one row drift apart forever and a deleted row can come back.
files:
  - packages/quereus-sync/src/metadata/keys.ts              # encodePK + every cv:/tb:/cl:/qt: key builder and parser
  - packages/quereus-sync/src/metadata/column-version.ts    # cv: record value format (needs the raw pk)
  - packages/quereus-sync/src/metadata/tombstones.ts        # tb: record value format (needs the raw pk); getAllTombstones
  - packages/quereus-sync/src/metadata/change-log.ts        # cl: entries — empty values, all info in the key
  - packages/quereus-sync/src/sync/sync-context.ts          # SyncContext — where a per-table keying accessor belongs
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # getTableSchema oracle; resolveLogEntry; recordDataEvent
  - packages/quereus-sync/src/sync/change-applicator.ts     # deleteKey/columnKey in-batch collapse keys
  - packages/quereus-sync/src/sync/store-adapter.ts         # groupChangesByRow (line ~334) raw JSON.stringify(pk)
  - packages/quereus-sync/src/sync/snapshot.ts              # rowKey grouping from parsed keys
  - packages/quereus-sync/src/sync/snapshot-stream.ts       # streamed versionKey `${encodePK(pk)}:${column}`
  - packages/quereus-store/src/common/store-table.ts        # resolvePkKeyCollations / resolvePkKeyTransforms (reuse these)
  - packages/quereus/src/util/key-serializer.ts             # serializeKeyNullGrouping — the type-tagged identity encoder
  - packages/quereus/src/util/comparison.ts                 # semanticKeyTransform
  - packages/quereus-sync/test/sync/_peer-harness.ts        # makePeer/relay/localWrite — the repro harness
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts        # hardcodes JSON.stringify(pk) as the version key
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts        # same
  - docs/sync.md
difficulty: hard
---

# Sync must key its per-row bookkeeping by the database's row identity

## Reproduced

All five scenarios below fail on `main` today. Full spec source is in
*Reproducing test* at the bottom — drop it in as
`packages/quereus-sync/test/sync/pk-key-identity.spec.ts` and it fails before
the fix, passes after.

| Scenario | Observed |
|---|---|
| `k text collate nocase primary key`, row rewritten `'apple'` → `'APPLE'` | change log carries **2** pk identities for 1 row |
| same, then a later delete on the peer | delete relays, then the earlier write **resurrects** the row on that peer — the two replicas permanently disagree |
| concurrent insert of `'apple'` on A and `'APPLE'` on B | peers **never converge**: A keeps `apple/fromA`, B keeps `APPLE/fromB`, repeated relays do not fix it |
| `d timespan primary key`, `'PT1H'` on A vs `'PT60M'` on B | same permanent divergence |
| same, delete under one spelling vs stale write under the other | same resurrection |

Plus one adjacent defect found while reproducing (same function, same fix):

> `insert into t values (9007199254740993, 'x')` on an `integer primary key`
> table throws `TypeError: Do not know how to serialize a BigInt` inside
> `encodePK`. The throw happens in the post-commit local-change capture, which
> logs and swallows it — so the row commits locally and **silently never
> replicates**. `JSON.stringify` cannot encode a `bigint`, and the engine hands
> sync a `bigint` for any integer outside the double-safe range.

## Root cause

`encodePK` (`packages/quereus-sync/src/metadata/keys.ts`) is
`JSON.stringify(pk)` over the raw values. That string is the pk component of
every per-row sync record:

```
cv:{schema}.{table}:{pk}:{column}    per-column version stamp (decides conflicts)
tb:{schema}.{table}:{pk}             tombstone (records a delete)
cl:{hlc}{type}{schema}.{table}:{pk}[:{column}]   HLC-ordered index over the above
qt:{schema}.{table}:{hlc}{type}:{pk}[:{column}]  quarantined out-of-basis change
```

Everywhere else in the engine, "same row?" is decided after two per-column
normalizations:

- the column's **key collation** — under `collate nocase`, `'apple'` and
  `'APPLE'` are one key. Resolved by `resolvePkKeyCollations` in
  `packages/quereus-store/src/common/store-table.ts`, whose names feed the
  key-normalizer resolver from `db.getKeyNormalizerResolver()`.
- the column's **semantic key transform** — `semanticKeyTransform` in
  `packages/quereus/src/util/comparison.ts`, i.e. the logical type's `groupKey`.
  Today that is TIMESPAN → total seconds, so `'PT1H'` and `'PT60M'` are one key.
  Resolved per pk column by `resolvePkKeyTransforms`.

The store, the in-memory backend, and the isolation layer all follow that rule.
Sync does not, so one row files under N identities and the conflict resolver,
the tombstone gate (`isDeletedAndBlocking`), and the delete cleanup all miss.

The same raw encoding also leaks into three in-memory grouping keys, which split
one row into two groups inside a single batch:

- `deleteKey` / `columnKey` — `change-applicator.ts:722,727`
- `groupChangesByRow` — `store-adapter.ts:334` (raw `JSON.stringify(change.pk)`)

## The design constraint that shapes the fix

The normalization is **lossy and not invertible**, but sync currently recovers
the pk *out of the key*: `parseColumnVersionKey`, `parseTombstoneKey`,
`parseChangeLogKey`, and `TombstoneStore.getAllTombstones` all `decodePK` the
key, and the recovered values become `Change.pk` on the wire. A receiver uses
that pk to address the row, and `mergeColumnUpdates`
(`store-adapter.ts:606-608`) seeds a fresh partial row's pk cells from it.

So the pk cannot simply be replaced by its normalized form: for TIMESPAN the
normalized value is a *number of seconds*, which is not a valid timespan pk.

Split the two roles:

- **Identity** — what a record is filed under. Derived, type-tagged, never
  decoded back.
- **Address** — what goes on the wire. Must stay a real, type-valid `SqlValue[]`.
  Any spelling from the equivalence class is acceptable (the receiver's store
  collapses spellings too, and where the pk column is itself versioned, its
  column change carries the exact spelling and overwrites the seeded cell).

Since identity can no longer be read back out of the key, the raw pk must live
in the record **value**.

## Recommended shape

**Identity encoder.** In `keys.ts`, replace `encodePK` with

```ts
/** Per-pk-column normalization for one table, resolved once from its schema. */
export interface PkKeying {
  readonly normalizers: ReadonlyArray<(s: string) => string>;
  readonly transforms: ReadonlyArray<((v: SqlValue) => SqlValue) | undefined>;
}

export function encodePkIdentity(pk: SqlValue[], keying: PkKeying): string;
```

Implementation: apply `transforms[i]` to each value, then run the result through
the engine's `serializeKeyNullGrouping(values, normalizers)`
(`packages/quereus/src/util/key-serializer.ts`). Use the *null-grouping* variant,
not `serializeKey` — the latter returns `null` for a NULL member and there is no
sensible key for that here. Its type tags also fix the bigint defect for free:
`canonicalNumeric` renders `5n` and `5` alike as `n:5`, matching the engine's
numeric-storage-class equality.

**Keying resolver.** New `packages/quereus-sync/src/metadata/pk-identity.ts`:
resolve a table's `PkKeying` from its `TableSchema` via `resolvePkKeyCollations`
+ `resolvePkKeyTransforms` (both exported from `@quereus/store`, already a
dependency) and the connection's `db.getKeyNormalizerResolver()`. Cache per
`(schema, table)` and invalidate when replicated DDL changes the table.

`SyncManagerImpl` already carries the `getTableSchema` oracle (used by
`isTableInBasis` / `getTableColumnNames`), so the schema is reachable; expose the
keying through `SyncContext` and thread it to every key-builder call site.

**When the schema is unavailable** (no oracle wired, or the table is out of
basis) there is no sound identity — and silently falling back to raw values is
the trap, because the identity would *flip* the moment the schema appears,
orphaning everything already filed. Recommend: **throw** for `cv:`/`tb:`/`cl:`.
`qt:` (quarantine) is the out-of-basis path and needs no identity at all — its
keys are never parsed back and its `(hlc, type)` component already makes them
unique — so leave it on a raw encoding, but switch it off `JSON.stringify` so a
bigint pk cannot throw there either.

**Raw pk in the record value.**

- `ColumnVersion` gains `pk: SqlValue[]`; add it to the JSON payload
  (`SerializedColumnVersionPayload`) through the existing `encodeSqlValue`, which
  already handles `Uint8Array`/`bigint`.
- `Tombstone` gains `pk: SqlValue[]` (it already carries an optional `priorRow`,
  so the serializer has the shape for it). Note `priorRow` is explicitly
  best-effort/absent in cases — the pk must be **unconditional**, not derived
  from it.
- `cl:` values stay empty. `resolveLogEntry`
  (`sync-manager-impl.ts:1011`) already re-reads the `cv:`/`tb:` record it points
  at and takes the authoritative HLC and value from there — take the pk from
  there too. Verify no other `cl:` consumer needs a pk straight from the key.
- The three parse functions (`parseColumnVersionKey`, `parseTombstoneKey`,
  `parseChangeLogKey`) can no longer return `pk`. Return the identity string
  instead and make each caller take the pk from the record value. `snapshot.ts`
  and `snapshot-stream.ts` are the affected readers; note `getSnapshot` already
  builds its rows from column *values*, not from the parsed pk, so only the
  grouping key and the shipped tombstone pk change.

**Wire format.** The streamed/snapshot `versionKey` is
`` `${encodePK(pk)}:${column}` `` — it becomes
`` `${identity}:${column}` ``. Two specs hardcode the old spelling and must be
updated in step: `snapshot-bootstrap.spec.ts` (`cvEntry`, ~line 50) and
`store-adapter-seam.spec.ts` (`'["k"]:v'`, ~line 575).

**Migration.** Every `cv:`/`tb:`/`cl:` key changes shape for every table, and old
record values carry no pk, so old metadata becomes unreadable. AGENTS.md says
backwards compatibility is not yet a concern, so the recommended default is:
**do not write a rewrite pass** — bump a stored sync-metadata format version, and
on mismatch require the replica to re-bootstrap from a peer snapshot. Document
that in `docs/sync.md`. Confirm with the dev before choosing otherwise; if a
rewrite pass is wanted instead, note that it is self-supplying (the *old* keys
still carry the raw pk, so one scan can recompute the new key and embed the pk in
the value) but it must run before any other metadata access at
`SyncManagerImpl.create`.

## Out of scope

`parseColumnVersionKey`'s last-colon split still mis-parses a column name
containing `:` — pre-existing, tracked as
`bug-sync-colon-in-column-name-drops-cell`. Do not fold it in, but do not make it
worse: the identity string must not itself contain a `:`
(`serializeKeyNullGrouping` uses `\0` as its member separator and `s:`/`n:`/`x:`/`o:`
type tags, so an identity *does* contain `:` — pick a key layout that keeps the
pk/column split unambiguous, e.g. keep using `buildColumnVersionRowPrefix`
stripping wherever the pk is known, and consider length-prefixing or a separator
that cannot occur in the identity).

## TODO

Phase 1 — pin the bug

- Add `packages/quereus-sync/test/sync/pk-key-identity.spec.ts` from *Reproducing test* below; confirm all five cases fail.
- Add the bigint case: `create table t (id integer primary key, v text) using store`, `insert into t values (9007199254740993, 'x')`, relay — the row must arrive on the peer. Confirm it fails with `Do not know how to serialize a BigInt` swallowed into a `[Sync] Error handling transaction commit` log.

Phase 2 — identity encoder and resolver

- Add `PkKeying` + `encodePkIdentity` to `metadata/keys.ts`, built on `serializeKeyNullGrouping`.
- Add `metadata/pk-identity.ts`: resolve `PkKeying` from a `TableSchema` via `resolvePkKeyCollations` / `resolvePkKeyTransforms` / `db.getKeyNormalizerResolver()`, cached per table with DDL invalidation.
- Expose the keying on `SyncContext`; decide and implement the no-schema behaviour (recommended: throw for `cv:`/`tb:`/`cl:`; raw, non-JSON encoding for `qt:`).

Phase 3 — carry the raw pk in record values

- Add `pk` to `ColumnVersion` and its serialized payload; update `ColumnVersionStore` writers.
- Add `pk` to `Tombstone` and its serializer; update `TombstoneStore` writers and `getAllTombstones` (which currently slices the pk out of the key by hand).
- Switch `resolveLogEntry` to take `Change.pk` from the resolved record.

Phase 4 — switch every key site

- Thread `PkKeying` through `buildColumnVersionKey`, `buildTombstoneKey`, `buildColumnVersionRowPrefix`, `buildColumnVersionScanBounds`, `buildChangeLogKey`, `ChangeLogStore.deleteEntryBatch`.
- Change the parse functions to return the identity instead of a pk; fix `snapshot.ts` (`rowKey`) and `snapshot-stream.ts` (`versionKey`).
- Fix the three in-memory grouping keys: `deleteKey` / `columnKey` (`change-applicator.ts`) and `groupChangesByRow` (`store-adapter.ts:334`).
- Update the two specs that hardcode `JSON.stringify(pk)` as the version key.
- Decide `encodePK` / `decodePK`'s fate in the public surface (`src/index.ts:221`).

Phase 5 — format version and docs

- Add the sync-metadata format version record and the mismatch behaviour agreed in *Migration*.
- Update `docs/sync.md`: the key layouts, the identity-vs-address split, and what a format-version mismatch means for an existing replica.

Phase 6 — validate

- `yarn workspace @quereus/sync test` — all five repro cases plus the bigint case pass.
- `yarn test` and `yarn build` clean.
- Spot-check `packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts` still passes — it pins the adapter's *store-side* keying and must not regress.

## Reproducing test

```ts
import { expect } from 'chai';
import { makePeer, closePeer, localWrite, relay, collect, changesFor, type Peer } from './_peer-harness.js';

describe('sync pk identity honours key collation and semantic key transforms', () => {
	let a: Peer;
	let b: Peer;

	const setup = async (ddl: string) => {
		a = await makePeer('A');
		b = await makePeer('B');
		await a.db.exec(ddl);
		await b.db.exec(ddl);
	};

	afterEach(async () => {
		await closePeer(a);
		await closePeer(b);
	});

	it('nocase: one row files under one pk identity', async () => {
		await setup(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'v1')`);
		await localWrite(a, `update t set k = 'APPLE', v = 'v2' where k = 'apple'`);

		const changes = await changesFor(a, b.manager.getSiteId());
		const pkSpellings = new Set(changes.map(c => JSON.stringify(c.pk)));
		expect([...pkSpellings], 'one row => one pk identity').to.have.length(1);
	});

	it('nocase: a delete under one spelling blocks a stale write under the other', async () => {
		await setup(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'v1')`);
		await relay(a, b);
		await localWrite(a, `update t set k = 'APPLE', v = 'v2' where k = 'apple'`);
		await localWrite(b, `delete from t where k = 'apple'`);

		await relay(b, a);
		expect(await collect(a.db, `select k from t`), 'delete wins on A').to.deep.equal([]);
		await relay(a, b);
		expect(await collect(b.db, `select k from t`), 'later delete not undone').to.deep.equal([]);
	});

	it('nocase: concurrent insert of one row under two spellings converges', async () => {
		await setup(`create table t (k text collate nocase primary key, v text) using store`);
		await localWrite(a, `insert into t values ('apple', 'fromA')`);
		await localWrite(b, `insert into t values ('APPLE', 'fromB')`);

		await relay(a, b);
		await relay(b, a);
		await relay(a, b);
		await relay(b, a);

		expect(await collect(a.db, `select k, v from t`), 'peers converge')
			.to.deep.equal(await collect(b.db, `select k, v from t`));
	});

	it('timespan: concurrent insert under two equal-elapsed spellings converges', async () => {
		await setup(`create table t (d timespan primary key, v text) using store`);
		await localWrite(a, `insert into t values ('PT1H', 'fromA')`);
		await localWrite(b, `insert into t values ('PT60M', 'fromB')`);

		await relay(a, b);
		await relay(b, a);
		await relay(a, b);
		await relay(b, a);

		expect(await collect(a.db, `select d, v from t`), 'peers converge')
			.to.deep.equal(await collect(b.db, `select d, v from t`));
	});

	it('timespan: a delete under one spelling blocks a stale write under the other', async () => {
		await setup(`create table t (d timespan primary key, v text) using store`);
		await localWrite(a, `insert into t values ('PT1H', 'v1')`);
		await relay(a, b);
		await localWrite(a, `update t set d = 'PT60M', v = 'v2' where d = 'PT1H'`);
		await localWrite(b, `delete from t where d = 'PT1H'`);

		await relay(b, a);
		expect(await collect(a.db, `select d from t`), 'delete wins on A').to.deep.equal([]);
		await relay(a, b);
		expect(await collect(b.db, `select d from t`), 'later delete not undone').to.deep.equal([]);
	});
});
```

Failure output on `main` (abridged):

```
nocase: one row files under one pk identity
  one row => one pk identity: expected 2 to equal 1
  A changes: [{"pk":["apple"],"col":"k"},{"pk":["apple"],"col":"v"},
              {"pk":["APPLE"],"col":"k"},{"pk":["APPLE"],"col":"v"}]

nocase: concurrent insert of one row under two spellings converges
  peers converge: A=[{k:"apple",v:"fromA"}]  B=[{k:"APPLE",v:"fromB"}]

timespan: concurrent insert under two equal-elapsed spellings converges
  peers converge: A=[{d:"PT1H",v:"fromA"}]   B=[{d:"PT60M",v:"fromB"}]
```
