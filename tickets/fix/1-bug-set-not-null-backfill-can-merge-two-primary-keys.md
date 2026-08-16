---
description: Filling in the empty values of a column that is part of a table's row identity can give two different rows the same identity, and one of them is then silently lost.
files:
  - packages/quereus/src/vtab/memory/layer/alter-column.ts (`planSetNotNull` ~176, `planTightenNotNull` ~200 — the backfill plan)
  - packages/quereus/src/vtab/memory/layer/manager.ts (`validateAlterColumnPlan` ~2628; the existing `NOTE:` at ~2625 predicts this exact defect; `validateRekeyedPrimaryKey` is the guard that is NOT run on this arm)
  - packages/quereus-store/src/common/store-module-alter-column.ts (~360-380 — the store's own SET/DROP NOT NULL arm)
  - packages/quereus-isolation/src/alter-migration.ts (~68, ~239, ~303 — `deriveSetNotNullBackfill`, the overlay leg of the same tightening)
  - packages/quereus/src/schema/table.ts (`findPKDefinition` ~1191 — why a primary-key column can be nullable at all)
  - packages/quereus/test/logic/43.1-notnull-or-conflict.sqllogic (nearest existing coverage)
difficulty: medium
repro: static
---

# `ALTER COLUMN … SET NOT NULL` can backfill two rows onto one primary key

## The plain version

Quereus lets a table's primary key contain empty (NULL) values in one case today: a table
that declares **no** `PRIMARY KEY` gets a key built from all its columns, and that key does
not force its columns to be non-empty (`findPKDefinition` in
`packages/quereus/src/schema/table.ts`; `docs/schema.md` § "Primary-key nullability").

`alter table t alter column x set not null` on such a column has to do something about the
existing empty values. If the column has a `DEFAULT`, the memory backend fills them in with
that default (`planTightenNotNull` in `packages/quereus/src/vtab/memory/layer/alter-column.ts`).
When the filled-in value equals a value another row already has in that column, the two rows
end up with the same primary key. Nothing checks for that on this path, so one row is
overwritten by the other and disappears.

## Where the check is missing

`validateAlterColumnPlan` (`packages/quereus/src/vtab/memory/layer/manager.ts` ~2628) runs
two different validations depending on the plan:

- the **rewrite** arm (`plan.rewrite` — `set data type`, and `set not null` with a backfill)
  validates only the *secondary* unique structures, via `validateRekeyedUniqueStructures`;
- the **`structuresRekeyed`** arm (`set collate`) additionally runs
  `validateRekeyedPrimaryKey`.

The doc comment on that method already states the assumption and predicts its failure:

> the backfill only fires on a column holding NULLs (which a PK member cannot — the engine
> enforces NOT NULL on every PK member regardless of the declared nullability) …
>
> `NOTE:` if PK members ever become genuinely nullable, the backfill arm gains a PK
> collision path (two NULL keys → one DEFAULT) and needs `validateRekeyedPrimaryKey` plus a
> primary-tree re-key of its own.

The premise in the parenthesis is not true: the engine enforces NOT NULL on *declared* key
columns only. A synthesized all-columns key leaves its columns nullable, so the condition the
`NOTE:` guards against is already reachable — it is a latent defect, not a future one.

There is a second, blunter guard nearby that is worth noting while investigating: DROP NOT
NULL on a primary-key column is refused outright in three places (the engine at
`packages/quereus/src/runtime/emit/alter-table.ts` ~1469, memory at `alter-column.ts` ~179,
store at `store-module-alter-column.ts` ~375). SET NOT NULL has no matching guard, which is
why this arm is reachable at all.

## Suspected reproduction (not yet run — confirm or refute first)

```sql
pragma default_column_nullability = 'nullable';
create table t (x integer default 0);   -- no PRIMARY KEY ⇒ synthesized key (x), x nullable
insert into t values (null), (0);       -- two distinct keys today
alter table t alter column x set not null;
select count(*) from t;                 -- expect 2; suspect 1
```

Run this on `main` before changing anything and record the actual result in the implement
ticket you produce. If it already errors for an unrelated reason (for example the ALTER is
refused earlier in the pipeline), say so — the ticket is then about the *store* leg, or
about nothing, and that is a valid outcome.

Also try the variant that reaches the same collision through a wider key
(`create table t (x integer default 0, y integer)` with rows `(null, 1)` and `(0, 1)`), and
the same two cases under `yarn test:store` for the persistent backend.

## What to research before writing the implement ticket

- **Does the memory backend actually lose a row, or does the B-tree upsert raise?** Name the
  observed behaviour precisely — silent loss and a raised CONSTRAINT are very different
  severities.
- **The store leg.** `store-module-alter-column.ts` has its own SET NOT NULL arm; does it
  re-key, reject, or overwrite? The two backends must agree, and the agreement is currently
  held together only by shared `.sqllogic` cases (see the `NOTE:` in
  `packages/quereus/src/vtab/memory/layer/manager.ts` ~2049 about the ADD COLUMN rule for
  the same pattern).
- **The isolation overlay leg.** `packages/quereus-isolation/src/alter-migration.ts` derives
  its own `setNotNull` backfill for staged rows; a collision there can also merge a staged
  row with a committed one.
- **Which fix.** Two shapes are plausible and the choice belongs in the implement ticket:
  (a) run `validateRekeyedPrimaryKey` on the rewrite arm too and reject the ALTER with a
  CONSTRAINT error naming the colliding key — the `NOTE:`'s own prescription, plus the
  primary-tree re-key it mentions; or (b) refuse `set not null` with a backfill on a
  primary-key column outright, matching the existing DROP NOT NULL refusal. (a) is more
  useful and more work; (b) is a one-line symmetry with the existing guard. Weigh them and
  pick one — do not leave the choice to the implementer.

## Why this is on the critical path

`tickets/implement/feat-relax-declared-primary-key-not-null` stops promoting *declared*
primary keys to NOT NULL, which turns this from "reachable only on a no-PK table under a
nullable column default" into "reachable on any table whose key columns are nullable". That
ticket names this one as a prerequisite, so resolve this first.
