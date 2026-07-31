---
description: Renaming a column covered by an unnamed UNIQUE constraint can silently swallow an unrelated index on the same table — the index stops appearing in schema listings, can no longer be dropped, and on the persistent backend is permanently erased from the saved schema on the next reopen.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts            # runRenameColumn ~300-433 — the unguarded site
  - packages/quereus/src/schema/catalog.ts                      # implicitIndexName ~391, implicitCoveringIndexExposure ~375, assertUniqueConstraintIndexNameFree ~453
  - packages/quereus/src/vtab/memory/layer/manager.ts           # ensureUniqueConstraintIndexes ~246, implicitIndexNameFor ~312
  - packages/quereus-store/src/common/store-module-catalog.ts   # buildCatalogEntry — skips whatever isHiddenImplicitIndex reports
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus-store/test/index-persistence.spec.ts       # reopen harness (persistent provider + open()/reopen()/catalogEntry())
difficulty: medium
repro: verified
---

## What a plain UNIQUE constraint's hidden index is named

A `unique (a)` constraint with no name of its own is enforced through an
automatically built secondary index the user never asked for and never sees. That
hidden index is named `_uc_<column names>` — `_uc_a` for a constraint over column
`a`. The name is **recomputed from the table's current column names every time it
is needed** (`implicitIndexName` in `packages/quereus/src/schema/catalog.ts`); it
is not recorded anywhere at the moment the constraint is declared.

So renaming a column moves the name. `unique (a)` is backed by `_uc_a`; rename
column `a` to `z` and the very same constraint is now considered to be backed by
`_uc_z`. If an ordinary index named `_uc_z` already exists on that table, the two
now claim one name, and every surface keyed by index name confuses them.

`ALTER TABLE … RENAME COLUMN` performs no check for this. The sibling ticket
`bug-unique-constraint-name-collides-with-index-name` closed the four paths that
*declare* or *rename a constraint* onto a taken name; renaming a **column** is a
fifth way to reach the same collision and was not covered by it.

## What actually happens (measured on the current tree, after that fix landed)

Setup, run on each backend:

```sql
create table t (id integer primary key, a text, b text, unique (a));
create index _uc_z on t (b);
insert into t values (1, 'x', 'p'), (2, 'y', 'q');
alter table t rename column a to z;   -- accepted, no error, no warning
```

### In-memory backend: the two objects swap visibility

The materialized index list is untouched by the rename (`_uc_a` on column `a`,
`_uc_z` on column `b` — read directly from `db._findTable('t').indexes`), but the
computed exposure map now says `_uc_z` is the hidden backing structure. The
consequences invert cleanly:

| statement | expected | actual |
| --- | --- | --- |
| `select name from schema() where type = 'index'` | `_uc_z` (the user's) | `_uc_a` (the constraint's own hidden structure) |
| `drop index _uc_z` | drops the user's index | `error: no such index: _uc_z` |
| `drop index _uc_a` | `no such index` (it is a backing structure) | **succeeds** — deletes the constraint's structure |

The user's declared index becomes permanently undroppable, and the constraint's
private structure becomes droppable by anyone who guesses its name. After
`drop index _uc_a` the table is left with the UNIQUE constraint but no covering
structure at all. Queries stay correct and the constraint keeps rejecting
duplicates on this backend (enforcement routes through the constraint list, not
the index), so nothing signals that anything happened.

### Persistent (store) backend: the index is erased from the saved schema

`buildCatalogEntry` omits any index reported as a hidden backing structure — which
is now the user's index. The catalog entry rewritten during the rename therefore
**loses its `CREATE INDEX` line**:

```
-- before the rename
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "a" TEXT NOT NULL, "b" TEXT NOT NULL, unique (a)) USING store
CREATE INDEX "_uc_z" ON "main"."t" ("b" COLLATE BINARY)

-- after the rename
CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "z" TEXT NOT NULL, "b" TEXT NOT NULL, unique (z)) USING store
```

No error, no warning. The index's physical storage still holds its 2 entries at
that point. On the next open, `rehydrateCatalog` reports zero errors and
`index_info('t')` comes back **empty** — the index is gone for good, and its
orphaned storage is left behind under exactly the name the constraint's structure
will claim (the physical name is a pure function of schema + table + index name).
That is the same adoption-of-an-orphaned-store mechanism that made the sibling
ticket's UNIQUE constraint silently stop catching duplicates, so the same
downstream damage is plausible here; it was not separately measured.

## Root cause

The hidden index's name is derived from live column names rather than fixed when
the constraint is declared, so a column rename can relocate it onto a name that is
already taken — and `runRenameColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`,
the schema-rewrite arm around lines 300-433) never asks whether the post-rename
name is free.

Two shapes of answer exist and the choice is genuinely open:

- **Guard the rename**, mirroring what the sibling ticket did for the constraint
  side. `assertUniqueConstraintIndexNameFree` in `schema/catalog.ts` already
  expresses exactly this question over prospective column *names*, so the
  rename arm can ask it with the post-rename names before dispatching to the
  module. Cheapest, and consistent with the four paths already guarded — but it
  means a legal column rename can be refused because of an unrelated index's name,
  which is a surprising thing to tell a user.
- **Stop deriving the name from live columns.** Record each unnamed constraint's
  backing-structure name once, when the constraint is declared, and carry it
  thereafter. Removes the whole class rather than one instance, but touches the
  constraint schema shape and the two backend mirrors of the naming rule
  (`quereus-store`'s `implicitUniqueIndexName`, `MemoryTableManager.implicitIndexNameFor`),
  and needs an answer for catalogs already on disk.

Named UNIQUE constraints are unaffected either way — their structure takes the
constraint's own name, which a column rename does not touch.

## Expected behavior

A column rename must never leave a declared index unlisted, undroppable, or
missing from the persisted schema, and must never make a constraint's private
backing structure droppable by name. Whichever shape is chosen, the outcome to
pin on both backends is: after `alter table t rename column a to z` with an index
`_uc_z` present, either the rename is refused with a message naming both objects,
or it succeeds and `_uc_z` is still the user's index — listed by `schema()` /
`index_info()`, droppable, and still present in the persisted catalog entry after
close → reopen.

## Reproducing

The memory-side behavior is expressible in a `.sqllogic` file under
`packages/quereus/test/logic/`, run on both backends:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  packages/quereus/test/logic.spec.ts --grep "<file stem>" --reporter spec

QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts \
  --grep "<file stem>" --reporter spec
```

The durable half needs close → reopen against the same storage, which `.sqllogic`
cannot express. `packages/quereus-store/test/index-persistence.spec.ts` already
has the persistent-provider + `open()` / `reopen()` helpers plus `catalogEntry()`
(the raw persisted bundle) and `indexStoreSize()` (physical entry count) — the two
readings that show the dropped `CREATE INDEX` line and the orphaned store. Its
last test, `a UNIQUE constraint colliding with an index name is refused and the
index survives reopen intact`, is the closest existing shape to copy.
