description: A table's auto-created index for a UNIQUE constraint used to be described differently depending on which storage backend was running; now every place that describes it agrees and says it is unique.
files:
  - packages/quereus/src/schema/catalog.ts                       # indexSchemaForDisplay (new, ~455), implicitCoveringIndexExposure now exported (~420), syntheticExposedIndexToIndexSchema (~914), collectSchemaCatalog index arms (~242-273), indexSchemaToCatalog (~1004)
  - packages/quereus/src/func/builtins/schema.ts                 # schema() index loops (~140-178), index_info() body (~425-450)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # section 4, new pins at ~line 106-146
  - packages/quereus/test/covering-structure.spec.ts             # ~line 925 memory-side catalog assertions
  - docs/sql-vtab.md                                             # §6.3 bullet
  - docs/schema.md                                               # "Introspection" paragraph
  - docs/functions.md                                            # index_info() column table note
difficulty: medium

# Exposed implicit covering index renders as UNIQUE everywhere

## What landed

The decision the implement ticket carried was built as specified — **no fallback
was taken, nothing was left disagreeing.** An exposed implicit covering index (the
auto-built secondary structure backing a UNIQUE constraint tagged
`quereus.expose_implicit_index = true`) now describes itself as UNIQUE on every
read surface and on both backends.

One new function is the single decision site:

```ts
// packages/quereus/src/schema/catalog.ts
export function indexSchemaForDisplay(
  tableSchema: TableSchema,
  index: IndexSchema,
  exposure?: Map<string, boolean>,
): IndexSchema
```

Returns `index` untouched when it already carries `unique`, or when
`exposure.get(name.toLowerCase()) !== true`. Otherwise returns
`{ ...index, unique: true }`. Keying off the exposure map (rather than mere
implicitness) is deliberate, per the ticket.

Three consumers now route through it, and none decides uniqueness for itself:

- `indexSchemaToCatalog` — the single funnel behind `collectSchemaCatalog`, so
  `ddl` and `definition` pick up the keyword together.
- Both `schema()` TVF index loops (materialized and synthetic).
- `index_info()` — its two differently-typed lists were merged into one
  `IndexSchema[]` (synthetic descriptors lifted, then every entry mapped through
  the helper), which retired the `('unique' in idx && idx.unique)` shape-probe.

`syntheticExposedIndexToIndexSchema` no longer stamps `unique: true` — it is now a
plain structural lift. Its docblock and the `SyntheticExposedIndex` NOTE, which
both asserted the *old* contract, were rewritten.

Two incidental changes worth a reviewer's eye:

- `implicitCoveringIndexExposure` is now **exported** from `catalog.ts` so
  `schema.ts` can hoist one map per table. That also resolved a standing NOTE in
  the `schema()` loop about rebuilding the map per index (O(indexes × unique
  constraints)); the `isHiddenImplicitIndex` call in that loop became a direct
  `exposure.get(...) === false` lookup, which is the same predicate inlined.
- `isHiddenImplicitIndex` is no longer imported by `schema.ts`. It is still used
  by `schema/manager.ts`, `quereus-store`, and the public barrel, so the export
  stays.

## Untouched on purpose

- `buildCatalogEntry` (`packages/quereus-store/src/common/store-module-catalog.ts`)
  — persistence, re-imported not read.
- `rebuildUserIndexes` (`runtime/emit/alter-table.ts`) — already excludes implicit
  structures.
- The memory/store schema-change **event** DDL (`vtab/memory/layer/manager.ts`,
  `store-module-index.ts`) and quereus-sync's `assertDefinitionMatches` — these
  render DDL that is re-executed or compared for replication, not shown. A NOTE
  in the `indexSchemaForDisplay` docblock names all of them so a future reader
  does not "finish the job" by routing them through the helper too.

## How to check it yourself

```sql
create table t (
  id integer primary key,
  x integer not null,
  constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true)
);

select sql from schema() where type = 'index' and name = 'uq';
-- CREATE UNIQUE INDEX "uq" ON "main"."t" ("x" COLLATE BINARY)   -- both backends

select "unique" from index_info('t') where index_name = 'uq';
-- 1                                                             -- both backends
```

And from TypeScript, `collectSchemaCatalog(db).indexes` for that entry now carries
`definition: 'unique index (x)'` and a `ddl` matching `/^create unique index /i`.

Run the store leg with a `Database` whose `default_vtab_module = 'store'` over the
LevelDB provider — or just let the sqllogic file below cover it.

## Tests added

