----
description: In-memory tables let two different spellings of the same duration (like "PT1H" and "PT60M") both sit in a UNIQUE column, even though everything else in the engine treats them as the same value. The second one should be rejected as a duplicate.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # checkUniqueViaIndex / checkUniqueViaMaterializedView / checkUniqueByScanning
  - packages/quereus/src/schema/unique-enforcement.ts        # home for the new shared comparator helper
  - packages/quereus/src/index.ts                            # export the helper for the store / isolation packages
  - packages/quereus-store/src/common/store-table.ts         # uniqueColumnComparators (~2241) — the existing copy to fold in
  - packages/quereus-isolation/src/isolated-table.ts         # findMergedUniqueConflict (~1632) — the other existing copy
  - packages/quereus/src/util/comparison.ts                  # hasSemanticOrdering / createTypedComparator
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # "secondary UNIQUE identity" — re-add the memory oracle
difficulty: medium
----

# Memory backend: UNIQUE enforcement must compare through the column's type

## Background

Some declared column types define their own notion of "same value" that differs from
comparing the stored text byte-for-byte. `docs/types.md` § "Semantic ordering" calls this
**semantic ordering**, and a type opts in by setting `semanticOrdering: true` plus a
`compare` function. `TIMESPAN` is the motivating case: the stored text `'PT1H'` and
`'PT60M'` are two spellings of one hour, and `TIMESPAN.compare` returns 0 for them.
Everywhere else in the engine they already behave as one value — `=`, `DISTINCT`,
`GROUP BY`, the memory table's PRIMARY KEY, and (since ticket
`duration-json-semantic-ordering-store`) the persistent store's UNIQUE constraints.

The in-memory backend's UNIQUE enforcement is the remaining hole.

## Reproduced behaviour

Verified against `main` with a scratch mocha spec (deleted; reproduce with the SQL below).

| case | SQL | actual | expected |
|---|---|---|---|
| plain column UNIQUE | `create table m (id integer primary key, d timespan unique); insert into m values (1,'PT1H'); insert into m values (2,'PT60M')` | **accepted** | UNIQUE violation |
| `insert or ignore` / `insert or replace` of the same | — | **both insert a second row** | ignore drops it / replace evicts row 1 |
| composite UNIQUE | `unique (k, d)` with `(1,'PT1H')` then `(1,'PT60M')` | **accepted** | UNIQUE violation |
| `create unique index` (write time) | index on `d`, insert `'PT1H'` then `'PT60M'` | **accepted** | UNIQUE violation |
| `update` into a colliding spelling | rows `'PT1H'` and `'PT30M'`; `update … set d='PT60M'` on the second | **accepted** | UNIQUE violation |
| `create unique index` over rows already holding both spellings | — | correctly rejected | (already correct) |
| `alter table … add constraint … unique (d)` over both spellings | — | correctly rejected | (already correct) |
| JSON column UNIQUE, key-reordered objects | `'{"a":1,"b":2}'` then `'{"b":2,"a":1}'` | correctly rejected | (already correct) |

## Root cause

The candidate lookup is already type-aware; the re-validation immediately after it is not.

`MemoryIndex` builds its BTree comparator with `createTypedComparator(columnSchema.logicalType, …)`
(`src/vtab/memory/index.ts` `createSingleColumnKeyFunctions` / `createCompositeColumnKeyFunctions`),
so `index.getPrimaryKeys(indexKey)` for a `'PT60M'` probe **does** return the primary key of
the `'PT1H'` row. Instrumented confirmation on `main`:

```
DBG checkUniqueViaIndex {"indexKey":"PT60M","candidates":1,"index":"_uc_d"}
```

`MemoryTableManager.checkUniqueViaIndex` then re-validates that candidate against the live
row with `compareSqlValuesFast(newRowData[col], conflictingRow[col], enforcementCollations[i])`
— storage-class + collation, no type involvement. That comparison says `'PT1H' ≠ 'PT60M'`, the
loop `continue`s, and the insert is accepted. The same byte/collation comparison is used in the
two sibling re-validators.

