---
description: Renaming an in-memory table to a name the persistent store cannot write leaves any saved table that referenced it holding an out-of-date definition on disk, and the statement still reports success.
files:
  - packages/quereus/src/schema/catalog-persistability.ts            # assertRenameDependentsPersistable — add the dependent-TABLE arm here
  - packages/quereus/src/runtime/emit/alter-table.ts                 # the two rename pre-flights; rewriteTableForTableRename / rewriteTableForColumnRename (~lines 199, 341, 1975, 2119)
  - packages/quereus/src/vtab/module.ts                              # CatalogObjectKind (~line 587) + the assertCatalogObjectPersistable docstring above it
  - packages/quereus/src/util/ast-spine-clone.ts                     # spineCloneAst — the copy-before-rewrite primitive
  - packages/quereus-store/src/common/store-module-catalog.ts        # the store's veto (~line 226) and its table write path (buildCatalogEntry / persistCatalogIfChanged)
  - packages/quereus-store/src/common/store-module.ts                # resolveOwnedTable (~line 166) — the synchronous ownership test to mirror
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts          # sibling rename tests live in the "a RENAME that would make …" describe (~line 452)
  - docs/schema.md                                                   # § catalog persistence / RENAME pre-flight (~lines 353-425)
  - docs/module-authoring.md                                         # hook table rows for assertCatalogObjectPersistable (~lines 441, 471)
difficulty: medium
repro: verified
---

## What is wrong

`alter table … rename to` / `rename column` also rewrites every OTHER table that
mentioned the renamed object — foreign-key targets, `check` expressions, partial-index
predicates. When such a dependent table is store-backed, its saved definition on disk
has to be rewritten too.

That rewrite is fire-and-forget: it rides `SchemaChangeNotifier` (try/catch per
listener, log only) and then the store's async persist queue (`.catch`-log). So if the
new name cannot be encoded for storage, the statement still reports success, the live
definition takes the new name, and the saved definition keeps the old one. The only
trace is a console line.

A "lone surrogate" is a broken half of a Unicode character (`'\uD800'` in JavaScript).
No UTF-8 byte sequence encodes one, so the store refuses to write text containing it.
The sibling fix `bug-store-rename-into-lone-surrogate-drops-dependent-view-or-mv` added
a pre-flight that refuses such a rename up front — but it inspects dependent **views and
materialized views** only. Dependent plain **tables** are not inspected, because the
module hook it asks (`VirtualTableModule.assertCatalogObjectPersistable`) accepts only a
view or a materialized view: `CatalogObjectKind` has no `'table'` case.

## Reproduction (run, observed)

Ran as a throwaway Mocha spec in `packages/quereus-store/test/` against an in-memory
KV provider. All three shapes below reported **success** and diverged.

```
create table st (id integer primary key, v integer) using store;   -- makes the store live
create table m  (id integer primary key, x integer);               -- in-memory: no store guard
create table s2 (id integer primary key,
                 mid integer references m(id)) using store;
insert into m values (1, 100);
insert into s2 values (1, 1);                                       -- see "one gotcha" below

alter table m rename to "<lone surrogate>";                         -- SUCCEEDS
```

Observed after the statement returned:

- live: `s2`'s foreign key `referencedTable` is `"\ud800"`
- on disk: `s2`'s saved definition still reads `… references m(id) …`
- console only: `[StoreModule] Failed to persist catalog DDL after schema change:
  cannot store persisted schema text containing an unpaired surrogate (U+D800 at offset 137)…`

Same result for `alter table m rename column id to "<lone surrogate>"` (through the
foreign key's referenced-column list) and for a dependent `check (v < (select count(*)
from m))` on a store table.

**One gotcha that will bite whoever writes the tests:** a store table that is created
but never written to has **no catalog entry yet** — the first run of the repro showed an
empty catalog and no divergence at all. Insert a row into the dependent store table
before the rename, or the test asserts nothing. (That lazy-persist gap is its own
ticket, `bug-store-untouched-table-and-early-view-never-persisted`; do not fix it here.)

**Also verified:** with a store module registered and live, a *memory-backed* dependent
table (`create table mem2 (… references m(id))`, no `using store`) has **no** catalog
entry and today the rename is correctly allowed. That is the false-positive the new veto
must not introduce — see *Self-filter* below.

## Why it is narrow, and why it still matters

The renamed table has to be in-memory: a store-backed table's own rename into such a
name is already refused by the store before any side effect, and an in-memory table does
not survive a reopen, so its own stale entry is moot. What is genuinely broken is the
contract — the statement reports success while the store logs a failure, and the live
and saved definitions of a *persistent* table silently disagree for the rest of the
session. Exactly the class of failure the sibling ticket declared unacceptable for
views.

## Shape of the fix

Three seams, mirroring the view/MV path that already exists.

**1. `CatalogObjectKind` gains `'table'`** (`packages/quereus/src/vtab/module.ts`). The
hook's `object` parameter is already `ViewSchema | TableSchema`, so only the union
member and the docstring change. The docstring's "Not covered: … dependent TABLE
entries … since `CatalogObjectKind` has no `'table'` case
(`bug-store-rename-diverges-dependent-table-catalog-entry`)" paragraph is now stale —
rewrite it, and mirror the change in `docs/schema.md`'s "Three things stay uncovered"
paragraph (it drops to two) and in the two `docs/module-authoring.md` hook-table rows
that say "view/MV".

**2. The pre-flight scan gains a dependent-table arm**
(`packages/quereus/src/schema/catalog-persistability.ts`).

`assertRenameDependentsPersistable(db, schema, rewrite)` becomes
`assertRenameDependentsPersistable(db, schema, rewrite, rewriteTable)`, delegating to two
private helpers (views/MVs; tables) behind the one `anyModuleCanVeto(db)` early return.

```ts
/** A rewrite of a dependent TABLE's schema, returning a NEW record when anything
 *  changed and the SAME reference when nothing did — the shape
 *  `rewriteTableForTableRename` / `rewriteTableForColumnRename` already have. */
