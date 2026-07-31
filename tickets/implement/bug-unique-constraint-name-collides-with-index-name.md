---
description: Giving a UNIQUE constraint the same name as an index that already exists on the same table is currently allowed, and it silently corrupts the table — queries against the indexed column start returning no rows, and on the persistent backend the index is permanently lost from the saved schema and the uniqueness rule stops catching duplicates.
prereq:
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts        # ALTER TABLE ADD CONSTRAINT — engine-side pre-dispatch checks
  - packages/quereus/src/runtime/emit/alter-table.ts           # runRenameConstraint ~1100, runAddColumn ~435
  - packages/quereus/src/schema/catalog.ts                     # implicitIndexName ~391, implicitCoveringIndexExposure ~375, isImplicitCoveringIndex ~498
  - packages/quereus/src/schema/manager.ts                     # createIndex ~2352 (the mirror-image guard), importIndex ~3361
  - packages/quereus/src/vtab/memory/layer/manager.ts          # ensureUniqueConstraintIndexes ~246 (context — reads, no change expected)
  - packages/quereus-store/src/common/implicit-unique-index.ts # withImplicitUniqueIndexes ~141 (context — reads, no change expected)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic
  - packages/quereus-store/test/index-persistence.spec.ts      # reopen harness to copy for the durability test
  - docs/sql-ddl.md                                            # §6.3, index-name namespace bullets
difficulty: medium
repro: verified
---

## Background: the two things that share one name

A plain `UNIQUE` constraint (`constraint foo unique (a)`) is enforced through an
automatically built secondary index that the user never asked for and never sees.
That hidden index is **named after the constraint** — `foo`, or `_uc_<columns>`
when the constraint is unnamed. Both storage backends do this, and the name is
computed in one place, `implicitIndexName` in
`packages/quereus/src/schema/catalog.ts`.

So a constraint named `foo` and a user index named `foo` want the same name on
the same table. The engine already refuses that collision **from the index side**:
`SchemaManager.createIndex` calls `isImplicitCoveringIndex` and rejects
`create index foo on t (…)` when `t` already carries a `foo` UNIQUE constraint
(`docs/sql-ddl.md` §6.3, bullet "…but the name is taken on the constraint's own
table"). There is no equivalent check **from the constraint side**. Declaring the
constraint second is accepted, and that is the whole bug.

## What actually happens (all measured on the current tree)

Setup used throughout:

```sql
create table t (id integer primary key, a text, b text);
create index foo on t (b);
insert into t values (1, 'x', 'p'), (2, 'y', 'q');
alter table t add constraint foo unique (a);   -- accepted today
```

Once the constraint exists, `implicitCoveringIndexExposure` maps the name `foo`
to "hidden implicit backing structure". Every surface keyed by index name —
introspection, the declarative-schema catalog, `drop index`, and the physical
store name on the persistent backend — now conflates the user's index with the
constraint's backing structure.

### Both backends: the user's index disappears from every read surface

```sql
select count(*) from schema()     where name = 'foo';  -- 0  (was 1)
select count(*) from index_info('t') where index_name = 'foo';  -- 0
drop index foo;   -- error: no such index
```

The index is still in the table's internal index list, still being maintained on
every write, and is no longer addressable or visible by any means.

### In-memory backend: queries on the indexed column return wrong answers

`ensureUniqueConstraintIndexes` looks for a reusable index by *columns*, not by
name. Index `foo` is on `b`, the constraint is on `a`, so it appends a **second**
index also named `foo`, on `a`. Confirmed directly against
`db._findTable('t').indexes`:

```json
[{"name":"foo","columns":[{"index":2,…}]},   // the user's, on b
 {"name":"foo","columns":[{"index":1,…}]}]   // the constraint's, on a
```

Reads then resolve by first match and land on the wrong structure:

| query | correct | actual |
| --- | --- | --- |
| `select id from t where b = 'q'` | `[{id:2}]` | `[]` |
| `select id from t where b = 'p'` | `[{id:1}]` | `[]` |
| `select id from t where a = 'y'` | `[{id:2}]` | `[{id:1},{id:2}]` |
| `select * from t` (no predicate) | 2 rows | 2 rows ✓ |

Rows silently vanish from one predicate and silently multiply on the other. A
full scan is still correct, so nothing errors and nothing warns. UNIQUE itself is
still enforced correctly here.

`alter table t drop constraint foo` does not recover: it tears down **both**
entries named `foo`, so the user's index is destroyed too (`indexes` ends up
empty).

