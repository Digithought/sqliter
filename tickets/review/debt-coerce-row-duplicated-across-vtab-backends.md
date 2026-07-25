description: |
  Four copies of "coerce every cell in a row to its declared column type" scattered across three
  packages have been unified into one shared helper, so a future fix to this logic only needs to
  land in one place.
files:
  - packages/quereus/src/types/validation.ts                          # new coerceRowToSchema (~line 94)
  - packages/quereus/src/index.ts                                     # export added
  - packages/quereus/src/types/index.ts                                # export added
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # performInsert (~829) / performUpdate (~875) now call coerceRowToSchema
  - packages/quereus-store/src/common/store-table.ts                   # StoreTable.coerceRow (~995) now delegates
  - packages/quereus-isolation/src/isolated-table.ts                   # IsolatedTable.coerceRow (~1041) now delegates
difficulty: easy
---

# Extracted shared `coerceRowToSchema` helper

## What changed

Added `coerceRowToSchema(row, columns, label)` to `packages/quereus/src/types/validation.ts`,
exported it from both `packages/quereus/src/index.ts` and `packages/quereus/src/types/index.ts`,
and rewired all four previously-duplicated call sites to delegate to it:

- `StoreTable.coerceRow` (`packages/quereus-store/src/common/store-table.ts:995`)
- `IsolatedTable.coerceRow` (`packages/quereus-isolation/src/isolated-table.ts:1041`)
- `MemoryTableManager.performInsert` (`packages/quereus/src/vtab/memory/layer/manager.ts:~828`)
- `MemoryTableManager.performUpdate` (`packages/quereus/src/vtab/memory/layer/manager.ts:~874`)

The helper does exactly what the four copies did: guard row-length against the column count, throw
a `QuereusError(StatusCode.ERROR)` "Too many values for `<label>`: expected N, got M" if the row is
too long, else `map` each cell through `validateAndParse(value, column.logicalType, column.name)`.

## The `label` param

The four call sites had two different error wordings ("Too many values for
`<schemaName>.<tableName>`" from the store/isolation backends vs "Too many values for INSERT into
`<tableName>`" / "...UPDATE on `<tableName>`" from the memory-table manager). Rather than pick a
winner, the helper takes a pre-built `label: string` and each call site passes its own existing
wording verbatim — so no message text changed and no test needed updating. Searched the repo for
any test asserting the literal "Too many values" string; found none (`packages/quereus-store/test/column-coercion.spec.ts`
only asserts on JSON/type-mismatch errors), so there was no exact-message-matching risk either way,
but the label param keeps that door open for the next backend to add without touching the others'
wording.

## Why this location

`validateAndParse` (the function the helper wraps) already lives in
`packages/quereus/src/types/validation.ts`, not `logical-type.ts` as the originating ticket
guessed — `logical-type.ts` only defines the `LogicalType` interface and physical-type helpers.
`coerceRowToSchema` needed `ColumnSchema` (from `packages/quereus/src/schema/column.ts`) as well,
which was safe to import into `validation.ts` (no cycle: `schema/column.ts` only reaches back into
`types/logical-type.ts` and `types/builtin-types.ts`, never `types/validation.ts`).

## Testing

- `yarn workspace @quereus/quereus run build` — clean
- `yarn workspace @quereus/store run build` — clean
- `yarn workspace @quereus/isolation run build` — clean
- `yarn workspace @quereus/quereus run test` — 7175 passing, 13 pending (unchanged from baseline)
- `yarn workspace @quereus/store run test` — 960 passing (includes `column-coercion.spec.ts`,
  the suite written for the affinity-coercion bug this logic serves — INTEGER/REAL affinity, JSON
  parse/reject, PK coercion, persistence round-trip all still green)
- `yarn workspace @quereus/isolation run test` — 251 passing
- `yarn workspace @quereus/quereus run lint` — clean (this is the package with a real lint +
  `tsc -p tsconfig.test.json --noEmit`; store/isolation only have the no-op `echo` lint script)

No new tests were added — this is a pure refactor (same guard, same error text, same
`validateAndParse` call per cell) and the existing suites already exercise all three call sites'
behavior end-to-end. If reviewing for regressions, the highest-value check is: diff the old vs new
body of each of the four sites and confirm the semantics (guard placement, `map` order, per-cell
column lookup) are identical — that's what `git diff` will show cleanly since each site shrank to a
one-line delegation.

## Known gaps / things I did not chase

- Did not add a unit test directly targeting `coerceRowToSchema` in isolation (e.g. in
  `packages/quereus/test/`) — coverage is entirely through the three backends' existing
  integration-style suites. A direct unit test would pin the guard + error text + per-cell mapping
  without needing a full `Database`/table setup, if the reviewer wants tighter coverage.
- Did not touch `docs/runtime.md:881`, which mentions "coerced ... via `validateAndParse`" in
  prose — still accurate (the helper calls `validateAndParse` per cell under the hood) so left
  as-is rather than churn a doc line for an internal refactor.
