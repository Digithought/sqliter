---
description: After a table's primary key is changed, the SQL text the engine writes out for that table still names the OLD key column — so a table saved to disk comes back with the wrong key after a restart, uniqueness stops being enforced, and legal inserts start getting rejected.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts               # formatColumnDef ~509 — inline PK read from the stale flag
  - packages/quereus/src/schema/table.ts                       # home of the new shared helper (next to shiftSchemaIndicesForDrop ~530)
  - packages/quereus/src/index.ts                              # ~196 — export the new helper alongside shiftSchemaIndicesForDrop
  - packages/quereus/src/schema/column.ts                      # ColumnSchema.primaryKey / pkOrder / pkDirection
  - packages/quereus/src/vtab/memory/layer/manager.ts          # buildRekeyedPrimaryKeySchema ~2443 — producer 1
  - packages/quereus-store/src/common/store-module-alter.ts    # alterPrimaryKeyChange ~396 — producer 2
  - packages/quereus/src/runtime/emit/alter-table.ts           # runAlterPrimaryKey ~1420, rebuildTableWithNewShape ~1530 — producer 3 (shadow rebuild)
  - packages/quereus/test/schema-shift-drop-column.spec.ts     # unit-test precedent for a shared schema helper
  - packages/quereus/test/alter-table-conformance.spec.ts      # ~182 — existing alterPrimaryKey conformance row
  - packages/quereus-store/test/tag-persistence.spec.ts        # ~20 — createPersistentProvider close→reopen harness to copy
  - docs/schema.md                                             # § DDL Generation ~260
  - docs/module-authoring.md                                   # ~893 — alterPrimaryKey module contract
difficulty: medium
---

# The invariant that breaks

A table's key is recorded twice in `TableSchema`:

- `primaryKeyDefinition` — the authoritative ordered list of `{ index, desc, collation }`.
- per-column flags on each `ColumnSchema` — `primaryKey` (member?), `pkOrder`
  (1-based position, 0 if not a member), `pkDirection`.

At `CREATE TABLE` time the two always agree — confirmed for inline single-column
PK, table-level single-column PK (incl. `desc`), table-level composite PK, and the
no-PK synthesized all-columns key. **`ALTER TABLE … ALTER PRIMARY KEY` is the only
operation that breaks the agreement**: every producer swaps
`primaryKeyDefinition` and leaves the flags at their CREATE-time values.

`generateTableDDL`'s single-column inline-PK path reads the **flag**
(`ddl-generator.ts:509`), so it renders the retired key.

# Confirmed behavior (reproduced on this branch, memory module)

| ALTER | generated DDL | re-parses to key |
|---|---|---|
| `t(id pk, code)` → `(code)` | `("id" … PRIMARY KEY, "code" …)` | `id` — **wrong** |
| same, `(code desc)` | `("id" … PRIMARY KEY DESC, …)` | `id desc` — **wrong twice** (the `desc` from the new key lands on the old column) |
| `t(a, b, v) pk(a,b)` → `(b)` | `("a" … PRIMARY KEY, "b" … PRIMARY KEY, "v" …)` | `(a, b)` — **wrong**, two inline `PRIMARY KEY` clauses emitted; the parser silently merges them into the old composite key rather than rejecting |
| `t(id pk, a, b)` → `(a, b)` | `(…, PRIMARY KEY ("a","b"))` | `(a, b)` — correct (the table-level branch reads the definition, and the inline branch is gated on `primaryKeyDefinition.length === 1`, so no stale inline clause appears next to it) |
| `t(id pk, code)` → `(id, code)` | no PK clause | `(id, code)` — correct (all-columns key, deliberately re-synthesized; see `isSynthesizedAllColumnsKey`) |

The original ticket predicted a stale inline `PRIMARY KEY` *beside* the
table-level clause on a single→composite move. That does not happen — the inline
branch requires a single-column definition. The two genuinely broken shapes are
**any move that leaves a single-column key**: single→single, and composite→single
(which emits two inline clauses).

## The store leg is data corruption, not cosmetics

`alterPrimaryKeyChange` physically re-keys the KV store and then persists this
generated DDL. Reproduced with the `createPersistentProvider` close→reopen
harness, `t(id integer primary key, code integer not null) using store` holding
`(1,10), (2,20)`, then `alter primary key (code)`:

```
persisted DDL: CREATE TABLE "main"."t" ("id" INTEGER NOT NULL PRIMARY KEY, "code" INTEGER NOT NULL) USING store
after reopen : rehydrate reports 0 errors; table_info says the key is `id`
```

The catalog now believes the key is `id` while every stored row's key bytes encode
`code`. Consequences observed after the reopen:

- `insert into t values (1, 99)` — a duplicate `id`, which the reopened schema
  claims is the key — is **accepted**. PK uniqueness is no longer enforced on
  either column.
- `insert into t values (7, 10)` — a duplicate `code` — is also accepted, leaving
  two rows with `code = 10`.