The build-time path is correct precisely because it has no such re-validation step: it probes
`index.hasAnyPrimaryKey(indexKey)` on the typed BTree and stops there (`layer/base.ts`
`addRowToIndex`), which is why `create unique index` over pre-existing duplicates and
`add constraint unique` already reject.

## Expected behaviour

Each constrained column compares through its declared type's `compare` when that type carries
semantic ordering, and through the enforcement collation otherwise — the rule the store and the
isolation overlay already follow. Concretely: the reproduced cases above flip to "UNIQUE
violation", `on conflict ignore` drops the second row, and `on conflict replace` evicts the
first — matching `using store` exactly.

Non-semantic-ordering columns must be untouched: their declared `compare` is not
collation-aware, so consulting it for a TEXT/ANY column would break NOCASE/RTRIM enforcement.
The existing `hasSemanticOrdering` predicate is the gate for exactly this reason.

## Design

There are already two independent copies of the needed per-column comparator construction:

- `StoreTable.uniqueColumnComparators` (`quereus-store/src/common/store-table.ts` ~2241)
- an inline block in `IsolatedTable.findMergedUniqueConflict` (`quereus-isolation/src/isolated-table.ts` ~1632)

Both are literally:

```ts
uc.columns.map((colIdx, i) => {
    const logicalType = columns[colIdx]?.logicalType;
    if (hasSemanticOrdering(logicalType)) return createTypedComparator(logicalType, collations[i]);
    return (a: SqlValue, b: SqlValue) => compareSqlValuesFast(a, b, collations[i]);
});
```

Adding a third copy in memory would be the wrong move. Lift it into
`src/schema/unique-enforcement.ts` — the module that already owns the shared
`uniqueEnforcementCollations` / `resolveUniqueEnforcementCollations` and is already exported
from the package index for exactly these two out-of-package callers:

```ts
/**
 * Per-constrained-column comparison functions for one UNIQUE constraint … (see the
 * file docstring for why memory resolves its own collations rather than sharing
 * `uniqueEnforcementCollations`).
 */
export function uniqueEnforcementComparators(
    columns: readonly ColumnSchema[],
    ucColumns: readonly number[],
    collations: readonly CollationFunction[],
): Array<(a: SqlValue, b: SqlValue) => number>
```

Take `(columns, ucColumns, collations)` rather than `(schema, uc, …)`: memory's
`checkUniqueViaIndex` deliberately resolves its collations from the **live `MemoryIndex`
handle** (`index.specColumns[i]?.collation ?? schema.columns[col].collation`), not from
`uniqueEnforcementCollations`, and that divergence is intentional and conformance-locked by
`test/unique-enforcement-collation.spec.ts` — do not change it. A signature that takes
pre-resolved collations lets all four call sites share the comparator construction while each
keeps its own collation resolution.

`hasSemanticOrdering` and `createTypedComparator` already live in `util/comparison.ts`, which
`unique-enforcement.ts` already imports from, so there is no new import edge.

### The three memory call sites

All in `packages/quereus/src/vtab/memory/layer/manager.ts`:

- `checkUniqueViaIndex` (~1167) — collations from the live index handle; the compare is the
  `uc.columns.every(...)` guard at ~1224.
- `checkUniqueViaMaterializedView` (~1271) — collations from `uniqueEnforcementCollations`;
  compare at ~1301.
- `checkUniqueByScanning` (~1336) — the cold full-scan fallback; collations from the declared
  column collation; compare at ~1352.

Resolve the comparators once per constraint check, above the candidate loop, exactly where the
collations are resolved today (the resolver throws on an unregistered name and is not
inlinable). `checkUniqueViaIndex`'s existing `if (existingPKs.length === 0) return null` early
bail must stay ahead of that resolution.

`enforceSecondaryUniqueOnMaintenance` (~1678) reuses `checkSingleUniqueConstraint` and is fixed
transitively — no separate change.

