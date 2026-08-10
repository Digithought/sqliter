----
description: When creating an index on a persistent table fails after the index has been built, the half-created index is left behind on disk, the open session keeps updating it, and a second attempt to create the same index is refused — even though the database itself never registered the index. Dropping an index has the mirror-image problem.
files:
  - packages/quereus-store/src/common/store-module-index.ts      # createIndex (~71-206) and dropIndex (~216-292) — the one site
  - packages/quereus-store/src/common/store-module-catalog.ts    # saveTableDDL / encodeCatalogDDL — the step that throws
  - packages/quereus-store/src/common/store-table-base.ts        # updateSchema (386), markDdlSaved (412) — the cached-schema swap to unwind
  - packages/quereus-store/test/stream-index-build.spec.ts       # home for the new tests; already has a failure-injecting provider
  - packages/quereus/src/schema/manager.ts                       # createIndex (2393) / dropIndex (2620) — engine registers only AFTER the module returns
repro: verified
difficulty: medium
----

# Root cause

`StoreModule.createIndex` (`packages/quereus-store/src/common/store-module-index.ts`) does six
things in order:

1. refuse the index if its physical store name is already taken
2. open (create) the physical index store
3. fill it from the table's rows — **the only step wrapped in a try/catch that tears the store down**
4. swap the connected table's cached schema to one that lists the new index
5. `saveTableDDL(...)` — write the table's catalog entry, now including the index
6. reconcile the hidden `_uc_*` stores that back plain UNIQUE constraints

The engine (`SchemaManager.createIndex`) registers the index in its own schema only *after*
the module call returns, and does no cleanup when it throws. So the module owns the whole
unwind — but its teardown arm ends at step 3. A failure in step 5 or 6 propagates the error
correctly and leaves three things behind:

- the physical index store, fully populated;
- the cached schema on the connected `StoreTable`, which still lists the index, so every
  write for the rest of the session maintains an index the engine does not know about;
- (step 6 only) a catalog entry that *does* list the index, while the engine does not.

## Verified reproduction

Run against an in-memory provider (`packages/quereus-store/test/` house style), with a
partial-index predicate carrying an unpaired surrogate — text the catalog encoder refuses,
which makes step 5 throw deterministically with no fault injection:

```sql
create table t (id integer primary key, v text) using store;
insert into t values (1, 'a'), (2, 'b');
create index ix on t (v) where v <> '<lone high surrogate>';
```

Observed today:

- the statement is refused: `cannot store persisted schema text containing an unpaired
  surrogate (U+D800 at offset 156)`;
- provider store keys afterwards include `main.t_idx_ix`, holding **2** entries;
- a later `insert into t values (3, 'c')` grows that store to **3** entries — the ghost index
  is still being maintained;
- the catalog holds only `CREATE TABLE "main"."t" (...)` — no index;
- retrying `create index ix on t (v)` is refused with a self-contradictory message:
  *"the index store of new index 'ix' on table 'main.t' would map to physical store
  'main.t_idx_ix', which already backs the index store of index 'ix' on table 'main.t'"* —
  the store-name guard reads occupancy off the cached schema, which still carries the ghost.

The unencodable predicate is the convenient deterministic trigger; the general case is any IO
error from the catalog write or the `_uc_*` reconcile.

# Second arm: `dropIndex`, same site, mirror shape

`dropIndex` runs: swap cached schema (index removed) → `saveTableDDL` → flush → tear down the
physical store → reconcile `_uc_*`. The engine, again, removes the index from its own registry
only after the module returns. A failure at `saveTableDDL` therefore leaves the engine still
planning seeks against an index that the connected table has already stopped maintaining —
stale index entries answering queries. That needs an IO error to trigger (the drop's catalog
bundle is a subset of what was already persisted, so it cannot newly fail to encode), but it is
the same missing-unwind at the same site and belongs in the same change.

Not in scope here: a `tearDownIndexStore` that only closes rather than deletes leaves an orphan
store that a later same-name `CREATE INDEX` would reopen with stale entries. That is a provider
gap already tracked as `bug-mobile-providers-delete-table-stores-only-closes`.

Also distinct from `feat-transactional-ddl-native-backends` (backlog), which is about a
*successful* DDL surviving a rolled-back transaction. This ticket is about a *failed* statement
leaving residue, and does not need a transaction-scoped catalog.

# Required behavior

A refused `CREATE INDEX` on a store table is a clean no-op — the guarantee the build-failure arm
already gives, extended to every later step: no index store, the connected table's cached schema
unchanged, the catalog entry unchanged, and a retry of the same statement free to succeed.

A refused `DROP INDEX` likewise leaves the index intact and maintained.

