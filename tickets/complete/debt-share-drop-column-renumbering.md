description: Two storage backends each kept their own copy of the bookkeeping for renumbering a table's positional fields when a column is dropped; this folded them into one shared routine, and the review pass found that dropping a column also left a unique index falsely claiming uniqueness over its remaining columns.
files:
  - packages/quereus/src/schema/table.ts                          # shiftSchemaIndicesForDrop (~line 491)
  - packages/quereus/src/index.ts                                  # package-root export
  - packages/quereus/src/vtab/memory/layer/manager.ts              # dropColumn
  - packages/quereus-store/src/common/store-module-alter.ts        # alterDropColumn (file split out of store-module.ts after implement)
  - packages/quereus/test/schema-shift-drop-column.spec.ts         # unit contract spec
  - packages/quereus/test/logic/41.10.1-alter-drop-column-unique-index.sqllogic  # cross-backend regression
  - docs/module-authoring.md                                       # dropColumn arm mandate
---

# Shared DROP COLUMN index-renumbering — complete

## What shipped

`shiftSchemaIndicesForDrop(schema, colIndex)` in `packages/quereus/src/schema/table.ts`,
exported from the package root, is now the single implementation of DROP COLUMN's
position renumbering. It is the mirror of the existing `shiftSchemaIndicesForInsert`
(which stays in `vtab/memory/layer/manager.ts` — still one caller). Given the pre-drop
schema and the dropped column's index it returns the renumbered `columns`,
`primaryKeyDefinition`, `indexes`, `uniqueConstraints`, `foreignKeys`, plus
`removedUniqueConstraints` (pre-shift indices, so a caller can name and tear down the
physical structure it materialized per constraint).

The rule it encodes: a PRIMARY KEY member, UNIQUE constraint, foreign key, or **UNIQUE
index** that names the dropped column is removed **outright**, not narrowed — one missing
a column is a different, stronger constraint. A plain index is narrowed, and one left with
no columns is dropped. Every survivor's column indices shift down over the removed slot.