## Out of scope / already tracked

- **`alter table … alter column … set data type timespan` over two colliding spellings is also
  accepted today** (verified). That is a second instance of the already-filed
  `fix/bug-set-data-type-skips-unique-index-revalidation` — the `SET DATA TYPE` arm of
  `alterColumn` only runs `validateRekeyedUniqueStructures` when the *collation* changed, never
  when the type (and hence the identity comparator) changed. Do **not** fix it here; that
  ticket's fix covers it, because its uniqueness probe builds a `MemoryIndex` from the NEW
  schema and so compares under the new type.
- **A UNIQUE constraint answered by a row-time covering materialized view is still admitted
  even after this ticket**, because the *candidate generator* filters under the declared
  collation before the re-validators ever see a candidate. That is engine-side and affects both
  backends — split out as `covering-mv-conflict-candidates-semantic`, which lists this ticket
  as its prerequisite.

## Tripwire noticed (do not file)

`MemoryTableManager.uniqueColumnsChanged` (~996) decides whether an UPDATE needs a UNIQUE
re-check using byte-level `compareSqlValues`. For a semantic-ordering column that
over-triggers (a `'PT1H'` → `'PT60M'` rewrite is reported as "changed" and re-runs the check,
which then excludes the row's own primary key and passes). Correct today, just not minimal.
Worth a `NOTE:` comment at the site while you are in the file rather than a behaviour change.

## TODO

Phase 1 — shared helper

- Add `uniqueEnforcementComparators` to `packages/quereus/src/schema/unique-enforcement.ts`
  with the signature above; document why it takes pre-resolved collations.
- Export it from `packages/quereus/src/index.ts` alongside `resolveUniqueEnforcementCollations`.
- Fold `StoreTable.uniqueColumnComparators` onto it (keep the method as a thin wrapper if the
  call sites read better that way) and replace the inline block in
  `IsolatedTable.findMergedUniqueConflict`. Preserve the existing explanatory comments at both
  sites — they carry the collation-superset reasoning.

Phase 2 — memory enforcement

- Route `checkUniqueViaIndex`, `checkUniqueViaMaterializedView`, and `checkUniqueByScanning`
  through the helper, each keeping its own collation resolution.
- Add a `NOTE:` at `uniqueColumnsChanged` for the tripwire above.

Phase 3 — tests

- Extend `packages/quereus/test/logic/15.1-semantic-ordering.sqllogic` with a UNIQUE block:
  plain column UNIQUE rejecting `'PT60M'` after `'PT1H'`; `insert or ignore` and
  `insert or replace` behaving as the store does; a composite `unique (k, d)` rejecting a
  duplicate while a differing leading column still inserts; `create unique index` write-time
  rejection; an UPDATE re-spelling the value on the SAME row succeeding (self-exclusion) while
  an UPDATE into another row's spelling is rejected; and a TEXT column holding the same
  strings under a UNIQUE constraint still accepting both (the negative control that proves
  only declared-TIMESPAN columns changed).
- In `packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` § "secondary UNIQUE
  identity", add the memory table back as the oracle in
  `"rejects 'PT60M' after 'PT1H' in a UNIQUE column, honoring \`on conflict\`"` and
  `"maintains a UNIQUE index across an UPDATE that re-spells the indexed value"`, and delete
  the comment that defers to this ticket slug.
- Confirm `packages/quereus/test/unique-enforcement-collation.spec.ts` and
  `test/logic/102.2-unique-collation.sqllogic` still pass — the NOCASE/RTRIM enforcement paths
  must be byte-for-byte unaffected.

Phase 4 — validation

- `yarn build`, `yarn lint`, `yarn test`.
- `yarn test:store` for the store-side refactor (it re-runs the quereus logic tests against
  LevelDB and exercises the folded `uniqueColumnComparators`).
- Update `docs/types.md` § "Semantic ordering" so its list of identity-collapsing sites names
  memory UNIQUE enforcement.