### Persistent (store) backend: durable schema loss, then a silently unenforced UNIQUE

Reads stay correct while the database is open (the store never materializes the
constraint's structure into the engine-facing index list, so the user's index is
the only `foo` there). The damage is on disk.

`buildCatalogEntry` in
`packages/quereus-store/src/common/store-module-catalog.ts` skips any index that
`isHiddenImplicitIndex` reports — which is now the user's index. The catalog entry
rewritten at `ALTER TABLE` time therefore **drops the `CREATE INDEX` line**:

```
-- before the ALTER
CREATE TABLE "main"."t" (…) USING store
CREATE INDEX "foo" ON "main"."t" ("b" COLLATE BINARY)

-- after the ALTER
CREATE TABLE "main"."t" (…, constraint foo unique (a)) USING store
```

The declared index is gone from the durable schema immediately, with no error and
no warning. On the next open (`rehydrateCatalog` reports zero errors):

- `index_info('t')` is empty — the index is gone for good.
- The constraint's backing structure is materialized under the name `foo`, and
  the physical store name is a pure function of schema + table + index name
  (`buildIndexStoreName`), so **it binds to the orphaned index store the user's
  index left behind** — 2 entries, keyed on column `b`.
- Uniqueness is checked by seeking that store for the value of `a`. The `b`-keyed
  entries never match, so **every row that existed at collision time is invisible
  to the constraint**:

  ```sql
  insert into t values (3, 'x', 'z');   -- accepted; row 1 already has a = 'x'
  select a from t;                      -- x, y, x   ← declared UNIQUE violated
  ```

  The duplicate is durable and unrepairable: a second reopen still shows both
  rows, and by then the constraint enforces normally again (the row-3 insert
  wrote a correctly-keyed entry), so the violation is frozen in place with no
  diagnostic ever emitted.

The store's own recovery path is also broken. `alter table t drop constraint foo`
deletes the shared physical index store (2 entries → 0) while leaving the user's
index in the schema and re-persisting its `CREATE INDEX` line — a live index
declaration over an empty backing store, so `select id from t where b = 'q'`
returns `[]` from then on, durably.

## Root cause

One missing check, mirroring one that already exists.

`SchemaManager.createIndex` guards the index-vs-constraint namespace overlap in
one direction. Nothing guards the other direction: no code path that **declares
or renames a UNIQUE constraint** asks whether the backing-structure name it is
about to claim is already held by an index on that same table. Everything above —
the duplicate index entry in memory, the dropped `CREATE INDEX` line, the
orphaned store adoption, the unenforced UNIQUE — is downstream of that one
omission. Reject the declaration and none of it is reachable.

## Authoring paths that reach it

All four verified broken on **both** backends (each leaves the user's index
invisible to `schema()`):

| path | example |
| --- | --- |
| `ALTER TABLE … ADD CONSTRAINT` | `alter table t add constraint foo unique (a)` |
| `ALTER TABLE … RENAME CONSTRAINT` | `alter table v rename constraint bar to baz` |
| unnamed constraint's auto-name | `alter table u add unique (a)` with index `_uc_a` present |
| `ALTER TABLE … ADD COLUMN … unique` | `alter table w add column c text unique` with index `_uc_c` present |

`CREATE TABLE` cannot reach it — a table is created with no indexes, and
`create index` afterwards is already refused. `apply schema` / `declare schema`
emit `ALTER TABLE … ADD <constraint fragment>` text
(`schema-differ.ts` ~2593) which runs through the normal statement pipeline, so
it is covered by the `ADD CONSTRAINT` arm and needs no separate site.

## Expected behavior

Reject at declaration time, on both backends, on all four paths above. The error
should name both objects and say what to do, in the register of the existing
cross-table message in `createIndex`:

```
Cannot add constraint 'foo' to table 't': its backing index would collide with
existing index 'foo' on the same table. Rename the constraint or the index.
```

