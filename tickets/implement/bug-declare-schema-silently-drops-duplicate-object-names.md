description: When a declared schema names the same table (or view, or check rule, or seed block) twice, the database quietly ignores all but the last one instead of complaining, so part of what the author wrote never gets built. Reject a duplicated name up front with a message that names the object.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts (declared-item collection loop ~262-356; duplicate-index capture ~292/338-351; raise point ~357-368; table↔materialized-view cross check ~379-387; logical path `computeLogicalSchemaDiff` ~763-784)
  - packages/quereus/src/runtime/emit/schema-declarative.ts (seed loop ~82-89 — where a repeated `seed` block overwrites)
  - packages/quereus/src/schema/declared-schema-manager.ts (`setSeedData` ~67-75 — the overwriting `Map.set`)
  - packages/quereus/src/parser/ast.ts (`DeclareItem` union ~883; item interfaces ~885-925)
  - packages/quereus/test/schema-differ.spec.ts (`describe('duplicate declared index names (unique per schema)')` ~240-280 — pattern to follow; helpers `parseDeclaredSchema` ~16, `makeCatalog` ~22)
  - packages/quereus/test/logic/10.5.5-index-name-uniqueness.sqllogic (sqllogic `-- error:` assertion style)
  - docs/sql-ddl.md (§ Declaration Syntax ~25-70; existing index bullet ~872)
  - docs/invariants.md (SCH area; SCH-001 ~989, SCH-002 ~1007 — next free id is SCH-003)
difficulty: medium
----

## What is wrong

A `declare schema` block lists the objects a schema should contain. The differ
collects those declarations into one map per object kind, keyed by lowercased
name, and a second declaration of the same name simply overwrites the first —
no error, no warning, the first declaration never reaches the migration.

`index` declarations were fixed by the `index-names-unique-per-schema` ticket
(see `tickets/complete/index-names-unique-per-schema.md`) and now raise. Four
sibling maps in the same loop were not, and a fifth silent overwrite of the same
shape lives outside the differ, in the seed store.

## Reproduced (against the built `packages/quereus/dist`)

Silent last-writer-wins — `declare schema` + `apply schema` succeeds and the
first declaration is gone:

| declaration | result |
| --- | --- |
| `table t1 {id …, a text}` then `table t1 {id …, b text}` | one table, columns `(id, b)`; `a` gone |
| `view v as select id as x from t1` twice (second `select a as y`) | one view, body `select a as y`; first body gone |
| `assertion ck check (… >= 0)` then `assertion ck check (… >= 1)` | one assertion, the `>= 1` rule; `>= 0` gone |
| `materialized view mv as select 1 as one` then (after a `table` item) `materialized view mv as select 2 as two` | one maintained table from `select 2 as two`; first gone |
| `seed t1 …` twice | only the second block's rows are stored (`setSeedData` overwrites) |

The materialized-view row needs care to reproduce: see *Test-authoring trap*
below.

## Two corrections to the incoming fix ticket

Both were checked by running the cases, not by reading.

**1. The cross-kind case does not produce an unreachable table — it half-applies
and then throws a low-level error.** The fix ticket said `getSchemaItem` resolves
a table/view name clash by preferring the view, leaving the table unreachable.
That is not what happens. `Schema.addView` rejects a view whose name a table
already holds, and `SchemaManager.createTable` (manager.ts:2656) rejects the
mirror case, so the namespace *is* shared and enforced imperatively. What
actually happens for

```
declare schema main {
  table dual { id integer primary key }
  view dual as select 1 as one
}
apply schema main;
```

is that the differ accepts the declaration and emits both statements;
`generateMigrationDDL` emits table creates before view creates
(schema-differ.ts:2421-2422), so `create table dual` runs, then
`create view dual …` throws

```
Failed to execute DDL: create view dual as select 1 as one
Error: Schema 'main': Cannot add view 'dual', a table with the same name already exists.
```

and table `dual` is left behind in the catalog. So the differ today accepts a
declaration that **can never apply**, and the failure is a partial apply with a
message that says nothing about the declaration. Declaring the items in the
other order changes nothing (the differ emits by bucket, not by declaration
order). The same holds for `materialized view mv` + `view mv` (an MV normalizes
into the table category, so it collides with a plain view exactly as a table
does).

That settles the decision the fix ticket left open: **reject the cross-kind
clash.** Matching the imperative path is not an option — there is nothing to
match, the imperative path rejects it too. "Resolving by precedence" would mean
the differ silently dropping one of the two declared objects, which is the
defect this ticket exists to close. And the differ already rejects the
table↔materialized-view clash with exactly this diagnostic shape
(schema-differ.ts:379-387), so rejecting is the consistent move.

