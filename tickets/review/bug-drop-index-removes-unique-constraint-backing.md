---
description: A plain "drop index" could delete the hidden helper structure the database builds behind a UNIQUE constraint, and the same drop/create pair behaved differently on the in-memory backend than on the disk-backed one; both are now refused consistently on both backends.
prereq:
files:
  - packages/quereus/src/schema/manager.ts               # createIndex guard ~2326, dropIndex owner scan ~2495
  - packages/quereus/src/runtime/emit/drop-index.ts      # strict-DDL-policy owner scan
  - packages/quereus/src/schema/catalog.ts               # collectSchemaCatalog exposure lookup ~208
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic   # new, both backends
  - packages/quereus/test/schema-manager.spec.ts         # 3 new DROP INDEX guard cases ~718
  - packages/quereus/test/covering-structure.spec.ts     # mixed-case catalog + differ idempotency cases
  - packages/quereus/test/logic-capabilities.spec.ts     # corpus list entry
  - docs/sql-ddl.md                                      # §6.3 bullets, ALTER INDEX note ~766
difficulty: medium
---

# DROP INDEX / CREATE INDEX no longer touch a UNIQUE constraint's backing structure

## What was wrong

Declaring `constraint uq_email unique (email)` makes the engine build a secondary
index behind the constraint for enforcement, named after the constraint (or
`_uc_<cols>` when unnamed). It is deliberately not a user-addressable object:
`ALTER INDEX … SET TAGS` on that name already raised `NOTFOUND`, and
`docs/sql-ddl.md` called it "not a user-addressable index".

`DROP INDEX` never got that guard, and `CREATE INDEX` only had it on the in-memory
backend (as a side effect of memory materializing the structure as a real index
entry). Before this change:

| statement, table carries `constraint uq_email unique (email)` | memory | store (LevelDB) |
|---|---|---|
| `drop index uq_email` | succeeded, deleted the backing structure | `no such index` |
| `create index uq_email on b (email)` | `Index uq_email already exists on table b` | succeeded |

On memory the drop left the table with no indexes while the constraint list still
named `uq_email` — uniqueness still enforced, but by full scan, and the registered
schema no longer matched the constraint that produced the structure. On the store,
the accepted `create index` put the user index and the constraint's structure on
the *same* physical key-value store (`buildIndexStoreName` is a pure function of
schema + table + index name), so a later drop deleted a shared store.

Bundled second defect: `collectSchemaCatalog` looked the exposure map up with
`implicit.get(indexSchema.name)` while that map is keyed lowercased. A
**mixed-case** constraint name therefore missed the filter and its hidden structure
landed in `catalog.indexes` unmarked — which the declarative schema differ read as
a real index and scheduled a `DROP INDEX "UQ_Email"` for, against a schema that was
already converged. Lowercase names never hit it, which is why it survived.

## What changed

One existing predicate, `isImplicitCoveringIndex(tableSchema, name)`
(`packages/quereus/src/schema/catalog.ts`), is now applied at three write-path
sites. It reads only `tableSchema.uniqueConstraints`, which **both** backends carry,
so a single engine-side change fixes both — no store-package change was needed.

- **`SchemaManager.createIndex`** (`manager.ts` ~2326) — the same-table duplicate
  test now also fires when the requested name is a constraint's implicit name.
  Memory behavior is byte-identical (both halves were already true there); the store
  gains the refusal, with the same message (`Index <name> already exists on table
  <table>`) and the same `IF NOT EXISTS` silent-skip.
- **`SchemaManager.dropIndex`** (`manager.ts` ~2495) — the owner scan **skips and
  keeps scanning** past an implicit match rather than stopping at it, the same shape
  `findIndexNameOwnerElsewhere` already used. No owner found falls through to the
  existing `IF EXISTS` / `no such index` handling.
- **`emitDropIndex`** (`runtime/emit/drop-index.ts`) — its strict-DDL-policy owner
  scan skips implicit matches too, so the policy gate cannot fire against a table
  whose index is not the one `dropIndex` will resolve.
- **`collectSchemaCatalog`** (`catalog.ts` ~208) — lowercases the exposure-map
  lookup key.

Docs: `docs/sql-ddl.md` §6.3 restates the same-table `create index` refusal as a
backend-independent rule and adds the `DROP INDEX` rule (raises `no such index`,
`IF EXISTS` a no-op, exposed or not, removed by dropping the constraint); the
ALTER INDEX note at ~766 now covers `DROP INDEX` alongside `ALTER INDEX … TAGS`.

## Use cases to exercise when reviewing

All of these are in
`packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`, which
runs on **both** backends (it declares `-- requires-capability: standalone-index-ddl`
and is deliberately NOT in `MEMORY_ONLY_FILES`):

- Named constraint: `drop index uq_email` → `no such index`; `drop index if exists
  uq_email` → no-op; the constraint and the structure both survive; a duplicate
  insert still fails.
- Named constraint: `create index uq_email on <that table> (email)` → `already
  exists on table …`; `create index if not exists …` skips silently and adds
  nothing (the following bare `create index` still errors).
