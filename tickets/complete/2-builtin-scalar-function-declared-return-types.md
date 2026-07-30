---
description: About thirty built-in SQL functions used to leave the query planner guessing what kind of value they return; each now declares its real type, so comparisons and stored values are based on facts.
files:
  - packages/quereus/src/func/builtins/return-types.ts   # shared return-type constants + scalarReturn() builder
  - packages/quereus/src/func/builtins/json.ts           # 13 functions
  - packages/quereus/src/func/builtins/datetime.ts       # 10 functions
  - packages/quereus/src/func/builtins/timespan.ts       # 11 functions
  - packages/quereus/src/func/builtins/scalar.ts         # random, randomblob, pow, power, sqrt, typeof
  - packages/quereus/src/func/builtins/string.ts         # like, glob
  - packages/quereus/src/func/builtins/conversion.ts     # review: literals → shared constants
  - packages/quereus/src/func/builtins/aggregate.ts      # review: literals → shared constants
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # review: literals → shared constants
  - packages/quereus/src/func/builtins/mutation.ts       # review: literal → shared constant
  - packages/quereus/test/logic/06.5.4-declared-return-type-builtins.sqllogic
  - packages/quereus/test/logic/06.5.3-undeclared-return-type-comparison.sqllogic
  - docs/types.md
  - docs/functions.md
  - docs/sql-functions.md
difficulty: medium
---

# Complete: declared return types on the built-in scalar functions

## What shipped

Every built-in scalar function now declares a `returnType` (or an `inferReturnType`),
with one deliberate exception: `json_extract`, which is genuinely polymorphic and declares
ANY explicitly with a comment saying so. A known return type routes comparisons through the
specialized `compare-fast` / `compare-typed` paths in `runtime/emit/binary.ts`, lets
`insertCrossTypeCoercion` fire, and lets the write path recognise an already-correctly-typed
value.

`src/func/builtins/return-types.ts` holds the shared shape constants (`TEXT_RETURN`,
`INTEGER_RETURN`, `REAL_RETURN`, `BOOLEAN_RETURN`, `BLOB_RETURN`, `JSON_RETURN`,
`ANY_RETURN`, `_NOT_NULL` variants) plus a `scalarReturn(type, nullable)` builder.

Declared in the implement pass: `json_valid`/`json_schema` BOOLEAN not-null;
`json_type`/`json_quote` TEXT; `json_array_length` INTEGER; the JSON constructors,
mutators and the two JSON aggregates JSON; the variadic `date`/`time`/`datetime` and
`strftime` TEXT; `epoch_s`/`epoch_ms` INTEGER; `julianday`/`epoch_s_frac` REAL;
`IsISODate`/`IsISODateTime` BOOLEAN not-null; the six timespan component extractors INTEGER
and `timespan_seconds` plus the four `timespan_total_*` REAL; `random` INTEGER not-null;
`randomblob` BLOB; `pow`/`power` REAL; `like`/`glob` BOOLEAN nullable.

Two implement-pass judgement calls, both re-checked in review and both upheld:

- **`timespan_seconds` is REAL, not INTEGER.** It folds the sub-second components in, so
  `timespan_seconds('PT1.5S')` is 1.5. INTEGER would be a lie the write path acts on.
- **The variadic `date`/`time`/`datetime` are TEXT, not DATE/TIME/DATETIME.** They emit
  SQLite's display spelling, which is not the canonical stored spelling of those types
  (`datetime()` uses a space separator; `time(…, 'subsec')` always emits three fractional
  digits). Declaring the temporal type would make the write path skip conversion and store
  the display spelling into a temporal column, where comparison is binary text. Documented
  at the site, in `docs/types.md`, and tracked by
  `backlog/debt-variadic-datetime-functions-not-temporally-typed`. Exact-arity lookup wins
  in `Schema.getFunction`, so the single-argument `date/1`, `time/1`, `datetime/1`
  conversion functions still resolve to their DATE/TIME/DATETIME-declaring selves —
  verified in the code, not assumed.