**2. There is a sixth instance, outside the differ: duplicate `seed` blocks.**
`emitDeclareSchema` loops the declared items and calls
`declaredSchemaManager.setSeedData(schema, table, rows)` per `seed` item;
`setSeedData` is a `Map.set` keyed by lowercased table name, so a second `seed`
block for the same table discards the first block's rows. Same defect class,
different file, and it is invisible to the differ (the differ ignores `seed`
items entirely), so a differ-only guard would never catch it.

## Namespaces — what collides with what

Probed both directions on each pair. Only three namespaces exist, and only the
first is shared across kinds:

- **`table` / `view` / `materialized view` — one shared namespace.** The engine
  enforces it (`Schema.addView`, `SchemaManager.createTable`). A duplicate here,
  same kind or cross kind, must be rejected.
- **`index` — its own namespace.** `create index t1 on t1 (a)` where table `t1`
  exists is accepted by the engine and applies cleanly. Same-name duplicates
  within the index namespace are already rejected (keep that behavior and its
  exact message); an index sharing a table's or view's name stays legal.
  **Do not widen this** — it is a separate decision with its own blast radius.
- **`assertion` — its own namespace.** `assertion t1 check (…)` alongside table
  `t1` applies cleanly. Same rule: reject same-kind duplicates, leave the
  cross-kind case alone.
- **`seed` — keyed by target table, one block per table.** Reject a second block
  for the same table. Do not invent append semantics: two blocks for one table
  have no defined meaning today and rejecting loses nothing an author can
  currently rely on.

## Shape of the fix

The existing shape (`let duplicateDeclaredIndex` captured inside the collection
`switch`, thrown after `raiseReservedTagDiagnostics`) does not generalize to five
kinds. Replace it with a **pure item-walk helper**, not five copies of the
capture:

```ts
/** Kind label as it appears in the duplicate-declaration diagnostic. */
type DeclaredObjectKind = 'table' | 'view' | 'materialized view' | 'index' | 'assertion';

interface DuplicateDeclaredName {
	/** The name as written on the SECOND declaration. */
	name: string;
	/** Kind of the second declaration. */
	kind: DeclaredObjectKind;
	/** Kind of the first declaration — equal to `kind` for a same-kind duplicate. */
	priorKind: DeclaredObjectKind;
	/** Owning table of each declaration; indexes only, for the existing message. */
	firstTable?: string;
	secondTable?: string;
}

/** First name collision in declaration order, or undefined. Pure — no throwing. */
function findDuplicateDeclaredName(items: readonly AST.DeclareItem[]): DuplicateDeclaredName | undefined;

/** Renders the diagnostic for a collision. */
function duplicateDeclaredNameError(dup: DuplicateDeclaredName, schemaName: string): QuereusError;
```

Internally: three `Map<string, {kind, table?}>` (shared-object, index,
assertion), first-write-wins, first collision recorded and returned. Reporting
only the **first** collision matches the surrounding structural conflicts and the
deliberate choice recorded in the prior ticket's review.

Being a pure walk over `items` lets it be called from more than one place
without threading state through the collection `switch`:

- `computeSchemaDiff` physical path — call **immediately after**
  `raiseReservedTagDiagnostics(...)`, i.e. exactly where the index throw sits
  today, so a reserved-tag typo still surfaces first (the deterministic order the
  prior ticket established).
- `computeSchemaDiff` logical path — `computeLogicalSchemaDiff` returns before
  any tag validation and dedupes declared table names into a `Set`, so a logical
  schema silently drops a duplicate too (verified: two `table t1` items →
  `lensToAttach: ['t1']`). Call the helper at the top of the logical branch and
  raise straight away.
- The seed guard is **not** this helper — it belongs where the overwrite happens,
  at declare time in `emitDeclareSchema`, since the differ never sees seeds. A
  small sibling (`findDuplicateSeedTable(items)`) keeps it a pure walk too.

The redundant table↔materialized-view check in the MV normalization loop
(schema-differ.ts:379-387) becomes dead once the registry raises earlier —
remove it and leave a one-line comment at the `declaredTables.set` pointing at
the registry, so a future reader knows the clobber is already impossible.

## Diagnostics

Same-kind, non-index (kind label capitalized):

```
Table 't1' is declared more than once in schema 'main'
View 'v' is declared more than once in schema 'main'
Materialized view 'mv' is declared more than once in schema 'main'
Assertion 'ck' is declared more than once in schema 'main'
```

Index — **unchanged**, pinned by `schema-differ.spec.ts:254` and documented in
`docs/sql-ddl.md`:

```
Index 'idx_note' is declared more than once in schema 'main' (on 't1' and 't2') — index names are unique per schema
```

Cross-kind, kinds in declaration order:

```
'dual' is declared as both a table and a view in schema 'main'
```

This adds ` in schema '<name>'` to the existing table↔materialized-view text.
Verified nothing pins the old string: the only occurrence outside tickets is the
throw itself, and no test or doc asserts it.

Seed:

```
Seed data for table 't1' is declared more than once in schema 'main'
```

