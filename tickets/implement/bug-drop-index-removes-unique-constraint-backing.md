---
description: A plain `drop index` can delete the hidden helper structure the database builds behind a UNIQUE constraint, and the same `drop index` / `create index` pair behaves differently on the in-memory backend than on the disk-backed one.
prereq:
files:
  - packages/quereus/src/schema/manager.ts (createIndex ~2306, dropIndex ~2469)
  - packages/quereus/src/schema/catalog.ts (collectSchemaCatalog ~205, implicitCoveringIndexExposure ~371, isImplicitCoveringIndex ~494)
  - packages/quereus/src/runtime/emit/drop-index.ts (strict-DDL-policy owner scan)
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic
  - packages/quereus/test/schema-manager.spec.ts (~473, ~703)
  - docs/sql-ddl.md (§6.3 Indexes on Virtual Tables ~880-919, ALTER INDEX note ~766)
difficulty: medium
---

## What is wrong

When a table declares a plain `UNIQUE` constraint, the engine builds a secondary
index behind it, named after the constraint (or `_uc_<cols>` when the constraint
is unnamed). That structure is deliberately not something the user can name:
`ALTER INDEX … SET TAGS` on it raises `NOTFOUND`, and `docs/sql-ddl.md` calls it
"not a user-addressable index".

`DROP INDEX` never got that guard, and `CREATE INDEX` only got it on one of the
two storage backends. All three statements below were run against the current
tree (`packages/quereus/test/logic.spec.ts`, plain and `QUEREUS_TEST_STORE=true`):

| statement — table has `constraint uq_email unique (email)` | memory | store (LevelDB) |
|---|---|---|
| `drop index uq_email` | succeeds, deletes the backing structure | `no such index` |
| `create index uq_email on b (email)` | `Index uq_email already exists on table b` | succeeds |

On memory, after the drop the table's index list is empty while its constraint
list still names `uq_email`. Uniqueness is still enforced — a duplicate insert
correctly fails — but by a full table scan instead of a bounded point seek, and
the registered schema no longer matches the constraint that produced the
structure. That schema is what the catalog, schema hashing, and the declarative
differ all read.

On the store, `create index uq_email` succeeding means the user index and the
constraint's hidden structure land on the *same physical key-value store*
(`buildIndexStoreName` is a pure function of schema + table + index name, and the
store's own physical-name guard enumerates only the engine-facing schema, which
carries no hidden entry). A later `drop index uq_email` deletes that shared
store. Uniqueness happened to survive in the probe, but the schema is aliased and
nothing pins the outcome.

### Why both guards can be one engine-side change

The ticket this came from assumed the store side would need to expose its hidden
index names to the engine. It does not. The predicate
`isImplicitCoveringIndex(tableSchema, name)` in
`packages/quereus/src/schema/catalog.ts` is built **only** from
`tableSchema.uniqueConstraints`, never from `tableSchema.indexes` — and
`uniqueConstraints` is present in the engine-facing schema on both backends. So
one guard in `SchemaManager` fixes both backends with no store-package change.

### Bundled: the same predicate is case-blind at one call site

`implicitCoveringIndexExposure` documents that its map keys are lowercased and
"callers must look up a lowercased name". `collectSchemaCatalog` does
`implicit.get(indexSchema.name)` without lowercasing. Reproduced:

```sql
create table zre (id integer primary key, email text, constraint UQ_Email unique (email));
select type, name from schema() where name = 'UQ_Email';
-- memory: returns index/UQ_Email   (the hidden structure, leaked)
-- store:  returns nothing
```

This is bundled here rather than filed separately because it is coupled to the
main fix: a leaked hidden index appears in `actualCatalog.indexes` unmarked, so
the declarative differ treats it as a real index and emits
`DROP INDEX "UQ_Email"` for a table declared without it. Today that phantom drop
silently deletes the backing structure; once the guard below lands it would
become a hard `apply schema` failure. Fix both together.

## Expected behavior

- `DROP INDEX <implicit name>` raises `no such index`, and `DROP INDEX IF EXISTS
  <implicit name>` is a no-op — matching what `ALTER INDEX` on that name already
  does, and matching what the store already does today. Removing the structure
  requires dropping the constraint.
- The refusal applies to an **exposed** structure too (a constraint tagged
  `quereus.expose_implicit_index`). Exposure makes it addressable for *tags*; its
  lifecycle still belongs to the constraint.
- `CREATE INDEX <implicit name> on <that same table>` is refused on **both**
  backends, with the message and `IF NOT EXISTS` semantics the memory backend
  already has (`Index <name> already exists on table <table>`; `IF NOT EXISTS`
  skips silently). Reusing the existing wording keeps
  `packages/quereus/test/schema-manager.spec.ts:715` and the documented behavior
  intact and makes the store match memory rather than inventing a third shape.
- An implicit name on **another** table stays outside the schema-wide index
  namespace — `create index uq_email on c (email)` is still legal when only
  tables `a`/`b` carry a `uq_email` constraint. `10.5.5-index-name-uniqueness.sqllogic`
  already pins this; do not regress it. It follows that the `DROP INDEX` owner
  scan must **skip and keep scanning** past an implicit match, not stop at it, so
  `drop index uq_email` still finds table `c`'s real index.