- `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`, section 4 — runs
  under **both** backends (`yarn test` and `yarn test:store`), which is the whole
  point of putting the pins here:
  - `schema()` DDL for `uq_vin` starts with `CREATE UNIQUE INDEX`.
  - `index_info('iul_e')` reports `unique = 1` for `uq_vin`.
  - Negative pin `iul_p`: a *plain* (unexposed) UNIQUE constraint still surfaces
    no index row at all — `schema()` count 0, `index_info` count 0.
  - Negative pin `iul_o`: an ordinary `create index ix_label` still renders
    `CREATE INDEX` (no UNIQUE) and reports `unique = 0`.
- `test/covering-structure.spec.ts` (~925) — the memory-side catalog surface,
  which sqllogic cannot reach: asserts `definition === 'unique index (x)'` and
  `ddl` matches `/^create unique index /i`.

Note on the sqllogic pins: `like` evaluates to a **boolean** in this engine, so the
expectations are written `→ [{"is_unique_ddl":true}]`, not `1`. Worth knowing before
adding sibling assertions.

## Validation run

| command | result |
|---|---|
| `yarn workspace @quereus/quereus run lint` | clean (eslint + `tsc -p tsconfig.test.json --noEmit`) |
| `node packages/quereus/test-runner.mjs` (memory) | **10282 passing**, 25 pending, 0 failing |
| `node packages/quereus/test-runner.mjs --store` | **10274 passing**, 33 pending, 0 failing |
| all other workspaces (`yarn workspaces foreach … run test`, excluding `@quereus/quereus`) | all green — plugin-loader 119, quereus-store 1931, quereus-sync 736, sync-client 85, quoomb-cli 64, quoomb-web 68, isolation/others green |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

Logs (auto-pruned) at `tickets/.logs/5-exposed-implicit-index.{memory,store,others}.log`.

## Known gaps — treat these as the floor, not the ceiling

Places a reviewer should actually push on:

- **Only one shape is pinned.** Every new assertion uses a *named, single-column,
  non-partial* exposed constraint. Untested and worth probing:
  - the **unnamed** form (`unique (x) with tags (…)` → `_uc_x`) — nothing asserts
    its rendered DDL or `unique` column;
  - a **multi-column** exposed constraint;
  - an exposed constraint with a **partial predicate** (`uc.predicate`), where
    `partial` and `unique` should both read 1;
  - a **mixed-case** constraint name on the display path specifically. The
    exposure map is lowercase-keyed and the helper folds case, and an existing
    test covers the *hiding* path under mixed case, but no test covers mixed-case
    + exposed + display.
- **No round-trip test that the new DDL re-parses.** The stated rationale for the
  change is "rendered DDL exists to re-parse into the object it describes", yet
  nothing asserts that `CREATE UNIQUE INDEX "uq" ON …` actually parses back into a
  unique index. `test/index-ddl-roundtrip.spec.ts` is the natural home; I did not
  extend it. Note the round-trip is not an *identity* here — re-importing this DDL
  materializes a real `IndexSchema`, which is precisely why the persistence path
  omits the line. A reviewer should decide whether the round-trip claim deserves a
  test that is honest about that asymmetry, or none at all.
- **`apply schema` idempotency was verified only by the existing suite passing.**
  `computeSchemaDiff` filters `CatalogIndex.implicit` out of its index buckets, so
  a changed `definition` for these entries cannot produce drift — that is the
  ticket's blast-radius analysis, and the full suite (including
  `apply-schema-unchanged-fast-path.spec.ts` and the covering-structure
  idempotency suite) passes. But I did not write a *new* test that specifically
  converges an exposed-implicit schema across the definition change. If you want
  that guarantee pinned rather than inferred, it is not pinned.
- **`renderCatalogForComparison` was not re-examined.** `definition` and `ddl`
  already participate in the fast-path rendering; I changed their *values*, not
  the field set, so the compiler-enforced exhaustiveness guard was never
  implicated. Cheap to double-check that a `definition` change for an `implicit`
  entry cannot flip the unchanged-catalog fast path.
- **Public-API surface question, unresolved by me.** `indexSchemaForDisplay` is
  package-internal (not re-exported from `src/index.ts`). If an out-of-package
  consumer ever renders index DDL *for display* — quoomb-web's schema tree is the
  obvious candidate — it will silently render the pre-fix text and the drift comes
  back across a package boundary instead of a backend boundary. I found no such
  consumer today, so I left it internal; that is a judgment call worth a second
  opinion rather than a fact.
- **`exposedIndexTags` interaction not re-pinned.** The helper spreads `index` and
  overrides only `unique`, so tags ride through unchanged, and the existing
  section-4 tag assertion still passes. No new test covers tags *and* the UNIQUE
  rendering together.
