---
description: Registering a function through the low-level API without a usable return type is accepted silently and then makes any query using it fail with a confusing internal error, and the plugin documentation shows a return-type shape the engine stopped understanding a while ago.
files:
  - packages/quereus/src/core/database.ts                     # registerFunction — validates name/numArgs/impl, never returnType
  - packages/quereus/src/func/registration.ts                 # createScalarFunction/createAggregateFunction — where the ANY default lives today
  - packages/quereus/src/schema/function.ts                   # isScalarFunctionSchema / isTableValuedFunctionSchema — throw on an absent returnType
  - packages/quereus/src/func/builtins/return-types.ts        # scalarReturn() + TEXT_RETURN/INTEGER_RETURN/… — not exported from the package index
  - packages/quereus/src/index.ts                             # public export surface (lines ~147-160 types, ~244 registration helpers)
  - packages/quereus/src/func/builtins/schema.ts              # classifyFunction / function_info() generator — truncates on a throwing type guard
  - packages/quereus/src/util/plugin-helper.ts                # registerPlugin → db.registerFunction(func.schema)
  - packages/quereus/test/boundary-validation.spec.ts         # registerFunction() boundary cases; fixtures use a stale returnType shape
  - packages/quereus/test/documentation.spec.ts               # existing home for "the docs actually run" tests
  - docs/plugins.md                                           # scalar/TVF/aggregate registration examples (lines 354, 388-394, 425, 739, 784)
  - packages/sample-plugins/string-functions/index.ts         # a correct, working registration to model the docs on
difficulty: medium
repro: verified
---

# One stated contract for a registered function's return type

## What is wrong

A function schema handed to `Database.registerFunction` is stored as-is. The method
checks the name, the argument count and that an implementation is present — it never
looks at `returnType`. So a schema with no return type, or with a return type in a shape
the engine no longer understands, registers successfully and then fails at planning
time with an internal `undefined` read that names neither the function nor the problem.

This is the path every plugin uses: `registerPlugin` (`util/plugin-helper.ts`) hands
each entry's `schema` straight to `registerFunction`. The other path —
`Database.createScalarFunction` / `createAggregateFunction` — goes through the helpers
in `func/registration.ts`, which fill in the "unknown type" (`ANY_TYPE`) when the caller
declares none. The two paths disagree, and the contract is written down in neither.

Compounding it: **`docs/plugins.md` documents the broken shape.** Every function example
in it writes `returnType: { typeClass: 'scalar', sqlType: 'TEXT' }`. A scalar return type
carries its type in a `logicalType` field holding a type object (`TEXT_TYPE`,
`INTEGER_TYPE`, …); `sqlType` appears nowhere in the engine source. The table-valued
example has the same rot, giving each column `type: 'INTEGER'` (a string) where a column
type object is expected.

## Reproduction

All rows below were run against current `main` (`8496a28c`) through `db.eval`, via a
throwaway mocha spec. Every registration in the table **succeeded** — the failures are
all at query time.

| registered `returnType` | query | result |
| --- | --- | --- |
| absent (scalar) | `select f(1)` | `Planning error: Cannot read properties of undefined (reading 'typeClass')` |
| absent (aggregate) | `select f(x) from t` | same |
| absent (TVF) | `select * from f(3)` | same |
| `{ typeClass: 'scalar', sqlType: 'TEXT' }` — **the documented shape** | `select f(1)` | works |
| `{ typeClass: 'scalar', sqlType: 'TEXT' }` | `select f(1) = 's:1'` | `Planning error: Cannot read properties of undefined (reading 'physicalType')` |
| relation whose column is `{ name: 'v', type: 'INTEGER' }` — **the documented shape** | `select * from f(3)` | works |
| relation whose column is `{ name: 'v', type: 'INTEGER' }` | `select * from f(3) where v = 1` | `Column not found: v` |
| `{}` (present but empty) | `select f(1)` | `Function f is not a scalar function` |
| a correctly shaped scalar type | `select f(1) = 'g:1'` | works |

