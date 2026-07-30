---
description: When a very large whole number is stored as text and then added, summed, or averaged, the answer comes back wrong in its last few digits — even though comparing or converting that same text keeps every digit.
prereq: debt-sqllogic-bigint-assertions-lossy
files:
  - packages/quereus/src/util/coercion.ts                # coerceToNumberForArithmetic, tryCoerceToNumber — both return `number`
  - packages/quereus/src/runtime/emit/binary.ts          # mixedBigIntArithmetic — consumer of the arithmetic coercion
  - packages/quereus/src/types/builtin-types.ts          # INTEGER_TYPE.parse / NUMERIC_TYPE.parse — the already-correct sibling path
  - packages/quereus/test/logic/03.6-type-system.sqllogic # where the CAST-side regression tests live
difficulty: medium
---

## Problem

JavaScript's plain number type only holds whole numbers exactly up to
9,007,199,254,740,991 (2^53 - 1). Beyond that it rounds. Quereus already
handles this everywhere it converts text to a number *for comparison or for
storage* — those paths produce an exact arbitrary-precision value instead of a
rounded one. Arithmetic and aggregation were never given the same treatment, so
the same text value silently rounds there.

Observed today (`9007199254740993` is 2^53 + 1):

```sql
select cast('9007199254740993' as integer);   -- 9007199254740993  (exact, correct)
select '9007199254740993' = 9007199254740993; -- true              (exact, correct)
select '9007199254740993' + 0;                -- 9007199254740992  (WRONG, rounded)
select sum(x) from (select '9007199254740993' as x);
                                              -- 9007199254740992  (WRONG, rounded)
```

The `sum` case is the more dangerous of the two: the rounded value is then
promoted to an exact big integer on the way out, so the result *looks* exact
and carries no hint that a digit was lost.

Note this is specifically about a value arriving as **text**. An integer
written directly in a query, or read out of a numeric column, is already exact
through arithmetic — only the text-to-number conversion step rounds.

## Expected behavior

Text-to-number conversion in arithmetic and aggregate contexts should preserve
the exact value past 2^53, matching what CAST, comparison, and column writes
already do.

## Where it comes from

Two helpers in `packages/quereus/src/util/coercion.ts` are declared to return
`number`, which forecloses the exact representation before any caller sees the
value:

- `coerceToNumberForArithmetic` — feeds `+ - * / %` (there is already a `NOTE:`
  comment at this function describing the asymmetry).
- `tryCoerceToNumber` — feeds `coerceForAggregate` (sum/avg/min/max) and
  `isNumericValue`.

Fixing means widening those return types to `number | bigint` and propagating
that through `mixedBigIntArithmetic` in `runtime/emit/binary.ts` and through the
aggregate accumulators — a wider blast radius than the CAST-side fix, which is
why it was deliberately left out of `bug-integer-string-cast-loses-precision`.

Related but distinct: `bug-text-minmax-numeric-coercion` tracks the *semantic*
question of whether `min('5','10')` should coerce text to a number at all. This
ticket is only about precision once the engine has decided to coerce.

## Suggested test home

`packages/quereus/test/logic/03.6-type-system.sqllogic` already has a
"TEXT -> INTEGER / NUMERIC conversion past 2^53" block covering the fixed
paths; the arithmetic and aggregate cases belong alongside it.

**Test-harness caveat that will bite here — and the reason for the `prereq:`.**
The sqllogic runner compares an actual big-integer result by first converting it
through JavaScript's `Number()`, which rounds it right back. It applies the same
lossy conversion to the *expected* value too, so both sides round identically and
a raw numeric assertion passes even against a still-broken engine. That means the
fix this ticket asks for cannot be *asserted* by a test until the harness is
fixed: `debt-sqllogic-bigint-assertions-lossy` is listed as a prerequisite for
that reason, not because of any code dependency.

The existing workaround — routing every big-integer assertion through
`cast(… as text)`, as the existing block does — still works and can be used for
spot checks in the meantime, but it is a workaround, not coverage.
