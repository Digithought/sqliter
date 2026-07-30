---
description: A SQL function that doesn't say what type it returns is assumed to return a number, so comparing its result to a piece of text is silently wrong — the text gets turned into the number 0 and the comparison comes back false.
files:
  - packages/quereus/src/func/registration.ts           # the offending default (2 sites)
  - packages/quereus/src/planner/building/coercion.ts   # where the default does the damage
  - packages/quereus/src/func/builtins/scalar.ts        # validateArgTypes call sites (6)
  - packages/quereus/src/types/builtin-types.ts         # ANY_TYPE
  - docs/types.md                                       # § Polymorphic Function Type Inference
  - packages/quereus/test/logic/06.5-polymorphic-types.sqllogic  # sibling test file for naming
difficulty: medium
---

# An undeclared function return type is assumed REAL, and that corrupts comparisons

## What is wrong

`createScalarFunction` (and `createAggregateFunction`) in
`packages/quereus/src/func/registration.ts` fill in a **default** return type
when the caller does not declare one:

```ts
const returnType: ScalarType = options.returnType ?? {
    typeClass: 'scalar',
    logicalType: REAL_TYPE,   // ← "I return a number"
    nullable: true,
    isReadOnly: true
};
```

`REAL_TYPE.isNumeric` is true, so the planner believes the function returns a
number. `insertCrossTypeCoercion`
(`packages/quereus/src/planner/building/coercion.ts`) sees *numeric on one side,
text on the other* and — correctly, given what it was told — wraps the text side
in a cast to REAL. The text `'object'` becomes the number `0`, and the
comparison against the function's actual TEXT result is false.

Confirmed at HEAD (fresh `Database`, one table `t(id integer primary key, j
json, d text)` holding `(1, '{"a":"x"}', '2024-03-04')`):

| query | result at HEAD | correct |
|---|---|---|
| `select json_type(j) = 'object' from t` | **false** | true |
| `select json_extract(j, '$.a') = 'x' from t` | **false** | true |
| `select strftime('%Y', d) = '2024' from t` | **false** | true |
| `select json_quote(j) = '{"a":"x"}' from t` | **false** | true |
| user-defined `tag(x)` returning text: `select tag(1) = 't:1'` | **false** | true |

The plan makes it explicit — `query_plan()` for
`select json_quote(j) = '"9"' from t` renders the BINARYOP as:

```
BINARYOP   json_quote(j) = 0
LITERAL    0
```

The text literal is gone; it was cast to REAL and constant-folded to `0`.

The **user-defined function** row above is the widest blast radius: `Database
.createScalarFunction` never passes a `returnType`, so *every* user/plugin
scalar function that returns text is affected.

## The original ticket's hypothesis was wrong

The source ticket (`bug-json-typed-comparison-reparses-text-literal`) guessed
that the TEXT literal was being **parsed as JSON**. It is not — no JSON parsing
happens on this path. Both operands are plain JS strings at runtime
(`typeof json_quote(...)` is `text`, `length` is 3 for `"9"`). The literal is
cast to **REAL**, and `cast('"9"' as real)` is `0`. The deliberate
"object-physical side wins, cast the other side to JSON" arm of
`insertCrossTypeCoercion` is *not* involved and needs no change; it is
documented and intentional.

## The fix

Default the undeclared return type to `ANY_TYPE`
(`packages/quereus/src/types/builtin-types.ts`) instead of `REAL_TYPE`, at both
sites in `registration.ts` (scalar at ~line 144, aggregate at ~line 248).

`ANY_TYPE` is the engine's existing "unknown scalar type" (already used that way
by `set-op-type-merge.ts` and `runtime/emit/join.ts`). It sets neither
`isNumeric` nor `isTextual` and its `physicalType` is `PhysicalType.NULL`, which
nothing in `src/` branches on behaviourally — only `physicalTypeName()` reads it.
So `insertCrossTypeCoercion` leaves **both** operands alone, the comparison falls
to the generic runtime path, and `compareSqlValuesFast` compares the two strings
as text. An honest "I don't know" replaces a confident wrong answer.

This has been probed on a scratch branch: the one-line change turns all five
rows in the table above from false to true, and the full
`yarn workspace @quereus/quereus run test` suite goes from 3069 passing / 0
failing to **3069 passing / 1 failing** — see next section for that one.

## The one consequential fallout: `validateArgTypes`

Six numeric builtins in `packages/quereus/src/func/builtins/scalar.ts` gate their
argument at plan time with `argTypes[i].isNumeric === true`:

- `abs` (~line 68), `round` (~line 110, shared by `round/1` and `round/2`),
  `sqrt` (~line 310), `floor` (~line 353), `ceil`/`ceiling` (~line 379),
  `clamp` (~line 405, all three args)

