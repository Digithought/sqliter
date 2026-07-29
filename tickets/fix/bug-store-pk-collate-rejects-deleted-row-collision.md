----
description: On the persistent (LevelDB) storage backend, changing the sorting rule of a primary-key column can be refused because of a row the current transaction has already deleted — and the refusal arrives after the table has been partly rewritten, so the transaction is gone and the table is left mid-change.
files:
  - packages/quereus-store/src/common/store-module.ts   # alterColumnChange, the `pkRekeyNeeded` block (~2227-2246) and its enforcing rebuildSecondaryIndexes call
  - packages/quereus-store/src/common/store-table.ts     # rekeyRows — its duplicate-key pass reads committed rows only
  - packages/quereus-isolation/src/isolation-module.ts   # supplies the merged `EffectiveRowSource` the other checks use
difficulty: medium
----

# `SET COLLATE` on a primary-key column judges rows the transaction has deleted

## What happens

The engine runs the LevelDB store behind an isolation layer that keeps each connection's
uncommitted writes in a private overlay. Rows the transaction has deleted are still physically
present in the store; the overlay records the deletion.

Every row-content check in `ALTER TABLE` is supposed to judge the rows the *issuing connection*
can see — committed rows merged with its own overlay. The isolation layer hands that merged
stream down as an `EffectiveRowSource`, and the non-primary-key UNIQUE re-validation uses it.

Two checks on the primary-key path do not:

- `StoreTable.rekeyRows`' duplicate-key pass, and
- the secondary-index rebuild that follows it (`rebuildSecondaryIndexes` with its in-pass
  uniqueness check active).

Both read the store's committed rows directly. So a row the transaction has already deleted still
counts, and if it collides under the new collation with a row that survives, the `ALTER` is
refused over a duplicate that no longer exists from the caller's point of view.

Reproduction shape (needs the isolation wrapper, i.e. the normal engine configuration):

```sql
create table t (k text collate binary primary key, v text);
create unique index t_v on t (v);          -- or any UNIQUE covering a column that collides
insert into t values ('A', 'x'), ('a', 'y');

begin;
delete from t where k = 'a';               -- the collider is gone as far as this transaction sees
alter table t alter column k set collate nocase;   -- refused anyway: 'A' vs 'a'
```

## Why it is worse than a plain false rejection

`ALTER COLUMN` on a store-backed table commits the module's buffered writes before it starts
rewriting (the store cannot replay pre-rewrite writes over rewritten storage). The primary-key
re-key runs after that commit. `rekeyRows` validates before mutating, so a rejection there leaves
storage intact but the transaction already committed. The index rebuild is later still — by then
the data store has been re-keyed, so its rejection leaves the table with new primary-key bytes and
a half-rebuilt index.

## Expected behavior

The primary-key re-key path should judge the same rows every other row-content check judges: the
issuing connection's effective rows. A collision only among rows the transaction has deleted must
not block the change; a collision involving a row it has inserted must still block it (today
neither side catches that one — the wrapper enforces the primary key among its own staged rows,
the store among its own, and a staged-vs-committed collision under the new collation falls between
them; there is an existing `NOTE:` at store-module.ts ~2235 saying so).

## Scope notes

- Pre-existing; not introduced by `bug-retype-unique-revalidation-store`, which fixed the
  analogous ordering problem on the *value-rewriting* arm and left this one untouched.
- Narrow: needs the isolation wrapper, a `SET COLLATE` (or a key-transform type change) on a
  primary-key column, and a committed-but-overlay-deleted row that collides under the new rule.
- The sibling arm already solved this: the value-rewrite / key-transform rebuild passes
  `skipDuplicateCheck` and leans on the pre-mutation probe over effective rows. The same shape
  may fit here once the probe covers the primary key, but the primary key is not represented in
  `uniqueConstraints`, so the probe would need a new arm rather than a filter change.
- Confirm under `yarn test:store`, or with a store-package spec that registers the isolation
  module over `StoreModule` (see `packages/quereus-store/test/isolated-store.spec.ts`).
