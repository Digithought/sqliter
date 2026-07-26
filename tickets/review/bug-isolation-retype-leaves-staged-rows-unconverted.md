---
description: Fixed a bug where changing a column's type inside a transaction left rows written earlier in that same transaction holding their old values, so after the commit the table contained values that contradicted its own declared column type.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # SetDataTypeConvertContext (~135); deriveSetDataTypeConvert (~1795); validateOverlayMigration (~1856); translateOverlayRow (~1975); alterTable tier-2/tier-3 (~1390-1485); buildAlterPoisonMessage (~1470)
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts   # 4 new tests in "ALTER over staged overlay rows (isolation layer)" (~433)
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # new top-level describe at EOF (~4962)
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
  overlay work. `convert` is a literal mirror of the underlyings' closure
  (`validateAndParse`, rethrown as the same `Cannot convert value in '<col>' to <type>`
  MISMATCH), so the two legs cannot drift.
- **`validateOverlayMigration`** gained a `set data type` arm that runs every staged
  non-NULL, non-tombstone value through `convert` and discards the result. For the issuer
  this duplicates the underlying's own pre-mutation pass (which walks the same rows via
  `issuerEffectiveRows`) — except when an outer wrapper supplied `rows`, where it is the only
  check. For a **foreign** overlay it is the only pass that ever sees those rows.
- **`translateOverlayRow`** converts the value in its `alterColumn` case. NULLs are left
  untouched (the underlyings' `convertNulls` is false for a retype) and tombstone rows are
  skipped.
- **Foreign-overlay routing:** tier 3 now maps `MISMATCH` to poison alongside `CONSTRAINT`.
  The underlying is already mutated by that point, so rethrowing would abort the issuer's
  ALTER after the fact. `buildAlterPoisonMessage` got a retype-specific arm ("changed the
  data type of column 'v' to integer, which this connection's uncommitted row cannot be
  converted to") distinct from the NOT NULL tightening wording.

Two stale `NOTE:` comments that described this gap (pointing at a since-completed ticket)
were replaced with pointers to the new context.

## Use cases to exercise / validate

**Issuer's own overlay** (plain SQL, `packages/quereus-isolation/test/alter-table-conformance.spec.ts`,
describe "ALTER over staged overlay rows (isolation layer)"):

1. *Honored retype converts the staged row.* Commit-then-stage-then-ALTER; both rows read
   back as integers **in-transaction** and past commit, and `select id from t where v = 20`
   finds the staged row. This is the test that fails without the fix.
2. *Unconvertible staged value rejects.* `insert into t values (2, 'abc')` before the same
   ALTER → MISMATCH, `Cannot convert value in 'v'`, column type unchanged after rollback.
   (Passed before the fix too — the underlying's pre-mutation pass over `issuerEffectiveRows`
   already caught it. Locked in as a regression test.)
3. *Post-conversion UNIQUE collision staged in the SAME transaction.* `'1'` and `'01'` both
   staged, `v` UNIQUE → must be a clean `CONSTRAINT`, not `INTERNAL`. The underlying's UNIQUE
   re-validation over the issuer's converted effective rows fires first, so the rebuilt
   overlay never gets the chance to raise it (which `adoptRebuiltOverlay` would have turned
   into INTERNAL). Verified both before and after.
4. *Metadata-only retype* (`text` → `clob`; same TEXT affinity) migrates staged rows
   untouched.

**Foreign overlays** (white-box, `packages/quereus-isolation/test/isolation-layer.spec.ts`,
new top-level describe at EOF — several `Database`s share one `IsolationModule`, overlays
injected directly, ALTER driven through `iso.alterTable`):

5. A foreign connection's staged **convertible** row is converted by the issuer's ALTER and
   flushes with the new type (asserted at the overlay row level *and* after
   `commitConnectionOverlays`).
6. A foreign connection's staged **unconvertible** row poisons that overlay, the issuer's
   ALTER still applies (its committed row converts), and the foreign commit fails with the
   retype-specific poison message.

## Validation run

- `yarn build` — clean.
- `yarn workspace @quereus/isolation run test` — 264 passing (was 258).
- `yarn test` — all workspaces green, no failures.
- `yarn lint`, `yarn typecheck` — clean.
- `yarn test:store` **not run.** The diff touches only `packages/quereus-isolation` plus one
  docs file; the store leg exercises the same wrapper over `StoreModule`, whose
  `alterColumnSetDataType` this change deliberately does not touch. Worth a run if the
  reviewer wants belt-and-braces on the store underlying.

## Known gaps / things worth a second look

- **The issuer's staged rows are now walked twice** on a retype — once by
  `validateOverlayMigration`'s new arm, once by the underlying's pre-mutation pass over
  `issuerEffectiveRows`. Deliberate (the wrapper-supplied-`rows` case and every foreign
  overlay need the layer's own pass), but it is a real duplicate scan of the overlay. Not
  parked as a code NOTE because the redundancy is spelled out in the method's doc comment.
- **Multi-attribute `alter column`.** `setNotNullCtx` and `setDataTypeCtx` are handled as
  `else if` branches in `translateOverlayRow` because the runtime rejects a multi-attribute
  ALTER COLUMN before it reaches the module. Parked as a `NOTE:` at that site — if combined
  attributes are ever admitted, the second rewrite would be silently skipped and the branches
  must compose.
- **A foreign overlay whose staged rows collide only *after* conversion** (`'1'` and `'01'`
  under a UNIQUE column) now raises CONSTRAINT out of the rebuild and is poisoned by
  `adoptRebuiltOverlay`. That is the pre-existing foreign-overlay contract and seems right,
  but there is no test for that specific combination — only for the issuer's own overlay
  (use case 3).
- **PRIMARY KEY retype** is refused upstream by the engine's ALTER COLUMN emitter, so the new
  validation never races the memory manager's "Cannot change the data type of primary key
  column" CONSTRAINT in practice. A white-box caller invoking `iso.alterTable` directly with
  a PK retype *and* an unconvertible staged value would now see MISMATCH where it previously
  saw that CONSTRAINT. Judged not worth guarding; flagging it in case the reviewer disagrees.
- **Line endings.** The new `isolation-layer.spec.ts` block was appended with LF endings
  while the rest of the working-copy file is CRLF. `core.autocrlf=true` normalizes to LF in
  the index, so the committed content is uniform — but the working copy is briefly mixed.