All `StatusCode.ERROR`, matching every other `computeSchemaDiff` throw.

## Test-authoring trap (materialized views)

A `materialized view` item written directly after another item whose body ends
at a FROM source is **misparsed**: `materialized` is not reserved, so it is taken
as a table alias and the following `view <name> as …` parses as a *plain* view.
Confirmed on the AST:

```
declare schema main {
  table t1 { id integer primary key, a text }
  materialized view m1 as select id from t1
  materialized view m2 as select a from t1
}
→ items: declaredTable:t1 | declaredMaterializedView:m1 | declaredView:m2
   (m1's FROM source carries alias: "materialized")
```

That is a separate bug — filed as
`tickets/fix/bug-declare-schema-materialized-swallowed-as-table-alias.md`. Not a
prereq for this work, but the MV duplicate tests here must sidestep it: either
give the first MV a FROM-less body (`as select 1 as one`) or put a non-select
item between the two MV declarations. Assert the parsed item types in the MV
tests so a future regression in the parser cannot quietly turn them into
view tests.

## Also worth knowing

- A failed `apply schema` left the already-created table in the catalog in the
  cross-kind probe. Whether `apply schema` should roll back a mid-migration DDL
  failure is a separate question; the guard makes it moot for *this* input, so do
  not chase it here.
- `packages/quereus/test/schema-manager.spec.ts:106` is named "views should
  shadow tables of the same name in getSchemaItem" but creates `dual_name`
  (table) and `dual_name_view` (view) — two different names, so it does not test
  shadowing at all. Given `Schema.addView` rejects the real clash, the test's
  premise is wrong. Rename it to what it checks (a view is found by
  `getSchemaItem`) or drop it; do not "fix" it by making the clash legal.
- Ad-hoc probe scripts on Windows: `node` needs `file:///C:/...` URLs to import
  from `dist`, and the package has no root `index.js` (entry is
  `dist/src/index.js`).

## Docs

- `docs/sql-ddl.md` § Declaration Syntax — one bullet stating each declared name
  must be unique, that `table` / `view` / `materialized view` share one
  namespace while `index` and `assertion` have their own, that a repeated `seed`
  block is rejected, and the diagnostic shape. Generalize the existing
  index-only bullet at ~872 to point at it rather than restating.
- `docs/invariants.md` — add `SCH-003` ("A declared schema names each object
  once"). SCH-001 / SCH-002 are taken. 120-word budget; `yarn docs:check`
  validates pointers and size and is green at HEAD.

## TODO

Phase 1 — differ guard

- Add `DeclaredObjectKind`, `DuplicateDeclaredName`, `findDuplicateDeclaredName`,
  `duplicateDeclaredNameError` to `schema-differ.ts` (module-local, not exported).
- Call it in `computeSchemaDiff` right after `raiseReservedTagDiagnostics`;
  delete the `duplicateDeclaredIndex` capture from the collection `switch` and
  the throw at ~361-368, keeping the index message byte-identical.
- Call it at the top of the logical branch (before/inside
  `computeLogicalSchemaDiff`) and raise immediately.
- Remove the now-unreachable table↔materialized-view throw in the MV
  normalization loop; leave a pointer comment.

Phase 2 — seed guard

- Add `findDuplicateSeedTable(items)` and raise from `emitDeclareSchema` before
  any `setSeedData` call, so a rejected declaration stores no seed rows at all.
- Grep the existing sqllogic / spec corpus for two `seed` blocks on one table
  before landing — a legitimate existing use would need discussing, not silently
  breaking.

Phase 3 — tests

- `packages/quereus/test/schema-differ.spec.ts`, sibling `describe` next to the
  index one: duplicate `table`, `view`, `materialized view`, `assertion`;
  case-divergent duplicate (`table T1` / `table t1`); cross-kind table+view and
  view+table (assert the declaration-order wording); cross-kind table+mv (old
  wording preserved apart from the schema clause) and mv+view.
- Negative cases in the same block: distinct names accepted; an `index` sharing a
  table's name accepted; an `assertion` sharing a table's name accepted.
- Ordering: a schema carrying both a bogus `quereus.*` tag and a duplicate name
  raises the **tag** diagnostic.
- Logical schema with two `table t1` items throws.
- New `packages/quereus/test/logic/50.3-declare-schema-duplicate-names.sqllogic`
  (`-- error:` style, per 10.5.5): the duplicate-name errors surface on `diff
  schema` / `apply schema`, and the duplicate-`seed` error on `declare schema`
  itself.
- Run the whole suite: an existing 50.x declarative test may contain a duplicate
  name that now errors.

Phase 4 — docs + validation

- `docs/sql-ddl.md` bullet; `docs/invariants.md` SCH-003.
- `yarn build`, `yarn lint`, `yarn workspace @quereus/quereus run test`,
  `yarn docs:check` — all green before handoff.
