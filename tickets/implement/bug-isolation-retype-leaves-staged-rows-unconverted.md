---
description: When a column's type is changed inside a transaction, rows written earlier in that same transaction keep their old-typed values, so after the commit the table holds values that contradict its own declared column type and a plain equality query cannot find them.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable (~1312); SetNotNullBackfillContext + stale NOTE (~110-133); deriveSetNotNullBackfill (~1724); validateOverlayMigration (~1773); translateOverlayRow (~1858) incl. stale NOTE (~1885); buildAlterPoisonMessage (~1452)
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn setDataType arm (~2130-2184) — the conversion to mirror
  - packages/quereus-store/src/common/store-module.ts    # alterColumnSetDataType (~2394-2413) — identical conversion, other underlying
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # "ALTER over staged overlay rows (isolation layer)" describe (~326)
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # foreign-overlay poison tests + stageOverlay/overlayKeys helpers (~1490-1560)
  - docs/design-isolation-layer.md                        # "ALTER: migrate, or poison" (~830-838)
difficulty: medium
---

# Convert staged overlay rows on `alter column … set data type`

## Confirmed repro (on `main`, isolation-wrapped memory)

```sql
create table t (id integer primary key, v text) using isolated;
insert into t values (1, '10');
begin;
insert into t values (2, '20');                        -- staged in this connection's overlay
alter table t alter column v set data type integer;    -- accepted
commit;
```

Observed (temporary spec, run and removed):

```
IN-TXN:            [{id:1,v:'10',ty:'text'},   {id:2,v:'20',ty:'text'}]
POST-ALTER-IN-TXN: [{id:1,v:10,ty:'integer'},  {id:2,v:'20',ty:'text'}]   <-- staged row unconverted
AFTER-COMMIT:      [{id:1,v:10,ty:'integer'},  {id:2,v:'20',ty:'text'}]   <-- committed that way
EQ   select id from t where v = 20  → []                                   <-- invisible to equality
RANGE select id from t where v > 5  → [1, 2]
TYPE table_info('t').v.type         → INTEGER
```

Also confirmed already-correct today and worth locking in as a regression test: an *unconvertible*
staged value (`insert into t values (2, 'abc')` before the same ALTER) is rejected with
`Cannot convert value in 'v' to integer` (MISMATCH), because the isolation layer already hands the
underlying the issuer's effective rows (`issuerEffectiveRows`) and the underlying's pre-mutation
pass walks them.

## Cause

`IsolationModule.alterTable` migrates every affected overlay into the post-alter shape through one
seam: derive a per-ALTER context → dry-run validate it per overlay → translate each staged row.
`addColumn`, `dropColumn`, and the `set not null` NULL → DEFAULT backfill each have a context;
`set data type` has none. Its value conversion lives entirely inside the underlying module
(`MemoryTableManager.alterColumn` / `StoreModule.alterColumnSetDataType`) over that module's
*committed* rows, so an overlay row never passes through it. `insertIntoRebuiltOverlay` inserts with
`preCoerced: true`, so the overlay's own insert path does not coerce the value either — nothing
converts it at any point.

`isolation-module.ts` already carries a `NOTE:` describing exactly this gap (on
`SetNotNullBackfillContext`, ~line 116, and again in `translateOverlayRow`, ~line 1885), but it
points at a ticket that has since completed.

The engine-level (unwrapped memory) path is correct — `convertColumnOnOpenLayers` converts the DDL
transaction's own layers — but that call no-ops under the wrapper, because the pending rows live in
an overlay the memory manager does not own.

## Design

Add a fourth context to the same seam, mirroring the underlying's conversion exactly rather than
inventing a parallel one.

```ts
/**
 * Per-ALTER constants for an `alter column … set data type` overlay conversion.
 * Present only when the retype actually rewrites values (the new physical type differs
 * from the old) and there are staged overlays to convert.
 */
interface SetDataTypeConvertContext {
	/** Zero-based index of the retyped column in the overlay's data columns. */
	colIndex: number;
	/** Per-value conversion; throws MISMATCH exactly as the underlying's does. */
	convert: (v: SqlValue) => SqlValue;
	/** Column name, for the poison message. */
	colName: string;
	/** Owning table name, for the poison message. */
	tableName: string;
}
```

`deriveSetDataTypeConvert(change, toMigrate, tableName)` — same shape and call site as
`deriveSetNotNullBackfill`:

*   `undefined` unless `change.type === 'alterColumn' && change.setDataType !== undefined`, or when
    `toMigrate` is empty.
*   `colIndex` from a to-be-migrated overlay's PRE-alter schema (the same source `dropColumnIdx` and
    `deriveSetNotNullBackfill` already use).
*   `const newLogicalType = inferType(change.setDataType)` — exported from `@quereus/quereus`; it
    never throws (unknown names fall through SQLite-style affinity rules), so deriving before the
    underlying mutation is safe.
*   Return `undefined` when `newLogicalType.physicalType === oldCol.logicalType.physicalType` — a
    metadata-only retype. Both underlyings gate on that exact comparison; mirror it rather than
    re-deciding, so a future change to what counts as a value-rewriting retype (see the open
    `bug-retype-to-semantic-type-unique-and-query`) moves all legs together.