Today `abs(some_udf())` passes that gate **by accident** — the UDF claims REAL.
With the honest ANY default it is rejected with
`Invalid argument types for function abs`. That is what breaks
`test/materialized-view-replicable.spec.ts` → "rejects a non-replicable UDF
nested inside a built-in call", which expects a *different* error message.

Fix by widening the predicate to accept a type the planner cannot classify:
introduce one shared helper (single definition, not six copies — this must stay
DRY) meaning "numeric, or not yet known", and use it at all six sites. An
unknown-typed argument then defers to the implementation, which already handles
non-numeric input by returning `null`.

While there, `NULL_TYPE` should pass the same gate: `select abs(null)` throws
`Invalid argument types for function abs` at HEAD today (pre-existing, unrelated
to the default — reproduced with the default unchanged). Every one of the six
implementations already starts with `if (arg === null) return null`, and
`inferReturnType` returns `argTypes[0]`, so accepting NULL yields a NULL-typed
`null` — correct SQL. Folding it into the same predicate is free; doing it in a
separate ticket would mean touching the same six lines twice.

## Consequences to verify, not assume

- **ANY vs JSON** still takes the object-physical arm of
  `insertCrossTypeCoercion` (`ANY_TYPE !== NULL_TYPE`, so the guard does not
  exclude it): the ANY side is cast to JSON. Probed: `tag(1) = j` is false
  (`'t:1'` is not JSON source → lenient fallback to the raw string → compared
  against the object `{"a":"x"}` → unequal). Consistent with how a TEXT operand
  behaves. Keep it; pin it with a test.
- **Comparison specialization.** An ANY operand no longer qualifies for the
  `compare-fast` path in `runtime/emit/binary.ts` and lands on `compare`
  (generic). Correctness improves; a plan-shape golden test that asserts the
  instruction note may need updating. Ticket 2 (`builtin-scalar-function-
  declared-return-types`) restores the fast path for the builtins by declaring
  their real types.
- **Aggregates.** Audited: no built-in aggregate rides the default
  (`count`→INTEGER, `avg`/`sum`/`total`/`stddev_*`/`var_*`→REAL,
  `group_concat`/`string_concat`→TEXT, `json_group_*`→JSON, `min`/`max` use
  `inferReturnType`). The aggregate-site change is purely a guardrail for
  user-defined aggregates registered via `Database.createAggregateFunction`.
- **Functions with `inferReturnType` are unaffected.** `building/function-call.ts`
  (~lines 120-135) always calls it when present and passes the result to
  `ScalarFunctionCallNode`, so the declared type is never consulted for
  `abs`/`round`/`coalesce`/`upper`/… — the whole `+infer` set.

## Documentation

`docs/types.md` § "Polymorphic Function Type Inference" documents the
`returnType` / `inferReturnType` / `validateArgTypes` trio but never states what
happens when `returnType` is omitted. Add that: omitting it yields `ANY_TYPE`
(unknown) — safe but it forfeits plan-time typing, so declare the real type when
you know it. Also note there that `validateArgTypes` must let an unknown-typed
argument through rather than rejecting it at plan time.

## TODO

- Replace `REAL_TYPE` with `ANY_TYPE` as the undeclared-`returnType` default at
  both sites in `packages/quereus/src/func/registration.ts`; drop the now-unused
  `REAL_TYPE` import if nothing else in the file needs it (`yarn lint` catches it).
- Add one shared "numeric, unknown, or NULL" argument-type predicate and use it
  at the six `validateArgTypes` sites in
  `packages/quereus/src/func/builtins/scalar.ts` (`abs`, `round` base, `sqrt`,
  `floor`, `ceil`/`ceiling`, `clamp` ×3).
- Confirm `test/materialized-view-replicable.spec.ts` → "rejects a non-replicable
  UDF nested inside a built-in call" passes again (it should reach the
  `cannot be materialized` error once `abs` accepts the ANY-typed UDF).
- New logic test, e.g.
  `packages/quereus/test/logic/06.5.3-undeclared-return-type-comparison.sqllogic`,
  covering: the five reproducing queries from the table above; `abs(null)` →
  `null`; `abs(<udf returning a number>)`; `round(<udf>, 1)`; an ANY-vs-JSON
  comparison. A `.sqllogic` file cannot register a user-defined function, so the
  UDF cases belong in a `.spec.ts` (`test/core-api-features.spec.ts` already
  registers UDFs and is the natural home) and the builtin cases in the
  `.sqllogic`.
- Update `docs/types.md` § "Polymorphic Function Type Inference" as described.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`; expect 3070
  passing.
