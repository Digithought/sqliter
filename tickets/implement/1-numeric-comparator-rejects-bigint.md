---
description: A column declared with the loose "numeric" type is allowed to hold whole numbers too large for a JavaScript number, but the code that orders and compares those columns crashes the moment it sees one — so a second insert into such a table fails with a raw JavaScript error.
files:
  - packages/quereus/src/types/builtin-types.ts                  # NUMERIC_TYPE.compare (delegates to REAL_TYPE.compare) and INTEGER_TYPE.compare (the correct pattern)
  - packages/quereus/src/vtab/memory/utils/primary-key.ts        # PK comparator built from the declared column type
  - packages/quereus/src/util/comparison.ts                      # createTypedComparator
  - packages/quereus/test/logic/03.6-type-system.sqllogic        # candidate home for the regression test
difficulty: easy
---

# `NUMERIC`'s comparator throws on the half of its own value space it accepts

## What happens

Quereus's `NUMERIC` type is the loose numeric declaration: its `validate` accepts
**both** JavaScript `number` and `bigint`, and its `parse` passes both through
untouched. So a `numeric`-declared column legitimately stores whole numbers
larger than 2^53 in their exact (`bigint`) form.

Its `compare`, however, just forwards to `REAL_TYPE.compare`, which does
`isNaN(a as number)` — and `isNaN` on a `bigint` throws
`TypeError: Cannot convert a BigInt value to a number`.

So the type accepts a value it then cannot order.

## Reproduction (verified on `main`, memory module)

```sql
create table n (v numeric primary key);
insert into n values (9007199254740993);   -- ok: first row, no comparison needed
insert into n values (3);
--> Execution error: Cannot convert a BigInt value to a number
```

The first insert succeeds because an empty B-tree performs no key comparison.
The second insert has to place the new key against the existing one, which calls
the declared column type's `compare`, which throws.

Confirmed stack (from the analogous `real primary key` case, same code path):

```
at isNaN (<anonymous>)
at compare (src/types/builtin-types.ts:102)          <- REAL_TYPE.compare
at src/util/comparison.ts:746                        <- createTypedComparator
at BTree.compare (src/vtab/memory/utils/primary-key.ts:78)
...
at MemoryTableManager.performInsert
```

## Why it is happening

`NUMERIC_TYPE.compare` (`src/types/builtin-types.ts`) is:

```ts
compare: (a, b) => REAL_TYPE.compare!(a, b),
```

`REAL_TYPE`'s value space is `number` only, so its comparator is entitled to
assume `number`. `NUMERIC`'s is `number | bigint`, so it is not — it needs its
own comparator.

`INTEGER_TYPE.compare` already shows the right shape for a mixed
`number | bigint` space: plain `<` / `>`, which JavaScript evaluates exactly
across the two representations without precision loss. What `INTEGER` does not
need, and `NUMERIC` does, is `NaN` handling — a `numeric` column can hold `NaN`
from the `number` half, and `NaN < 1n` and `NaN > 1n` are both `false`, which
would silently report "equal".

## Expected behavior

- `NUMERIC` orders any pair drawn from its own declared value space
  (`number`, `bigint`, `NaN`, `null`) without throwing.
- Mixed `number` / `bigint` pairs order by true mathematical value, with no
  precision loss for magnitudes past 2^53 (`9007199254740993n > 9007199254740992`
  must be true, which a `Number()` conversion on both sides would get wrong).
- `NaN` keeps `REAL`'s existing placement — smallest, below every non-NULL
  number; two `NaN`s compare equal.
- `null` keeps the shared `compareNulls` convention (handled before the numeric
  branch, as every other builtin type does).
- The reproduction above completes and `select v from n order by v` returns both
  rows in value order.

`REAL_TYPE.compare` itself should be left alone: `bigint` is genuinely outside
`REAL`'s value space, so a value reaching it is a real upstream defect and
throwing is the honest outcome. (One such upstream defect is the subject of
ticket `set-op-numeric-promotion-skips-conversion`, which depends on this one.)

## Scope note

This is a defect in the type itself, reachable with no set operation, no join,
and no unusual query shape — just a `numeric` column holding a large whole
number. It is being fixed first because
`set-op-numeric-promotion-skips-conversion` starts routing mixed-numeric set
operations through `NUMERIC`, which makes this path much easier to reach
(`insert into n(v numeric primary key) select <big whole number> union all
select 2.5`).

## TODO

- Give `NUMERIC_TYPE` its own `compare` in `src/types/builtin-types.ts` rather
  than delegating to `REAL_TYPE.compare`: `compareNulls` first, then `NaN`
  handling matching `REAL`'s (NaN smallest, NaN vs NaN equal), then plain
  `<` / `>` on the `number | bigint` pair the way `INTEGER_TYPE.compare` does.
  Comment why the delegation was wrong, so it does not get "simplified" back.
- Add SQL-level regression coverage (suggested: `test/logic/03.6-type-system.sqllogic`)
  for a `numeric primary key` holding a value past 2^53 alongside a small one —
  both inserts succeed, and `order by v` puts them in value order. Note the
  logic-test harness normalizes BigInt results to Number before comparing
  (`normalizeBigInts` in `test/logic.spec.ts`), so assert ordering and use
  `cast(v as text)` if an exact large value needs pinning.
- Add a direct unit assertion over `NUMERIC_TYPE.compare` for the mixed pair
  `9007199254740993n` vs `9007199254740992` (must be `1`, not `0`) — the
  precision case a `Number()`-based implementation would silently fail.
- Run `yarn test` and `yarn lint` from the repo root.