The three crash sites, from the captured stacks:

- `schema/function.ts` `isScalarFunctionSchema` — reads `schema.returnType.typeClass`,
  called from `planner/building/function-call.ts`.
- `types/comparison-coercion.ts` `isObject` — reads `logicalType.physicalType`, called
  from `planner/building/coercion.ts` `insertCrossTypeCoercion`. This is the
  `sqlType`-shaped case: the type object survives until something compares against it.
- `planner/analysis/const-pass.ts` `detectBorderNodes` — reads
  `node.getType().typeClass`, and `AggregateFunctionCallNode.getType()` returns
  `functionSchema.returnType` verbatim.

### A quieter symptom: the function catalog silently truncates

`function_info()` (`func/builtins/schema.ts`) calls `classifyFunction`, which calls the
throwing type guards, inside a `try` that yields a single `['error', …]` row and then
**stops enumerating**. Verified: with one broken function registered followed by one
good one, `select name from function_info() where name like 'plug%'` returns *nothing* —
both are lost. `schema()` lists them both, so the two catalog surfaces disagree.

## Expected behavior

**One contract, stated once,** shared by both registration paths:

- **Absent `returnType`** is legitimate — it means "unknown" and normalizes to
  `ANY_TYPE`, exactly as `createScalarFunction` already does. It must not be a crash.
  Note the one genuine ambiguity: a schema with an `implementation` and no `returnType`
  could be scalar or table-valued, and nothing else distinguishes them. Defaulting to
  scalar is the right call (a table-valued function with no declared columns is useless
  anyway); say so in the docs, and point TVF authors at `createTableValuedFunction`.
- **Malformed `returnType` is rejected at registration**, with a `MisuseError` naming
  the function and saying what is wrong. A typo must not be silently downgraded to
  "unknown" — that is how `sqlType: 'TEXT'` half-worked for so long. Malformed means:
  `typeClass` missing or not `'scalar'` / `'relation'`; a scalar type whose
  `logicalType` is absent or is not a type object; a relation type whose `columns` is
  not an array, or any of whose columns lacks a `name` or carries a `type` that is not a
  scalar type object.
- A cheap structural test for "is a type object" is `typeof name === 'string' &&
  typeof physicalType === 'number'` (see the `LogicalType` interface in
  `types/logical-type.ts`).

**Defense in depth:** the type guards in `schema/function.ts` should answer `false` for
a schema with no `returnType` rather than throwing. Then a schema that reaches the
planner despite the new gate produces `Function f is not a scalar function` instead of
an internal `undefined` read, and `function_info()` keeps listing.

**Documentation:** every registration example in `docs/plugins.md` must be a shape the
engine accepts, and must be *checked against the engine* rather than edited by eye.
Beyond the return type, the table-valued example is wrong in two further ways: it is a
synchronous generator (the implementation type is
`(...args) => MaybePromise<AsyncIterable<Row>>`) and it yields objects
(`{ index, value }`) where a row is an array of values. `packages/sample-plugins/string-functions/index.ts`
is a working model to follow: it imports `createScalarFunction` / `createTableValuedFunction`
and the public `TEXT_TYPE` / `INTEGER_TYPE` constants and builds its own scalar-type
constant from them.

## Design notes

- The natural place for the contract is a `normalizeFunctionSchema(schema)` in
  `func/registration.ts` that both normalizes the absent case and rejects the malformed
  one. `Database.registerFunction` calls it and stores the result; the `create*` helpers
  route their existing defaulting through it so the `ANY_TYPE` default is written once
  rather than three times. `Schema.addFunction` (`schema/schema.ts`) is the other
  possible choke point — it is where *all* roads meet, including the ~116 builtins
  registered at startup — but it is a plain map insert today, and putting a validating
  copy there is a wider blast radius for the same benefit. Prefer `registration.ts`
  unless something makes the wider point necessary.
