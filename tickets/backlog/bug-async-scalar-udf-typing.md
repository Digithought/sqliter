description: Registering a user-defined function that does asynchronous work is rejected by the TypeScript types even though the engine runs it correctly.
files: packages/quereus/src/core/database.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/func/registration.ts, docs/usage.md

## What is wrong

The engine's internal scalar-function type allows a function to return a promise:

```ts
// packages/quereus/src/schema/function.ts
export type ScalarFunc = (...args: SqlValue[]) => MaybePromise<SqlValue>;
```

The runtime honours that — an asynchronous scalar function registered through the
internal factory (`createScalarFunction` in `func/registration.ts`, handed to
`db.registerFunction`) evaluates correctly, including inside a `WHERE` clause.

The public convenience method on `Database` declares the callback as synchronous:

```ts
// packages/quereus/src/core/database.ts
createScalarFunction(name, options, func: (...args: SqlValue[]) => SqlValue): void
```

So a TypeScript user who wants an async user-defined function gets a compile error
from the documented entry point, and has to either cast or reach for the internal
factory. `packages/quereus/test/filter-conjunct-early-exit.spec.ts` had to take the
internal route for exactly this reason.

## Expected behaviour

The public method accepts the same callback shape the engine accepts, so an
`async` implementation type-checks. Existing synchronous registrations keep working
unchanged (widening a callback's allowed return type does not break them).

## Worth deciding before implementing

- Whether async is genuinely supported everywhere a scalar function can appear, or
  only in some positions. The materialized-view row-time projection gate
  (`compileSourceRowEvaluator`) explicitly rejects a promise result, so a promise-
  returning function in that position must fail with a clear, documented error
  rather than a confusing one.
- Whether a deterministic function is allowed to be async at all (caching and
  replication assumptions).
- `docs/usage.md` describes `db.createScalarFunction` and does not mention async
  either way; it should say what is supported once this is settled.