export type TableRewrite = (table: TableSchema) => TableSchema;
```

Two things differ from the view arm and are the whole substance of this task:

- **Scope is every schema, not one.** The view/MV loops are scoped to the renamed
  object's own schema because the propagation's view/MV loops are. The propagation's
  *table* loop is not — `propagateTableRename` walks
  `db.schemaManager._getAllSchemas()` so a cross-schema FK reference is picked up. The
  table arm of the scan must walk the same set.

- **The rewriters mutate in place, and a table's rewritable state is spread over three
  fields.** `rewriteTableForTableRename` calls `renameTableInAst(cc.expr, …)` and
  `renameTableInAst(idx.predicate, …)` — both mutate the live catalog AST — and only the
  FK arm builds a new object. So the probe must rewrite a copy, exactly as the view arm
  spine-clones `selectAst`. Clone just the two mutable AST fields, not the whole record:

  ```ts
  /** A shallow copy of `table` whose in-place-rewritable ASTs are spine clones, so a
   *  prospective rewrite cannot touch the live catalog. `foreignKeys` needs no clone —
   *  that arm of both rewriters is already copy-on-write. */
  function cloneTableRewritableAsts(table: TableSchema): TableSchema {
      return {
          ...table,
          checkConstraints: table.checkConstraints.map(cc => ({ ...cc, expr: spineCloneAst(cc.expr) })),
          indexes: table.indexes?.map(idx =>
              idx.predicate ? { ...idx, predicate: spineCloneAst(idx.predicate) } : idx),
      };
  }
  ```

  The loop then uses same-reference-means-unchanged against the **clone**, not the
  original:

  ```ts
  for (const schema of db.schemaManager._getAllSchemas()) {
      for (const table of Array.from(schema.getAllTables())) {
          const probe = cloneTableRewritableAsts(table);
          const rewritten = rewriteTable(probe);
          if (rewritten === probe) continue;      // nothing to re-persist
          assertCatalogObjectPersistable(db, 'table', rewritten);
      }
  }
  ```

Deliberately **not** special-cased: the renamed table itself is left in the scan. Under
the table arm it is probed under its OLD name with self-references rewritten to the NEW
one; under the column arm with its CHECK expressions rewritten. Either way the probe
only ever fires on text that carries the new name, so a veto there is always true, and a
table with no self-reference rewrites to nothing and is skipped. Its own catalog entry
stays covered by the module's `renameTable` / `alterTable` guards, as today. Say this in
a comment — the next reader will ask.

A maintained table (materialized view) is in `getAllTables()` and so gets probed as
`'table'` too. That is correct: a **store-hosted** MV really does persist an ordinary
table bundle alongside its MV entry, and a **memory-hosted** one is filtered out by
seam 3.

**3. The store implements the `'table'` branch of the veto**
(`packages/quereus-store/src/common/store-module-catalog.ts`), running the same
derivation its write path runs — `buildCatalogKey(schemaName, name)` plus the existing
private `buildCatalogEntry(table)` (table DDL + index DDL + exposed-implicit-index tag
DDL) through `assertPersistableDdlText`. Add a `tableCatalogEntry` alongside
`viewCatalogEntry` / `maintainedViewCatalogEntry` so veto and write cannot drift, and
switch the veto on `kind`.

**Self-filter (the load-bearing part).** The table write path
(`persistCatalogIfChanged`) self-filters on *catalog entry absent → skip*, which is an
async read the veto cannot do (the hook is synchronous and IO-free by contract). Mirror
it synchronously with the ownership test `StoreModule.resolveOwnedTable` already uses:

```ts
const key = `${table.schemaName}.${table.name}`.toLowerCase();
const wrapper = table.vtabModule as { underlying?: unknown } | undefined;
const owned = this.tables.has(key) || table.vtabModule === this || wrapper?.underlying === this;
```

The `wrapper.underlying` arm matters: under `@quereus/quereus-isolation` a wrapped
store table's `vtabModule` is the `IsolationModule`, not the `StoreModule`. Not owned →
return no entry → no check, which is what keeps the verified memory-dependent case
(`mem2` above) passing.

Where this is *stricter* than the write path — a store-owned table whose catalog entry
has not been written yet — refusing is the safe side: that table's eventual lazy
`saveTableDDL` would throw on the diverged text anyway. Note it in a comment.

Keep the existing `subscribedDb !== db` gate unchanged.

## Decisions already made — do not re-open

- **Rename-only; no `create table` veto.** The ticket asked whether the new `'table'`
  kind should also gate `create table`. It should not, in this ticket. `create … using
  store` already goes through `module.create`, whose failure reaches the statement, and
  a store table's *definition text* is deliberately checked lazily on first storage
  access — pinned by existing passing tests in `lone-surrogate-keys.spec.ts` (a
  lone-surrogate column name or `default` literal creates fine and is refused on the
  first insert). Changing that is a separate behavior change with its own test churn.
- **No dependency on `bug-store-untouched-table-and-early-view-never-persisted`.** The
  ownership-based self-filter above is already correct whether or not persistence later
  becomes unconditional.

## Watch out

- `yarn lint` in `packages/quereus` type-checks the test files too, so a signature change
  to `assertRenameDependentsPersistable` surfaces there as well as in `yarn typecheck`.
- Both rename arms in `alter-table.ts` must pass the new argument; the table arm's
  closure is `t => rewriteTableForTableRename(t, tableSchema.schemaName.toLowerCase(),
  oldName, newName)` and the column arm's is `t => rewriteTableForColumnRename(t,
  tableSchema.schemaName.toLowerCase(), tableSchema.name, oldName, newName,
  resolveColumnInSource)` — reuse the column arm's existing `resolveColumnInSource`
  rather than building a second one.
- The message a store-backed rename reports may shift from `cannot store the identifier
  …` to `cannot store persisted schema text …` when the object now has a dependent
  table. `docs/schema.md` already carries an "Ordering note" paragraph about exactly this
  for views — extend it rather than adding a second one, and keep the existing
  regression-pin tests asserting on substance (`/unpaired surrogate/`), not wording.

## TODO

Phase 1 — engine seam

- Add `'table'` to `CatalogObjectKind` in `packages/quereus/src/vtab/module.ts` and
  rewrite the now-stale "Not covered: … dependent TABLE entries" paragraph in the
  `assertCatalogObjectPersistable` docstring.
- Add `TableRewrite` and `cloneTableRewritableAsts` to
  `packages/quereus/src/schema/catalog-persistability.ts`; split
  `assertRenameDependentsPersistable` into the view/MV helper plus a new all-schemas
  table helper behind the single `anyModuleCanVeto` early return.
- Thread the new `rewriteTable` argument through both rename pre-flights in
  `packages/quereus/src/runtime/emit/alter-table.ts`.
- Add a `NOTE:` tripwire beside the existing one on `assertRenameDependentsPersistable`:
  the table arm now spine-clones the CHECK/predicate ASTs of every table in every schema
  on every `ALTER … RENAME`; fine because DDL is rare and the whole scan is skipped when
  no module can veto, but if a schema-heavy workload shows up hot, gate the clone on a
  cheap dry-run name scan.

Phase 2 — store seam

- Add `tableCatalogEntry` + the synchronous ownership self-filter and the `'table'`
  branch in `packages/quereus-store/src/common/store-module-catalog.ts`, sharing the
  existing `buildCatalogEntry` with the write path.

Phase 3 — tests and docs

- Extend the `a RENAME that would make a persisted view or materialized view unwritable`
  describe in `packages/quereus-store/test/lone-surrogate-keys.spec.ts` (rename the
  describe to cover tables) with, at minimum:
  - table rename refused because a store-backed dependent's **foreign key** would become
    unwritable — asserting the persisted DDL still names the old table AND that the live
    catalog was not mutated;
  - column rename refused through the same FK's referenced-column list;
  - table rename refused because a store-backed dependent's **check expression** would
    become unwritable;
  - a partial-index predicate dependent, if cheap to set up;
  - **negative**: a *memory-backed* dependent table with a store module registered and
    live still permits the rename (the verified false-positive guard);
  - **negative**: a well-formed astral rename with a dependent store table still succeeds
    and re-persists (extend the existing `still accepts a well-formed astral rename` case).
  Remember the insert-a-row gotcha above, and `await storeModule.whenCatalogPersisted()`
  before reading the catalog.
- Update `docs/schema.md` (§ persistence: the "Three things stay uncovered" paragraph,
  the RENAME pre-flight bullets, the ordering note) and the two
  `docs/module-authoring.md` rows that describe the hook as view/MV-only.
- Validate: `yarn build`, then `yarn test 2>&1 | tee /tmp/test.log`, then
  `yarn lint` and `yarn typecheck`. `yarn test:store` is the store-path re-run of the
  engine logic suite — run it if time allows, since this touches both rename arms.
