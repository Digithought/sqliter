---
description: Date and time arithmetic now has one shared rulebook — a single table saying which operand combinations are legal, what each produces, and what type the answer is — so the query planner and the evaluator can no longer disagree about it.
files:
  - packages/quereus/src/types/temporal-ops.ts                 # NEW — the table, the two classifiers, the shared wrapper
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts   # tryTemporalArithmetic rewritten as sniff → lookup → run
  - packages/quereus/src/planner/nodes/scalar.ts               # BinaryOpNode.generateType arithmetic arm (~line 205)
  - packages/quereus/test/types/temporal-ops.spec.ts           # NEW — unit spec over the table itself
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts
  - packages/quereus/test/runtime/temporal-arithmetic.spec.ts  # pre-existing behavior lock, unchanged, still green
  - docs/types.md                                              # § Temporal Types + § Implementation Files
difficulty: medium
---

# One table for temporal arithmetic — implemented

## What changed

**New `packages/quereus/src/types/temporal-ops.ts`.** The set of supported temporal
arithmetic operations is now data, not control flow. It exports:

- `TemporalOperandKind` — `'date' | 'time' | 'datetime' | 'timespan' | 'number'`.
- `temporalKindOfType(logical)` — plan-time classifier. Identity against the registered
  singletons; `undefined` for TEXT / ANY / BLOB / NULL / JSON / TIMESTAMP and for any
  plugin-registered type (including one that shadows a built-in name).
- `temporalKindOfValue(v)` — runtime classifier; the four shape probes lifted out of
  `tryTemporalArithmetic` verbatim, plus `typeof v === 'number'`. `bigint` is
  deliberately *not* `'number'`.
- `isTemporalKind(k)` — true for the four temporal kinds, false for `'number'`/`undefined`.
- `temporalOpCase(operator, left, right)` — lookup into a `ReadonlyMap` keyed
  `` `${operator}|${left}|${right}` ``, holding all 20 supported combinations. Each entry
  is `{ resultType, apply }`.
- `runTemporalCase(entry, v1, v2)` — the shared envelope: null propagation, `apply`,
  `catch → null` for a malformed value while an `UNSUPPORTED` error propagates.
- `unsupportedTemporalOp()` — the one home for the
  `QuereusError(UNSUPPORTED, 'Unsupported temporal operation')` throw.
- `temporalOpCaseKeys()` — test-only view of the table's keys.
- `hasCalendarUnits` / `scaleDuration` / `divideDuration` — moved here from
  `runtime/emit/temporal-arithmetic.ts`, bodies byte-identical.

**`tryTemporalArithmetic` is now sniff-kinds → lookup → `runTemporalCase`** (about 15
lines, down from a ~200-line cascade). The four `isXxxValue` helpers are gone;
`tryTemporalCompare` now asks `temporalKindOfValue(v) === 'timespan'` (same predicate).

**`BinaryOpNode.generateType`** consults the table in its `+ - * / %` arm *before* the
numeric-promotion rule. Two numeric operands never produce a case, so the reordering is
inert for ordinary arithmetic. `nullable`, `isReadOnly`, and the collation merge are
untouched.

## The two intended behavior changes

Both follow from the announced result type finally matching the value produced.

1. `select (2 * timespan('PT1H')) + 3` — **was `null`, now raises
   `Unsupported temporal operation`.** The inner expression is announced TIMESPAN rather
   than INTEGER, so the outer `+` takes the temporal path and finds no TIMESPAN+INTEGER
   case. The old `null` was an artifact: the numeric fast path trusted the (wrong)
   INTEGER announcement, computed `'PT7200S' + 3` = `'PT7200S3'`, failed the finite check.
   Locked in `107-…sqllogic` as an `-- error:` expectation.
2. `select (timespan('PT2H') / timespan('PT1H')) + 1` — **same answer (`3`), different
   route.** The ratio is announced REAL and takes the numeric fast path instead of
   falling through the temporal probes.

No existing test asserted the old announcements — the full suite passed before the test
additions too.

## Verification done

- `yarn lint` (packages/quereus: eslint + `tsc -p tsconfig.test.json --noEmit`) — clean.
- `yarn build`, `yarn typecheck` at repo root — clean.
- `yarn test` at repo root (all workspaces) — clean.
- `yarn test` in `packages/quereus` — **9185 passing, 25 pending** (was 9155 before the
  30 tests this ticket adds).
- Manually probed `query_plan()` (`BinaryOp … "resultType":"TIMESPAN"` for `a - b`),
  `Statement.getColumnType()` (TIMESPAN for `a - b`, REAL for the timespan ratio), and a
  view over `a - b` (`'P5D'`). `create table … as select` is **not implemented at all**
  in this engine (`CREATE TABLE AS SELECT is not supported.` from the parser), so that
  metadata site named in the plan ticket does not exist to check.

## Use cases to exercise when reviewing

Everything below is covered by a test; re-running them by hand is the fastest way to
sanity-check the table.

**All 20 supported combinations** already had value locks in
`107-temporal-arithmetic-mutation-kills.sqllogic` before this ticket — every one was
verified present, none were missing. They all still return the same values.

**Chained arithmetic** (the reason the result type had to be fixed; new tests):

