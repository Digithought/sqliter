---
description: Someone registering a custom function through the simple database method has no way to say what type it returns, so the engine treats every such function's result as an unknown type and gives up some speed and type checking it could otherwise have.
files:
  - packages/quereus/src/core/database.ts                # createScalarFunction / createAggregateFunction option bags
  - packages/quereus/src/func/registration.ts            # the helpers those two call; already accept returnType
  - docs/types.md                                        # § Polymorphic Function Type Inference → "Omitting the return type"
difficulty: easy
---

# Let a user-registered function declare its return type

`Database.createScalarFunction(name, options, fn)` and
`Database.createAggregateFunction(name, options, step, final)` accept `numArgs`,
`deterministic`, `replicable`, `flags` and `hidden` — but not a return type. The helpers
they delegate to (`func/registration.ts`) do accept one; the public methods simply never
pass it. So every function registered this way reports the engine's "unknown type", which
is correct but costs something:

- comparisons against it cannot be specialized at plan time (they fall to the generic
  runtime comparison rather than the numeric or text fast path);
- a numeric-looking text literal is not coerced, so `my_numeric_fn(x) = '10'` is false
  where `my_numeric_fn(x) = 10` is true;
- the planner's type-driven analyses (monotonicity, invertibility, index range extraction)
  see nothing to work with.

`docs/types.md` now tells authors to "declare the real type whenever you know it", which
they cannot do through this API. The only route is `Database.registerFunction` with a
hand-built schema — the low-level path, which also asks the caller to get flags and the
implementation field name right.

## Expected behavior

An optional return type in the options bag of both methods, threaded to the existing
helper parameter, with the current unknown-type default when it is omitted. Whatever the
option looks like, it should be expressible from JavaScript without importing internal
types — the built-in type objects (`TEXT_TYPE`, `INTEGER_TYPE`, …) are already public, so
accepting one of those is likely enough; a plain type name string would be friendlier
still if there is already a name→type lookup to reuse.

Worth deciding at the same time whether the aggregate method should also expose the
argument-driven inference hook, or whether a fixed type is enough for user aggregates.