- Unnamed constraint's auto-name `_uc_email`: same drop and create rules.
- Constraint tagged `quereus.expose_implicit_index = true`: `alter index … add
  tags` still works and `schema()` still lists it, but `drop index` is still
  refused and `create index` of that name still refused — exposure buys tags, not
  lifecycle.
- Mixed-case constraint name `UQ_Email`: both `drop index UQ_Email` and
  `drop index uq_email` refused; `create index uq_email` refused.
- Cross-table: constraint `uq_shared` on `iul_b` plus a **real** `create index
  uq_shared on iul_c (email)` — `drop index uq_shared` drops `iul_c`'s index and
  leaves `iul_b` enforcing; `iul_c`'s rows stay readable; the name is reusable on
  `iul_c` afterwards. This is the skip-and-continue behavior;
  `10.5.5-index-name-uniqueness.sqllogic` pins the create half of the same rule and
  is unchanged.
- `alter table … drop constraint uq_email` still removes the structure, a duplicate
  is accepted afterwards, and the name then behaves as an ordinary index name
  (create + drop both succeed).

Unit-level:

- `packages/quereus/test/schema-manager.spec.ts` — three new cases in
  "Index names are unique per schema": drop refused on a hidden implicit index (and
  `if exists` is a no-op, with the constraint and the index entry both asserted
  intact), drop refused on an exposed one, and skip-past-implicit finding the real
  owner on another table.
- `packages/quereus/test/covering-structure.spec.ts` — "introspection hiding" gains
  a mixed-case case (catalog omits it), and a new
  "declarative idempotency — mixed-case hidden covering structure" describe asserts
  a converged `declare schema` with a `constraint UQ_Email unique (email)` diffs
  **empty** (no phantom `DROP INDEX`) under both `allow` and `require-hint`.

## Validation run

All from the repo root, all green, no skips added and none disabled:

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json --noEmit`).
- `yarn build` — clean.
- `yarn test` — 8046 passing / 13 pending in `packages/quereus`, plus every other
  workspace green.
- `yarn test:store` — 8037 passing / 22 pending (the 22 are the pre-existing
  `MEMORY_ONLY_FILES` skips), 0 failing.

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was
written.

## Known gaps / things a reviewer should push on

- **`schema()` and `index_info()` still leak hidden structures on memory.** The
  ticket's repro used `select … from schema() where name = 'UQ_Email'` and
  attributed the leak to the catalog lookup. The catalog lookup *was* broken for
  mixed case and is fixed, but those two table-valued functions
  (`packages/quereus/src/func/builtins/schema.ts`) iterate `tableSchema.indexes`
  with **no** implicit filter at all — so on memory they list a hidden structure
  under *any* casing, while the store lists none. Confirmed empirically both ways
  (memory 1 row, store 0 rows) with a throwaway `.sqllogic` that was deleted after
  the probe. That is a distinct pre-existing defect from the four sites this ticket
  names, so it is filed as `fix/bug-hidden-implicit-index-leaks-into-introspection`
  rather than fixed here — but if the reviewer judges it in scope, it is a
  one-predicate change (`isHiddenImplicitIndex`, already exported) and the new
  `10.5.7` file is the right place for its assertions. **Consequence right now:**
  the new `10.5.7` file cannot assert "hidden structure absent from `schema()`",
  so the hidden/exposed distinction is pinned at the catalog level (unit test)
  rather than through SQL.
- **The constraint-name / index-name clash on one table is refused, not resolved.**
  `create index foo on t (b); alter table t add constraint foo unique (a);` both
  succeed today and leave the predicate true for a name that is *also* a real user
  index — so `drop index foo` is now refused there. That state is already broken in
  worse ways (memory ends up with two index entries literally named `foo`) and is
  tracked as `bug-unique-constraint-name-collides-with-index-name`. Per the
  implement ticket this is the accepted conservative outcome, recorded as a `NOTE:`
  next to the `dropIndex` owner scan. Worth a reviewer sanity check that refusing
  (rather than dropping the user index) is the right default.
- **Test placement deviates from the implement ticket.** It asked for the
  mixed-case `collectSchemaCatalog` assertion in `schema-manager.spec.ts`; it went
  into `covering-structure.spec.ts` instead, next to the existing "introspection
  hiding" / declarative-idempotency cases which already import
  `collectSchemaCatalog` and own that surface. `schema-manager.spec.ts` got the
  `DROP INDEX` guard cases instead. Reviewer may prefer them co-located
  differently.
- **`importIndex` / rehydration was not touched.** It deliberately warns rather
  than throws on a cross-table collision, and it does not consult
  `isImplicitCoveringIndex`. Reopening a store database whose catalog somehow
  contains a `create index` that shadows a constraint name would still import it —
  a pre-existing path, unchanged, and not exercised by the new tests.
- **No test drives the strict-DDL-policy path in `emitDropIndex`.** That scan was
  changed for consistency with `dropIndex`; nothing in the new coverage sets a
  strict DDL transaction policy and then drops an implicit name. The existing
  strict-policy suites still pass, but the specific skip-implicit branch there is
  untested.
- **Cross-schema behavior is only covered indirectly.** All new `.sqllogic` cases
  live in `main`. `dropIndex` scans one schema, so the guard should be
  schema-scoped for free, but there is no explicit two-schema case.