## Behavior changes

**`abs(strftime('%Y', d))` now raises `Invalid argument types for function abs`** (was
2024). The numeric builtins gate their argument on "numeric or unclassifiable"; while
`strftime` rode the ANY default it was unclassifiable and slipped through. Now the planner
knows it returns TEXT, so the gate rejects it — the same rejection `abs(text_col)` already
got. `abs(integer(strftime(…)))` is the way to write it, and both forms are pinned in
`06.5.3`. Upheld in review: leaving `strftime` undeclared to preserve the old answer would
undeclare the exact function whose missing type caused the original bug, and widening `abs`
to accept TEXT is a separate design decision. Arithmetic and aggregation are unaffected
(`strftime(…) + 1` is still 2025) because they coerce rather than gate.

**Cross-type coercion is restored** where a real type is now known — `epoch_s(d) =
'1709510400'`, `json_array_length('[1,2,3]') = '3'`, `pow(2,3) = '8'` are TRUE where they
were silently FALSE. That is the ticket's stated intent.

## Review findings

### Fixed in this pass

- **`sqrt` was left declaring its argument's type — a real defect, not a style nit.**
  Its own comment said "declaring REAL … belongs to the declared-return-type work, not
  here", and this ticket *is* that work, so it was simply missed. `Math.sqrt` is not
  closed over the integers, so `sqrt(int_col)` claimed INTEGER for a value like
  1.4142135623730951. `buildRowCoercion` skips conversion on a declared-type match, so
  `insert into t(int_col) select sqrt(2)` stored the fraction in an INTEGER column —
  reproduced live before the fix, and it now stores 1 like `pow(2, 0.5)` does. The old
  declaration also claimed `nullable: false` while `sqrt(-1)` and `sqrt(null)` both return
  NULL. Now `REAL_RETURN`. Pinned by new assertions in sections 3 and 7 of `06.5.4`.
  `docs/functions.md` already documented sqrt as REAL, so the doc was right and the code
  was wrong.
- **Repeated four-field `returnType` literals.** `return-types.ts` and `docs/types.md`
  both say "use these rather than re-spelling the four-field literal", but ~35 sites in
  the same directory still spelled it out. Converted `conversion.ts` (9),
  `aggregate.ts` (10), `builtin-window-functions.ts` (14), `scalar.ts` (`typeof`) and
  `mutation.ts` (1); added the `TEXT_RETURN_NOT_NULL` / `REAL_RETURN_NOT_NULL` constants
  the sweep needed. No behavior change; ~100 lines of noise removed. `explain.ts` was left
  alone — its literals are relation column types, a different shape and concern.
- **Documentation that contradicted the new declarations.** `docs/functions.md` and
  `docs/sql-functions.md` documented `json_valid`, `json_schema`, `IsISODate`,
  `IsISODateTime`, `like` and `glob` as returning INTEGER "1 or 0"; they return JS
  booleans and now declare BOOLEAN. Corrected, including the worked examples. Two adjacent
  errors fixed while in those files: `sql-functions.md` had `like`/`glob` argument order
  backwards (the pattern is the *first* argument), and listed `json_type`'s result values
  as the JavaScript names rather than the ones `getJsonType` actually returns.

### Test gaps closed

The implement handoff was explicit that its tests were a floor. Added to `06.5.4`:

- **Plan-shape assertions — the gap the handoff called the highest-value one.** Nothing
  proved the specialized comparison path was actually taken; the suite only proved answers
  had not moved. New section 9 reads instruction notes out of `scheduler_program(sql)` and
  pins `json_quote(j) = 'text'` and `epoch_s(d) = 1` to `=(compare-fast)`,
  `json_object('a','x') = j` to `=(compare-typed)`, and `json_extract(j,'$.a') = 'x'` — the
  deliberate ANY holdout — to the generic `=(compare)` as a control. Every one of the first
  three read `=(compare)` before the declarations landed.
