description: When creating an index on a persistent table fails at the very last step, the half-built index is left behind on disk and the open session keeps updating it, even though the database itself no longer knows the index exists.
files:
  - packages/quereus-store/src/common/store-module-index.ts        # createIndex (~71-210) — teardown arm only wraps buildIndexEntries
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts        # § "an identifier or persisted DDL text carrying a lone surrogate" — nearest existing coverage
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The leftover index is invisible to queries and never returns wrong rows, so a maintainer may reasonably rank a cleanup-path fix below work that affects results a user can see.
----

# What happens

`StoreModule.createIndex` builds a new index in this order:

1. check the physical store name is free
2. open (create) the index store
3. fill it from the table's rows — **wrapped in a try/catch that tears the store down on failure**
4. update the connected table's cached schema so later writes maintain the new index
5. `saveTableDDL(...)` — write the table's catalog entry, now including the index
6. reconcile implicit unique-index stores

Only step 3 has the teardown arm. If step 5 or 6 throws, the error does reach the user (the
whole call is awaited by the engine, which then does not register the index), but three
things are already done and nothing undoes them:

- the physical index store exists and is fully populated;
- the connected table's cached schema lists the index, so every write for the rest of the
  session maintains an index the engine does not know about;
- the persisted catalog entry still describes the table *without* the index, so on reopen the
  index is unknown while its store lingers.

A later `CREATE INDEX` reusing the same name then hits the store-name-already-taken guard and
is refused, for a store nothing references.

# How to reach it

Any failure of the catalog write reaches it — an IO error from the underlying key-value store
is the general case. The one deterministic, no-fault-injection reproduction is a partial index
whose predicate carries text the store cannot encode:

```sql
create table t (id integer primary key, v text) using store;
create index ix on t (v) where v <> '<lone surrogate>';
```

Observed (run during review of `create-table-persistability-preflight`): the statement is
refused with `cannot store persisted schema text containing an unpaired surrogate`, the engine
has no `ix`, and the catalog still holds the pre-index table DDL. The residue itself was read
off the code path, not measured — confirming it means asserting, after that refused statement,
that no index store exists for `ix` and that the connected table's cached schema does not list it.

# Expected behavior

A refused `CREATE INDEX` on a store table leaves nothing behind — the same clean-no-op
guarantee the build-failure arm already provides: no index store, no index in the connected
table's cached schema, catalog unchanged.

# Note on scope

The natural fix is to widen the existing teardown arm to cover everything after the index store
is opened, and to restore the table's cached schema when it has already been swapped — rather
than adding a second, separate cleanup path. Worth checking whether `dropIndex` and the
implicit-unique-index reconcile share the same shape of exposure.