- `func/builtins/return-types.ts` already has exactly what plugin authors need —
  `scalarReturn(logicalType, nullable?)` and the `TEXT_RETURN` / `INTEGER_RETURN` /
  `REAL_RETURN` / … constants — but none of it is exported from
  `packages/quereus/src/index.ts`. Exporting them is a small change that makes the
  corrected docs a one-token example instead of a four-field object literal. Do this;
  the sample plugins each hand-roll the same constant today.
- `packages/quereus/test/boundary-validation.spec.ts` fixtures carry an even older stale
  shape, `{ typeClass: 'scalar', affinity: 3 }`. They pass today only because each case
  throws on its own field before `returnType` is looked at. Keep the existing checks
  ordered first so those assertions keep firing on the field they name, and fix the
  fixtures to a valid shape as part of this work.
- Related but separate: `tickets/backlog/feat-udf-registration-surface-gaps.md` proposes
  adding a return-type option to `Database.createScalarFunction` /
  `createAggregateFunction`. That is a different function in the same file. If it lands
  later, its option should feed the same `normalizeFunctionSchema` rather than adding a
  fourth spelling of the default.

## TODO

### Phase 1 — the contract

- Add `normalizeFunctionSchema(schema)` to `packages/quereus/src/func/registration.ts`:
  returns the schema unchanged when `returnType` is well-formed, fills in the `ANY_TYPE`
  scalar default when `returnType` is absent, and throws `MisuseError` naming the
  function and the offending field when `returnType` is present but malformed.
- Route `createScalarFunction` and `createAggregateFunction`'s existing `ANY_TYPE`
  defaulting through it, so the default is written once. Keep
  `createTableValuedFunction`'s empty-relation default (its row-width normalization
  contract depends on the empty-columns case — see the comment above it).
- Call it from `Database.registerFunction` (`core/database.ts`), after the existing
  name / numArgs / implementation checks, and store the normalized result.
- Make `isScalarFunctionSchema` and `isTableValuedFunctionSchema`
  (`packages/quereus/src/schema/function.ts`) return `false` for a schema with no
  `returnType` instead of throwing.
- Export `scalarReturn` and the `*_RETURN` constants from
  `packages/quereus/src/index.ts`.

### Phase 2 — tests

- New spec covering registration: absent return type normalizes and the function is then
  usable in both a bare `select` and a comparison; `sqlType`-shaped, `affinity`-shaped,
  `{}`-shaped and relation-with-string-column-types schemas are all rejected at
  `registerFunction` with a message naming the function; a correctly shaped schema still
  registers. Cover scalar, aggregate and table-valued.
- Regression test for the catalog: register a malformed-then-good pair directly via
  `schemaManager.getMainSchema().addFunction` (bypassing the new gate, since
  `registerFunction` now rejects it) and assert `function_info()` still lists everything
  after it.
- Fix the stale `returnType` fixtures in
  `packages/quereus/test/boundary-validation.spec.ts` and confirm each case still throws
  on the field it names.

### Phase 3 — documentation

- Rewrite the scalar (line ~354), table-valued (~388) and aggregate (~425) examples in
  `docs/plugins.md`, plus the two later repeats (~739 in the comprehensive example, ~784
  in the TypeScript section), using the `create*` helpers and the exported return-type
  constants. Fix the table-valued example's generator to be `async function*` yielding
  row arrays.
- State the contract in the same document: what an omitted return type means, that a
  function with an implementation and no return type is taken to be scalar, and that a
  table-valued function must declare its columns or use `createTableValuedFunction`.
- Add doc-example tests to `packages/quereus/test/documentation.spec.ts` that register
  each corrected `docs/plugins.md` example verbatim and query it, so the examples cannot
  rot again silently.

### Phase 4 — validation

- `yarn build`, then `yarn test` from the repo root, then `yarn lint`.
