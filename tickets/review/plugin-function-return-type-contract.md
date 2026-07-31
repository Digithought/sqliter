---
description: Registering a function without a usable return type used to be accepted silently and then blow up with a confusing internal error mid-query; now bad declarations are rejected up front with a clear message, and the plugin docs show shapes the engine actually reads.
files:
  - packages/quereus/src/func/registration.ts                 # normalizeFunctionSchema — the contract; create* helpers route through it
  - packages/quereus/src/core/database.ts                     # registerFunction calls it and stores the normalized schema
  - packages/quereus/src/schema/function.ts                   # type guards answer false instead of throwing on an absent returnType
  - packages/quereus/src/index.ts                             # scalarReturn + *_RETURN constants now exported
  - packages/quereus/test/function-return-type.spec.ts        # NEW — the contract's spec
  - packages/quereus/test/documentation.spec.ts               # NEW cases — doc examples run; doc-rot guard
  - packages/quereus/test/boundary-validation.spec.ts         # stale returnType fixtures fixed
  - docs/plugins.md                                           # every function example rewritten; new "Declaring return types" section
  - docs/types.md                                             # § Omitting the return type cross-references the contract
difficulty: medium
---

# Review: one stated contract for a registered function's return type

## What shipped

**One function states the contract:** `normalizeFunctionSchema(schema)` in
`packages/quereus/src/func/registration.ts`. It

- fills in a nullable scalar of ANY when `returnType` is **absent** (a schema with an
  implementation and no declared return type is therefore taken to be *scalar*),
- fills in `isReadOnly` / `isSet` / `keys` / `rowConstraints` when a **relation**
  return type omits them (only `columns` carries meaning the author must supply),
- throws `MisuseError` naming the function (`Function 'f/1': …`) and the offending
  field when `returnType` is **present but malformed**.

Both registration paths route through it: `Database.registerFunction` (the path every
plugin takes, via `registerPlugin`) calls it *after* the existing name / numArgs /
implementation checks, and all four `create*` helpers build their schema through it.
The `ANY_TYPE` default is now one constant (`UNKNOWN_SCALAR_RETURN`) rather than three
copies; the empty-relation default is likewise one constant.

**Defense in depth:** `isScalarFunctionSchema` / `isTableValuedFunctionSchema`
(`schema/function.ts`) return `false` for a schema with no `returnType` instead of
throwing on `undefined.typeClass`. A schema that reaches the planner some other way now
gets `Function f is not a scalar function`, and `function_info()` keeps enumerating
instead of truncating at the first bad entry.

**Public surface:** `scalarReturn`, `TEXT_RETURN`, `INTEGER_RETURN`, `REAL_RETURN`,
`BOOLEAN_RETURN`, `BLOB_RETURN`, `JSON_RETURN`, `ANY_RETURN` and the `*_NOT_NULL`
variants are exported from `packages/quereus/src/index.ts`, plus
`normalizeFunctionSchema` itself.

**Docs:** every function example in `docs/plugins.md` was rewritten onto the `create*`
helpers and the exported constants; the table-valued example is now an `async function*`
yielding row arrays (it was a sync generator yielding objects). A new
§ *Declaring return types* states the contract. `docs/types.md` § *Omitting the return
type* cross-references it.

## Scope note — one thing beyond the ticket's letter

The ticket enumerated malformed as covering `columns`; while probing I found that a
relation `returnType` declaring **only** `columns` — a reasonable hand-built shape, and
close to what the old docs showed — registers fine and then fails at planning with
`TypeError: type.keys is not iterable` (`planner/util/fd-utils.ts` `keysOf`, reached from
`FilterNode.computePhysical`) the moment a predicate or ORDER BY touches it. Verified by
throwaway spec before the fix. Same code site, same failure class, so it is fixed here by
filling the absent fields rather than rejecting them; `keys` / `rowConstraints` that are
*present but not arrays* are rejected. Regression test:
`function-return-type.spec.ts` → "fills in the omittable relation fields".

