---
description: Filling in the empty values of a column that is part of a table's row identity is handled as if the identity could not change — so rows silently merge, deleted rows come back, and on the persistent backend rows become invisible to lookups and can be duplicated.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts (`validateAlterColumnPlan` ~2629 — the arm that skips the primary-key check; `validateRekeyedPrimaryKey` ~3601 and its two `assertNoPrimaryKeyCollisionIn*` helpers ~3651/~3682; the stale `NOTE:` ~2620-2627)
  - packages/quereus/src/vtab/memory/layer/alter-column.ts (`planTightenNotNull` ~201, `buildAlterColumnPlan` ~306 — where `pkColumnRekeyed` is computed)
  - packages/quereus/src/vtab/memory/layer/transaction.ts (`convertColumn` ~583 — replays staged deletions under their OLD key; stale doc ~557-561)
  - packages/quereus-store/src/common/store-module-alter-column.ts (`alterColumnChange` ~150-290 — `pkRekeyNeeded` ~196, the deferred `valueConvert` block ~255, and the `NOTE:` ~244-254 that prescribes the reordering)
  - packages/quereus-store/src/common/store-table.ts (`mapRowsAtIndex` ~98 — payload-only rewrite; `validateRekeyedPrimaryKey` ~186; `rekeyRows` ~269)
  - packages/quereus-isolation/src/alter-migration.ts (`derivePkRekey` ~385 — gated on `setCollation` only; `validateOverlayMigration` ~483 — early `return`s make the arms exclusive; `forwardAlterColumnToOverlay` ~765; `backfillStagedNotNull` ~925)
  - packages/quereus/test/logic/41.2-alter-column.sqllogic, 41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic (nearest patterns to copy for the new cases)
  - packages/quereus/test/logic.spec.ts (~55-73 — the store-skip list, if any new case must be memory-only)
  - docs/schema.md (§ "Primary-key nullability")
difficulty: hard
repro: verified
---

# `alter column … set not null` must treat a key column's backfill as a re-key

## What is wrong, in plain terms

A table that declares no `primary key` still has a row identity: Quereus uses all of its
columns. Those columns are allowed to hold empty (NULL) values.

```sql
create table t (x integer null default 0, y integer null);
insert into t (x, y) values (null, 1), (0, 1);   -- two different rows today
alter table t alter column x set not null;        -- fills the NULL from `default 0`
```

After the backfill both rows read `(0, 1)` — they have become the same row identity. Every
backend handles the value rewrite as if the identity were untouched, so nothing notices.

## Observed behaviour on `main` (all verified, not inferred)

Reproduced with a throwaway mocha spec against both backends; the spec was deleted after the
run, and the cases below are what the new `.sqllogic` coverage must pin.

### Memory backend (`yarn test`)

| case | result |
| --- | --- |
| two committed rows collide after backfill | **`alter` succeeds, one row silently disappears.** `select count(*)` → 1 |
| one committed + one pending-insert row collide | same silent loss, survives `commit` |
| two NULL rows, transaction deletes one, then alters | **the deleted row comes back.** In-transaction scan before the ALTER: 1 row. After the ALTER: 2 rows, the deleted one resurrected with the backfilled value. `commit` persists it |
| backfill on a key column with no collision | correct — keys follow the values |
| the same column under a *secondary* `unique` instead | correctly refused: `UNIQUE constraint failed: t (x)` |

That last row is the tell: the primary key is the one structure on this path that is never
re-validated. A `unique` constraint over the identical column already rejects.

### Store backend (LevelDB via `createIsolatedStoreModule`)

The store is broken **even when nothing collides**, because its backfill
(`StoreTable.mapRowsAtIndex`) rewrites the row payload and reuses the stored key verbatim.
On a key column the key bytes keep encoding the old NULL:

```sql
create table t (x integer null default 7, y integer null);
insert into t (x, y) values (null, 1), (3, 1);
alter table t alter column x set not null;

select x, y from t;                            -- (7,1), (3,1)   ← scan sees the backfill
select x, y from t where x = 7 and y = 1;      -- []             ← key seek finds nothing
delete from t where x = 7 and y = 1;           -- reports ok, deletes nothing
insert into t (x, y) values (7, 1);            -- accepted → two identical (7,1) rows
```

