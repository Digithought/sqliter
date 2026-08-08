---
description: The easy way to add your own function to the database cannot express two things the engine already supports — saying what type the function returns, and doing work that takes time — so anyone needing either has to fall back to a harder, low-level route.
files:
  - packages/quereus/src/core/database.ts       # createScalarFunction / createAggregateFunction — the two signatures and option bags this ticket changes
  - packages/quereus/src/schema/function.ts     # ScalarFunc already allows MaybePromise
  - packages/quereus/src/func/registration.ts   # the helpers those two call; already accept returnType
  - docs/usage.md                               # § db.createScalarFunction — says nothing about async or return type
  - docs/types.md                               # § Polymorphic Function Type Inference → "Omitting the return type"
  - packages/quereus/test/filter-conjunct-early-exit.spec.ts  # had to use the internal factory to get an async UDF
difficulty: easy
tradeoffs: Both capabilities already exist one layer down, so anyone who needs them has a working route - this is convenience-surface parity rather than new capability.
---

# The convenience registration surface for user functions is missing two capabilities

## Root cause

`packages/quereus/src/schema/function.ts` and `packages/quereus/src/func/registration.ts`
**already support both** an async implementation and a declared return type. The only thing
missing is the convenience registration surface on `Database`: `createScalarFunction` and
`createAggregateFunction` neither accept a return type in their option bags nor allow a
promise-returning callback. Both arms change the same two signatures and option bags in
`core/database.ts` and the same section of `docs/usage.md`, so they are one change.

## Arm A — no way to declare a return type

`Database.createScalarFunction(name, options, fn)` and
`Database.createAggregateFunction(name, options, step, final)` accept `numArgs`,
`deterministic`, `replicable`, `flags` and `hidden` — but not a return type. The helpers they
delegate to (`func/registration.ts`) do accept one; the public methods simply never pass it.
So every function registered this way reports the engine's "unknown type", which is correct
but costs something:

- comparisons against it cannot be specialized at plan time (they fall to the generic runtime
  comparison rather than the numeric or text fast path);
- a numeric-looking text literal is not coerced, so `my_numeric_fn(x) = '10'` is false where
  `my_numeric_fn(x) = 10` is true;
- the planner's type-driven analyses (monotonicity, invertibility, index range extraction)
  see nothing to work with.

`docs/types.md` now tells authors to "declare the real type whenever you know it", which they
cannot do through this API. The only route is `Database.registerFunction` with a hand-built
schema — the low-level path, which also asks the caller to get flags and the implementation
field name right.

**Expected:** an optional return type in the options bag of both methods, threaded to the
existing helper parameter, with the current unknown-type default when omitted. It should be
expressible from JavaScript without importing internal types — the built-in type objects
(`TEXT_TYPE`, `INTEGER_TYPE`, …) are already public, so accepting one of those is likely
enough; a plain type-name string would be friendlier still if there is already a name→type
lookup to reuse.

**Also decide:** whether the aggregate method should expose the argument-driven inference
hook too, or whether a fixed type is enough for user aggregates.

## Arm B — an async implementation does not type-check

The engine's internal scalar-function type allows a function to return a promise:

```ts
// packages/quereus/src/schema/function.ts
export type ScalarFunc = (...args: SqlValue[]) => MaybePromise<SqlValue>;
```

The runtime honours that — an asynchronous scalar function registered through the internal
factory (`createScalarFunction` in `func/registration.ts`, handed to `db.registerFunction`)
evaluates correctly, including inside a `WHERE` clause. The public convenience method declares
the callback as synchronous:

```ts
// packages/quereus/src/core/database.ts
createScalarFunction(name, options, func: (...args: SqlValue[]) => SqlValue): void
```

So a TypeScript user who wants an async user-defined function gets a compile error from the
documented entry point, and has to either cast or reach for the internal factory.
`packages/quereus/test/filter-conjunct-early-exit.spec.ts` had to take the internal route for
exactly this reason.

**Expected:** the public method accepts the same callback shape the engine accepts, so an
`async` implementation type-checks. Existing synchronous registrations keep working unchanged
(widening a callback's allowed return type does not break them).

**Worth deciding before implementing:**

- Whether async is genuinely supported everywhere a scalar function can appear, or only in
  some positions. The materialized-view row-time projection gate
  (`compileSourceRowEvaluator`) explicitly rejects a promise result, so a promise-returning
  function in that position must fail with a clear, documented error rather than a confusing
  one.
- Whether a deterministic function is allowed to be async at all (caching and replication
  assumptions).
- **New since scalar-function fusion landed** (`runtime-scalar-fusion-function-calls`): the
  engine now decides at compile time whether a scalar function can return a promise, and a
  function that returns one without saying so fails at its first call with a message telling
  the author to set `isAsync: true` on the registration. That option exists only on the
  low-level factory. So widening this convenience method to accept a promise-returning
  callback must also give it a way to say so — either by accepting the same flag, or by
  treating any callback registered through the widened method as possibly-asynchronous.
  Callbacks written with the `async` keyword are recognized automatically and need neither;
  the gap is only for a plain function that hands back a promise (a wrapper, a `.bind()`,
  a memoizer). Until this lands, a user of this method who hits that error has no remedy
  inside this API and must move to `db.registerFunction`, which `docs/usage.md` now says.

## Documentation

`docs/usage.md` describes `db.createScalarFunction` and mentions neither the return type nor
async support; it should state both once this lands. `docs/types.md`'s "Omitting the return
type" guidance becomes actionable from this API for the first time.
