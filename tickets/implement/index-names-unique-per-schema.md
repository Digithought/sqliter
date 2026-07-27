description: Two tables in the same database can each have an index with the same name, so dropping or tagging that index by name silently hits whichever table happens to be registered first. Make `create index` reject a name already taken in the schema.
prereq:
files:
  - packages/quereus/src/schema/manager.ts (createIndex ~2315, dropIndex ~2427, importIndex ~3168, updateIndexTags ~1213)
  - packages/quereus/src/schema/catalog.ts (implicitCoveringIndexExposure ~367, implicitIndexName ~383, isHiddenImplicitIndex ~471)
  - packages/quereus/src/schema/schema-differ.ts (declaredIndexes collection ~332, actualIndexes ~375)
  - packages/quereus-sync/src/sync/store-adapter.ts (findIndexOwner)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (recordSchemaMigration ~855)
  - docs/sql-ddl.md:696
  - packages/quereus/test/logic/10.5-indexes.sqllogic
  - packages/quereus/test/schema-manager.spec.ts
difficulty: medium
----

## What is wrong

`docs/sql-ddl.md:696` states the rule as fact:

> `ALTER INDEX` resolves the owning table from the index name (index names are
> unique per schema).

Nothing enforces it. `SchemaManager.createIndex` (manager.ts ~2331) checks only
whether the *target table* already has an index of that name — it never looks at
the schema's other tables.

Every consumer that resolves an index by name within a schema does a first-match
scan across the schema's tables and stops at the first hit:

| Consumer | Site |
| --- | --- |
| `DROP INDEX` | `SchemaManager.dropIndex`, manager.ts ~2437 |
| `ALTER INDEX … TAGS` | `SchemaManager.updateIndexTags`, manager.ts ~1213 |
| sync convergence decisions | `findIndexOwner`, quereus-sync store-adapter.ts |
| strict-DDL-policy gate | `emitDropIndex`, runtime/emit/drop-index.ts |

"First" is table registration order, which is not stable across devices.

## Reproduced

Memory-backed engine, no store or sync involved:

```sql
create table t1 (id integer primary key, note text);
create table t2 (id integer primary key, note text);
create index idx_note on t1 (note);
create index idx_note on t2 (note);   -- accepted, no error
drop index idx_note;                  -- drops t1's; t2's survives
```

Observed: `SECOND CREATE ERROR: (none — allowed)` /
`after drop: t1 idx= []  t2 idx= [ 'idx_note' ]`.

Sync makes it worse in two ways, both introduced by the drop/index DDL
replication work:

- A replicated `drop index "main"."idx_note"` names no table (the `DROP INDEX`
  grammar has no slot for one), so the receiver re-runs the first-match scan
  against *its* registration order. One device can drop `t1`'s index while its
  peer drops `t2`'s, and both believe they converged.
- `recordSchemaMigration` versions an index migration under
  `` `${schemaName}.${objectName}` `` where `objectName` is the *index* name.
  Two same-named indexes on different tables share one version counter and can
  suppress each other's migrations.

## The fix

Make `create index` refuse a name already in use by a **user index** anywhere in
the same schema, naming the existing owner. That one change makes every
by-name resolver above correct by construction.

### Which indexes occupy the schema-wide namespace

**Only ordinary user indexes — implicit covering structures must be excluded.**

The auto-built secondary structure backing a plain `UNIQUE` constraint is named
by `implicitIndexName` (catalog.ts ~383): the *constraint's own name* when it has
one, else `_uc_<cols>`. Constraint names are unique per table, not per schema, so
this is legal and common:

```sql
create table a (id integer primary key, email text, constraint uq_email unique (email));
create table b (id integer primary key, email text, constraint uq_email unique (email));
```

Verified: both tables end up with an index literally named `uq_email` in
`tableSchema.indexes` (memory mode materializes them; store mode does too, via
`withImplicitUniqueIndexes`). A schema-wide check that counted implicit indexes
would reject this perfectly valid schema.

So the new check skips any index that is an implicit covering structure —
**hidden or exposed**. Exposed implicit indexes (constraints tagged
`quereus.expose_implicit_index`) are user-addressable by `ALTER INDEX`, so
excluding them leaves a residual first-match hole for that narrow case; it cannot
be closed at `create index` time because the collision would be created by
`create table`, not by `create index`. Record that as a `NOTE:` comment at the
check site rather than a ticket.

### Where the check goes

`SchemaManager.createIndex`, after the existing per-table check. Order matters:

- **Keep the existing per-table check first, unchanged.** It is the check that
  catches a `create index uq_email on b (email)` when `b` already carries an
  implicit `uq_email` (verified: currently errors
  `Index uq_email already exists on table b`), and it is the one `IF NOT EXISTS`
  keys off.
- **Add a cross-table check after it**, scanning the schema's other tables for a
  non-implicit index of the same name (case-insensitively). Throw
  `StatusCode.CONSTRAINT` with a message naming the owner, e.g.
  `Index 'idx_note' already exists in schema 'main' on table 't1'`.
- **`IF NOT EXISTS` does not suppress the cross-table error.** `IF NOT EXISTS`
  means "skip if *this* index already exists"; an index of that name on a
  *different* table is a different object, and silently skipping would leave the
  requested index absent from the target table with no signal. Errors are
  cheap to see; a missing index is not. Document this in `docs/sql-ddl.md`.