Use `StatusCode.CONSTRAINT`, matching the index-side refusal.

Details settled during investigation — implement to these, don't re-litigate:

- **Reject even when the columns match.** `create index foo on t (a)` followed by
  `add constraint foo unique (a)` is the one case where the two structures would
  physically coincide, so nothing goes wrong at runtime. It is still rejected: the
  effect is that the user's declared index is silently reclassified as a hidden
  backing structure, vanishes from `schema()` and from the persisted catalog, and
  stops being droppable. The legitimate reuse case (a constraint reusing an
  existing index to avoid a duplicate structure) works on *columns*, not names, and
  is unaffected — it is `constraint bar unique (a)` reusing index `foo`.
- **Only UNIQUE.** CHECK and FOREIGN KEY constraints build no backing index, so
  they cannot collide. Scope the guard to the UNIQUE arm.
- **A `create unique index`-derived constraint stays legal.** `create unique index
  foo on t (a)` synthesizes a UNIQUE constraint named `foo` alongside index `foo`
  by design (`derivedFromIndex` set), and `implicitCoveringIndexExposure` already
  skips those. The guard must not fire on it.
- **No rehydration carve-out is needed for the new guard.** The ticket that
  produced this one asked whether reopening an already-collided database should
  warn-and-proceed instead of failing, following §6.3's precedent. It does not
  arise: `importCatalog` → `importDDL` imports the `CREATE TABLE` (constraints
  included) *before* any `CREATE INDEX`, so at constraint-declaration time the
  table carries no indexes and the guard cannot fire. Add the guard
  unconditionally.
- **The one rehydration path that can meet a collision is `importIndex`**
  (`manager.ts` ~3361), which deliberately skips `isImplicitCoveringIndex` so a
  pre-existing collided catalog still opens. Keep that behavior — but it is
  currently *silent*, and §6.3 promises a warning for the sibling cross-table
  case. Add a `warnLog` there naming the index and the constraint that holds the
  name. Do not reject.

## Implementation shape

Add one shared predicate next to the existing name machinery in
`packages/quereus/src/schema/catalog.ts` — that file already owns
`implicitIndexName`, `implicitCoveringIndexExposure`, `isHiddenImplicitIndex` and
`isImplicitCoveringIndex`, so the new check belongs beside them rather than in
three emitters. Something along the lines of:

```ts
/**
 * The existing index on `tableSchema` whose name would be claimed by the backing
 * structure of a UNIQUE constraint declared as `constraintName` over
 * `columnIndices` — or undefined when the name is free. Mirror of the guard
 * `SchemaManager.createIndex` applies from the index side.
 */
export function findIndexShadowedByUniqueConstraint(
  tableSchema: TableSchema,
  constraintName: string | undefined,
  columnIndices: ReadonlyArray<number>,
): IndexSchema | undefined
```

It resolves the prospective name the same way `implicitIndexName` does
(`constraintName ?? '_uc_<colNames>'`) and matches case-insensitively against
`tableSchema.indexes`, like every other index-name comparison in the engine.
`implicitIndexName` is currently module-private; either export it or factor the
name computation so both callers share one copy — do **not** add a fourth
spelling of the `_uc_` naming rule (`quereus-store`'s
`implicitUniqueIndexName` and `MemoryTableManager.implicitIndexNameFor` already
mirror it, and their doc comments say the three must stay equal).

Call it from three engine-side sites, each of which already has a
validate-before-module-dispatch block to extend:

- `runAddConstraintViaModule` in `runtime/emit/add-constraint.ts` — alongside the
  existing FK-collation pre-check, and for the same reason stated in that
  comment: a rejection after `module.alterTable` would already have persisted.
- `runRenameConstraint` in `runtime/emit/alter-table.ts` (~1100) — next to the
  existing `namedConstraintExists` collision check, which is its exact analogue
  for the constraint namespace.
- `runAddColumn` in `runtime/emit/alter-table.ts` (~435) — for an inline `unique`
  in the column definition. The column does not exist yet, so the auto-name comes
  from the column definition's own name (`_uc_<colName>`), not from a resolved
  column index; make sure the helper's signature accommodates that or give this
  site a thin wrapper.

