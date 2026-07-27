---
description: A CAST that cannot convert its value used to quietly keep the original value, so the word "junk" could end up stored in a date column; it now produces NULL instead.
files:
  - packages/quereus/src/runtime/emit/cast.ts                      # castFallback rule change
  - packages/quereus/src/planner/nodes/scalar.ts                   # CastNode.generateType (~line 704)
  - packages/quereus/test/logic/99.1-cast-syntax-extras.sqllogic   # new coverage
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic  # comment reworded only
  - docs/types.md                                                  # ~line 211 and ~line 412
difficulty: medium
---

# A failed CAST now yields NULL instead of the unconverted operand

## What changed

Three edits, all small.

**`runtime/emit/cast.ts`** — `castFallback` now takes the whole `LogicalType`
instead of just its name, and its `default:` arm returns
`type.validate?.(value) === true ? value : null` instead of `value`. The
INTEGER / REAL / NUMERIC / TEXT / BLOB arms are untouched; each was checked
against its own type's `validate` and each already passes (`0`, `0.0`,
`String(v)`, UTF-8 bytes).

Why `validate` and not "always NULL": `parse` reads its input as *source text*,
so it rejects values that are already valid members of the target type. A bare
JS string is a legitimate JSON string scalar, but `JSON_TYPE.parse('hello')`
throws on it as invalid JSON syntax. Asking `validate` keeps that case and
still NULLs a blob cast to JSON.

**`planner/nodes/scalar.ts`, `CastNode.generateType`** — two changes:
- `typeRegistry.getTypeOrDefault(targetType)` → `typeRegistry.inferType(targetType)`,
  so the planner resolves the target the same way the emitter does. They
  previously disagreed for any single-word name that misses the registry but
  matches an affinity rule (`cast(5 as nvarchar)` produced TEXT at runtime while
  the plan advertised BLOB).
- `nullable: operandType.nullable` → `operandType.nullable || logicalType !== operandType.logicalType`.
  A converting cast can produce NULL from a non-null operand — that was already
  true before this ticket (`cast('' as integer)` is null) and this change adds
  more such paths.

**`docs/types.md`** — both sites from the ticket updated: the JSON comparison
paragraph (~line 211) now states the two ways a non-JSON text operand still
compares unequal, and the "known cases" list (~line 412) now describes CAST as
the settled rule the other cases must meet rather than as an open defect.

## Validation performed

- `yarn test` from `packages/quereus`: **7338 passing / 13 pending / 0 failing**.
  Note the passing count is unchanged from before the ticket because the
  sqllogic harness registers **one mocha `it()` per `.sqllogic` file**, not per
  assertion — the ~20 new assertions live inside the existing
  `99.1-cast-syntax-extras.sqllogic` test. Don't read the flat count as "the new
  tests didn't run"; verify by editing an expectation if you want to see it fail.
- `yarn lint` from repo root: clean (only the intentional
  `No lint configured` no-ops from other packages).
- `yarn build` from repo root: clean.

## Behavior to exercise

Read path (`99.1-cast-syntax-extras.sqllogic`):

| expression | result |
|---|---|
| `cast('junk' as date)` / `time` / `datetime` / `timespan` | `null` |
| `cast('junk' as boolean)` | `null` |
| `cast(x'0102' as json)` | `null` |
| `cast('abc' as json)` | `'abc'` (JSON string scalar — unchanged) |
| `cast('junk' as integer)` / `as real` | `0` (SQLite fallback — unchanged) |
| `cast('2024-03-05' as date)`, `cast('true' as boolean)` | succeed as before |

Write path, also covered in that file:
- nullable `date` column + `insert … cast('junk' as date)` → stores NULL,
  `typeof` is `null`
- NOT NULL `date` column + same insert → `NOT NULL constraint failed`. This is
  the intended, visible consequence: columns default NOT NULL in Quereus, so
  what used to silently store `'junk'` is now an error. The message differs from
  the raw-literal path's `Type conversion failed for column 'dt'` because the two
  statements fail for genuinely different reasons (a NULL was produced vs. a
  value could not be converted).
- A successful cast still round-trips through storage and still orders as a date.

`06.9.2-json-structural-equality.sqllogic` is the regression to watch — it
asserts `json_col = 'not json'` is empty rather than an error. It still passes;
only a stale explanatory comment in it was reworded.

## Known gaps / things a reviewer should push on

- **No test for the `inferType` vs `getTypeOrDefault` reconciliation.** The
  parser accepts only a single identifier token after `AS` in a CAST
  (`parser.ts` ~line 1855, so `cast(x as varchar(10))` is rejected outright),
  which makes the divergence hard to reach — `cast(5 as nvarchar)` is the shape
  that hits it. I did not add a case for it. Worth adding one, or convincing
  yourself the divergence is genuinely unreachable and saying so.
- **No test for the nullability widening.** Nothing in the engine prunes NOT NULL
  checks from static nullability today (the runtime check in
  `runtime/emit/constraint-check.ts` always runs), so the change is a
  truthfulness fix with no observable behavior to assert against at the SQL
  level. If there is a plan-shape or `getType()`-level assertion harness I
  missed, that gap should be filled.
- **Store-mode not run.** Only `yarn test` (memory vtab). The write-path
  assertions above touch storage; `yarn test:store` would exercise the LevelDB
  path for the same inserts. I did not run it — it is slower and the ticket did
  not call for it, but it is the obvious next validation if the reviewer wants
  more confidence in the NULL-reaching-storage claim.
- **`castFallback`'s arms were checked by reading, not by asserting.** I read
  each of INTEGER / REAL / NUMERIC / TEXT / BLOB against its own `validate` and
  they all pass, but there is no test that mechanically enforces "every
  `castFallback` arm returns something its own type validates". A reviewer who
  wants that invariant guarded should ask for a unit test over the arms.

## Tripwires recorded

- `runtime/emit/cast.ts` — `NOTE:` above `castFallback`: `validate` is optional
  on `LogicalType`, so a custom registered type that omits it will NULL on every
  parse failure. All built-ins define one; the fix if a plugin type ever needs
  the operand preserved is to give that type a `validate`, not to loosen the rule
  to "no validate ⇒ keep".

## Out of scope (unchanged)

`union-branch-value-not-converted-on-write` is the same root shape — a node
advertising a logical type it does not produce — and remains a separate ticket.
`docs/types.md` still lists it as an open case.
