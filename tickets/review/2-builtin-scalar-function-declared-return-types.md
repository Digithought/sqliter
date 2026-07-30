---
description: About thirty built-in SQL functions used to leave the query planner guessing what kind of value they return; each now declares its real type, so comparisons and stored values are based on facts.
files:
  - packages/quereus/src/func/builtins/return-types.ts   # NEW — shared return-type constants
  - packages/quereus/src/func/builtins/json.ts           # 13 functions
  - packages/quereus/src/func/builtins/datetime.ts       # 10 functions
  - packages/quereus/src/func/builtins/timespan.ts       # 11 functions
  - packages/quereus/src/func/builtins/scalar.ts         # random, randomblob, pow, power
  - packages/quereus/src/func/builtins/string.ts         # like, glob
  - packages/quereus/test/logic/06.5.4-declared-return-type-builtins.sqllogic  # NEW test
  - packages/quereus/test/logic/06.5.3-undeclared-return-type-comparison.sqllogic  # amended
  - docs/types.md
difficulty: medium
---

# Review: declared return types on the built-in scalar functions

## What landed

Every built-in scalar function that previously declared no `returnType` now declares one,
with a single deliberate exception. The declarations are meant to change **plans**, not
**answers** — a known return type routes comparisons through the specialized
`compare-fast` / `compare-typed` paths in `runtime/emit/binary.ts`, lets
`insertCrossTypeCoercion` fire, and lets the write path recognise an already-correctly-typed
value. One answer did change; see "The one behavior change" below.

New file `src/func/builtins/return-types.ts` holds the shared shape constants
(`TEXT_RETURN`, `INTEGER_RETURN`, `REAL_RETURN`, `BOOLEAN_RETURN`, `BLOB_RETURN`,
`JSON_RETURN`, `ANY_RETURN`, plus `_NOT_NULL` variants) and a `scalarReturn(type, nullable)`
builder, so declaring a type is a one-token edit instead of a repeated four-field literal.
The two JSON aggregates in `json.ts` were switched to the shared constant too.

| file | functions | declared |
|---|---|---|
| json.ts | `json_valid`, `json_schema` | BOOLEAN, not-null |
| json.ts | `json_type`, `json_quote` | TEXT |
| json.ts | `json_array_length` | INTEGER |
| json.ts | `json_array`, `json_object`, `json_patch`, `json_insert`, `json_replace`, `json_set`, `json_remove`, and the `json_group_array`/`json_group_object` aggregates | JSON |
| json.ts | `json_extract` | **ANY, explicitly** — polymorphic on purpose, with a comment saying so |
| datetime.ts | `date/-1`, `time/-1`, `datetime/-1`, `strftime` | TEXT |
| datetime.ts | `epoch_s`, `epoch_ms` | INTEGER |
| datetime.ts | `julianday`, `epoch_s_frac` | REAL |
| datetime.ts | `IsISODate`, `IsISODateTime` | BOOLEAN, not-null |
| timespan.ts | `timespan_years/_months/_weeks/_days/_hours/_minutes` | INTEGER |
| timespan.ts | `timespan_seconds`, `timespan_total_seconds/_minutes/_hours/_days` | REAL |
| scalar.ts | `random` | INTEGER, not-null |
| scalar.ts | `randomblob` | BLOB |
| scalar.ts | `pow`, `power` | REAL |
| string.ts | `like`, `glob` | BOOLEAN (nullable — a null operand yields NULL) |

## Two deviations from the ticket's inventory — check these first

**1. `timespan_seconds` is REAL, not INTEGER.** The ticket grouped it with the six other
component extractors, but its implementation folds the sub-second components in
(`duration.seconds + milliseconds/1000 + …`), so `timespan_seconds('PT1.5S')` is 1.5.
Declaring INTEGER would have been a lie the write path acts on — inserting into an INTEGER
column would skip conversion and store a fraction. Commented at the site.

**2. `date/-1`, `time/-1`, `datetime/-1` are TEXT, not DATE/TIME/DATETIME.** The ticket
recommended the temporal types and named a fallback condition; the fallback applies, but
for a different reason than the ticket anticipated (not `semanticOrdering` — DATE/TIME/
DATETIME do not carry it). The real problem is the *spelling*: these functions emit
SQLite's display format, which is not the canonical stored form of those types —
`datetime()` uses a space separator where DATETIME canonicalizes to `T`, and
`time(…, 'subsec')` always emits three fractional digits where TIME trims them.

This was **verified experimentally, not just reasoned about.** With DATETIME/TIME declared,
`insert into dw(dt, tm) select datetime('2024-03-04 05:06:07','+1 day'), time('12:00:00','subsec')`
stores `2024-03-05 05:06:07` / `12:00:00.000`, and `dt = '2024-03-05T05:06:07'` becomes
FALSE. With TEXT declared the conversion still runs and the stored values are canonical
(`2024-03-05T05:06:07` / `12:00:00`), which section 8 of the new test pins.

