---
description: About thirty built-in SQL functions never say what type of value they return, so the query planner has to guess — declare the real type for each so plans, comparisons and stored values are based on facts.
prereq: scalar-function-default-return-type-any
files:
  - packages/quereus/src/func/builtins/json.ts       # 13 functions
  - packages/quereus/src/func/builtins/datetime.ts   # 10 functions
  - packages/quereus/src/func/builtins/timespan.ts   # 11 functions
  - packages/quereus/src/func/builtins/scalar.ts     # random, randomblob, pow, power
  - packages/quereus/src/func/builtins/string.ts     # like, glob
  - packages/quereus/src/func/registration.ts        # createScalarFunction options
difficulty: medium
---

# Declare the real return type on the built-ins that ride the default

## Why

Ticket `scalar-function-default-return-type-any` makes an omitted `returnType`
mean "unknown" (`ANY_TYPE`) instead of the wrong "REAL". That stops the engine
lying, but ~30 built-in scalar functions still declare nothing, so the planner
knows nothing about them. Consequences of an unknown return type — none of them
*wrong*, all of them worse than the truth:

- Comparisons fall to the generic runtime path instead of the specialized
  `compare-fast` / `compare-typed` paths in `runtime/emit/binary.ts`.
- Cross-type coercion that *should* fire does not: `epoch_s(d) = '1709510400'`
  gets no numeric cast of the text literal, because the planner does not know
  `epoch_s` returns a number.
- Write-path conversion (`buildRowCoercion`) cannot recognise an
  already-correctly-typed cell, so it converts values it did not need to.
- `date()/time()/datetime()` results do not participate in temporal comparison,
  even though their single-argument conversion siblings (`date/1` etc., which DO
  declare DATE/TIME/DATETIME) do.

Note this ticket does **not** change any currently-correct result; it restores
plan-time precision. Anything that changes a result is a bug this ticket exposes,
not a bug it introduces — chase it down rather than adjusting the expectation.

## Inventory

Enumerated from a live `Database` by walking
`schemaManager._getAllSchemas()` → `_getAllFunctions()`. These are the scalar
functions with **no** `returnType` and **no** `inferReturnType` (the `inferReturn
Type` set — `abs`, `round`, `coalesce`, `upper`, `substr`, `nullif`, … — is
already correctly typed at every call site and is out of scope).

`packages/quereus/src/func/builtins/json.ts`

| function | returns | declare |
|---|---|---|
| `json_valid/1` (~line 29) | `boolean` | BOOLEAN |
| `json_schema/2` (~line 96) | `boolean` | BOOLEAN |
| `json_type/-1` (~line 119) | type name string, or `null` | TEXT, nullable |
| `json_extract/-1` (~line 137) | the extracted value — any JSON shape | **leave undeclared / declare ANY explicitly**; genuinely polymorphic |
| `json_quote/1` (~line 170) | serialized JSON *text* | TEXT |
| `json_array/-1` (~line 198) | native array | JSON |
| `json_object/-1` (~line 206) | native object | JSON |
| `json_array_length/-1` (~line 224) | number | INTEGER |
| `json_patch/2` (~line 242) | native object | JSON |
| `json_insert/-1` (~line 272) | native object | JSON |
| `json_replace/-1` (~line 314) | native object | JSON |
| `json_set/-1` (~line 354) | native object | JSON |
| `json_remove/-1` (~line 401) | native object | JSON |

`packages/quereus/src/func/builtins/datetime.ts`

| function | returns | declare |
|---|---|---|
| `date/-1` (~line 457) | `YYYY-MM-DD` | DATE — see decision below |
| `time/-1` (~line 465) | formatted time | TIME — see decision below |
| `datetime/-1` (~line 473) | formatted datetime | DATETIME — see decision below |
| `julianday/-1` (~line 481) | number | REAL (already the effective value; declare it) |
| `epoch_s/-1` (~line 499) | integer seconds | INTEGER |
| `epoch_ms/-1` (~line 512) | integer milliseconds | INTEGER |
| `epoch_s_frac/-1` (~line 525) | fractional seconds | REAL (declare it) |
| `strftime/-1` (~line 605) | formatted string | TEXT |
| `IsISODate/1` (~line 623) | `boolean` | BOOLEAN |
| `IsISODateTime/1` (~line 634) | `boolean` | BOOLEAN |

`packages/quereus/src/func/builtins/timespan.ts`