| expression | expected |
|---|---|
| `(date('2024-01-20') - date('2024-01-15')) + timespan('P1D')` | `'P6D'` |
| `(date('2024-01-20') + timespan('P1D')) - date('2024-01-15')` | `'P6D'` |
| `(timespan('PT2H') / timespan('PT1H')) + 1` | `3` |
| `(timespan('PT2H') - timespan('PT30M')) + timespan('PT30M')` | `'PT2H'` |
| `(2 * timespan('PT1H')) + 3` | error `Unsupported temporal operation` |

**Preserved errors** (new tests): `date + date`, `date * 2`, `time - date`,
`timespan % timespan`, `date - 5`, `timespan('PT1H') * 9007199254740993`.

**Preserved runtime-sniffing fallback** (new tests): `'not-a-date' - date(…)` errors;
`timespan('PT1H') + 'PT1H'` → `'PT2H'` (the TEXT operand has no plan-time kind, so the
pair falls back to value shapes).

**TIMESTAMP stays out of the table** (new test): `t + 1` and `t - t` on a TIMESTAMP
column are plain integer arithmetic. The type-level tripwire is in
`test/types/temporal-ops.spec.ts` — `temporalKindOfType(TIMESTAMP_TYPE) === undefined`.

**Emit-note proof the planner got the right type** (`scalar-op-spec.spec.ts`):
`select (d2 - d1) = (d4 - d3) from d` emits `=(compare-typed)` — the semantic
(elapsed-time) TIMESPAN comparator, reachable only if both sides are announced TIMESPAN.

**Table-shape spec** (`test/types/temporal-ops.spec.ts`): every key parses into
`(operator, known kind, known kind)`; every `resultType` is one of DATE / TIME /
DATETIME / TIMESPAN / REAL; every case has at least one temporal operand; `%` has no case
on any of the 25 kind pairs; a named list of documented-unsupported combinations really
is absent. Plus per-classifier tables and `runTemporalCase`'s null / malformed /
propagate-UNSUPPORTED envelope.

## Preserved-as-found behavior, flagged not fixed

Three oddities were carried forward deliberately, each with a `NOTE:` at the site:

- **DATETIME − DATETIME drops the time of day** — `datetime('2024-01-20T10:00:00') -
  datetime('2024-01-15T08:00:00')` is `'P5D'`, not `'P5DT2H'`, because both sides collapse
  to a `PlainDate` first. `NOTE:` on `dateDifference` in `temporal-ops.ts`; locked by a
  new sqllogic case. The plan ticket says the fix is filed separately as
  `bug-datetime-difference-drops-time-of-day` — **I did not find that ticket anywhere in
  `tickets/`, so it appears not to have been filed yet.** Worth confirming during review.
- **`bigint` on the number side is rejected** — `timespan('PT1H') * 9007199254740993`
  raises `Unsupported temporal operation`, because the old cascade's match condition was
  literally `typeof v2 === 'number'`. `NOTE:` on `scaleTimespan`. Widening it is a
  separate call.
- **`divideDuration` silently drops a sub-month remainder** — the `if (monthRemainder !==
  0) { /* best-effort */ }` block is a no-op with an explanatory comment. Moved verbatim
  from the old file; not touched here.

## Known gaps / where I'd look hardest

- **`nullable` is still optimistic and untouched, by instruction.**
  `timespan('PT1H') / 0` and `timespan('P1Y') / timespan('P1M')` both return null from
  non-nullable operands, so the announced `nullable: false` is wrong for them — exactly as
  `1 / 0` already is for plain numeric division. Out of scope per the plan ticket; if a
  reviewer thinks it should be in scope, it is a real (pre-existing) inaccuracy.
- **`emitTemporalArithmetic` is dead code and I left it there.** Nothing calls it;
  `tickets/implement/2-runtime-temporal-arithmetic-emit-specialization.md` names deleting
  it as part of its own work, so removing it here would collide.
- **Constant folding means a statically-doomed constant expression can throw at plan
  time.** `select date('2024-01-15') + date('2024-01-16')` errors during folding rather
  than at row evaluation. This is pre-existing (folding evaluates through the runtime) and
  unchanged by this ticket, but ticket 2's "why arm 2 throws at runtime, not at emit"
  reasoning brushes against it — worth keeping in mind there.
- **Commuted cases evaluate their two operands in the opposite order from the old
  cascade.** `commuted(entry)` calls `entry.apply(v2, v1)`, so for `TIMESPAN + DATE` the
  date is parsed before the duration where the cascade parsed the duration first. Only
  observable if *both* values are malformed, and both orders are caught into `null`, so I
  believe it is unobservable — but it is the one place I knowingly did not preserve
  statement order, so it deserves a second pair of eyes.
- **Test floor, not ceiling.** The new sqllogic cases are value locks on the paths the
  plan ticket named. I did not fuzz operand pairs, and I did not test temporal arithmetic
  inside every plan shape (only WHERE-clause dispatch, which the file already covered).
- One full-suite run timed out in
  `test/incremental/aggregate-algebra.spec.ts` ("negative twin — the harness catches a
  broken declaration", 10s Mocha timeout) while the machine was loaded — the same run
  took 8m wall clock versus 2m normally. It passed on re-run and on every subsequent run.
  Unrelated to this diff (property-based aggregate algebra, no temporal code), so no
  `.pre-existing-error.md` was written; flagging it only because a loaded CI box could
  reproduce it.
