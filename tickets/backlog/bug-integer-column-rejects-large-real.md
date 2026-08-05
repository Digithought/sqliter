---
description: Storing a very large round number written in scientific notation into a whole-number column fails with a type-mismatch error, even though the identical value written as text or as plain digits is accepted.
files:
  - packages/quereus/src/types/builtin-types.ts   # INTEGER_TYPE.parse (number arm, ~line 46) and INTEGER_TYPE.validate (~line 36)
  - packages/quereus/src/types/validation.ts      # validateAndParse — parse-then-validate, where the two disagree
difficulty: easy
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Only whole numbers above 2^53-1 written in scientific notation are affected, and accepting them means INTEGER.parse and INTEGER.validate must agree on a rule that today's exact-integer promotion may not want.
---

## Problem

An `INTEGER` column accepts a whole number written as digits or as text, no
matter how large, but rejects the same value written in scientific notation:

```sql
create table t (v integer);
insert into t values ('100000000000000000000');   -- ok, stored exactly
insert into t values (100000000000000000000);     -- ok, stored exactly
insert into t values (1e20);                      -- ERROR: Type mismatch for column 'v':
                                                  --        expected INTEGER, got number
```

All three spell the same value. Only the third form is a floating-point
literal, and that is the one that fails.

`cast(1e20 as integer)` does not error — it returns a floating-point
`100000000000000000000` — so the inconsistency is visible in expressions too,
just without the error.

## Why it happens

The INTEGER type has two separate hooks and they disagree about floating-point
values that are whole but too large for exact integer representation
(above 2^53 - 1):

- `INTEGER_TYPE.parse` (the `number` branch) truncates a fractional value but
  passes a large whole value straight through as a floating-point number.
- `INTEGER_TYPE.validate` accepts a floating-point number only when it is a
  *safe* integer — which that value is not.

Writes run parse first, then validate, so the value survives conversion and
then fails the check. The string branch of the same `parse` was recently taught
to rebuild an exact arbitrary-precision integer past that boundary
(`bug-integer-string-cast-loses-precision`); the number branch was not, which is
why the two spellings now diverge.

## Expected behavior

A whole-valued floating-point number should be accepted by an `INTEGER` column
and stored exactly, matching the text and digit-literal spellings. A value with
a real fractional part keeps today's truncating behavior.

Open question worth settling while fixing: whether `cast(1e20 as integer)`
should likewise return an exact integer rather than a floating-point number —
it almost certainly should, for the same consistency reason, but that changes
the observable type of an existing expression.

## Scope note

This is pre-existing and independent of the text-conversion fix; it was found
while reviewing it. Nothing in the current test suite covers a large
floating-point value written to an `INTEGER` column.
