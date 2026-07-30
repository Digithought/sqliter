---
description: Registering a function through the low-level API without a usable return type makes any query using it fail with a confusing internal error, and the plugin docs show a return-type shape the engine stopped understanding a while ago.
files:
  - packages/quereus/src/core/database.ts                # registerFunction — validates name/numArgs/impl, never returnType
  - packages/quereus/src/func/registration.ts            # createScalarFunction/createAggregateFunction — where the ANY default lives
  - packages/quereus/src/util/plugin-helper.ts           # registerPlugin → db.registerFunction(func.schema), bypasses the helpers
  - docs/plugins.md                                      # scalar/aggregate/TVF registration examples (lines ~354, ~388, ~425, ~739, ~784)
difficulty: medium
---

# A function registered without a usable return type fails late and unhelpfully

## What happens

There are two ways to register a function:

- `Database.createScalarFunction` / `createAggregateFunction` — go through the helpers in
  `func/registration.ts`, which fill in a return type when the caller declares none
  (as of ticket `scalar-function-default-return-type-any`, that filler is the
  "unknown type", `ANY_TYPE`).
- `Database.registerFunction(schema)` — takes a hand-built schema object as-is. This is
  the path every plugin uses: `registerPlugin` (`util/plugin-helper.ts`) hands each
  entry's `schema` straight to it.

The second path fills in nothing and validates nothing about the type. `registerFunction`
checks the name, the argument count and that an implementation is present, then stores the
schema. A schema with no `returnType`, or one whose `returnType` is missing the
`logicalType` field, is accepted silently and then blows up at planning time — for every
query that mentions the function, with an error that names neither the function nor the
problem.

Reproduced against current `main`:

| registered schema | query | result |
| --- | --- | --- |
| no `returnType` at all | `select plug_no_type(1)` | `Planning error: Cannot read properties of undefined (reading 'typeClass')` |
| no `returnType` at all | `select plug_no_type(1) = 'p:1'` | same |
| `returnType: { typeClass: 'scalar', sqlType: 'TEXT' }` | `select plug_stale_type(1)` | works — returns the value |
| `returnType: { typeClass: 'scalar', sqlType: 'TEXT' }` | `select plug_stale_type(1) = 's:1'` | `Planning error: Cannot read properties of undefined (reading 'physicalType')` |

The second shape is not invented for the repro — **it is what `docs/plugins.md` currently
tells plugin authors to write.** A `returnType` describes its type with a `logicalType`
field holding a type object (`TEXT_TYPE`, `INTEGER_TYPE`, …); `sqlType: 'TEXT'` is a
long-dead spelling that appears nowhere in the engine source. The relation-typed example
in the same document has the same rot: it gives each column `type: 'INTEGER'` (a string)
where a column type object is expected. So the documented happy path produces a schema
that half-works — fine in a bare `select`, an internal error the moment the value is
compared to anything.

## Expected behavior

- Registering a function whose return type is absent or unusable should either be
  **rejected at registration** with a message that names the function and says what is
  wrong, or be **normalized to the unknown type** the same way the `createScalarFunction`
  helpers do. Rejecting is probably the better answer for a *malformed* type (a typo
  should not be silently downgraded to "unknown"), and normalizing is the better answer
  for an *absent* one, since omitting it is a legitimate choice everywhere else in the
  API. Either way the failure must not be an internal `undefined` read at planning time.
- Every registration example in `docs/plugins.md` must be the shape the engine actually
  accepts, for scalar, aggregate and table-valued functions alike, and should be checked
  against the engine rather than edited by eye.

## Notes

Whatever validation lands, the two registration paths should end up agreeing about what an
omitted return type means — one contract, stated once. Right now the default lives in
`func/registration.ts` and the plugin path never sees it.
