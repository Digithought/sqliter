description: A table's auto-created index for a UNIQUE constraint is described differently depending on which storage backend is running — one calls it unique, the other does not. Make every place that describes it agree, and say it is unique.
files:
  - packages/quereus/src/schema/catalog.ts                       # implicitCoveringIndexExposure (~419), SyntheticExposedIndex + syntheticExposedIndexToIndexSchema (~843-876), collectSchemaCatalog index arms (~246-272), indexSchemaToCatalog (~963)
  - packages/quereus/src/func/builtins/schema.ts                 # schema() index loops (~148-174), index_info() body (~424-452)
  - packages/quereus-store/src/common/store-module-catalog.ts    # buildCatalogEntry (~118) — persistence path, must NOT change
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # section 4 "EXPOSED implicit structure" (~line 74) — cross-backend pin goes here
  - packages/quereus/test/covering-structure.spec.ts             # ~line 913 memory-side exposure test
  - docs/sql-vtab.md                                             # section 6.3 bullet at ~line 184
  - docs/schema.md                                               # "Introspection" note at ~line 99
  - docs/functions.md                                            # ~line 578
difficulty: medium

# Exposed implicit covering index renders as UNIQUE everywhere

## Reproduced

Ran the shape below against both backends (memory `Database`, and a `Database` with
`default_vtab_module = 'store'` over the LevelDB provider, mirroring the store-mode
harness in `packages/quereus/test/logic.spec.ts`):

```sql
create table t (
  id integer primary key,
  x integer not null,
  constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true)
);
```

Observed:

| surface | memory | store |
|---|---|---|
| `select sql from schema() where type='index'` | `CREATE INDEX "uq" ON "main"."t" ("x" COLLATE BINARY)` | `CREATE UNIQUE INDEX "uq" ON "main"."t" ("x" COLLATE BINARY)` |
| `collectSchemaCatalog(db).indexes[].definition` | `index (x)` | `unique index (x)` |
| `collectSchemaCatalog(db).indexes[].ddl` | `CREATE INDEX "uq" ON "t" (…)` | `CREATE UNIQUE INDEX "uq" ON "t" (…)` |
| `select "unique" from index_info('t')` | `0` | `0` |

Two disagreements: the backends disagree with each other on the DDL text, and the
store backend's DDL disagrees with its own `index_info()`.

## Why the two answers exist

One logical index, two code paths:

- **Memory** materializes the backing index into `tableSchema.indexes`
  (`MemoryTableManager.ensureUniqueConstraintIndexes`) and sets no `unique` flag on
  the entry — enforcement routes through `uniqueConstraints`, not the index. The
  generic "render every real index" loop therefore renders `CREATE INDEX`.
- **Store** never materializes it. The read surfaces rebuild it on the fly from
  `exposedImplicitIndexes()` as a `SyntheticExposedIndex`, and
  `syntheticExposedIndexToIndexSchema` stamps `unique: true` before rendering.
  `index_info()` reads the raw descriptor instead of the lifted one, so it still
  answers `0` — the within-backend contradiction.

## Decision (settled — build this)

**An exposed implicit covering index describes itself as UNIQUE**, on every backend
and on every read surface. Rationale: rendered DDL exists to re-parse into the object
it describes, and `CREATE INDEX "uq" ON "t" ("x")` does not re-parse into something
that enforces uniqueness. Cost accepted: memory-mode DDL text changes and
`index_info().unique` becomes `1` for this shape on both backends.

The other arm — reverting the `unique: true` stamp so the flag belongs solely to the
constraint — was weighed and not taken. If a hard blocker turns up mid-implementation,
that reversal is the fallback, but say so in the review handoff rather than leaving
the surfaces disagreeing.

## Shape: one decision site, three consumers

The drift happened because the materialized path and the synthetic path each decided
uniqueness for themselves. The fix must leave exactly **one** function that answers
"how does this index describe itself", called by every read surface.

Add it to `schema/catalog.ts`, next to the private `implicitCoveringIndexExposure`
map it needs:

```ts
/**
 * The IndexSchema a *read* surface should render for `index` on `tableSchema`.
 * An exposed implicit covering structure describes itself as UNIQUE even though
 * its IndexSchema carries no flag (memory) or is synthesized (store) — the flag
 * is a display fact here, not an enforcement one, which stays on the constraint.
 * Pass `exposure` to reuse one map across a whole table's indexes.
 */
export function indexSchemaForDisplay(
  tableSchema: TableSchema,
  index: IndexSchema,
  exposure?: Map<string, boolean>,
): IndexSchema;
```

