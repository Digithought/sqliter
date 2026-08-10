---
description: Fixed a bug where changing a column's type inside a transaction left rows written earlier in that same transaction holding their old values, so after the commit the table contained values that contradicted its own declared column type.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # SetDataTypeConvertContext (~133); deriveSetDataTypeConvert (~1780); stagedLiveRows (~1900); validateOverlayMigration (~1845); translateOverlayRow (~1975); alterTable tier-2/tier-3 (~1390-1490); buildAlterPoisonMessage (~1475)
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # 4 tests in "ALTER over staged overlay rows (isolation layer)" (~433)
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # "IsolationModule — cross-connection SET DATA TYPE over staged overlay rows" (EOF)
  - docs/design-isolation-layer.md                        # "ALTER: migrate, or poison" (~832, 837-838)
difficulty: medium
---

# Convert staged overlay rows on `alter column … set data type`

## What was wrong

`alter table t alter column v set data type integer` converts values. Under the isolation
wrapper the conversion lived entirely in the underlying module (memory or store), which only
ever sees its own **committed** rows. Rows staged in an open transaction's per-connection
overlay were never converted, so an accepted retype committed a mix of old- and new-typed
values:

```sql
create table t (id integer primary key, v text) using isolated;
insert into t values (1, '10');
begin;
insert into t values (2, '20');                        -- staged in the overlay
alter table t alter column v set data type integer;
commit;
-- before: row 1 held integer 10, row 2 still held text '20'
-- select id from t where v = 20  → []   (row 2 invisible to equality)
```

## What changed

`IsolationModule.alterTable` already migrates every affected overlay through one seam:
derive a per-ALTER context → dry-run validate it per overlay → translate each staged row.
`addColumn`, `dropColumn` and `set not null` each had a context; `set data type` now has a
fourth, `SetDataTypeConvertContext`, riding that same seam.

