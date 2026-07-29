description: The code that converts a value when a column's type changes was copy-pasted in three separate places; it is now a single shared helper so a fix or a change in one spot cannot be missed in the other two.
files:
  - packages/quereus/src/types/validation.ts                        # new: planRetypeConversion + RetypeConversion
  - packages/quereus/src/index.ts                                    # exports the new helper/type
  - packages/quereus/src/vtab/memory/layer/alter-column.ts           # planSetDataType now calls the helper
  - packages/quereus-store/src/common/store-module-alter-column.ts   # alterColumnSetDataType now calls the helper
  - packages/quereus-isolation/src/alter-migration.ts                # deriveSetDataTypeConvert now calls the helper
difficulty: easy
---

# One retype converter, three copies — now one

## What changed

Added `planRetypeConversion(dataType, oldLogicalType, columnName)` to `packages/quereus/src/types/validation.ts`, exported from `@quereus/quereus`'s root `index.ts` alongside the existing `foldDefaultToType` (the same kind of cross-package shared ALTER helper).

```ts
export interface RetypeConversion {
	readonly newLogicalType: LogicalType;
	readonly convert: ((value: SqlValue) => SqlValue) | null;
}
export function planRetypeConversion(dataType: string, oldLogicalType: LogicalType, columnName: string): RetypeConversion
```

It resolves `dataType` via `inferType` and compares it by object identity against `oldLogicalType` (the existing alias-flattening gate: `varchar(50)` IS `TEXT_TYPE`). Equal → `convert: null` (metadata-only retype, nothing to rewrite). Different → `convert` validates and normalizes one non-NULL value via `validateAndParse`, and on failure throws `QuereusError` with the exact pre-existing message `` `Cannot convert value in '<column>' to <type>` `` and `StatusCode.MISMATCH`. NULL handling is unchanged: the helper never sees NULLs — every call site still routes them around `convert` itself (or, for the NOT NULL backfill path, maps them to the folded DEFAULT before this helper is ever involved).

All three previous copies now call it:
- `packages/quereus/src/vtab/memory/layer/alter-column.ts` `planSetDataType`
- `packages/quereus-store/src/common/store-module-alter-column.ts` `alterColumnSetDataType`
- `packages/quereus-isolation/src/alter-migration.ts` `deriveSetDataTypeConvert`

Each site kept its own surrounding logic (PK-retype rejection, comparator-change tracking, effective-row scanning, overlay-vs-underlying wiring) — only the "does this rewrite / how do I convert one value" decision moved into the shared helper. `grep -rn "Cannot convert value in" packages --include=*.ts` now shows exactly one production site (`types/validation.ts`); the other two hits are test assertions.

## Validation performed

- `yarn workspace @quereus/quereus run build` / `run lint` / `run typecheck` — clean
- `yarn workspace @quereus/store run build` / `run typecheck` — clean
- `yarn workspace @quereus/isolation run build` / `run typecheck` — clean
- `yarn workspace @quereus/quereus run test` — 7874 passing, 13 pending (no failures); includes `test/vtab/alter-column-plan.spec.ts` (asserts the exact message text) and `test/logic/41.2-alter-column.sqllogic`
- `yarn workspace @quereus/store run test` — 1186 passing (no failures); includes `test/alter-pending-ops.spec.ts` (`Cannot convert value` regex assertion)
- `yarn workspace @quereus/isolation run test` — 348 passing (no failures); includes `test/alter-table-conformance.spec.ts`, which is the test the original ticket called out as asserting on the literal message string (lines ~582, ~619) — both still pass unchanged

No `yarn test:store` (full store-backed logic-test rerun) or `yarn test:full` run — the package-level test suites above already exercise every retype call site (memory module, store module, isolation overlay) and all passed; a full rerun was judged redundant for a pure extract-a-helper change with no behavior change. Reviewer may want to run it anyway for extra confidence given ALTER COLUMN's history of subtlety in this codebase.

## What to check on review

- Confirm the three call sites still read correctly in context — the PK-retype-rejection check in each now runs AFTER `planRetypeConversion` returns instead of interleaved with the old inline `newLogicalType` computation; the *order* of checks (metadata-only-return before PK-rejection) is unchanged, just refactored to route through the shared decision point first.
- The isolation site's doc comment above `deriveSetDataTypeConvert` previously argued the copies "cannot drift" *because* they were literal mirrors (the concern this ticket exists to fix) — I rewrote that comment to point at the shared helper instead; worth a read to confirm the new wording is accurate.
- No behavior change was intended anywhere; this is a pure extract-shared-helper refactor. If reviewing turns up any semantic drift versus the pre-refactor code, that's a bug in this change, not a pre-existing issue.