Both `MemoryTableManager.dropColumn` and `StoreModule.alterDropColumn` (now in
`store-module-alter.ts`, split out after the implement pass) call it. What remains
backend-specific in each is genuinely so: the memory module still name-excludes the
auto-built covering index of a removed UNIQUE constraint (that index deliberately carries
no `unique: true` flag — enforcement routes through `uniqueConstraints` — so the shared
helper's unique-index rule does not see it), and the store module relies on its separate
generic `reconcileImplicitUniqueIndexStores` pass for the physical `_uc_*` store.

`columnIndexMap` stays the caller's to rebuild via `buildColumnIndexMap`, matching every
other schema-mutation site.

## Review findings

### Read first, then the handoff

Reviewed the implement diff (`b227b6b5`) before reading the handoff summary. The
consolidation itself is correct: the helper is a faithful union of the two copies, and the
handoff's one flagged risk — the memory module now name-excludes the dropped covering index
*after* the positional pass instead of before — is genuinely order-independent (the two
filters select over independent dimensions: which indexes survive vs. how a survivor's own
columns renumber). Confirmed by reasoning and by the suite.

### Major — found and fixed in this pass

**A UNIQUE index spanning the dropped column survived, narrowed and unenforced.**
The helper inherited both backends' index handling verbatim: prune the dropped column from
each index, keep the rest. For a `create unique index ux_bc on t (b, c)` followed by
`drop column b`, that left `ux_bc` in `indexes` as `unique (c)` — a constraint the table
never declared — while the matching `derivedFromIndex` UNIQUE constraint (the thing that
actually enforces it, see `appendIndexToTableSchema`) was correctly removed by the
constraint rule. So the index advertised uniqueness nothing checked.

Reproduced against both backends before fixing. Memory happened to escape it, but only by
accident: its by-name covering-index exclusion matches the derived constraint's name, which
equals the index name, so the narrowed index was filtered out anyway. The **store** module
does not run that pass and kept it: schema showed
`[{"name":"ux_bc","columns":[{"index":1,...}],"unique":true}]` with `uniqueConstraints`
undefined, and a duplicate `c` insert was accepted. Three consumers take that flag at face
value — `index_info` (`func/builtins/schema.ts`), the planner's at-most-one-partner-row
proof (`planner/mutation/multi-source.ts`, which can fold away a join on the strength of
it), and `generateTableDDL`, which re-persists it as a real `CREATE UNIQUE INDEX` that
`appendIndexToTableSchema` resurrects as an enforced constraint on reopen.

Fixed in the shared helper — one filter, drop a `unique` index that loses any column, the
same argument the function already documented for constraints — so both backends agree.
Both callers' comments updated to say which module needs which pass and why.

**`DROP COLUMN` leaks a removed index's backing store (store backend).** Filed as
`tickets/fix/bug-drop-column-leaks-index-store.md`. Pre-existing and independent of this
ticket: an index whose *only* column is dropped has always been removed from the schema
with no `deleteIndexStore` call, so `main.t_idx_ix_b` outlives the index it belonged to.
Confirmed by inspecting the provider's store map after the drop. Two consequences — space
never reclaimed, and a later `CREATE INDEX` of the same name gets the stale store back from
`getIndexStore` rather than a fresh one (`assertStoreNameFree` compares against registered
schema objects, and the dropped index is no longer one). Whether the stale entries produce
wrong answers is the open question the ticket asks first; a UNIQUE index is the case to
prove, since `findUniqueConflictViaIndex` trusts the index to describe live rows. Not fixed
here: it needs teardown wiring plus reopen coverage, and the fix above only widens an
existing hole rather than opening one. Sited with a comment in `alterDropColumn`.

### Tests

The implementer's own gap list was accurate — no new tests. Now covered:

- `packages/quereus/test/schema-shift-drop-column.spec.ts` — the unit contract spec the
  prior (interrupted) review run wrote, pinning each returned field. Amended: its
  "preserves index-level fields of a survivor" case asserted `unique` survived a narrowing,
  which pinned the bug above; it now checks `tags` instead, and two new cases cover
  remove-unique-outright and narrow-a-unique-that-keeps-every-column.
- `packages/quereus/test/logic/41.10.1-alter-drop-column-unique-index.sqllogic` — new,
  and the higher-value placement: `.sqllogic` runs under **both** `yarn test` (memory) and
  `yarn test:store`, so one file asserts the two backends now agree. Covers the UNIQUE index
  spanning the dropped column, a UNIQUE index that keeps all its columns, and a plain index
  that is narrowed. Verified failing-then-passing shape by running it against each backend.

### Minor — fixed in this pass

- **No bounds check on `colIndex`.** Both in-tree callers do their own name lookup, but the
  helper is now public API and `docs/module-authoring.md` points third-party module authors
  at it. Out of range, every shift silently no-ops and the schema keeps a column the module
  has removed. Now throws `INTERNAL`; unit-tested at `-1` and past the last column.
- **`docs/module-authoring.md` was stale.** Its per-arm mandate table still described
  `dropColumn` as "Remove the column slot and reindex remaining columns" — one line, while
  the sibling `addColumn` entry spells out the same renumbering obligation in detail. It now
  names the exported helper, its return fields, and the removed-outright-vs-narrowed rule.
  Checked the other files this change touches or should have: `docs/schema.md` covers only
  ALTER *phase ordering* (unaffected), `docs/memory-table.md` covers the memory module's
  transaction/base-rewrite rules for DROP COLUMN (unaffected — no schema-field claims), and
  no doc referenced the old duplicated logic.

### Checked, nothing to report

- **Scratch files from the interrupted run.** The resume commit (`161a1ce3`) had swept up
  `packages/quereus/test/zz-scratch.spec.ts`, a throwaway probe. Deleted. The unit spec from
  the same run was real work and was kept.
- **Frozen-ness / immutability.** Every array the helper returns is frozen at the top level;
  the per-index `columns` arrays are plain, exactly as in both pre-refactor copies. Verified
  the helper does not mutate its input (unit-tested).
- **DRY, decomposition, file size.** The helper is a single ~35-line pure function with one
  local `shift`; both call sites shrank by ~40 lines each. `schema/table.ts` is 1358 lines —
  large, but it is the schema type module and well below the sizes that earned this repo's
  own file-splitting tickets; not worth churning here.
- **Type safety / error handling.** No `any`, no widened returns, no swallowed exceptions.
  The one new throw is a programmer-error guard, not control flow.
- **Resource cleanup.** The one real finding is the index-store leak above. Nothing else in
  the diff acquires a resource.

### Tripwires

None recorded. Every concern this pass turned up was either definitely wrong on a path
reachable today (the unique-index narrowing, fixed; the store leak, ticketed) or fine as
written — nothing landed in the "fine now, only matters if X later" category, so there was
nothing to park as a `NOTE:`.

### Not pursued

The `_uc_<cols>` implicit-index *naming* convention is still duplicated between
`MemoryTableManager.implicitIndexNameFor` and the store's `implicitUniqueIndexName`. The
implementer flagged it and was right to leave it: it is used across ADD/DROP/RENAME
CONSTRAINT in both files, so unifying it is a separately-scoped change, not DROP COLUMN
work. Not filed — no defect, and the duplication is stable and named identically on both
sides.

## Validation

Final state, from repo root:

- `yarn build` — clean.
- `yarn lint` — clean (eslint + the test-file `tsc` pass).
- `yarn typecheck` — clean across all workspaces.
- `yarn test` — `packages/quereus` **7874 passing, 13 pending**; every other workspace
  passing (store package 1186, sync 594, …). 0 failing.
- `yarn test:store` — **7865 passing, 22 pending**, 0 failing.

No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.
