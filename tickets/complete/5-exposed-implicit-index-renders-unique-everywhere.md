description: A table's auto-created index for a UNIQUE constraint used to be described differently depending on which storage backend was running; now every place that describes it agrees and says it is unique.
files:
  - packages/quereus/src/schema/catalog.ts                       # indexSchemaForDisplay (~460), displayIndexesForTable + DisplayIndex (new, ~477), implicitCoveringIndexExposure exported (~420), syntheticExposedIndexToIndexSchema (~955), collectSchemaCatalog index arm (~242-250), indexSchemaToCatalog (~1038)
  - packages/quereus/src/func/builtins/schema.ts                 # schema() index loop (~140-155), index_info() body (~404-425)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # section 4 pins
  - packages/quereus/test/covering-structure.spec.ts             # ~925 memory-side catalog assertions
  - packages/quereus/test/index-ddl-roundtrip.spec.ts            # ~147 exposed-implicit round-trip block
  - docs/sql-vtab.md, docs/schema.md, docs/functions.md, docs/store-catalog-persistence.md

# Exposed implicit covering index renders as UNIQUE everywhere

## What shipped

An exposed implicit covering index — the auto-built secondary structure backing a
UNIQUE constraint tagged `quereus.expose_implicit_index = true` — now describes
itself as UNIQUE on every read surface and on both backends: `collectSchemaCatalog`'s
`ddl` / `definition`, `schema()`'s rendered DDL, and `index_info().unique`.

Two functions in `packages/quereus/src/schema/catalog.ts` carry it:

```ts
/** How one index describes itself. */
export function indexSchemaForDisplay(
  tableSchema: TableSchema, index: IndexSchema, exposure?: Map<string, boolean>,
): IndexSchema

/** Which indexes a read surface lists, already display-rendered. */
export function displayIndexesForTable(tableSchema: TableSchema): DisplayIndex[]
```

`indexSchemaForDisplay` returns the index untouched unless it is an *exposed*
implicit structure lacking the flag (keyed off the exposure map, not mere
implicitness); then it returns `{ ...index, unique: true }`.

`displayIndexesForTable` — added during review, see findings — is the single
enumeration all three read surfaces call. It filters hidden implicit structures,
appends the store-mode synthetics (`exposedImplicitIndexes` lifted through
`syntheticExposedIndexToIndexSchema`), and renders every entry through
`indexSchemaForDisplay`, returning `{ index, implicit }` pairs so
`collectSchemaCatalog` still gets the `implicit` marker the differ needs.

`syntheticExposedIndexToIndexSchema` is a plain structural lift that stamps no
flags — memory and store now reach the same answer by the same route rather than
by two routes that happened to agree.

Deliberately **not** routed through the helper (a NOTE on `indexSchemaForDisplay`
names them): `buildCatalogEntry` in quereus-store, `rebuildUserIndexes`, the
memory/store schema-change events, and quereus-sync's `assertDefinitionMatches`.
Those render DDL that is re-executed or compared for replication, not shown.

Verify by hand:

```sql
create table t (id integer primary key, x integer not null,
  constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true));

select sql from schema() where type = 'index' and name = 'uq';
-- CREATE UNIQUE INDEX "uq" ON "main"."t" ("x" COLLATE BINARY)   -- both backends

select "unique" from index_info('t') where index_name = 'uq';
-- 1                                                             -- both backends
```

## Review findings

Read the implement diff (`470764487`) first, then the handoff. The implementation
was correct as specified — no fallback taken, no surface left disagreeing. Findings
below are what the pass added on top.

### Fixed in this pass (minor)

- **DRY / architecture — the enumeration was still triplicated.** The implement
  ticket collapsed the *uniqueness* decision to one site but left all three read
  surfaces independently spelling out the same three-step recipe: build the
  exposure map, filter hidden implicit structures, append the store-mode
  synthetics, render. The uniqueness bug was one instance of the class "a read
  surface forgets one of the steps"; the other steps were still open to it.
  Climbing to the boundary-invariant rung: added `displayIndexesForTable`, the one
  enumeration those three now call. `collectSchemaCatalog` lost its two index
  loops, `schema()` lost its two, `index_info()` lost its two-list merge —
  ~50 lines of duplication retired, and `indexSchemaToCatalog` no longer needs the
  exposure map threaded into it. Behavior is unchanged (order preserved:
  materialized first, then synthetics); the full suite on both backends confirms.
- **Missing shapes, now pinned** (all were listed as gaps in the handoff; all
  passed on first run on both backends, so these are regression pins, not fixes).
  Added to `10.5.7-implicit-unique-index-lifecycle.sqllogic` § 4:
  - unnamed exposed constraint → auto-name `_uc_code`: `CREATE UNIQUE INDEX` +
    `unique = 1`;
  - multi-column exposed constraint under a **mixed-case** name (`UQ_AB`):
    `CREATE UNIQUE INDEX`, and both columns report `unique = 1` — this is the
    mixed-case-plus-exposed-plus-display combination that had no coverage.