With a collision the store keeps both rows carrying equal identity values (a genuine
duplicate primary key on disk), a seek finds one of them, and a delete removes one and
leaves the other. Backfilling a **non-key** column on the store is correct.

### Isolation overlay

`createIsolatedStoreModule` staging an insert that collides with a committed row: the
in-transaction scan reports one row, and after `commit` there are two. The overlay's
`backfillStagedNotNull` rewrites a staged row's key column through an ordinary update while
`derivePkRekey` — the machinery that already refuses two staged rows landing on one key —
returns `undefined` for anything that is not `set collate`.

## The two `NOTE:`s that predicted this

`packages/quereus/src/vtab/memory/layer/manager.ts` ~2620 asserts the premise "the engine
enforces NOT NULL on every PK member regardless of the declared nullability" and warns that
if it ever stops holding, the backfill arm needs `validateRekeyedPrimaryKey`. The premise is
already false — the engine promotes only *declared* key columns, so an all-columns key
leaves its columns nullable. `packages/quereus-store/src/common/store-module-alter-column.ts`
~244 states that `valueConvert` and `pkRekeyNeeded` cannot both be set and that if that ever
changes, the value rewrite must move in front of the re-key block. Both notes are now due.

## Which fix — decided, do not re-litigate

**Validate and re-key (the notes' own prescription), not a blanket refusal.**

The alternative considered was refusing `set not null` on any key column outright, mirroring
the existing `drop not null` refusal at `runtime/emit/alter-table.ts` ~1469. Rejected:

- The non-colliding backfill on a key column is a legitimate operation that works correctly
  on the memory backend today (verified above). A blanket refusal is a regression.
- Tightening a nullable identity column back to `not null` is the natural migration step
  that `feat-relax-declared-primary-key-not-null` opens up for *every* table. Forbidding it
  would leave that feature with no way back.
- The machinery already exists in all three legs and is merely gated on `set collate`. The
  error shape, the statuses, and the messages are all settled precedent.

So: a backfill that would collapse two rows the transaction can see is refused with the
existing `CONSTRAINT` message naming the key; a backfill that would collapse two committed
rows a rollback must restore is refused with the existing `BUSY` message; anything else
proceeds and physically re-keys.

## Design, per leg

### Memory

`validateAlterColumnPlan` currently runs `validateRekeyedPrimaryKey` only on the
`structuresRekeyed` arm. Run it on the `rewrite` arm too, whenever the altered column is a
primary-key member, probing the **converted** rows — the same
`convertRowAtIndex(row, colIndex, convert, convertNulls)` mapping the sibling
`validateRekeyedUniqueStructures` call already passes. That needs an optional row mapper
threaded into `validateRekeyedPrimaryKey` and both of its arms
(`assertNoPrimaryKeyCollisionInRows`, `assertNoPrimaryKeyCollisionInLayer`) — the layer arm
matters as much as the row arm, because the base rebuild is what merges committed rows.

No new physical re-key is needed here. `BaseLayer.rebuildPrimaryTreeFromRows` and
`TransactionLayer.installNetOwnWrites` both derive keys from the row via
`pkFunctions.extractFromRow`, so on the accepted path keys already follow the backfilled
values (verified). What *is* needed is the staged-deletion fix below.

`TransactionLayer.convertColumn` collects `survivingDeletions` as `write.primaryKey` — the
key recorded when the delete was staged, still encoding the pre-backfill NULL — and replays
them into a tree rebuilt over an already-converted parent, where that key no longer exists.
The deletion lands nowhere and the row resurrects. When the rewrite touches a key column the
deletion key must be recomputed from the row the delete removed, under the post-backfill
values. `netOwnWriteEffects` yields the write alongside its effective row, so the converted
key is derivable at the same point the upserts are converted; confirm what a deletion's entry
carries there before choosing the mechanism. Its doc block (~557-561) claims the key bytes are
unchanged and that no key can collapse onto another — rewrite both sentences to state the new
precondition (collisions refused upstream) rather than the false premise.

### Store

Two changes, in this order:

- Extend the pre-mutation validation. `StoreTable.validateRekeyedPrimaryKey` takes an
  `effectiveRows` stream for pass 1 and re-reads the committed store itself for pass 2. Pass 1
  can be fed `convertRowsAtIndex(...)` (already imported in the caller), but pass 2 would
  compare *un*-backfilled committed values and miss exactly the collision that matters — give
  it an optional per-row mapper applied by both probes, so the guarantee "every refusal
  happens before any store mutation" survives.
- Make the backfill actually re-key. Widen `pkRekeyNeeded` to include a `valueConvert` whose
  column is a key member, and move the `valueConvert` block **in front of** the
  `pkRekeyNeeded` block, as the `NOTE:` at ~244 instructs. `rekeyRows` recomputes each key
  from the stored row, so running it after `mapRowsAtIndex` produces the right bytes with no
  change to `rekeyRows` itself. Check the index rebuild is not run twice once both blocks can
  fire for one statement.

### Isolation overlay

`derivePkRekey` must also fire for `setNotNull: true` on a key member with a usable default,
with a `keyOf` that serializes the *backfilled* tuple (null → the folded default at
`colIndex`). Then the existing group logic does the rest: `validateOverlayMigration` refuses
two live staged rows on one post-backfill key, and `dropCollapsedPkRekeyMarkers` discards a
deletion marker collapsing onto a live row.

Two structural obstacles to plan around:

- `validateOverlayMigration`'s arms `return` early, so the `setNotNull`-with-default case
  never reaches the `pkRekey` block. The tightening arm has to fall through instead.
- `forwardAlterColumnToOverlay` returns immediately for any `setNotNull` change, so the
  marker-drop step is unreachable on this path. It needs to run the drop before
  `backfillStagedNotNull`.

The collision message on this leg says "under new collation" — generalize the wording, since
the same code now reports a backfill collapse.

## Cross-backend agreement

The two backends must accept and reject the same statements with the same status. Once the
store re-keys, its behaviour matches memory's on every case above, so the new coverage should
be plain `.sqllogic` (running under both `yarn test` and `yarn test:store`) rather than
`-memory` / `-store` variants. Only add a skip entry in `test/logic.spec.ts` if a case
genuinely cannot agree, and say why in the entry, as the neighbours do.

## TODO

### Phase 1 — memory

- Thread an optional per-row mapper through `validateRekeyedPrimaryKey` and both of its arms.
- Call it from `validateAlterColumnPlan`'s `rewrite` arm when the altered column is a key
  member, with the same converted-row mapping the unique-structure probe uses.
- Fix `TransactionLayer.convertColumn` to recompute staged deletion keys from post-backfill
  values when the rewrite touches a key column.
- Replace the false premise in the `NOTE:` at `manager.ts` ~2620-2627 and in `convertColumn`'s
  doc ~557-561 with what now holds.

### Phase 2 — store

- Give `StoreTable.validateRekeyedPrimaryKey` an optional row mapper used by both probes.
- Call it from the backfill path with the null → default mapping, before any mutation.
- Widen `pkRekeyNeeded` to cover a key-member `valueConvert`; move the `valueConvert` block
  ahead of the re-key block per the existing `NOTE:`; drop or update that `NOTE:`.
- Verify the secondary-index rebuild runs exactly once when both blocks fire.

### Phase 3 — isolation overlay

- Make `derivePkRekey` cover the `set not null` backfill on a key member, serializing the
  backfilled tuple.
- Let `validateOverlayMigration`'s tightening arm fall through to the collision check.
- Run the marker drop before `backfillStagedNotNull` in `forwardAlterColumnToOverlay`.
- Generalize the "under new collation" message.

### Phase 4 — coverage and docs

- New `.sqllogic` cases, cross-backend, pinning: committed/committed collision refused with
  `CONSTRAINT`; staged/committed collision refused; a collision only among rows the
  transaction has deleted refused with `BUSY`; a staged delete that removes the collision
  accepted; a non-colliding key-column backfill accepted **and still findable by an equality
  lookup and deletable** (the store's silent-failure case); non-key backfill unchanged.
- Pin the resurrection case: two NULL rows, one staged-deleted, then the ALTER — the deleted
  row must stay deleted through `commit`.
- Update `docs/schema.md` § "Primary-key nullability" with what `set not null` on a key column
  now does.
- `yarn build`, `yarn lint`, `yarn test`, `yarn test:store` all green before handing off.