# Design (prototyped and validated)

Widen the existing arm rather than adding a second cleanup path. A prototype of exactly this
shape made the reproduction above clean (no `main.t_idx_ix` store, retry succeeds and persists
`CREATE INDEX "ix" ON "main"."t" ("v" COLLATE BINARY)`) and the full
`yarn workspace @quereus/store run test` suite stayed green at 1581 passing.

Track how far the statement got, then unwind in reverse:

```
let schemaSwapped = false;
let catalogWritten = false;
try {
    buildIndexEntries(...)
    table.updateSchema(updatedSchema);   schemaSwapped  = true
    saveTableDDL(updatedSchema); table.markDdlSaved();   catalogWritten = true
    reconcileImplicitUniqueIndexStores(..., oldSchema: tableSchema)
    emitSchemaChange(...)
} catch (e) {
    // unwind, each step guarded so its own throw cannot mask `e`
    if (schemaSwapped) {
        const failedSchema = table.getSchema();
        table.updateSchema(tableSchema);
        reconcileImplicitUniqueIndexStores(..., oldSchema: failedSchema);  // rebuilds any `_uc_*` step 6 tore down
    }
    if (catalogWritten) saveTableDDL(tableSchema);
    tearDownIndexStore(...);   // the arm that exists today
    throw e;
}
```

Points worth keeping in the code comments:

- `StoreTableBase.updateSchema` validates before adopting and recomputes the materialized
  `_uc_*` copy, so restoring the pre-create schema is safe and re-materializes any implicit
  unique index the create had retired.
- Re-running the reconcile with the *failed* schema as its `oldSchema` and the restored schema
  live is the symmetric inverse: it rebuilds the `_uc_*` store that step 6 tore down. Nothing is
  doomed on that pass, so it takes only the build arm — no forced DDL commit.
- Only re-save the catalog when the create actually got past `saveTableDDL`; if that call is what
  threw, the catalog is already correct and a write there would create an entry for a table that
  may deliberately have none yet (the lazy first-access persist).
- `markDdlSaved` staying set after a re-save of the old bundle is correct — the flag means "the
  catalog matches this table", which it then does.

`dropIndex` gets the matching treatment: restore the cached schema (and `markDdlSaved` state)
if `saveTableDDL` throws, before the physical teardown starts.

# Tests

`packages/quereus-store/test/stream-index-build.spec.ts` already owns the "a failed CREATE INDEX
leaves no orphan store" cases and already has a provider that injects a write failure on the Nth
flush and implements `deleteIndexStore` (so a teardown is observable). Extend it there rather
than starting a new file.

Beyond the two point cases, the class here is "a refused store DDL statement leaves residue", so
prefer one shared assertion helper over three hand-written checks — snapshot every provider store
(keys plus entry counts, and the catalog bytes) before the statement, run a statement expected to
throw, and assert the snapshot is unchanged. That is what catches the next step someone appends
after `saveTableDDL`.

# TODO

Phase 1 — reproduce in the suite

- Add a failing test: `create index` whose partial-index predicate carries a lone surrogate, over
  a store table with rows; assert the statement throws, no `main.t_idx_ix` store exists, a
  following insert does not grow one, and the catalog is unchanged.
- Add a failing test: the same statement retried as a plain `create index ix on t (v)` afterwards
  must succeed and persist.
- Add a failing test with the flush-failure provider aimed at the catalog store, so the general
  IO-error case is covered and not only the unencodable-text one.
- Add the `dropIndex` case: make the catalog write fail during `drop index`, assert the index is
  still listed by the engine AND still maintained by later DML (insert a row, check the index
  store grew).

Phase 2 — fix

- Widen `createIndex`'s try/catch to cover the cached-schema swap, the catalog write, the
  `_uc_*` reconcile and the event emit, with the reverse unwind above; keep each unwind step
  guarded so a cleanup failure cannot mask the original error, and log a `console.warn` naming
  the index and table when one does.
- Give `dropIndex` the matching cached-schema restore around its `saveTableDDL`.
- Update the block comments in `store-module-index.ts` that currently describe the arm as
  covering only the build.

Phase 3 — cover the class

- Factor the before/after residue snapshot into a shared helper in the spec and use it for every
  refused-DDL case added here.
- Check whether the `alterTable` arms in `store-module-alter.ts` (each of which mutates physical
  state and then calls `saveTableDDL`) have the same exposure; if they do and the fix does not
  generalize cheaply, note it in the review handoff rather than widening this ticket.

Phase 4 — validate

- `yarn workspace @quereus/store run test`
- `yarn build && yarn typecheck && yarn lint`
- `yarn test`
