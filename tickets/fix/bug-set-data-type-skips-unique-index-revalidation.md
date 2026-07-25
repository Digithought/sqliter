----
description: Changing a column's data type can make two rows that used to be different become identical, but a UNIQUE index or constraint on that column is not re-checked, so the duplicate slips through silently.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts    # alterColumn setDataType arm (~2100); base rebuild (~2223)
  - packages/quereus/src/vtab/memory/layer/base.ts        # rebuildAllSecondaryIndexes (~173) — non-enforcing populate
  - packages/quereus-store/src/common/store-module.ts     # alterColumnSetDataType (~1987) — same gap
difficulty: medium
----

# `SET DATA TYPE` does not re-validate UNIQUE after the conversion

## What happens

```sql
create table t (id integer primary key, v text);
create unique index tv on t (v);
insert into t values (1, '1'), (2, '01');   -- distinct text values, both unique
alter table t alter column v set data type integer;
-- '1' -> 1 and '01' -> 1: now two rows share v = 1, but the UNIQUE index still holds both
```

Two rows whose values were distinct under the old type collapse to equal under the new type. The
UNIQUE index (or UNIQUE constraint) on the column is silently violated — no error, and the index
now maps one key to two primary keys, so later lookups/enforcement behave inconsistently.

## Why

`SET DATA TYPE`'s secondary-index rebuild goes through the **non-enforcing** populate path
(`BaseLayer.rebuildAllSecondaryIndexes` → `populateSecondaryIndexes`, which does not pass
`enforceUnique`). Unlike the `SET COLLATE` path — which runs `validateRekeyedUniqueStructures`
before re-keying — the type-conversion path has no uniqueness re-check over the converted values.
The collate path added that guard; the type path never got the analogue.

## Expected behavior

After computing the converted values, re-validate every UNIQUE index/constraint that covers the
altered column and reject with `CONSTRAINT` if the conversion introduces a collision — over the
DDL transaction's effective rows, consistent with how `SET COLLATE` validates
(`validateRekeyedUniqueStructures`). Autocommit path needs the same check.

## Scope notes

- **Pre-existing** — not introduced by `alter-column-set-data-type-sees-transaction-rows`; the
  old in-place-upsert code took the same non-enforcing rebuild. Surfaced during that ticket's
  review.
- Affects **both** backends: the store's `alterColumnSetDataType` (`mapRowsAtIndex` +
  index rebuild) has the same missing re-validation.
- Reachable now, but narrow: needs a UNIQUE index/constraint on a column whose type change
  collapses two live distinct values (text→numeric leading zeros/whitespace, text→real, etc.).
  Low frequency; flagged low priority.