- **The JSON mutators' scalar results**, flagged untested. `json_set('{}', '$', 5)` returns
  a JSON scalar; `typeof` reports its storage class (`integer`), which is the same answer
  `json('5')` gives. Benign, now pinned.
- **Nullability**, flagged as declared-but-unasserted. A nullable BOOLEAN that resolves to
  NULL (`like('a%', null)`) still trips a column's NOT NULL check rather than slipping
  past it. Confirms the handoff's reading that nothing elides constraint work off a
  scalar function's declared nullability.
- **The REAL-into-INTEGER write path** (section 7), the mirror of the JSON convert-once
  case and the regression guard for the `sqrt` fix.

### Checked, nothing found

- **The audit the handoff deferred: window functions.** All fourteen registrations in
  `builtin-window-functions.ts` already declare an explicit `returnType`; the four
  pass-through ones (`LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, and the MIN/MAX
  registration) additionally carry `inferReturnType`. Nothing rides an undeclared type.
- **The remaining multi-line scalar declarations** the handoff's grep-based audit could
  have missed — `abs`, `coalesce`, `nullif`, `typeof`, `iif`, `floor`, `clamp`,
  `greatest`, `least`, `choose`, `length`, `instr`, `mutation_ordinal` — every one carries
  a `returnType` or `inferReturnType`. `sqrt` was the only one whose declaration was
  wrong, and it is fixed above.
- **Not-null claims verified against implementations**, not just declarations:
  `json_valid`, `json_schema`, `IsISODate`, `IsISODateTime` and `random` each return a
  value on every path.
- **INTEGER claims verified against values:** `toEpochSeconds` floors, `toEpochMilliseconds`
  is integral, the timespan component extractors read whole `Temporal.Duration` fields,
  `json_array_length` returns a count. None can produce a fraction.
- **Shared-constant aliasing.** Nothing in `src/` assigns to a `ScalarType` field, so
  sharing one object across many function schemas is safe. Recorded as a tripwire rather
  than left implicit — see below.

### Tripwires (recorded in code, not filed as tickets)

- **Shared return-type constants are read-only by convention only.** One object is now
  named by ~50 function schemas, so an in-place edit would corrupt all of them. `NOTE:` in
  the `return-types.ts` module comment says to build a fresh object with `scalarReturn`
  instead.
- **`json_array` declares nullable although it provably cannot return null**, so that every
  JSON-returning builtin shares one constant. `NOTE:` at the site says to split the constant
  if a NOT NULL inference ever keys off scalar-function nullability.

### Not done, deliberately

- **`yarn test:store` was not run.** It is the slow path and this change is store-agnostic;
  the new suite carries no `using memory`, so it exercises the persisted path whenever a
  store run does happen. Same call the implement pass made.
- **The `abs`-rejects-TEXT / arithmetic-coerces-TEXT asymmetry was not chased.** It is
  pre-existing behaviour that this ticket only made more visible, and both halves are
  pinned by tests with comments explaining why. Widening the numeric gate is a design
  decision for its own ticket, and the adjacent text-coercion tickets
  (`bug-text-arithmetic-loses-precision`, `bug-text-minmax-numeric-coercion`,
  `bug-numeric-text-coercion-skips-in-and-case`) already own that territory.

## Validation

```
yarn workspace @quereus/quereus run lint          # clean (eslint + test-file tsc pass)
yarn workspace @quereus/quereus run typecheck     # clean
yarn workspace @quereus/quereus run test          # 8080 passing, 13 pending
yarn workspace @quereus/quereus run test:plans    # 292 passing
yarn lint                                          # all workspaces, clean
yarn test                                          # all workspaces, clean
```

`yarn docs:check` fails on three documents this ticket never touched
(`docs/invariants.md`, `docs/schema.md`, `docs/sql-ddl.md`). Reproduced identically in a
clean worktree at `bfa86e42`, i.e. before the review pass; reported in
`tickets/.pre-existing-error.md`.
