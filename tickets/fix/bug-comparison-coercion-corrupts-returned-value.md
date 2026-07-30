---
description: Functions that pick and return one of their arguments — nullif, greatest, least — can hand back a converted number instead of the value the user passed in, and for non-numeric text they can return 0, a value that was never an argument at all.
files:
  - packages/quereus/src/planner/building/coercion.ts        # coerceComparisonGroup / coerceComparisonSet — where the cast is inserted
  - packages/quereus/src/schema/function.ts                  # BaseFunctionSchema.comparesArgs — declares which args form a comparison group
  - packages/quereus/src/func/builtins/                      # nullif / greatest / least implementations
  - docs/functions.md                                        # nullif/greatest/least comparison paragraph
  - docs/types.md                                            # "Type Coercion in Comparisons" → "One probe against many values"
  - packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic  # has a NOTE marking the expectation that must flip
difficulty: medium
---

# Comparison coercion must not change the value a builtin returns

## What happens now

Quereus reconciles the two sides of a comparison when one is a number and the
other is a numeric-looking string, so `int_col = '1'` is true. Three builtins —
`nullif`, `greatest`, `least` — declare that some of their arguments are compared
to each other, and so get the same reconciliation applied to those arguments.

The problem: those three functions do not just *compare* their arguments, they
**return** one of them. Applying the conversion rewrites the argument itself, so
the converted value is what comes back out.

Reproduced against the current tree (`t` is a TEXT column):

| query | result now | expected |
|---|---|---|
| `nullif('3', 1)` | `3` (integer) | `'3'` (text — SQL defines `nullif(X,Y)` as returning X unchanged) |
| `nullif('abc', 1)` | `0` | `'abc'` |
| `least('abc', 1)` | `0` | `'abc'` or `1` — but *some* argument |
| `greatest(t, 1)` where `t='3'` | `3` (integer) | `'3'` |

The `least('abc', 1)` row is the sharpest one: `0` was never an argument. It is
what `cast('abc' as integer)` produces, and that intermediate leaks out as the
answer.

`coalesce` is unaffected — it does not compare its arguments, so it never gets
the conversion.

## Why it started

The conversion used to be applied at these functions only for the JSON pairing,
which is rare and mostly harmless. A recent change (`ticket(fix):
bug-numeric-text-coercion-skips-in-and-case`, commit `5549091c`) widened it to
the number-vs-text pairing, which is common, and made the leak easy to hit. The
underlying shape — "the thing we cast for comparison is also the thing we return"
— predates that change and applies to the JSON pairing too.

## Expected behavior

Comparing and returning must be separated: the comparison sees the converted
values, the return value is the original argument the comparison selected.

- `nullif(X, Y)` returns `X` exactly as written whenever the comparison says they
  differ, whatever conversion the comparison needed.
- `greatest`/`least` return the original argument that won the comparison, not a
  converted stand-in, and never a value that was not among the arguments.
- The comparison answers themselves must not change — `nullif(int_col, '1')` must
  keep matching, `greatest(1, '2')` must keep picking the second argument.

## Notes for whoever picks this up

- Whether the fix belongs in the coercion helper (do not rewrite arguments for
  value-returning functions; give the function both forms) or in the function
  implementations is an open design question — the current mechanism only has one
  slot per argument, so something has to carry the pair.
- Not every comparison group has this problem. A group whose function returns a
  *fresh* value rather than one of its arguments can keep the current behavior;
  worth checking whether the declaration needs to distinguish the two cases.
- `packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic`
  currently pins `greatest(i, '2')` as the integer `2` with a NOTE pointing at
  this ticket. That expectation flips to the text `'2'` when this lands.
- Also worth pinning: the reverse-order forms (`least(1, 'abc')` casts the
  *value* rather than the probe and returns `0` the same way), so a fix that only
  addresses the hoisted-probe path is incomplete.
