description: Dropping a column from a persistent table leaves behind the stored data of every index the drop removed, and leaves the stored data of an index that merely lost one of its columns encoded the old way — so afterwards a lookup through such an index can silently miss rows or return the same row twice.
files:
  - packages/quereus-store/src/common/store-module-alter.ts        # alterDropColumn — the arm missing both the teardown and the rebuild
  - packages/quereus-store/src/common/store-module-index.ts        # dropIndex teardown to mirror; rebuildSecondaryIndexes; tearDownImplicitUniqueIndexStore
  - packages/quereus/src/schema/table.ts                           # shiftSchemaIndicesForDrop (read-only reference — decides removed vs narrowed)
  - packages/quereus-store/test/index-persistence.spec.ts          # provider whose store map makes create/delete observable — new specs go here
  - packages/quereus/test/logic/41.10.1-alter-drop-column-unique-index.sqllogic  # existing DROP COLUMN + index coverage; §3 is the gap
  - docs/module-authoring.md                                       # `dropColumn` per-arm mandate row (~line 877)
difficulty: medium
---

# DROP COLUMN mishandles the physical index stores

`ALTER TABLE … DROP COLUMN` on a `using store` table rewrites the schema correctly
(`shiftSchemaIndicesForDrop`) but does nothing to the physical index stores the rewrite
implies. Two distinct defects, both confirmed by a throwaway repro run against the
observable provider in `index-persistence.spec.ts` (results quoted below). The memory
module is correct in both cases — its index structures live in the base layer and are
rebuilt from the post-drop schema — so this is store-only.

Each secondary index on a store table owns one physical key-value store named
`{schema}.{table}_idx_{indexName}`. An index key is `<index column values> ‖ <PK suffix>`.

## Defect 1 — a removed index's store is never torn down

`shiftSchemaIndicesForDrop` removes an index outright when the dropped column was its
**only** column, or when it is **UNIQUE** and spans the dropped column (narrowing would
claim a constraint the table never declared). `DROP INDEX` tears the store down in that
situation (`StoreModuleIndex.dropIndex` → `releaseIndexStore` + `deleteIndexStore`);
`alterDropColumn` does not, and `reconcileImplicitUniqueIndexStores` — the one generic
teardown pass here — deliberately covers only the hidden `_uc_*` stores backing a plain
UNIQUE constraint.

Observed (`create index ix_b on t (b)`, two rows, `alter table t drop column b`):

```
index_info = []                                    ← schema is right
stores      = [ '__catalog__', 'main.t', 'main.t_idx_ix_b' ]
leaked entries = 2
```

Same for `create unique index ux_bc on t (b, c)` + `drop column b`.

Consequences:

1. **Space is never reclaimed** — on a disk-backed provider the directory stays forever.
2. **A later index of the same name adopts the stale entries.** `createIndex` calls
   `provider.getIndexStore(...)`, which hands back the existing store, and
   `buildIndexEntries` appends. `assertStoreNameFree` does not catch it — it compares
   against *registered schema objects*, and the dropped index is no longer one.
   That produces a **user-visible wrong answer**: a range scan yields each row twice,
   because a stale entry's leading bytes can fall inside the seek window and the row it
   resolves to does satisfy the range predicate.

   ```
   create index ix_b on t (b); insert (1,10,100),(2,20,200);
   alter table t drop column b; create index ix_b on t (c);
     entries               = 4          (expected 2)
     where c = 100         = [{id:1}]              ← EQ seek is fine
     where c > 0 order by id = [{id:1},{id:1},{id:2},{id:2}]   ← WRONG: each row twice
   ```

   An EQ seek stays correct because a stale key whose value byte-equals the row's current
   indexed value *is* the fresh key (same PK suffix) and simply overwrites it; anything
   else lands in a different window and is dropped by `scanIndex`'s `matchesFilters`
   re-check.