| function | returns | declare |
|---|---|---|
| `timespan_years`/`_months`/`_weeks`/`_days`/`_hours`/`_minutes`/`_seconds` (~lines 25-97) | a whole `Temporal.Duration` component | INTEGER |
| `timespan_total_seconds`/`_minutes`/`_hours`/`_days` (~lines 111-165) | `Duration.total(...)` | REAL (declare it) |

`packages/quereus/src/func/builtins/scalar.ts`

| function | returns | declare |
|---|---|---|
| `random/0` (~line 240) | `bigint` | INTEGER |
| `randomblob/1` (~line 249) | `Uint8Array` | BLOB |
| `pow/2`, `power/2` (~lines 331, 336) | `Math.pow` result | REAL (declare it) |

`packages/quereus/src/func/builtins/string.ts`

| function | returns | declare |
|---|---|---|
| `like/2` (~line 95) | `boolean` | BOOLEAN |
| `glob/2` (~line 103) | `boolean` | BOOLEAN |

Every one of these can return `null` (bad input, unresolvable path, `null`
argument), so declare `nullable: true` throughout unless the implementation
provably cannot — `json_valid`, `json_schema`, `IsISODate`, `IsISODateTime`,
`like`, `glob` and `random` are the candidates for `nullable: false`, and note
`like`/`glob` return `null` when either argument is `null`, so those stay
nullable.

## Decision to make: DATE/TIME/DATETIME vs TEXT for the variadic date functions

`date/1`, `time/1`, `datetime/1` (the conversion functions, elsewhere) already
declare DATE / TIME / DATETIME. The variadic `date/-1`, `time/-1`, `datetime/-1`
in `datetime.ts` are the modifier-accepting forms and produce the same textual
shapes.

Recommendation: **declare the temporal types**, matching the single-argument
siblings — otherwise `date(x)` and `date(x, '+1 day')` type differently, which is
a trap. The risk is that temporal types carry `semanticOrdering` and get routed
through `tryTemporalComparison` at runtime; if that turns out to change any
existing result, fall back to TEXT for these three, record why in the review
handoff, and file the divergence as its own ticket rather than papering over it.

## Cases to check, because they cross a category boundary

- `json_valid('{}') = 1`. True at HEAD (REAL vs INTEGER → both numeric → fast
  path). With BOOLEAN declared it goes BOOLEAN vs INTEGER → generic path — but
  **both** paths end in `compareSqlValuesFast(true, 1)`, so the result must not
  move. Pin it with a test.
- `timespan_days(timespan('P3D')) = 3` — true at HEAD, must stay true.
- `json_object('a','x') = j` where `j` is a JSON column — true at HEAD. With JSON
  declared on `json_object` both sides are JSON, which routes through
  `compare-typed` (`JSON_TYPE.compare`, structural) instead of the object-cast
  arm. Must stay true.
- `json_quote(j) = '{"a":"x"}'` — this is the originally reported symptom. Ticket
  1 already makes it true via ANY; declaring TEXT here must keep it true, now via
  the `compare-fast` textual path.
- Inserting a JSON-declared function's result into a JSON column
  (`insert into t(j) select json_object('a','x')`) now matches the column type
  exactly, so `buildRowCoercion` skips conversion and the native object is stored
  directly. That is the intent of the "convert exactly once" invariant — the
  06.9.1 coerce-once suite is the regression net.
- `randomblob(4)` declared BLOB: check nothing in the existing
  `test/logic/24.2-random-extras.sqllogic` depends on its previous typing.

## TODO

- Add `returnType` to each function listed above, in the five `builtins/*.ts`
  files. Where several functions in a file share one shape (the seven
  `timespan_*` component functions, the five JSON-object-returning mutators),
  hoist one shared `ScalarType` constant per shape rather than repeating the
  literal — stay DRY.
- Decide DATE/TIME/DATETIME vs TEXT for `date/-1`, `time/-1`, `datetime/-1`;
  document the choice in a comment at the site.
- Leave `json_extract` polymorphic. If declaring `ANY_TYPE` explicitly reads
  better than omitting `returnType`, do that and comment why — a reader should
  not have to wonder whether it was forgotten.
- Extend the logic test added by ticket 1 (or add a sibling `.sqllogic`) with the
  "cases to check" list above.
- Re-run the audit walk (`_getAllSchemas()` → `_getAllFunctions()`, filter
  scalar schemas with neither `returnType` nor `inferReturnType`) and confirm the
  only remaining entry is `json_extract`, deliberately.
- Run `yarn workspace @quereus/quereus run test` and `yarn lint`. Also run
  `yarn test:plans` — plan-shape goldens may record the comparison instruction
  note (`compare` vs `compare-fast` vs `compare-typed`), which these declarations
  change.