## How to exercise it

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/function-return-type.spec.ts" \
  "packages/quereus/test/documentation.spec.ts" \
  "packages/quereus/test/boundary-validation.spec.ts"
```

Behaviour worth poking at by hand (all of these are the ticket's original repro table):

| registered `returnType` | before | now |
| --- | --- | --- |
| absent, scalar / aggregate | `Cannot read properties of undefined (reading 'typeClass')` at plan time | registers; `select f(1)` and `select f(1) = 's:1'` both work |
| absent, on a function meant to be table-valued | same internal error | registers as scalar; `select * from f(3)` says `Function f/1 is not a table-valued function` |
| `{ typeClass: 'scalar', sqlType: 'TEXT' }` | registers, then `Cannot read properties of undefined (reading 'physicalType')` on any comparison | `MisuseError: Function 'f/1': returnType.logicalType must be a type object…` |
| `{ typeClass: 'scalar', affinity: 3 }` | ditto | ditto |
| `{}` | registers, then `Function f is not a scalar function` | rejected at registration |
| relation column `{ name: 'v', type: 'INTEGER' }` | registers; `where v = 1` fails `Column not found: v` | `MisuseError: … returnType.columns[0] ('v') must carry a scalar type object…` |
| relation with columns but no `keys` | registers, then `type.keys is not iterable` on any filter | registers; fields filled |
| correctly shaped | works | works |

## Validation run

`yarn build`, `yarn test`, `yarn lint` from the repo root — all exit 0, no new warnings.
`yarn test` is 8217 passing in `packages/quereus` (was 8215 + the new cases) and green
across every workspace. Did **not** run `yarn test:store` (store-path re-run; nothing in
this diff touches the store path).

## Known gaps — please push on these

- **`Schema.addFunction` is still an ungated map insert.** It is where all roads meet,
  including the ~116 builtins registered at every database open, so gating there would
  revalidate every builtin on every open for the same benefit. Anything inserting into a
  Schema directly (there is nothing in-tree that does, outside the new catalog test)
  therefore bypasses the contract, with the loosened type guards as the only backstop.
  Documented as a NOTE on `normalizeFunctionSchema`. Worth a second opinion on whether
  that tradeoff is the right one.
- **The malformed-shape checks are structural, not exhaustive.** A relation whose
  `keys` entries are junk objects, or a scalar carrying a `logicalType` that has `name` +
  `physicalType` but is otherwise not a registered type, still passes. The check is
  deliberately the cheap structural one the ticket specified (`typeof name === 'string'
  && typeof physicalType === 'number'`) — deeper validation was not attempted.
- **Backwards compatibility is a real (accepted) break.** Any out-of-tree plugin that
  copied the old documented `sqlType` shape registered successfully before and now throws
  at registration. That is the point of the ticket, and `docs/plugins.md` says so
  explicitly, but it is the change most likely to surprise someone.
- **The doc-example tests transcribe, they do not extract.** `documentation.spec.ts`
  re-types each `docs/plugins.md` example with the import specifier swapped to the in-tree
  source; nothing mechanically proves the spec and the markdown stay identical. The
  mechanical half is a separate guard test that scans the doc's fenced code blocks for
  `sqlType` and for string-valued column `type:` and fails if either reappears. Rot in a
  direction neither test names is still possible.
- **`packages/sample-plugins/*` still hand-roll their own scalar-type constants** rather
  than using the newly-exported `TEXT_RETURN` / `scalarReturn`. They are correct and they
  build, so they were left alone to keep the diff focused; converting them is a
  reasonable ask.
- **`Database.createScalarFunction` / `createAggregateFunction` still never accept a
  `returnType` from the caller.** That is `tickets/backlog/feat-udf-registration-surface-gaps.md`,
  deliberately out of scope; when it lands its option should feed
  `normalizeFunctionSchema` rather than adding a fourth spelling of the default.
