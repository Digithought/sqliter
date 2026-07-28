description: Converting a text value that holds a very large whole number into a number silently changes the number — the last digits get rounded away — even though storing the same number written directly in a query keeps it exact.
files:
  - packages/quereus/src/types/builtin-types.ts   # INTEGER_TYPE.parse and NUMERIC_TYPE.parse — both use parseInt()
  - packages/quereus/src/types/cast-semantics.ts  # CAST's numeric/text fallback rules
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # candidate home for a regression test
difficulty: medium
----

# Text → INTEGER / NUMERIC conversion rounds whole numbers past 2^53

## What happens

Quereus stores whole numbers larger than JavaScript's exact-integer range
(magnitude > 2^53) as `bigint`, and a literal written straight into SQL keeps its
exact value. Converting the *same* number from text does not — it is rounded to the
nearest value a JavaScript double can represent, silently:

```sql
select cast(9007199254740993 as numeric);   -- 9007199254740993  (bigint, exact)
select cast('9007199254740993' as numeric); -- 9007199254740992  (number, wrong)
select cast('9007199254740993' as integer); -- 9007199254740992  (number, wrong)
```

Verified against the current build (memory module) while reviewing
`numeric-comparator-rejects-bigint`; it is independent of that fix, which only
touched comparison.

## Why

`INTEGER_TYPE.parse` and `NUMERIC_TYPE.parse` in
`packages/quereus/src/types/builtin-types.ts` both convert an all-digit string with
`parseInt(trimmed, 10)`, which returns a `number`. Any magnitude past 2^53 loses its
low digits on the way in. Both types' value spaces already include `bigint` — the
number just never gets produced from the text path.

## Expected behavior

An all-digit (optionally signed) string whose value does not fit exactly in a
JavaScript `number` should convert to a `bigint`, preserving every digit — matching
what the same value written as a SQL literal already does, and matching SQLite's
64-bit integer `CAST`. Values that do fit should keep returning `number`, so nothing
about ordinary integers changes.

Places this reaches beyond an explicit `CAST`: inserting a text value into an
`integer`/`numeric` column, comparing a numeric column against a quoted number, and
any plan-time text→numeric conversion the planner inserts for a cross-category
comparison. A wrong value from any of those can silently match (or miss) the wrong
row — the rounded and exact values are distinct keys.

## Notes

- Decide the boundary explicitly: `Number.isSafeInteger` on the parsed result is the
  natural test, but the string must be re-read as `BigInt(trimmed)` rather than
  recovered from the already-rounded `number`.
- Non-integer strings (`'3.14'`) keep going through `parseFloat` — unchanged.
- Strings past the `bigint` path that are *not* all digits (`'9007199254740993.0'`,
  exponent forms) should be spelled out in the test, whichever way they are decided.