### Case sensitivity

`isHiddenImplicitIndex` and `implicitCoveringIndexExposure` (catalog.ts) key
their map by **exact-case** name. Existing callers happen to pass the stored
name, so they are fine, but the new check receives the raw statement spelling.
Add an exported case-insensitive predicate in catalog.ts —
`isImplicitCoveringIndex(tableSchema, indexName): boolean`, true for hidden *and*
exposed — and use it. Consider lowering the existing map's keys so
`isHiddenImplicitIndex` stops being case-sensitive too; check its call sites
(`manager.ts:1242`, `store-module.ts:3268`) before changing behavior there.

### Rehydrating a database that already contains a collision

Warn, do not fail. `importIndex` (manager.ts ~3168) is the rehydrate path and is
deliberately silent (no `notifyChange`). A pre-existing database with a
collision must still open — refusing to open it strands the data. Emit a
`warnLog` naming the index and both owning tables, then import as before.
(Backwards compatibility is otherwise out of scope per AGENTS.md; this is only
about not bricking an open.)

### The declarative differ has the same blind spot from the other side

`computeSchemaDiff` builds both `declaredIndexes` (schema-differ.ts ~332) and
`actualIndexes` (~375) as `Map` keyed by lowercased index name, schema-wide.
A `declare schema` block containing two `create index idx …` statements on
different tables silently keeps only the last — last-writer-wins, no diagnostic.
Raise a declaration-time diagnostic there instead, so a declared schema that
violates the invariant is rejected up front rather than half-applied.

### Sync needs no code change, but does need the invariant written down

Once `create index` enforces uniqueness, `findIndexOwner`'s first-match scan and
the `<schema>.<index name>` migration version key are both correct for
index-vs-index. Add a `NOTE:` at each site recording that the correctness rests
on the `create index` invariant, so a future change there does not quietly
reintroduce the ambiguity.

An index name colliding with a *table* name still shares a migration version
counter — that is out of scope here and filed separately as
`bug-sync-migration-version-key-ignores-object-kind`.

## TODO

Phase 1 — engine enforcement

- Add `isImplicitCoveringIndex(tableSchema, indexName)` to
  `packages/quereus/src/schema/catalog.ts` (case-insensitive; true for hidden and
  exposed implicit covering structures) and export it from `src/index.ts`
  alongside `isHiddenImplicitIndex`.
- In `SchemaManager.createIndex`, after the existing same-table check, scan the
  schema's other tables for a non-implicit index of the same name and throw
  `QuereusError(CONSTRAINT)` naming the existing owner. Carry the statement's
  `loc` for line/column reporting, as the sibling throws do.
- Add a `NOTE:` at the check site recording the exposed-implicit-index residual
  (two tables can each expose a same-named implicit covering index; `ALTER INDEX`
  on that name is still first-match).
- In `SchemaManager.importIndex`, `warnLog` (do not throw) when the imported
  index name is already taken by a non-implicit index on another table in the
  same schema.

Phase 2 — declarative + sync alignment

- In `computeSchemaDiff` (schema-differ.ts ~332), raise a diagnostic when two
  `declaredIndex` items resolve to the same lowercased name instead of silently
  overwriting the map entry. Match how the surrounding declaration-collection
  diagnostics are raised.
- Add `NOTE:` comments recording the dependency on the new invariant at
  `findIndexOwner` (quereus-sync store-adapter.ts) and at the `counterKey`
  computation in `recordSchemaMigration` (sync-manager-impl.ts ~882).

Phase 3 — docs

- `docs/sql-ddl.md`: in the CREATE INDEX section, state that index names are
  unique per schema and that a collision raises an error naming the owning
  table; note that `IF NOT EXISTS` does not suppress a cross-table collision;
  note that a UNIQUE constraint's implicit covering structure is not part of that
  namespace. Update the ALTER INDEX line at :696 so the parenthetical points at
  the enforcement instead of asserting it unbacked.

Phase 4 — tests

- `packages/quereus/test/logic/10.5-indexes.sqllogic` (or a new
  `10.5.5-index-name-uniqueness.sqllogic`, whichever fits the file's shape):
  - second `create index idx_note on t2 (note)` after one on `t1` → error
  - `create index if not exists idx_note on t2 (note)` → still errors
  - two tables each with `constraint uq_email unique (email)` → still legal
  - `create index uq_email on b (email)` where `b` already has the implicit
    `uq_email` → still the existing same-table error
  - after enforcement, `drop index idx_note` resolves unambiguously
- `packages/quereus/test/schema-manager.spec.ts`: a case-divergent collision
  (`create index IDX_NOTE on t2` after `idx_note` on `t1`) errors.
- Add a schema-differ case covering the duplicate declared-index diagnostic
  (see `packages/quereus/test/` for the existing differ spec's location).
- Run `yarn test` and `yarn lint`. Run `yarn test:store` for this one — the store
  module materializes implicit unique indexes on its own path
  (`withImplicitUniqueIndexes`), so the implicit-exclusion behavior must be
  confirmed there too, not only in memory mode.
