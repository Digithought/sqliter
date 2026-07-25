---
description: |
  The same "coerce every cell in a row to its declared column type" logic is copy-pasted in four
  places across the store, isolation, and memory table backends. A fix to one copy won't reach the
  others, so they can silently drift apart. Extract one shared helper.
files:
  - packages/quereus-store/src/common/store-table.ts                 # StoreTable.coerceRow (~:857)
  - packages/quereus-isolation/src/isolated-table.ts                 # IsolatedTable.coerceRow (~:825)
  - packages/quereus/src/vtab/memory/layer/manager.ts                # performInsert (~:829) + performUpdate (~:886), inline copies
  - packages/quereus/src/types/logical-type.ts                       # validateAndParse lives near here; natural home for the shared helper
difficulty: easy
---

# Extract one shared `coerceRowToSchema` helper

## What

Four near-identical implementations of "map each cell through `validateAndParse(value,
column.logicalType, column.name)`, guarding against too-many-values" now exist:

- `StoreTable.coerceRow` (`packages/quereus-store/src/common/store-table.ts`)
- `IsolatedTable.coerceRow` (`packages/quereus-isolation/src/isolated-table.ts`) — added by
  `bug-store-isolation-upsert-affinity-coerced-pk`
- two inline copies in `MemoryTableManager.performInsert` / `performUpdate`
  (`packages/quereus/src/vtab/memory/layer/manager.ts`)

All four do the same thing with the same "Too many values for … expected N, got M" error. They are
in three different packages, so a correctness fix to one (e.g. how a partial/short row is handled,
or the error message) will not propagate — the copies can drift.

## Why it's backlog, not inline

The `bug-store-isolation-upsert-affinity-coerced-pk` fix that surfaced this was a scoped bug fix
told explicitly not to touch `store-table.ts` or `manager.ts` (reference-only). Unifying the four
copies means editing all three packages plus exporting a new helper, and re-running `yarn test:store`
to confirm the store/memory write paths are unchanged — more scope and risk than that bug fix owned.

## Shape

Add an exported helper alongside `validateAndParse` (e.g. in
`packages/quereus/src/types/logical-type.ts`):

```ts
export function coerceRowToSchema(row: Row, columns: ColumnSchema[], schemaName: string, tableName: string): Row
```

that contains the guard + `map(validateAndParse)` loop once, and have all four call sites delegate
to it. Watch the two subtly-different error strings ("Too many values for `<schema>.<table>`" vs
"Too many values for INSERT into `<table>`") — pick one wording or keep an operation label param so
existing test expectations (if any assert the message) still match.