*   `convert` is the literal mirror of `manager.ts` ~2148 / `store-module.ts` ~2404:
    `validateAndParse(v, newLogicalType, change.columnName)`, catching and rethrowing as
    `` `Cannot convert value in '${change.columnName}' to ${change.setDataType}` `` with
    `StatusCode.MISMATCH`. Both symbols are already exported from `@quereus/quereus`
    (`src/index.ts` lines 163, 168).

NULLs are left untouched (the underlying's `convertNulls` is false for `set data type`); tombstone
rows carry placeholder NULLs and are skipped.

`validateOverlayMigration` gains a `set data type` arm alongside the `set not null` reject arm: scan
the staged rows, skip tombstones and NULLs, run `convert` and discard the result. For the issuer
this is belt-and-braces (the underlying's pre-mutation pass over `issuerEffectiveRows` already
covers the same rows — unless an *outer* wrapper supplied `rows`, in which case this is the only
check); for a foreign overlay it is the only pass that sees those rows at all, and it must run
before the migration so a failure becomes poison rather than a half-migrated overlay.

`translateOverlayRow`'s `alterColumn` case applies the conversion. `setNotNullCtx` and
`setDataTypeCtx` are mutually exclusive — the runtime rejects multi-attribute `alter column` before
it reaches the module — so the two are independent branches, not a combination.

Foreign-overlay routing: `alterTable`'s tier-3 catch currently maps only `StatusCode.CONSTRAINT` to
poison and rethrows everything else. A `MISMATCH` from the new validation arm must poison too —
otherwise one connection's unconvertible staged value aborts the issuer's ALTER *after* the
underlying has already been mutated, which is exactly the divergence the tiering exists to prevent.
`buildAlterPoisonMessage`'s `alterColumn` branch hardcodes "tightened … to NOT NULL"; split it so a
retype gets its own wording.

Interaction the fix closes rather than adds: the UNIQUE re-validation probe already judges overlay
rows as *converted* while the honored path leaves them *unconverted*, so the two disagree today. Once
the honored path converts, they agree; no separate handling is needed.

## TODO

Phase 1 — conversion

- Add `SetDataTypeConvertContext` next to `SetNotNullBackfillContext`; replace the stale `NOTE:` on
  `SetNotNullBackfillContext` (~line 116) and the one in `translateOverlayRow` (~line 1885) with a
  pointer to the new context.
- Add `deriveSetDataTypeConvert`; call it in `alterTable` beside `deriveSetNotNullBackfill` and
  thread the result through `validateOverlayMigration`, `adoptRebuiltOverlay`'s rebuild closures,
  `migrateOverlayForAlter`, and `translateOverlayRow`.
- Add the `set data type` arm to `validateOverlayMigration` (skip tombstones and NULLs; throw
  MISMATCH on an unconvertible staged value).
- Convert the value in `translateOverlayRow`'s `alterColumn` case.

Phase 2 — foreign-overlay routing

- Map `StatusCode.MISMATCH` (as well as `CONSTRAINT`) to poison in `alterTable`'s tier-3 foreign loop.
- Give `buildAlterPoisonMessage` a retype arm distinct from the NOT NULL tightening arm.

Phase 3 — tests (`packages/quereus-isolation/test/alter-table-conformance.spec.ts`, inside the
"ALTER over staged overlay rows (isolation layer)" describe)

- Honored retype converts the staged row: after commit, `typeof(v)` is `integer` for BOTH rows,
  `select id from t where v = 20` returns row 2, and the in-transaction read right after the ALTER
  already shows the converted value.
- Unconvertible staged value rejects with MISMATCH and leaves the column type unchanged after
  rollback (passes today — lock it in).
- Two rows staged in the SAME transaction that collide only after conversion (`'1'` and `'01'` under
  a UNIQUE column) must reject with a clean `CONSTRAINT`, not `INTERNAL`. Check which one fires
  before and after the change; if the issuer's rebuilt overlay raises the collision instead of the
  underlying's pre-mutation probe, `adoptRebuiltOverlay` will convert it to INTERNAL and that needs
  addressing here.
- Metadata-only retype (new physical type equals old) still migrates staged rows untouched.

Phase 4 — foreign overlay (`packages/quereus-isolation/test/isolation-layer.spec.ts`, near the
DROP-TABLE poison tests, which already have the `stageOverlay` / `overlayKeys` helpers)

- A foreign connection's staged *convertible* row is converted by the issuer's ALTER and flushes
  with the new type.
- A foreign connection's staged *unconvertible* row poisons that overlay, the issuer's ALTER still
  succeeds, and the foreign commit fails with the poison message.

Phase 5 — docs and validation

- Update `docs/design-isolation-layer.md` "ALTER: migrate, or poison" (tiers 2 and 3, ~lines 837-838):
  the validated/migrated work is not only NOT-NULL backfill and row reshaping but also per-value
  conversion, and a foreign overlay can now be poisoned by an unconvertible value (MISMATCH), not
  only by a constraint violation (CONSTRAINT).
- `yarn build`, `yarn workspace @quereus/isolation run test`, `yarn test`, `yarn lint`.
- The LevelDB store runs the same wrapper over `StoreModule`; `yarn test:store` is the store leg but
  is slow — run it only if the change touches anything beyond the isolation package.
