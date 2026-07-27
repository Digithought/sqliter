----
description: A plain `drop index` statement can delete the hidden helper structure the database builds behind a UNIQUE constraint, quietly making every uniqueness check on that column a full table scan — and the same statement, plus the matching `create index`, behaves differently depending on which storage backend is in use.
prereq:
files:
  - packages/quereus/src/schema/manager.ts (dropIndex ~2481, createIndex ~2315, findIndexNameOwnerElsewhere ~2454, resolveIndexTagSwap ~1226)
  - packages/quereus/src/schema/catalog.ts (isHiddenImplicitIndex ~488, isImplicitCoveringIndex ~494)
  - packages/quereus/src/runtime/emit/drop-index.ts
  - packages/quereus-store/src/common/store-table.ts (withImplicitUniqueIndexes ~382, materializedSchema ~565)
  - packages/quereus-store/src/common/store-module.ts (collectOccupiedStoreNames ~577, assertStoreNameFree, materializedIndexNames ~1626)
  - packages/quereus-sync/src/sync/store-adapter.ts (findIndexOwner ~403)
  - packages/quereus/test/logic/drop-unique-index.sqllogic
difficulty: medium
----

## What happens

When a table declares a plain `UNIQUE` constraint, the engine materializes a
secondary index to back it, named after the constraint (or `_uc_<cols>` when the
constraint is unnamed). That structure is deliberately **not** user-addressable:
`ALTER INDEX … SET TAGS` on its name raises `NOTFOUND`, guarded by
`isHiddenImplicitIndex`, and `docs/sql-ddl.md` documents it as "not a
user-addressable index".

`DROP INDEX` has no such guard. `SchemaManager.dropIndex` scans
`table.indexes` — which contains the implicit structures — and drops whatever it
finds.

Reproduced (memory-backed engine):

```sql
create table a (id integer primary key, email text, constraint uq_email unique (email));
insert into a values (1, 'x');
drop index uq_email;          -- succeeds
```

After the drop, `a.indexes` is empty while `a.uniqueConstraints` still lists
`uq_email`. Uniqueness is *still enforced* — a duplicate insert correctly fails
with `UNIQUE constraint failed: a (email)` — so this is not a data-integrity
hole. What is lost is the index that made the check a bounded point-seek; the
constraint falls back to the slow path, silently and permanently. The registered
table schema is also now inconsistent with the constraint that produced the
structure, which is what the catalog, schema hashing, and declarative diffing all
read.

## The two backends disagree, on drop and on create

The memory backend materializes the implicit structure into the table schema the
engine registers. The store backend deliberately keeps it in a private
enforcement copy (`StoreTable.materializedSchema`) and never registers it. So the
same SQL takes different paths on each, in both directions:

| statement (table `b` has `constraint uq_email unique (email)`) | memory | store (LevelDB) |
|---|---|---|
| `drop index uq_email` | succeeds, deletes the backing structure | `no such index` |
| `create index uq_email on b (email)` | `ERR: Index uq_email already exists on table b` | `OK` |

(Both rows run against the built `dist` of each backend.)

The create row matters because nothing on the store sees the clash — not the
engine's per-table duplicate check (the implicit entry is not in the schema it
reads), and not the store's own physical-store-name guard: `assertStoreNameFree`
takes occupancy from `collectOccupiedStoreNames`, which walks `getSchema()`
(engine-facing, no implicit entries), while the physical index-store name is
`buildIndexStoreName(schema, table, indexName)` — identical for the user index and
for the constraint's hidden structure of the same name. On the store the two
logical structures therefore share one physical store.

UNIQUE enforcement was **not** observed to break in that probe: a duplicate email
was still rejected after the `create index`, and still rejected after a following
`drop index uq_email` (the store falls back to a full-scan conflict search when no
index serves the constraint). So the demonstrated harm is the divergence and the
store-name aliasing, not lost enforcement — but a `drop index` that deletes a
physical store the constraint may later be handed back empty deserves a test
rather than an argument.

Note this is *not* the same thing as `debt-store-implicit-unique-index-reuse`,
which is about the store maintaining two **distinctly named** identical structures
over the same columns. Here the two structures share a name and a store.

## Expected behavior

`DROP INDEX` on the name of a hidden implicit covering structure should behave
the way `ALTER INDEX` on that name already does: raise "no such index", and
honor `IF EXISTS` as a no-op. Dropping the backing structure should require
dropping the constraint.

`CREATE INDEX` taking the name of a table's own implicit covering structure
should be refused on **both** backends, not only on memory.

Whether an **exposed** implicit covering structure (a constraint tagged
`quereus.expose_implicit_index`) should be droppable is a separate call — it is
user-addressable for tags, but its lifecycle still belongs to the constraint, so
the same refusal is probably right.

The asymmetry looks like an oversight rather than a decision: the tag path grew
an explicit guard and the drop path never did. The predicate to reuse already
exists: `isImplicitCoveringIndex` / `isHiddenImplicitIndex` in
`packages/quereus/src/schema/catalog.ts`. Note that on the store neither predicate
can see anything, because the engine-facing schema carries no implicit entry —
either the store must expose its implicit names to the engine, or the guards must
ask the module.

## While in here: one owner-lookup instead of four

Four separate copies of "scan a schema's tables for the index of this name" now
exist — `SchemaManager.findIndexNameOwnerElsewhere`, `SchemaManager.dropIndex`,
`SchemaManager.resolveIndexTagSwap`, and `quereus-sync`'s `store-adapter.ts`
`findIndexOwner` (whose comment says outright that it mirrors `dropIndex` because
the schema manager exposes no index accessor). They already disagree on implicit
structures: `resolveIndexTagSwap` skips a hidden implicit and keeps scanning,
`dropIndex` takes the first match of any kind. One public owner-lookup on
`SchemaManager` with an explicit "include implicit?" choice would make that
disagreement impossible to reintroduce, and would give the sync adapter something
to call.