## Design

One predicate, three call sites, all in `packages/quereus/src/schema/`:

**`SchemaManager.createIndex`** (`manager.ts` ~2306). Widen the existing
same-table duplicate test so it also fires when the requested name is a
constraint's implicit name:

```ts
const existingIndex = tableSchema.indexes?.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
const shadowsConstraintStructure = isImplicitCoveringIndex(tableSchema, indexName);
if (existingIndex || shadowsConstraintStructure) {
    if (stmt.ifNotExists) { log(...); return; }
    throw new QuereusError(`Index ${indexName} already exists on table ${tableName}`, StatusCode.CONSTRAINT, ...);
}
```

Memory behavior is unchanged (both halves are true there); the store gains the
refusal.

**`SchemaManager.dropIndex`** (`manager.ts` ~2469). The owner scan currently
takes the first table with any name match. Skip implicit matches and continue:

```ts
for (const table of schema.getAllTables()) {
    const matched = table.indexes?.find(idx => idx.name.toLowerCase() === lowerIndexName);
    if (!matched || isImplicitCoveringIndex(table, matched.name)) continue;
    ownerTable = table;
    break;
}
```

This is the same shape `findIndexNameOwnerElsewhere` already uses one screen
above. No owner found then falls through to the existing `IF EXISTS` / `no such
index` handling, which is exactly the wanted behavior.

**`emitDropIndex`** (`runtime/emit/drop-index.ts`). Its strict-DDL-policy owner
scan is a fourth copy of the same loop and must skip implicit matches for the
same reason, or the policy gate fires against a table whose index is not the one
`dropIndex` will resolve.

**`collectSchemaCatalog`** (`catalog.ts` ~208). Lowercase the lookup key:
`implicit.get(indexSchema.name.toLowerCase())`.

### Known consequence, accepted

A table can currently hold a UNIQUE constraint whose name equals an unrelated
index's name on the same table (`create index foo on t (b);
alter table t add constraint foo unique (a);` — both statements succeed today).
In that state `isImplicitCoveringIndex(t, 'foo')` is true and the new guard
refuses `drop index foo`, even though `foo` is also a real user index. That state
is already broken in worse ways — on memory it produces **two** index entries
literally named `foo` on one table — and is tracked separately as
`bug-unique-constraint-name-collides-with-index-name`. Refusing the drop there is
the conservative outcome; do not add shape-matching logic to work around it here.
Note the interaction in a `NOTE:` comment next to the `dropIndex` guard.

## TODO

Phase 1 — guards

- Add the `isImplicitCoveringIndex` term to `SchemaManager.createIndex`'s
  same-table duplicate test, reusing the existing message and `IF NOT EXISTS`
  behavior. Comment why the term is needed (store carries no materialized entry).
- Skip-and-continue past implicit matches in `SchemaManager.dropIndex`'s owner
  scan; add the `NOTE:` about the constraint-name/index-name clash.
- Same skip in `emitDropIndex`'s strict-DDL-policy owner scan.
- Lowercase the exposure-map lookup in `collectSchemaCatalog`.

Phase 2 — tests

- New `packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`
  (`-- requires-capability: standalone-index-ddl`, runs on **both** backends —
  do not add it to `MEMORY_ONLY_FILES`) covering:
  - `drop index uq_email` → `no such index`; `drop index if exists uq_email` →
    no-op; uniqueness still enforced after both.
  - Same for an unnamed constraint's auto-name (`_uc_email`).
  - Same for a constraint tagged `quereus.expose_implicit_index = true`.
  - `create index uq_email on <same table> (email)` → `already exists on table`;
    `create index if not exists uq_email on <same table> (email)` → silent skip.
  - Table `c` with a real index named `uq_email` while tables `a`/`b` carry a
    `uq_email` constraint: `drop index uq_email` drops `c`'s index and leaves
    `a`/`b` enforcing.
  - `alter table … drop constraint uq_email` still removes the structure, and a
    duplicate is accepted afterwards.
- New assertion in `packages/quereus/test/schema-manager.spec.ts`, next to the
  existing implicit-index cases (~473, ~703): a mixed-case constraint name
  (`constraint UQ_Email unique (email)`) does **not** surface an index row from
  `collectSchemaCatalog`, on memory.
- Add a declarative-differ case (or extend one in
  `packages/quereus/test/logic/50-declarative-schema.sqllogic`) proving a table
  with a mixed-case-named UNIQUE constraint diffs **empty** against its own
  declaration — no phantom `DROP INDEX`.

Phase 3 — docs + validation

- `docs/sql-ddl.md` §6.3: the bullet at ~917 currently says a same-table
  `create index uq_email` "still fails the ordinary same-table check" — restate
  it as a rule that holds on both backends, and add that `DROP INDEX` on an
  implicit name raises `no such index` (with `IF EXISTS` a no-op), exposed or
  not, and that the structure is removed by dropping the constraint.
- `docs/sql-ddl.md` ~766 (ALTER INDEX note): extend the "not a user-addressable
  index" sentence to cover `DROP INDEX` alongside `ALTER INDEX … TAGS`.
- Run `yarn workspace @quereus/quereus run lint`, `yarn test`, and
  `yarn test:store` (all three; the store leg is the point of this ticket).
