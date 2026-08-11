---
description: Adding or multiplying two whole numbers can return an answer that is off by one when the true answer is bigger than about nine quadrillion — no error, no warning, just a slightly wrong number.
files:
  - packages/quereus/src/runtime/emit/binary.ts        # buildCoercingArithmeticRun — the non-bigint arm (~lines 137-147) that never checks the result
  - packages/quereus/src/util/numeric-canonical.ts     # canonicalizeInteger — the widening the arm is missing
  - packages/quereus/src/planner/nodes/scalar.ts       # BinaryOpNode.generateType — announces INTEGER for this shape
  - packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic  # where value-level coverage for this lives
difficulty: medium
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Only whole numbers past 9,007,199,254,740,991 are affected, and the obvious fix adds a range check (or a big-integer retry) to the innermost per-row arithmetic loop that every ordinary small-number query also runs — a maintainer may reasonably judge that cost too high for the size of the audience.
---

# Whole-number arithmetic silently falls out of the exact range

## What happens

```sql
select 9007199254740991 * 3;      -- 27021597764222972   (exact answer: 27021597764222973)
select 9007199254740991 + 9007199254740991;  -- 18014398509481982, returned as a plain JS number
```

Verified against a plain in-memory `Database` (2026-08-11). No error, no NULL, no log
line — the first result is simply wrong by one.

## Why

Quereus keeps whole numbers exact by holding anything past 9,007,199,254,740,991 (2^53 − 1)
as an arbitrary-precision value instead of a floating-point one. Every place a value is
*born* is supposed to re-check which side of that boundary it landed on.

Binary arithmetic only does that re-check when one of the two **inputs** was already past
the boundary. When both inputs are ordinary whole numbers, `buildCoercingArithmeticRun`
(`runtime/emit/binary.ts`) takes a plain floating-point path that computes the answer and
returns it as-is — it never asks whether the *answer* crossed the boundary. Two inputs that
are individually fine can produce an answer that is not.

## Second, related symptom: the announced type

The same shape also breaks the promise the engine now makes about result-column types.
`INTEGER + INTEGER` is announced as `INTEGER`, and INTEGER's value space is "a whole number
inside the safe range, or an arbitrary-precision value outside it". The plain floating-point
answer above is neither. So a caller that switches on the announced type lands in the wrong
branch, and the permanent representation check (`QUEREUS_REPR_STRICT`) cannot be widened to
cover result columns while this shape exists.

Note the announcement is *right* and the value is *wrong*: `9007199254740991 * 3` genuinely
is an integer. The fix belongs in the runtime, not the planner.

## Scope note — sibling tickets

Three tickets now describe the same underlying theme (floating-point arithmetic quietly
leaving the exact whole-number range), each at a different code site, and a fix for one does
not fix the others:

- this one — plain binary `+ - * %` where both inputs are ordinary numbers,
- `bug-text-coercion-in-arithmetic-and-aggregates` (arm A) — where one input is a big
  number held as text,
- `bug-window-sum-loses-exactness-vs-grouped-sum` — where the running total inside a window
  or materialized view accumulates in floating point.

## Preferred shape of the fix

A point fix (range-check the result of each arithmetic operation and redo it in exact
arithmetic when it escaped) would close this instance. A **generated test over the boundary**
would close the class and keep it closed: for operand pairs drawn from just below, at, and
just above 2^53, assert that every arithmetic spelling returns the exact mathematical answer
*and* a value inside the space its announced type claims. That test would also fail today for
the two sibling tickets above, which is the point — one guard, three instances.

Whatever the fix, it must not cost the common small-number path a big-integer allocation per
row.