- **`deriveSetDataTypeConvert`** returns a context only when the retype actually rewrites
  values — it mirrors both underlyings' gate (`inferType(setDataType).physicalType !==
  oldCol.logicalType.physicalType`), so a metadata-only retype produces no context and no
  overlay work. `convert` mirrors the underlyings' closure (`validateAndParse`, rethrown as
  the same `Cannot convert value in '<col>' to <type>` MISMATCH).
- **`validateOverlayMigration`** gained a `set data type` arm that runs every staged
  non-NULL, non-tombstone value through `convert` and discards the result. For the issuer
  this duplicates the underlying's own pre-mutation pass (which walks the same rows via
  `issuerEffectiveRows`) — except when an outer wrapper supplied `rows`, where it is the only
  check. For a **foreign** overlay it is the only pass that ever sees those rows.
- **`translateOverlayRow`** converts the value in its `alterColumn` case. NULLs are left
  untouched (the underlyings' `convertNulls` is false for a retype) and tombstone rows are
  skipped.
- **Foreign-overlay routing:** tier 3 maps `MISMATCH` to poison alongside `CONSTRAINT`. The
  underlying is already mutated by that point, so rethrowing would abort the issuer's ALTER
  after the fact. `buildAlterPoisonMessage` got a retype-specific arm distinct from the NOT
  NULL tightening wording.

Two stale `NOTE:` comments that described the gap were replaced with pointers to the new
context.

## Behavior now pinned by tests

**Issuer's own overlay** (plain SQL, `alter-table-conformance.spec.ts`):

1. Honored retype converts the staged row — both rows read back as integers in-transaction
   and past commit, and `select id from t where v = 20` finds the staged row. This is the
   test that fails without the fix.
2. Unconvertible staged value rejects with MISMATCH; column type unchanged after rollback.
3. Post-conversion UNIQUE collision staged in the same transaction (`'1'` and `'01'` under a
   UNIQUE column) is a clean `CONSTRAINT`, not `INTERNAL`.
4. Metadata-only retype (`text` → `clob`) migrates staged rows untouched.

**Foreign overlays** (white-box, `isolation-layer.spec.ts` — several `Database`s share one
`IsolationModule`, overlays injected directly, ALTER driven through `iso.alterTable`):

5. A foreign connection's staged convertible row is converted by the issuer's ALTER and
   flushes with the new type.
6. A foreign connection's staged unconvertible row poisons that overlay, the issuer's ALTER
   still applies, and the foreign commit fails with the retype-specific poison message.
7. *(added during review)* A foreign overlay whose staged rows collide only **after**
   conversion is poisoned by the rebuild, and the issuer's ALTER still applies.

## Review findings

### Checked

The implement diff was read first, before the handoff summary. Beyond it:

- **Behavior probing.** Sixteen throwaway scenarios were driven through the real engine and
  then deleted: staged DELETE + retype, staged UPDATE + retype, staged NULL under a retype,
  two sequential retypes in one transaction, narrowing `integer → text`, `text → blob`,
  retype of an indexed non-PK column, mixed-case column name in the ALTER, a column DEFAULT
  literal read back after its column is retyped, an issuer overlay carrying a tombstone, a
  foreign overlay carrying only a tombstone, issuer and foreign both staging rows at once,
  and the post-conversion UNIQUE collision on a foreign overlay. All behaved correctly.
- **Drift against the underlyings.** The isolation `convert` closure was compared line by
  line with `MemoryTableManager.alterColumn` and `StoreModule.alterColumnSetDataType`: same
  physical-type gate, same `validateAndParse` call, same MISMATCH message. No drift today.
- **The multi-attribute claim.** The implementer's `NOTE:` asserts the runtime never delivers
  a combined `alter column`. Confirmed at `parser.ts` `alterColumnAction` — each `SET …` arm
  returns an action with exactly one attribute set.
- **Docs.** `docs/design-isolation-layer.md` § "ALTER: migrate, or poison" and its line-821
  bullet both now describe the closed gap accurately. No other doc or comment still describes
  the retype overlay hole as open.
- **Line endings.** The handoff flagged the new `isolation-layer.spec.ts` block as LF in an
  otherwise-CRLF file. The working copy is 100% LF and `.editorconfig` sets no `end_of_line`,
  so there was nothing to correct.
- **Validation.** `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` — all clean.
  Isolation package: 265 passing (258 before the fix, 264 after implement, +1 from review).

### Fixed in this pass (minor)

- **Dead context fields.** `SetDataTypeConvertContext.colName` and `.tableName` were never
  read — poison messages are built from `change`, not from the context. Removed, along with
  the now-unused `tableName` parameter on `deriveSetDataTypeConvert`. The identical dead field
  on the pre-existing `SetNotNullBackfillContext` was removed at the same time (same file,
  same defect, zero behavior change).
- **Third copy of the same scan loop.** `validateOverlayMigration` had grown a third
  `for await … query(makeFullScanFilterInfo())` loop with a hand-rolled tombstone skip.
  Extracted a `stagedLiveRows(overlay, tombstoneIdx)` generator; the `set not null` and
  `set data type` arms now share it, and the "why skip tombstones" reasoning lives in one
  place instead of two comments.
- **Missing test.** The handoff named the foreign-overlay post-conversion UNIQUE collision as
  untested. Added as test 7 above.

### Filed as tickets (major)

- `backlog/bug-retype-of-deleted-row-leaves-wrong-typed-value` — a retype validates over the
  rows the transaction can see, so a row it has already deleted is not counted. On **rollback**
  the delete is undone but the ALTER is not, leaving a value that contradicts its column's
  declared type with no error raised. Reproduces on the plain memory module too, so it is not
  an isolation-layer defect and predates this ticket; it was found while probing this change.
- `backlog/debt-share-retype-value-converter` — the retype gate and per-value converter now
  exist verbatim in three packages. The isolation copy's own doc comment argues the copies
  "cannot drift" because they are literal mirrors, but nothing enforces that, and the
  cross-connection poison routing keys off the status code one of them throws.

### Tripwire (recorded in code, not filed)

- The ALTER overlay-migration machinery is roughly a third of a 2,140-line
  `isolation-module.ts` and threads one context parameter per value-rewriting attribute — the
  parameter list grew by one with this change. Parked as a `NOTE:` above the `derive*` helper
  cluster: if a fourth attribute ever needs a context, extract the cluster into its own module
  and pass one context object.

### Checked and deliberately left alone

- **The issuer's staged rows are scanned twice** on a retype (once by the layer, once by the
  underlying over `issuerEffectiveRows`). Real, but load-bearing: the wrapper-supplied-`rows`
  case and every foreign overlay need the layer's own pass. The cost is one extra overlay scan
  per retype, and only when a transaction has staged rows. The method's doc comment already
  spells the redundancy out.
- **`convert` discards the underlying parse error** (`catch { throw new QuereusError(…) }`).
  This is against the house rule on swallowing exceptions, but it is copied verbatim from both
  underlyings; changing it here alone would create exactly the drift the design guards against.
  It belongs to the `debt-share-retype-value-converter` ticket, where all three sites move
  together.
- **PRIMARY KEY retype ordering.** A white-box caller invoking `iso.alterTable` directly with a
  PK retype *and* an unconvertible staged value now sees MISMATCH where it previously saw the
  memory manager's "Cannot change the data type of primary key column" CONSTRAINT. Agreed with
  the implementer: unreachable through SQL (the engine's ALTER COLUMN emitter refuses a PK
  retype first) and not worth a guard.
- **`yarn test:store` was not run**, and did not need to be. The handoff offered it as
  belt-and-braces on the store underlying, but `yarn test:store` runs only `packages/quereus`'s
  logic tests against LevelDB, and `@quereus/quereus` cannot import `@quereus/isolation` — it
  cannot reach this diff at all. The isolation-over-store combination is covered by
  `packages/quereus-store/test/isolated-store.spec.ts`, which runs under `yarn test` and passed.
