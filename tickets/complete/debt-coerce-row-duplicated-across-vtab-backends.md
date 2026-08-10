description: |
  Four copies of "coerce every cell in a row to its declared column type" scattered across three
  packages were unified into one shared helper, so a future fix to this logic only needs to land in
  one place. Reviewed and given direct unit tests.
files:
  - packages/quereus/src/types/validation.ts        # coerceRowToSchema
  - packages/quereus/src/index.ts                   # export
  - packages/quereus/src/types/index.ts             # export
  - packages/quereus/src/vtab/memory/layer/manager.ts   # performInsert / performUpdate delegate
  - packages/quereus-store/src/common/store-table.ts    # StoreTable.coerceRow delegates
  - packages/quereus-isolation/src/isolated-table.ts    # IsolatedTable.coerceRow delegates
  - packages/quereus/test/type-system.spec.ts       # new unit coverage (added in review)
difficulty: easy
---

# Shared `coerceRowToSchema` helper — complete

## What landed

`coerceRowToSchema(row, columns, label)` in `packages/quereus/src/types/validation.ts`: guards
`row.length > columns.length` (throws `QuereusError(StatusCode.ERROR)` "Too many values for
`<label>`: expected N, got M"), else maps each cell through `validateAndParse(value,
column.logicalType, column.name)`. Exported from `src/index.ts` and `src/types/index.ts`.

All four previously-duplicated sites now delegate to it: `StoreTable.coerceRow`,
`IsolatedTable.coerceRow`, and both inline copies in `MemoryTableManager.performInsert` /
`performUpdate`.

The `label` parameter exists because the four sites carried two different wordings
(`<schema>.<table>` for the store/isolation backends; `INSERT into <table>` / `UPDATE on <table>`
for the memory manager). Each site passes its own wording, so no user-visible message changed.

## Review findings

**Checked:** the implement diff cell-by-cell against the four original bodies (guard placement,
`map` order, per-cell column lookup); import cycle risk of `types/validation.ts` → `schema/column.ts`;
leftover unused imports at every touched site; whether a fifth duplicate exists; test coverage of
the extracted helper; lint + all three packages' test suites; every doc line mentioning the affected
functions.

**Semantics — clean.** All four bodies reduce to the helper exactly. One deliberate behavior
difference worth recording: the memory manager previously ran its too-many-values guard *inside* the
`map`, so a row that was both too long and had an invalid cell at index 0 reported the *validation*
error; the helper checks length first, so it now reports "Too many values". Strictly clearer, no test
asserted the old precedence, and the store/isolation copies already guarded up front — the four sites
are now consistent where they previously were not.

**No fifth duplicate.** `constraint-check.ts:423` also calls `validateAndParse` per column, but it
writes into a sparse snapshot by index with no row-length guard and a per-cell fall-back-to-raw on
failure — a genuinely different operation, correctly left alone. `validateAndParse` remains imported
in `manager.ts` for its `ALTER COLUMN` retype path (line ~2105); no dead imports anywhere in the
diff.

**Test gap — fixed in this pass (minor).** The implementer added no direct coverage, and the
too-many-values guard turned out to be untested by *any* suite in the repo. Added five unit tests to
`packages/quereus/test/type-system.spec.ts` (`describe('coerceRowToSchema')`): per-cell coercion to
distinct column types, short rows accepted, empty row accepted, the too-long throw asserting both the
caller-supplied label in the message and `StatusCode.ERROR`, and a failing cell surfacing its column
name. Test count went 7175 → 7180.

**Docs — verified, no change needed.** `docs/runtime.md:881` ("coerced ... via `validateAndParse`")
describes the ConstraintCheck snapshot path in `constraint-check.ts`, which still calls
`validateAndParse` directly and was not touched. No other doc references these functions.

**Unrelated content in the commit — left alone deliberately.** `d2794174` also carries a hunk in
`packages/quereus/bench/suites/execution.bench.mjs` adding `createTextDb`, `createTextPkDb`,
`PREFIX40`, and `UNICODE_PREFIX`. Nothing references them yet, so they are currently dead code.
They belong to `debt-bench-no-text-comparison-coverage`, which is still sitting in `tickets/implement/`
— a concurrent run's in-flight edit swept into this commit. Its own run will add the benchmark
entries that consume them, so reverting would destroy another ticket's work. Flagged, not touched.

**Major findings:** none — no new tickets filed. **Tripwires:** none; the helper has no
conditional-scaling or deferred-cost characteristics worth parking a note about.

## Validation

- `yarn workspace @quereus/quereus run test` — 7180 passing, 13 pending
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`)
- `yarn workspace @quereus/store run test` — 960 passing
- `yarn workspace @quereus/isolation run test` — 251 passing