- `insert into t values (10, 555)` is **rejected** with
  `UNIQUE constraint failed: t PK`: the key bytes for `id = 10` alias the
  pre-ALTER row whose `code = 10`. A legal insert fails, and the same aliasing
  means a write can land on top of an unrelated row.

Rehydration reports no error, so nothing warns the operator.

## Other affected surfaces

- **Sync.** Both the memory module (`vtab/memory/module.ts`) and the store
  (`store-module.ts`) attach `generateTableDDL(...)` to their schema-change
  events; a peer replaying that statement creates a wrongly-keyed table.
- **Introspection.** `explain schema` and the declarative differ's *rendered*
  output show the retired key. (The differ's PK *comparison* is safe — it reads
  `CatalogTable.primaryKey`, derived from `primaryKeyDefinition`.)
- **Planner uniqueness hints.** `rule-select-access-path`, `rule-key-set-seek`,
  `rule-grow-retrieve`, `rule-lateral-top1-asof` all set
  `isPrimaryKey`/`isUnique` from `col.primaryKey`, so after the ALTER a plan may
  assume uniqueness on the retired column and miss it on the new key.
- **`CatalogTable.columns[].primaryKey`** (`schema/catalog.ts:258`) is stale.
  Nothing inside the repo reads it today; it is part of the catalog surface an
  external host sees.
- **`buildConstraintsFromColumn`** (`runtime/emit/alter-table.ts:2035`) rebuilds a
  `ColumnDef` AST from the flags for `RENAME COLUMN`, so the stale
  `primaryKey` constraint rides into that AST. Verified *not* currently
  corrupting: a `rename column` after a re-key preserves `primaryKeyDefinition`
  (the memory module keeps the definition), and a `desc` key survives a rename.

`table_info` is correct throughout — it reads the definition.

# Fix

Two layers; do both. Either alone leaves a real gap: layer A alone leaves the
planner hints stale, layer B alone leaves the generator one forgetful producer
away from re-breaking.

## Layer A — render the inline clause from the authoritative definition

In `generateTableDDLInternal`, resolve the single inline-key column once and pass
it down instead of having `formatColumnDef` consult `col.primaryKey`:

```ts
// -1 when there is no single-column inline key to emit.
const inlinePkIndex = !synthesizedKey && tableSchema.primaryKeyDefinition.length === 1
  ? tableSchema.primaryKeyDefinition[0].index
  : -1;
```

`formatColumnDef` then takes the column's own index and emits
`PRIMARY KEY [DESC]` only when `columnIndex === inlinePkIndex`. This alone fixes
both broken shapes and makes the generator immune to flag drift from any future
producer. No CREATE-time behavior changes: at CREATE the flag and the definition
already agree in every shape checked above.

## Layer B — restore the flag/definition invariant in one shared helper

Add to `packages/quereus/src/schema/table.ts`, beside `shiftSchemaIndicesForDrop`
(same role: one renumbering shared by both built-in modules), and export it from
`src/index.ts` on the same line:

```ts
export function rekeySchemaPrimaryKey(
  schema: TableSchema,
  newPkColumns: ReadonlyArray<{ index: number; desc?: boolean }>,
): TableSchema
```

It returns a frozen schema with:

- `primaryKeyDefinition` — frozen
  `{ index, desc: desc ?? false, collation: columns[index].collation || 'BINARY' }`;
- `columns` — a frozen **new** array of **new** `ColumnSchema` objects with
  `primaryKey` / `pkOrder` rebuilt from membership in the new definition
  (`pkOrder` = 1-based position, `0` for a non-member).

Two constraints on the implementation:

- **Do not mutate the incoming columns in place.** The pre-ALTER schema object is
  handed onward as `oldObject` on the `table_modified` notification, and the
  memory manager keeps it as its rollback snapshot (`originalManagerSchema`);
  mutating shared `ColumnSchema` objects would corrupt both. Note that
  `ColumnSchema` objects are *not* frozen (`materialized-view-helpers.ts:329`
  mutates them), so nothing will catch this for you.
- **Leave `pkDirection` alone.** CREATE never populates it — a `primary key
  (a desc)` table has `pkDirection: undefined` — so writing `'desc'` here would
  make a post-ALTER column shape that no parse can produce. Direction lives in
  `primaryKeyDefinition.desc`, which is what the DDL generator reads.

No validation inside the helper: the memory manager's
`buildRekeyedPrimaryKeySchema` keeps its own bounds / duplicate / NOT NULL checks
and then delegates the schema construction; the engine emitter
(`runAlterPrimaryKey`) validates by column name before dispatch.

Wire it into both producers:

- `MemoryTableManager.buildRekeyedPrimaryKeySchema` — keep the validation loop,
  replace the trailing `Object.freeze({ ...this.tableSchema, primaryKeyDefinition })`.
- `StoreModuleAlter.alterPrimaryKeyChange` — replace the `updatedSchema` literal.