- **Round-trip claim now tested.** `test/index-ddl-roundtrip.spec.ts` gained an
  `exposed implicit covering index` block: the rendered DDL re-parses to a
  `createIndex` AST with `isUnique === true`, and re-executed against a plain table
  it builds an index that actually rejects a duplicate. The block's docblock is
  explicit that this is *not* an identity round-trip — re-import materializes a real
  `IndexSchema` with no originating constraint — which is precisely why the
  persistence bundle omits the line.
- **Docs.** `docs/schema.md` § Introspection now names `displayIndexesForTable` as
  the enumeration, not just `indexSchemaForDisplay` as the decision.
  `docs/store-catalog-persistence.md` gained the missing half of the story: the
  read surfaces *do* render `CREATE UNIQUE INDEX` for a structure this bundle
  deliberately omits, and why that asymmetry is correct.

### Checked and clean

- **`renderCatalogForComparison` / `apply schema` fast path.** Flagged as
  unverified in the handoff; verified now. The `catalogRendering` snapshot lives
  only in `DeclaredSchemaManager` in memory (`AppliedSchemaSnapshot`), is recomputed
  from the live catalog on every apply, and is never persisted — so a changed
  `definition` for an `implicit` entry changes both sides of the comparison
  together and cannot flip the unchanged-catalog fast path. `computeSchemaDiff`
  filters `CatalogIndex.implicit` out of `actualIndexes` before the rename /
  create / drop buckets are built, so the changed value never reaches the differ
  at all. `apply-schema-unchanged-fast-path.spec.ts` and the covering-structure
  idempotency suite pass.
- **`schema-hasher.ts`** hashes the declared AST, not the catalog — untouched by
  a `definition` change.
- **Public-API surface question.** The handoff left this as a judgment call.
  Searched `quoomb-web`, `shared-ui`, `quoomb-cli` and `quereus-vscode` for any
  index-DDL rendering or `schema()` / `index_info()` consumption: there is none —
  no `indexes` reference outside one unrelated comment. Keeping
  `displayIndexesForTable` / `indexSchemaForDisplay` package-internal is right for
  today. If an out-of-package schema tree ever renders index DDL, export
  `displayIndexesForTable` from `src/index.ts` rather than letting the caller
  re-derive the list.
- **`exposedIndexTags` × UNIQUE.** The handoff called this un-pinned; it is
  covered incidentally — sqllogic § 4 sets tags on `uq_vin` and then asserts the
  `CREATE UNIQUE INDEX` rendering and `unique = 1` on that same index, so the two
  are already exercised together.
- **quereus-store persistence and quereus-sync replication.** `buildCatalogEntry`
  uses `isHiddenImplicitIndex` / `exposedImplicitIndexes` directly and never the
  display helpers; `assertDefinitionMatches` compares
  `generateIndexDDL(owner.index, …)` for real materialized indexes only. Both
  unaffected, both suites green.

### Recorded as a NOTE, not a ticket

- **`SyntheticExposedIndex.predicate` is unreachable today.** The handoff asked for
  a partial-predicate test where `partial` and `unique` both read 1. There is no
  such case to test: `uc.predicate` is only ever set by `appendIndexToTableSchema`
  for a constraint synthesized from `CREATE UNIQUE INDEX … WHERE`, and such a
  constraint carries `derivedFromIndex`, which `exposedImplicitIndexes` and
  `implicitCoveringIndexExposure` both skip. The inline grammar
  `unique (x) where …` does not parse. NOTE added at the field saying so, and
  saying to pin `partial = 1` if an inline partial-UNIQUE grammar ever lands.
- **`catalog.ts` size.** 1169 lines (`wc -l packages/quereus/src/schema/catalog.ts`),
  up ~35 net across implement + review. Not filed: its schema-package peers are
  larger (`schema-differ.ts` 3114, `manager.ts` 3668, `table.ts` 1769), and this
  ticket's additions consolidated more code than they added.

### Not found

No correctness defects. Specifically probed and found nothing: name-collision
between an exposed structure and an ordinary index on the same table (blocked by
`assertUniqueConstraintIndexNameFree`); the cross-table `uq_email` case (the
exposure map is per table); a `derivedFromIndex` constraint reaching the helper
(skipped by the map, and its index already carries `unique`); tag loss through
the object spread.

## Validation

| command | result |
|---|---|
| `yarn workspace @quereus/quereus run lint` | clean (eslint + `tsc -p tsconfig.test.json --noEmit`) |
| `node packages/quereus/test-runner.mjs` | **10284 passing**, 25 pending, 0 failing |
| `node packages/quereus/test-runner.mjs --store` | **10276 passing**, 33 pending, 0 failing |
| `yarn workspaces foreach … run test` (all other workspaces) | all green — quereus-store 1931, quereus-sync 736, plugin-loader 119, sync-client 85, quoomb-cli 64, quoomb-web 68, isolation/others green |
| `yarn build` | clean |

Both quereus counts are +2 over the implement handoff — the two new round-trip
tests. No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not
written.
