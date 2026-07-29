description: When a column is dropped from a persistent table, any index that existed only for that column stops being listed in the schema but its stored data is never deleted, so the space is never reclaimed and a later index created with the same name silently inherits the leftover data.
files:
  - packages/quereus-store/src/common/store-module-alter.ts   # alterDropColumn — the arm missing the teardown
  - packages/quereus-store/src/common/store-module-index.ts    # dropIndex (has the correct teardown to mirror), reconcileImplicitUniqueIndexStores, createIndex/assertStoreNameFree
  - packages/quereus/src/schema/table.ts                       # shiftSchemaIndicesForDrop — decides which indexes disappear
  - packages/quereus-store/test/index-persistence.spec.ts      # existing spec with a provider that makes store create/delete observable
difficulty: medium
---

# DROP COLUMN leaves a removed index's backing store behind

## What happens

Each secondary index on a `using store` table owns its own physical key-value store,
named `{schema}.{table}_idx_{indexName}`. `DROP INDEX` tears that store down explicitly
(`StoreModuleIndex.dropIndex` → `provider.deleteIndexStore`).

`ALTER TABLE … DROP COLUMN` can also make an index disappear, and in that path nothing
tears the store down:

- an index whose **only** column is the one being dropped (`create index ix_b on t (b)`,
  then `drop column b`) — the index collapses to zero columns and is removed;
- a **UNIQUE** index that *spans* the dropped column (`create unique index ux_bc on t (b, c)`,
  then `drop column b`) — removed outright, because narrowing it would claim a constraint
  the table never declared.

In both cases the table's schema, the regenerated DDL, and `index_info` all correctly stop
naming the index — but the physical store stays. `reconcileImplicitUniqueIndexStores`, the
one generic teardown pass in this area, only covers the hidden `_uc_*` stores that back a
plain UNIQUE constraint; it deliberately skips anything with `derivedFromIndex` set, so a
user-created index is outside its remit.

Reproduced (confirmed manually, not yet as a committed test) with the observable-provider
pattern from `packages/quereus-store/test/index-persistence.spec.ts`: after
`create index ix_b on t2 (b)` + `alter table t2 drop column b`, `index_info` returns no rows
while `main.t2_idx_ix_b` is still in the provider's store map.

## Why it matters

1. **Space is never reclaimed.** On a real disk-backed provider the directory and its
   contents stay forever — the table is smaller but its storage footprint is not.
2. **A later index of the same name adopts the stale data.** `createIndex` calls
   `provider.getIndexStore(schema, table, name)`, which hands back the existing store rather
   than a fresh one, and `buildIndexEntries` appends to it. So
   `create index ix_b on t2 (b)` → `drop column b` → `create index ix_b on t2 (c)` builds a
   new index on top of entries keyed under the old column layout. The name collision is not
   caught: `assertStoreNameFree` compares against *registered schema objects*, and the
   dropped index is no longer one.

   Whether those stale entries produce user-visible wrong answers is the open question this
   ticket should settle first. Index reads resolve each entry back to its live row and drop
   entries that no longer match (see the entry-resolution note in `buildIndexEntries`), which
   plausibly masks the corruption on a plain index. A **UNIQUE** index is the case to prove or
   disprove: `StoreTable.findUniqueConflictViaIndex` trusts the index to describe live rows,
   so a stale entry could reject an insert that has no real duplicate.

## Expected behavior

`DROP COLUMN` should treat an index it removes the same way `DROP INDEX` does: flush pending
ops, release the cached index-store handle, and delete (or, absent `deleteIndexStore`, close)
the physical store — so the storage is reclaimed and a same-named `CREATE INDEX` afterwards
starts from an empty store.

The set of removed indexes is derivable at the call site: the names in `oldSchema.indexes`
that are absent from the post-shift `indexes` returned by `shiftSchemaIndicesForDrop`.

Worth checking the sibling ALTER arms for the same omission while in here — any arm that can
make an index disappear owes the same teardown.

## Scope notes

- The memory module has no equivalent leak to fix: its index structures live in the base
  layer and are rebuilt from the post-drop schema, so an index missing from that schema simply
  ceases to exist.
- Pre-existing: the single-column-collapse half predates the shared `shiftSchemaIndicesForDrop`
  helper; the UNIQUE-spanning half was added by
  `debt-share-drop-column-renumbering`'s review pass, which fixed the schema-level side of
  that case (the index used to survive narrowed and falsely unique) without adding the
  physical teardown.
- Tests should assert on the provider's store map (the `createPersistentProvider` pattern in
  `index-persistence.spec.ts` already exposes it), and cover the close → reopen round trip:
  a leaked store must not resurrect the index on `rehydrateCatalog`.