Rule: return `index` unchanged when `index.unique` is already true or the name is not
an *exposed* implicit covering structure; otherwise return `{ ...index, unique: true }`.
Hidden implicit structures never reach a read surface (they are filtered first), so
they are unaffected either way — but key off `exposure.get(name) === true`, not merely
"is implicit", so that stays true if the filters ever move.

Consumers, all three routed through it:

- `collectSchemaCatalog` — cleanest at the single funnel `indexSchemaToCatalog`, which
  already receives `tableSchema` and the `implicit` marker; both `ddl` and `definition`
  then pick up `UNIQUE` together.
- `schema()` TVF index loops — both the materialized loop and the synthetic loop.
- `index_info()` — build one `IndexSchema[]` (real indexes plus lifted synthetic
  descriptors, each through the helper) and read `idx.unique` off it. That also
  retires the `('unique' in idx && idx.unique)` shape-probe, which exists only because
  the two lists have different types today.

With the helper in place, `syntheticExposedIndexToIndexSchema` should stop stamping
`unique: true` itself — the descriptor lifts to a plain `IndexSchema` and the display
helper supplies the flag, so there is one answer, not two agreeing ones.

## Do NOT change the persistence path

`buildCatalogEntry` in `packages/quereus-store/src/common/store-module-catalog.ts`
renders DDL that is **re-imported** to rebuild a table, not shown to a user. It
deliberately emits no `CREATE INDEX` line for an exposed implicit index (a re-import
would materialize a real `IndexSchema` and change the store-mode shape) and carries
its tags on a trailing `alter index … set tags`. Leave it alone; the display helper is
for read surfaces only. Same for `rebuildUserIndexes` in
`runtime/emit/alter-table.ts`, which already excludes implicit structures from the
ALTER-rebuild re-create loop.

## Blast radius checked

- **Declarative differ**: `computeSchemaDiff` filters `CatalogIndex.implicit` out of
  its index buckets (`schema-differ.ts` ~line 528), so a changed `definition` for these
  entries cannot produce drift or a phantom DROP/CREATE.
- **Applied-schema snapshots** are in-memory only (`declared-schema-manager.ts`
  `appliedSnapshots`), so no stale rendering survives a process restart.
- **Existing assertions**: no test pins the DDL text or the `unique` column for this
  shape today (that is the coverage gap below).
  `apply-schema-unchanged-fast-path.spec.ts` matches
  `/^index .* on vehicles implicit$/m`, which is insensitive to the change.

## Coverage

The pin has to run under **both** backends. `yarn test:store` re-runs only the
`test/logic/*.sqllogic` files, so the cross-backend assertions belong in a sqllogic
file — `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` section 4 already
builds exactly this shape (`iul_e` / `uq_vin`) and is not on the memory-only skip list
in `logic.spec.ts`. Extend that section rather than adding a file.

## TODO

- Add `indexSchemaForDisplay` to `schema/catalog.ts` and export it; drop the
  `unique: true` stamp from `syntheticExposedIndexToIndexSchema`.
- Rewrite the stale `SyntheticExposedIndex` NOTE (~line 859) and the
  `syntheticExposedIndexToIndexSchema` docblock — both currently assert the *old*
  contract ("deliberately NO unique flag … so index_info()'s unique matches across
  backends").
- Route `indexSchemaToCatalog` through the helper.
- Route both `schema()` index loops through the helper.
- Rebuild `index_info()`'s iteration over a single lifted `IndexSchema[]`; update its
  comment, which currently states synthetic descriptors report `unique = 0`.
- Extend `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` section 4: assert
  the `sql` column from `schema()` for `uq_vin` contains `CREATE UNIQUE INDEX`, and that
  `select "unique" from index_info('iul_e') where index_name = 'uq_vin'` is `1`.
- Extend the memory-side test at `test/covering-structure.spec.ts` ~line 913 to assert
  the catalog `definition` is `unique index (vin)` (the catalog surface is not
  reachable from sqllogic).
- Add a negative pin in the same sqllogic section: a *plain* (unexposed) UNIQUE
  constraint still surfaces no index row at all, and an ordinary `create index`
  (non-unique) still renders without `UNIQUE` — so the helper cannot over-apply.
- Update docs: `docs/sql-vtab.md` section 6.3 bullet (~184), `docs/schema.md`
  Introspection note (~99), `docs/functions.md` (~578) — state that an exposed implicit
  covering index reports itself as UNIQUE in both `schema()` DDL and
  `index_info().unique`, on every backend, while uniqueness *enforcement* remains the
  constraint's.
- Validate: `yarn workspace @quereus/quereus run lint`, `yarn test`, and
  `yarn test:store` (the store leg is the whole point).