3. **UNIQUE enforcement is NOT affected** — this settles the open question the fix ticket
   raised. `findUniqueConflictViaIndex` resolves each entry to its live row and re-compares
   the constrained columns, so a stale entry cannot cause a false rejection; and the fresh
   build plus write-time maintenance still cover every live row, so no real duplicate is
   missed. Verified both directions:

   ```
   insert c = 10  (stale window, no real duplicate) → accepted     ✓
   insert c = 100 (real duplicate)                  → ConstraintError: UNIQUE ✓
   ```

4. **No resurrection on reopen** — the catalog bundle no longer names the index, so
   `rehydrateCatalog` does not bring it back; the orphan store just sits there.

## Defect 2 — a NARROWED surviving index is never re-encoded

A plain multi-column index that loses one of its columns is *narrowed* and survives. Its
key layout changes (one fewer value in the prefix), but `alterDropColumn` never rebuilds
the physical store — unlike `alterPrimaryKeyChange` and the collation arm, which call
`rebuildSecondaryIndexes`. So every pre-existing entry keeps the wide encoding while all
later maintenance uses the narrow one.

```
create index ix_bc on t (b, c); insert (1,10,100),(2,20,200);
alter table t drop column b;
  index_info               = ['ix_bc']         ← survives, correctly
  entries                  = 2                 ← never re-encoded
  plan for `where c = 100`  = INDEXSEEK
  select id from t where c = 100 = []           ← WRONG: row 1 is missing
  delete from t; entries    = 2                 ← permanent orphans
```

This is the more serious of the two: it needs no unusual statement sequence — one
`CREATE INDEX`, one `DROP COLUMN`, one indexed lookup — and the answer is silently
*short*, not merely duplicated. `where c > 0` happened to return both rows in the repro
only because the stale leading bytes (10, 20) also satisfy `> 0`; that is luck, not
soundness.

A surviving index needs re-encoding **iff its column count changed**. A survivor that
keeps every column has its column *indices* shifted but encodes the same *values* in the
same order, so its key bytes are unchanged — which is why the existing coverage passes.

The engine already rejects `DROP COLUMN` when the column is named only by a partial
index's `WHERE` clause (`Cannot drop column 'b' from 't': it is referenced by the WHERE
clause of partial index 'ix_p'`), so a rebuild pass can never meet a predicate naming the
dropped column. And any index whose column set narrowed is necessarily non-UNIQUE (a
UNIQUE one spanning the slot is removed outright), so the rebuild's in-pass duplicate
check is never exercised.

## Sibling arms

Checked: no other `alterTable` arm removes or reshapes an index. `alterRenameColumn`
keeps the index (verified: `index_info = ['ix_b']`, entries intact). `alterColumnChange`
only rewrites per-column collation on the index entries and already rebuilds when the
key bytes move. `alterPrimaryKeyChange` preserves the index list and already calls
`rebuildSecondaryIndexes`. `alterDropColumn` is the only offender.

## Shape of the fix

Both defects fall out of one diff computed at the call site — `oldSchema.indexes`
against the post-shift `shifted.indexes`:

```typescript
const oldIndexes = oldSchema.indexes ?? [];
const survivors = new Map(shifted.indexes.map(ix => [ix.name.toLowerCase(), ix]));
const removed = oldIndexes.filter(ix => !survivors.has(ix.name.toLowerCase()));
const narrowed = oldIndexes
    .map(ix => survivors.get(ix.name.toLowerCase()))
    .filter((now, i) => now !== undefined && now.columns.length !== oldIndexes[i].columns.length);