`date/-1` alone is canonical either way, but typing it apart from its two siblings is a
worse trap than typing all three the same. The resulting divergence from the
single-argument `date/1`, `time/1`, `datetime/1` conversion functions is documented at the
site, in `docs/types.md` (Temporal Types), and filed as
`backlog/debt-variadic-datetime-functions-not-temporally-typed`.

**A reviewer who disagrees with either call should say so** — both are judgment calls with
a documented rationale, not facts.

## The one behavior change

`abs(strftime('%Y', d))` returned 2024; it now raises
`Invalid argument types for function abs` at plan time.

Why: the numeric builtins gate their argument on "numeric **or** unclassifiable"
(`isNumericOrUnknownType`). While `strftime` rode the ANY default it was unclassifiable and
slipped through, and the implementation coerced the string at runtime. Now the planner
knows `strftime` returns TEXT, so the gate rejects it — the *same* rejection `abs(d)` gets
for a text column, which section 7 of `06.5.3` pins deliberately. `abs(integer(strftime(…)))`
is the way to write it, and that form is now pinned alongside.

The `06.5.3` expectation was updated with a comment explaining the change. **This is the
call most worth a second opinion**: the alternative readings are (a) leave `strftime`
undeclared to preserve the old answer — rejected, since `strftime` is the exact function
whose missing type caused the original bug, or (b) argue that `abs` should accept TEXT at
all, which relitigates a design decision this ticket did not touch.

Nothing else moved. `strftime('%Y', d) + 1` is still 2025 and
`sum/avg(strftime('%Y', d))` is still 4047 / 2023.5 — arithmetic and aggregation coerce,
they do not gate.

## New capability, worth confirming is desirable

Declaring INTEGER/REAL turns cross-type coercion back on, so comparisons against
numeric-looking strings now succeed where they were silently false:

- `epoch_s(d) = '1709510400'` → TRUE (was FALSE)
- `epoch_ms(d) = '1709510400000'` → TRUE (was FALSE)
- `json_array_length('[1,2,3]') = '3'` → TRUE (was FALSE)
- `pow(2,3) = '8'` → TRUE (was FALSE)

This is the ticket's stated intent (restore the coercion the honest-ANY change cost), but
it is a *result* change from HEAD in the "was wrong, now right" direction rather than the
"unchanged" direction, so it deserves an explicit nod.

## How to exercise it

```
yarn workspace @quereus/quereus run test        # 8080 passing, 13 pending
yarn workspace @quereus/quereus run test:plans  # 292 passing
yarn workspace @quereus/quereus run lint        # clean
yarn test                                       # all workspaces, clean
```

New suite: `test/logic/06.5.4-declared-return-type-builtins.sqllogic`, eight sections —
BOOLEAN predicates vs numbers, INTEGER returns and the coercion they re-enable, REAL
returns, TEXT returns (including the `abs` rejection), BLOB `randomblob`, JSON structural
comparison, the write path's convert-exactly-once, and the variadic date/time/datetime
spelling decision. It carries no `using memory`, so store mode exercises the persisted
path too.

The audit walk the ticket asked for was re-run against a live `Database`
(`schemaManager._getAllSchemas()` → `_getAllFunctions()`, filtering scalar schemas with
neither a real `returnType` nor `inferReturnType`). Only `json_extract` remains, as
intended. The throwaway script was deleted; re-create it if you want to re-verify.

## Known gaps — treat the tests as a floor

- **Nullability is declared but barely tested.** `nullable: false` on `json_valid`,
  `json_schema`, `IsISODate`, `IsISODateTime` and `random` is asserted by reading the
  implementations, not by a test that would fail if one of them started returning null.
  Nothing in the engine appears to act on scalar-function nullability today, which is why
  this was not chased further — worth confirming that reading.
- **`json_array` is declared nullable although it provably cannot return null.** Chosen so
  every JSON-returning builtin shares one constant. If a NOT NULL inference ever keys off
  this, split the constant.
- **The JSON mutators' non-object results are untested.** `json_set('{}', '$', 5)` can
  return a JSON *scalar* rather than an object. JSON_TYPE accepts scalars, so this should
  be fine, but no test covers it.
- **Store mode was not run separately.** `yarn test:store` was not executed (it is the
  slow path and the ticket did not call for it); the new suite does run under store mode
  as part of the normal logic sweep, but a dedicated store run has not happened.
- **Plan goldens did not move.** `test:plans` passes unchanged, which means no golden
  actually records the `compare` / `compare-fast` / `compare-typed` instruction note for
  any of these functions. So the *plan-shape* improvement this ticket exists to deliver is
  currently unverified by any test — the new suite proves the answers did not move, not
  that the specialized path is being taken. Adding one plan assertion (e.g. that
  `json_quote(j) = 'text'` emits `=(compare-fast)`) would close that hole and is the single
  highest-value addition a reviewer could make.
- **Window functions were not audited.** The audit walk filtered to scalar schemas, as the
  ticket specified. Whether any window function rides an undeclared return type is unknown.
