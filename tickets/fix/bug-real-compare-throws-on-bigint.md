---
description: Looking up a row in an in-memory table by a decimal-number column crashes with an internal JavaScript error whenever the value being searched for is a whole number too large to hold exactly as a decimal.
files:
  - packages/quereus/src/types/builtin-types.ts       # REAL_TYPE.compare (~line 110) — the throwing site; NUMERIC_TYPE.compare (~line 301) already does it right
  - packages/quereus/src/util/comparison.ts           # createTypedComparator (~line 807) — builds the index comparator from the column's declared type
  - packages/quereus/src/vtab/memory/index.ts         # MemoryIndex key comparator (~lines 123, 144) — one caller
  - packages/quereus/src/vtab/memory/utils/primary-key.ts  # primary-key comparator (~lines 100, 137) — the other caller
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # where numeric type-system row assertions live
difficulty: easy
repro: verified
---

## What happens

Quereus keeps whole numbers exactly. Anything up to 9,007,199,254,740,991 (2^53 − 1)
fits in a JavaScript `number`; past that the engine switches to JavaScript's
arbitrary-precision `BigInt` so no digits are lost. A `REAL` column, by contrast,
only ever holds `number`.

So a query that compares a `REAL` column against a literal past 2^53 hands the
engine one `number` and one `BigInt`. Every such comparison that goes through an
in-memory table's **index or primary-key ordering** raises:

```
Error during query on table 't': Cannot convert a BigInt value to a number
```

The query fails outright — it does not return wrong rows, it returns nothing at all.

## Reproduction (verified — run and observed)

```sql
create table t (id integer primary key, r real);
create index ir on t(r);
insert into t values (1, 5.0), (2, 9007199254740992.0);

select id from t where r = 9007199254740993;           -- THROWS
select id from t where r > 9007199254740993;           -- THROWS
select id from t where r in (9007199254740993, 5);     -- THROWS
```

and on a `REAL` primary key, with no secondary index in sight:

```sql
create table p (r real primary key);
insert into p values (5.0);

select r from p where r = 9007199254740993;            -- THROWS
select r from p where r in (9007199254740993, 5);      -- THROWS
```

`select id from t order by r` does **not** throw — sorting goes through a
different comparator — so the failure is specific to the ordering function the
in-memory BTree is built with.

## Root cause

`REAL_TYPE.compare` in `packages/quereus/src/types/builtin-types.ts` asserts both
operands are `number` and calls `isNaN()` on them:

```ts
	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		const numA = a as number;
		const numB = b as number;

		if (isNaN(numA)) return isNaN(numB) ? 0 : -1;
		if (isNaN(numB)) return 1;

		return numA < numB ? -1 : numA > numB ? 1 : 0;
	},
```

`isNaN` converts its argument to a number, and that conversion **throws** on a
`BigInt` rather than returning false. The cast `a as number` is a compile-time
assertion only; nothing enforces it at runtime.

The operand really can be a `BigInt`, because `createTypedComparator`
(`util/comparison.ts`) only falls back to generic cross-type ordering when the two
values are in **different storage classes** — and `5.0` and `9007199254740993n`
are both in the single NUMERIC storage class, so the guard passes them straight
through to `REAL_TYPE.compare`.

`NUMERIC_TYPE.compare`, ten lines further down the same file, already handles
exactly this and even carries the comment explaining why it cannot delegate to
`REAL_TYPE.compare`: `isNaN()` throws on a bigint operand. `REAL_TYPE.compare`
was simply never given the same treatment.

## Expected behaviour

A mixed `number`/`BigInt` comparison must order by true mathematical value, with
full precision on the `BigInt` side — the same answers the engine already gives
for an `INTEGER` or `NUMERIC` column. Against the fixture above:

| query | expected |
|---|---|
| `select id from t where r in (9007199254740993, 5)` | `[{id: 1}]` — the stored `9007199254740992.0` is a *different* number from `9007199254740993`, so only the `5.0` row matches |
| `select id from t where r in (9007199254740992, 5)` | `[{id: 1}, {id: 2}]` |
| `select id from t where r = 9007199254740993` | no rows, no error |
| `select id from t where r > 9007199254740993` | no rows, no error |
| `select r from p where r in (9007199254740993, 5)` | `[{r: 5}]` |

Both of these were confirmed to hold once `REAL_TYPE.compare` is given
`NUMERIC_TYPE.compare`'s typeof-guarded NaN test and a mixed-operand magnitude
comparison — including the boundary case, where `9007199254740993` correctly
fails to match a stored `9007199254740992.0` rather than colliding with it.

## Notes for whoever picks this up

- The persistent (`quereus-store`) backend is **not** expected to share the bug:
  it never calls a logical type's `compare` for key ordering, it encodes keys to
  bytes, and its numeric encoding is value-based — calling `encodeValue` directly
  on `5n` and `5.0` produces byte-identical keys, while `9007199254740993n` and
  `9007199254740992` produce different ones. Worth confirming with a store-side
  case rather than assuming.
- Check whether any other builtin logical type's `compare` makes the same
  unguarded `as number` assumption over a value space that can hold a `BigInt`.
- Regression coverage belongs where the numeric type-system row assertions
  already live (`test/logic/03.6-type-system.sqllogic`) so it runs under both the
  memory and the store backends, and should cover the secondary-index, primary-key,
  `=`, `>` and `IN` shapes above.