The third producer, the engine's shadow rebuild
(`rebuildTableWithNewShape` → `buildShadowTableDdl` → create/copy/drop/rename),
ends at a **parser-built** schema, so its flags are already consistent; it needs
no change but does benefit from layer A (a single-column `primary key (b)` in the
shadow DDL sets the flag, so it renders correctly either way — verify, don't
assume).

## Watch item for layer B

The store arm currently builds its PK definition as `{ index, desc }` with **no
`collation`**, while the memory arm records the column's collation. The shared
helper unifies them on the memory arm's (more correct) shape. That is a real
behavior change for the store on a text PK column with a non-BINARY collation:
the store keys PK columns under their declared collation
(`StoreTable.pkKeyCollations`, see `docs/module-authoring.md` ~547). Run the
store suite — especially `packages/quereus-store/test/rehydrate-catalog.spec.ts`
("per-column PK key collation round-trips through close → reopen" and the
divergent-PK case) — and `yarn test:store`. If it regresses, fix the underlying
disagreement rather than dropping collation back out of the helper.

# TODO

Phase 1 — generator

- Add `inlinePkIndex` resolution in `generateTableDDLInternal`; thread the column
  index into `formatColumnDef` and gate the inline `PRIMARY KEY [DESC]` on it.
  Drop the `col.primaryKey` read and update the comment above it to say the
  definition is authoritative.
- New spec (suggest `packages/quereus/test/alter-primary-key-generated-ddl.spec.ts`):
  for each of single→single, single→single `desc`, composite→single,
  single→composite subset, single→composite all-columns — assert the generated
  DDL names the new key, contains **exactly one** `PRIMARY KEY` occurrence
  (guarding the double-inline shape), and that re-parsing it in a fresh
  `Database` yields an equal `primaryKeyDefinition` (index + `desc`).

Phase 2 — shared helper

- Add `rekeySchemaPrimaryKey` to `schema/table.ts`; export from `src/index.ts`.
- Rewire `MemoryTableManager.buildRekeyedPrimaryKeySchema` and
  `StoreModuleAlter.alterPrimaryKeyChange`; delete the now-inaccurate `NOTE:`
  block on `MemoryTableManager.alterPrimaryKey` (~2337) that documents the flags
  as deliberately stale.
- Unit spec modeled on `test/schema-shift-drop-column.spec.ts`: flags mirror the
  new definition (membership, `pkOrder`, non-members zeroed), the input schema's
  column objects are **unmutated**, `collation` is carried from the column, and
  `pkDirection` is left as-is.
- Add an assertion to the existing `alterPrimaryKey` row in
  `test/alter-table-conformance.spec.ts` (~182): post-ALTER, every column's
  `primaryKey`/`pkOrder` agrees with `primaryKeyDefinition`. This runs the row
  against both the memory module and the no-`alterTable` (shadow-rebuild) module,
  covering producers 1 and 3 in one place; the store mirror
  (`packages/quereus-store/test/alter-table-conformance.spec.ts`) covers producer 2.

Phase 3 — store persistence regression

- New spec in `packages/quereus-store/test/`, using the `createPersistentProvider`
  helper copied from `tag-persistence.spec.ts`: create `using store`, insert,
  `alter primary key (code)`, `whenCatalogPersisted()`, assert the persisted
  catalog string declares `code` as the key, then `closeAll()` + fresh
  `Database`/`StoreModule` + `rehydrateCatalog`. Assert: 0 rehydrate errors;
  `table_info` reports `code` as the key; a point lookup under `code` returns the
  right row; a duplicate `code` insert is rejected `UNIQUE`; a duplicate `id` is
  accepted; and `insert into t values (10, 555)` succeeds — that last one is the
  key-aliasing case that fails today.

Phase 4 — validation and docs

- `yarn lint`, `yarn build`, `yarn typecheck`, `yarn test`, then `yarn test:store`
  (each streamed with `tee`, per AGENTS.md).
- `docs/schema.md` § DDL Generation: state that the inline single-column
  `PRIMARY KEY` is rendered from `primaryKeyDefinition`, and that the per-column
  flags are a CREATE-time/planner-hint mirror of it, not an input to DDL.
- `docs/module-authoring.md` ~893 (`alterPrimaryKey`): document the obligation to
  rebuild the per-column flags and point at `rekeySchemaPrimaryKey`, matching how
  the `dropColumn` row (~877) points at `shiftSchemaIndicesForDrop`.
- While in `docs/schema.md` or `column.ts`, park this tripwire as a `NOTE:` at the
  `pkDirection` declaration: no code path populates `pkDirection` — CREATE leaves
  it `undefined` even for `primary key (a desc)` — so
  `buildConstraintsFromColumn` always emits `direction: undefined`. Harmless
  today because every consumer reads `primaryKeyDefinition.desc`; if a module is
  ever added that rebuilds its key from the reconstructed `ColumnDef`, a `desc`
  key would silently flip ascending.
