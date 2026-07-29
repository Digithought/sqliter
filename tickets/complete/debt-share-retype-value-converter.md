description: The code that converts a value when a column's type changes was copy-pasted in three separate places; it is now a single shared helper so a fix or a change in one spot cannot be missed in the other two.
files:
  - packages/quereus/src/types/validation.ts                        # planRetypeConversion + RetypeConversion
  - packages/quereus/src/index.ts                                    # exports the helper/type
  - packages/quereus/src/vtab/memory/layer/alter-column.ts           # planSetDataType calls the helper
  - packages/quereus-store/src/common/store-module-alter-column.ts   # alterColumnSetDataType calls the helper
  - packages/quereus-isolation/src/alter-migration.ts                # deriveSetDataTypeConvert calls the helper
  - packages/quereus/test/type-system.spec.ts                        # review: added planRetypeConversion unit tests
  - docs/module-authoring.md                                         # review: setDataType arm now names the shared helper
difficulty: easy
---

# One retype converter, three copies — now one

## What landed

`planRetypeConversion(dataType, oldLogicalType, columnName)` in `packages/quereus/src/types/validation.ts`, exported from `@quereus/quereus`'s root `index.ts` next to `foldDefaultToType`:

```ts
export interface RetypeConversion {
	readonly newLogicalType: LogicalType;
	readonly convert: ((value: SqlValue) => SqlValue) | null;
}
export function planRetypeConversion(dataType: string, oldLogicalType: LogicalType, columnName: string): RetypeConversion
```

It resolves `dataType` via `inferType` and compares by object identity against `oldLogicalType` (the alias-flattening gate: `varchar(50)` IS `TEXT_TYPE`). Equal → `convert: null` (metadata-only retype). Different → `convert` validates and normalizes one non-NULL value via `validateAndParse`, rethrowing failure as `QuereusError(`Cannot convert value in '<column>' to <type>`, StatusCode.MISMATCH)`. NULLs never reach it — every call site routes them around it.

Three call sites now share it: memory module `planSetDataType`, store module `alterColumnSetDataType`, isolation overlay `deriveSetDataTypeConvert`. Each kept its own surrounding logic (PK-retype rejection, comparator-change tracking, effective-row scanning, overlay wiring). One production site holds the message text.

## Review findings

### Checked

- **Diff read fresh before the handoff summary.** All three call sites verified line-by-line against their pre-refactor form: memory `if (newLogicalType === oldCol.logicalType) return metadataOnly(...)` → `if (!convert) return metadataOnly(...)`; store `if (newLogicalType !== oldCol.logicalType)` → `if (convert)`; isolation `if (newLogicalType === oldCol.logicalType) return undefined` → `if (!convert) return undefined`. All three are exact equivalents — `convert` is non-null iff the logical types differ. Check *ordering* (metadata-only return before PK rejection) unchanged. No semantic drift found.
- **Import cycle.** `types/validation.ts` now takes a *value* import of `inferType` from `types/registry.ts`. `registry.ts` and its transitive imports (`builtin-types`, `temporal-types`, `json-type`, `logger`) do not import `validation.ts` — no cycle.
- **Removed cast.** The old copies wrote `validateAndParse(...) as SqlValue`; the helper drops the cast. `validateAndParse` returns `SqlValue`, so the cast was redundant, not load-bearing.
- **Completeness of the extraction.** `grep validateAndParse` across every package outside `packages/quereus/src` returns nothing — no fourth hand-rolled copy hides in sync, plugins, or a wrapper. `Cannot convert value in` has exactly one production site.
- **Helper doc claim verified.** The docstring asserts the isolation layer keys error routing off `MISMATCH`; confirmed at `packages/quereus-isolation/src/isolation-module.ts:1468` (`CONSTRAINT || MISMATCH` → mark foreign overlay unusable rather than abort the ALTER).
- **NULL contract verified at all three sites.** Memory: `assertEveryValueConverts` skips NULL, `convertNulls: false`. Store: `valueConvert = v => v === null ? v : convert(v)`. Isolation: `if (value !== null) convert(value)`.
- **Isolation's "validated AND normalized" claim traced end-to-end.** The isolation `convert` is only ever called for validation (result discarded, `alter-migration.ts:529`); the actual staged-value normalization happens when `forwardAlterColumnToOverlay` forwards the change to the overlay table's own `alterSchema`, i.e. the memory module's `planSetDataType` running the shared helper on the overlay's rows. The comment is accurate; there is no missing rewrite.
- **Lint + tests.** `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc) clean; `@quereus/quereus` tests 7880 passing / 13 pending; `@quereus/store` 1186 passing; `@quereus/isolation` 348 passing; `@quereus/isolation` typecheck clean after the comment edit. No pre-existing failures surfaced.

### Found and fixed in this pass (minor)

- **No direct test for the new shared helper.** The three call sites were covered end-to-end, but nothing exercised `planRetypeConversion` itself — so the contract every backend now depends on had no unit-level pin. Added a `planRetypeConversion` describe block to `packages/quereus/test/type-system.spec.ts` (mirroring the existing `foldDefaultToType` block): alias retype returns a `null` converter, differently-spelled-but-same-inferred type (`bigint` vs `INTEGER_TYPE`) also returns `null`, storage-class change converts (`'7'` → `7`), same-storage-class retype normalizes (`text → date`: `'2024-06-05T00:00:00Z'` → `'2024-06-05'`), failure throws MISMATCH echoing the declared type *verbatim* (`'INTEGER'`, not the canonical name), and an unknown type name infers by affinity instead of throwing (which is what makes deriving the plan before any mutation safe).
- **`docs/module-authoring.md` `alterColumn.setDataType` row didn't name the new exported helper**, while its sibling rows (`addColumn`/`setNotNull` → `foldDefaultToType`, `dropColumn` → `shiftSchemaIndicesForDrop`) all do. A third-party module author reading that table would still hand-roll the converter and invent their own message/code — exactly the drift this ticket removed. Added the `planRetypeConversion` sentence, including why the status code matters (isolation keys off it).
- **Stale wording in the isolation docstring.** The rewritten comment still said the gate is *mirrored* here ("mirroring it here") when it is now *shared*. Reworded to say the decision comes from the same shared helper.

### Found and filed as tickets (major)

None. The change is a pure extract-shared-helper refactor and nothing in it warranted a new ticket.

### Tripwires recorded

None new. The two conditional concerns in this area were already sited as `NOTE:` comments by earlier tickets and remain accurate: the unconditional rewrite even when every converted value comes back byte-identical (`vtab/memory/layer/alter-column.ts`, above `planSetDataType`) and the store arm's scan ignoring a wrapper-supplied `rows` stream (`store-module-alter-column.ts`).

### Noted, not filed

`packages/quereus-isolation/src/alter-migration.ts` is 1089 lines — above what this codebase's other files run. Pre-existing (this diff *shrank* it by 15 lines), cohesive in purpose (one derive-plan/validate/forward pipeline per ALTER arm, heavily documented), and unrelated to this ticket's scope, so no ticket filed. Worth splitting if another ALTER arm gets added.

### Not run

`yarn test:store` / `yarn test:full` (store-backed logic-test rerun). The three package suites already exercise every retype call site — memory module, store module, isolation overlay — and all passed on a change with no behavior difference. Deferred to CI rather than spending ~10 minutes of ticket wall-clock on it.