```

Removed → mirror `dropIndex`'s teardown: `table.releaseIndexStore(name)`, then
`provider.deleteIndexStore(...)` when the provider implements it, else
`closeIndexStore(...)`. That six-line teardown now appears three times
(`createIndex`'s build-failure catch, `dropIndex`, `tearDownImplicitUniqueIndexStore`) —
generalize `tearDownImplicitUniqueIndexStore` into one shared `protected` helper on
`StoreModuleIndex` and route all four call sites through it rather than adding a fourth
copy.

Narrowed → `rebuildSecondaryIndexes(schemaName, tableName, table, {...updatedSchema,
indexes: narrowed}, db.getKeyNormalizerResolver())`. It clears and rebuilds every index in
the schema it is handed, so passing a schema whose `indexes` holds only the narrowed ones
keeps the pass off untouched indexes with no signature change. It must run **after**
`table.migrateRows` (it reads the data store and expects the new column layout) and needs
`db` — which `alterDropColumn` does not currently receive, so thread it in from
`alterTable`.

Ordering / flushing notes for the implementer:

- The arm already calls `ddlCommitPendingOps()` before `migrateRows`, and both
  `migrateRows` and `rebuildSecondaryIndexes` write outside the coordinator, so no
  buffered ops accumulate against the doomed index handles in between — the teardown
  needs no second flush. Say so in a comment; the reason is non-obvious and `dropIndex`
  flushes immediately before its own teardown.
- Put the teardown after `saveTableDDL(updatedSchema)` for the same reason `dropIndex`
  does: the catalog must already be correct so a failed physical delete cannot resurrect
  the index on reopen.
- `reconcileImplicitUniqueIndexStores` still runs after the arm returns and still owns the
  `_uc_*` stores. A `_uc_*` never narrows (a UNIQUE constraint spanning the dropped column
  is removed outright, and a survivor keeps its whole column set), so it must stay out of
  the narrowed-rebuild set.
- Replace the "Pre-existing … tracked by `bug-drop-column-leaks-index-store`" comment
  block in `alterDropColumn` (currently ~lines 262–268) with what the arm now does.

## TODO

- Generalize `StoreModuleIndex.tearDownImplicitUniqueIndexStore` into one shared
  `protected` index-store teardown helper (release handle → `deleteIndexStore` else
  `closeIndexStore`) and route `createIndex`'s failure catch, `dropIndex`, and the implicit
  reconcile through it.
- Thread `db` into `StoreModuleAlter.alterDropColumn` from `alterTable`.
- In `alterDropColumn`, diff `oldSchema.indexes` against `shifted.indexes` to get the
  removed and the narrowed sets.
- Tear down each removed index's physical store, after `saveTableDDL`.
- Rebuild each narrowed index's physical store via `rebuildSecondaryIndexes` over
  `{...updatedSchema, indexes: narrowed}`, after `migrateRows`.
- Rewrite the stale known-leak comment in `alterDropColumn`.
- New specs in `packages/quereus-store/test/index-persistence.spec.ts`, asserting on
  `provider.stores` / `indexStoreSize` (both are already in that file):
  - single-column index collapse → `main.t_idx_ix_b` absent from the store map;
  - UNIQUE index spanning the dropped column → its store absent;
  - same-named `CREATE INDEX` after the drop → entry count equals row count, and
    `select id from t where c > 0` returns each row exactly once;
  - narrowed multi-column index over rows inserted **before** the drop →
    `where c = 100` finds the row, and `delete from t` drains the index store to 0;
  - close → reopen after a drop → index still absent from `index_info` and its store still
    absent from the map (no resurrection from a leaked store).
- Extend `packages/quereus/test/logic/41.10.1-alter-drop-column-unique-index.sqllogic` §3
  (or add `41.10.2-…`) with rows inserted **before** the `DROP COLUMN`, so the
  missing-row and duplicate-row answers are covered module-agnostically under both
  `yarn test` and `yarn test:store`. §3 today inserts only after the drop, which is why it
  passes.
- Update the `dropColumn` row of the per-arm mandate table in `docs/module-authoring.md`:
  it documents `removedUniqueConstraints` for tearing down UNIQUE-backed structures but
  says nothing about a module's obligation to tear down the physical structure of an index
  the drop **removed**, nor to re-encode one it **narrowed**.
- Validate with `yarn test`, `yarn workspace @quereus/store test`, and `yarn test:store`
  (the store-module ALTER paths only run under the last one).
