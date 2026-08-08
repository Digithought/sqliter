---
description: Adding up a column that contains both a very large whole number and a decimal silently throws away some of the values, and which ones survive depends on the order the rows happen to be read in.
files:
  - packages/quereus/src/func/builtins/aggregate.ts   # addWithPromotion (~line 16), sum step (~line 88, the swallowing catch), algebra.merge (~line 65)
  - packages/quereus/src/runtime/emit/binary.ts       # mixedBigIntArithmetic (~line 62) — the engine's existing, correct rule for the same mixed pair
  - docs/types.md                                    # § Physical representation — the number/bigint rule the fix must follow
difficulty: medium
repro: verified
---

# `sum()` drops values instead of adding them

## What happens

Quereus holds whole numbers past 9,007,199,254,740,991 (2^53 − 1) in an exact
arbitrary-precision form and everything else as an ordinary floating-point number
(the rule is written up in `docs/types.md` § "Physical representation"). `sum()`
cannot add one of each. When it meets that pair it does not error out to the user —
it throws away one of the values and returns a total built from what is left:

```sql
create table t (id integer primary key, v any);
insert into t values (1, 0.5), (2, 9007199254740993);
select sum(v) from t;      -- returns 0.5    (the big value vanished)
```

Reverse the two rows and the *other* value vanishes instead:

```sql
insert into t values (1, 9007199254740993), (2, 0.5);
select sum(v) from t;      -- returns 9007199254740993   (the 0.5 vanished)
```

With more decimals it keeps only the decimals it managed to accumulate before it
first met the large value: `sum` over `0.5, 0.25, 9007199254740993` returns `0.75`.

There is no error, no NULL, and no warning in the result — only a debug-level log
line. A caller cannot tell a dropped value from a genuine total. Which value
survives depends on the order rows come back from the scan, so the same query can
return different answers on the same data after an index change or a plan change.

## Why it happens

`addWithPromotion` in `packages/quereus/src/func/builtins/aggregate.ts` promotes
*both* sides to the exact integer form whenever *either* side is already in it. That
conversion is undefined for a value with a fractional part and raises a
`RangeError`. The `sum` step function wraps each value in a `try`/`catch` that logs
a warning and then **returns the accumulator unchanged** — which is how the value
disappears rather than surfacing as an error.

The engine already has the right rule for exactly this pair, one directory over:
`mixedBigIntArithmetic` in `src/runtime/emit/binary.ts` checks whether the
non-exact side is a whole number, and if it is not, it demotes the exact side to
floating point and does float arithmetic. So `9007199254740993 + 0.5` as a plain
expression answers correctly; only the aggregate is wrong.

## Expected behavior

`sum()` must agree with repeated `+`. Mixing an exact large integer with a
fractional value should produce the same answer the binary `+` operator produces
for the same pair, and that answer must not depend on the order the rows are
folded in.

Two more things belong to the same decision, because they are the same conversion:

- **`min`/`max`-style silent swallowing.** The `catch` in the `sum` step turns *any*
  coercion failure into a dropped value. Whatever the promotion rule ends up being,
  a value that cannot be added should not vanish silently — decide whether it is an
  error or a documented skip, and make the choice visible.
- **Materialized-view maintenance takes the same path uncaught.** `algebra.merge`
  and `algebra.negate` call the same `addWithPromotion` with no `try`/`catch`, so a
  maintained view or rollup whose partial sums hit this pair raises the `RangeError`
  out to the caller instead of dropping a value. That arm is inferred from reading
  the code, not reproduced — a maintained view over a column mixing both forms would
  confirm it.

## Notes

- Found during review of `integer-canonical-representation`, which canonicalized
  `addWithPromotion`'s *result* (narrowing a sum that lands back inside the safe
  range) but did not touch its promotion rule. Pre-existing; that ticket neither
  caused nor widened it.
- Distinct from `backlog/bug-text-coercion-in-arithmetic-and-aggregates`, which is
  about how *text* becomes a number in `util/coercion.ts`. This one is about how two
  already-numeric values are combined, and lives in a different file.
- A regression test should assert fold-order independence (sum the same rows in both
  orders and require the same answer), not just the two literal values above.
