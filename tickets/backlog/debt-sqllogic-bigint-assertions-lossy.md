---
description: A test in the main SQL test suite that expects a very large whole number can pass even when the engine returns the wrong answer, because the comparison rounds both the expected and actual values the same way before checking them.
files:
  - packages/quereus/test/logic.spec.ts                    # normalizeBigInts (~line 25), assertion site (~line 723)
  - packages/quereus/test/logic/03.6-type-system.sqllogic  # blocks that work around this today
  - packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic
difficulty: medium
---

## Problem

`.sqllogic` files state expected results as JSON:

```
select some_big_number();
→ [{"v":9007199254740993}]
```

Two independent roundings happen before that line is checked:

1. The expected side is read with a standard JSON parser, which has no
   large-integer type — `9007199254740993` becomes the nearest representable
   value, `9007199254740992`.
2. The actual side is passed through `normalizeBigInts` (`test/logic.spec.ts`),
   which converts an exact big-integer result the same lossy way, for the same
   reason.

So a correct result and a result that is off by one both land on
`9007199254740992`, and the assertion passes either way. Any `.sqllogic`
expectation whose value exceeds 9,007,199,254,740,991 (2^53 - 1) is currently
unable to fail.

This is a false-negative in the project's primary test suite, not a bug in
shipped code — but it silently weakens exactly the tests written to guard
large-number precision.

## Current workaround

Test authors wrap such results in `cast(… as text)` and assert against a
string, which both roundings leave alone. The existing "TEXT -> INTEGER /
NUMERIC conversion past 2^53" and `numeric_big` blocks in
`03.6-type-system.sqllogic` do this deliberately. It works, but it depends on
every future author knowing the trap, and there is nothing stopping a plain
numeric assertion from being written and quietly passing.

## Expected behavior

A `.sqllogic` expectation containing a whole number too large for exact
floating-point representation should compare exactly — so that a wrong engine
result fails the test. Failing that, writing such an expectation should be a
loud error telling the author to use the `cast(… as text)` form, rather than
passing vacuously.

## Notes for whoever picks this up

The expected side is the harder half: it needs a JSON reader that can keep an
oversized integer literal exact (e.g. capturing the raw token, or a
reviver-based approach), because by the time the standard parser has run the
information is already gone. Changing `normalizeBigInts` alone fixes nothing.

Worth auditing the existing corpus once exact comparison is possible — some
current expectations may have been written against the rounded value and will
need updating to the true one.