Placing the guard engine-side, before module dispatch, is what makes one arm cover
both backends — the same reasoning the `createIndex` comment gives for its
`isImplicitCoveringIndex` term.

The memory backend's `ensureUniqueConstraintIndexes` and the store's
`withImplicitUniqueIndexes` need no change: with the collision refused up front,
neither can be handed a name that is already taken. Both are listed in `files:`
as reading material only.

## Note on an overlapping open ticket

`tickets/backlog/debt-memory-unique-index-reuse-after-create-index` also names
`ensureUniqueConstraintIndexes`. It is a different concern — the in-memory backend
decides index reuse once at table-construction time and never revisits it, so a
`create index` that arrives after a `UNIQUE` leaves two *identical* structures
maintained forever. That is a cost problem with no wrong behavior, and it is about
constraints and indexes with **different** names. No site is shared with this
ticket's fix; nothing here needs to wait on it.

## Reproducing

Two scratch harnesses were used; both were deleted after the investigation.
Recreate them as real tests (see TODO).

Backend-parity behavior, as a `.sqllogic` file under
`packages/quereus/test/logic/` — run memory then store:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  packages/quereus/test/logic.spec.ts --grep "<file stem>" --reporter spec

QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts \
  --grep "<file stem>" --reporter spec
```

Durability behavior needs a close → reopen against the same storage, which
`.sqllogic` cannot express. Copy the persistent-provider + `open()` / `reopen()`
helpers from `packages/quereus-store/test/index-persistence.spec.ts` — they
already expose `catalogEntry()` (the raw persisted bundle) and
`indexStoreSize()` (physical entry count), which is exactly what shows the
dropped `CREATE INDEX` line and the orphaned store. Run with:

```
node --import ./packages/quereus-store/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus-store/test/<file>.spec.ts" \
  --reporter spec
```

## TODO

- Add the shared name-collision predicate to `packages/quereus/src/schema/catalog.ts`, reusing the existing `implicitIndexName` computation rather than restating the `_uc_<cols>` rule.
- Wire it into `runAddConstraintViaModule` (`runtime/emit/add-constraint.ts`), before `module.alterTable` is called.
- Wire it into `runRenameConstraint` (`runtime/emit/alter-table.ts` ~1100), beside the existing `namedConstraintExists` check.
- Wire it into `runAddColumn` (`runtime/emit/alter-table.ts` ~435) for an inline `unique` column constraint, handling the not-yet-existing column's auto-name.
- Add the `warnLog` to `SchemaManager.importIndex` (`schema/manager.ts` ~3361) for an imported index whose name is held by that table's own UNIQUE constraint; keep it warn-and-proceed and update the existing NOTE comment there to say the warning now exists.
- Add a `.sqllogic` case covering all four authoring paths on both backends, asserting the rejection message. Extend `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic` (it already owns the index-side half of this rule and runs dual-backend) rather than starting a new file, unless it grows unwieldy.
- Add a store reopen test pinning the durability guarantee: with the collision now refused, a `create index` + a same-named `add constraint` attempt leaves the `CREATE INDEX` line intact in the persisted catalog bundle and the index's backing store populated after reopen.
- Add a memory-side assertion that `db._findTable(t).indexes` never contains two entries with the same name after a refused declaration — `test/alter-drop-rename-constraint.spec.ts` already reads that array directly and is the natural home.
- Update `docs/sql-ddl.md` §6.3: add a bullet symmetric to the existing "…but the name is taken on the constraint's own table", stating that declaring or renaming a UNIQUE constraint onto a name already held by an index on the same table is likewise rejected, and that this covers `ADD CONSTRAINT`, `RENAME CONSTRAINT`, `ADD COLUMN … unique`, and the `apply schema` equivalents.
- Re-run the neighbouring suites that pin the existing half of this rule and must not regress: `10.5.5-index-name-uniqueness`, `10.5.7-implicit-unique-index-lifecycle`, `41.6-alter-drop-rename-constraint` (all dual-backend), plus `test/alter-drop-rename-constraint.spec.ts` and `test/schema-manager.spec.ts`.
- Run `yarn test`, `yarn test:store`, and `yarn lint` before handing off.
