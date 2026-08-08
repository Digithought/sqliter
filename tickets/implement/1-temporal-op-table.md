---
description: Date and time arithmetic decides what each operation means by inspecting the values as they flow past, and the type it announces for the answer is often wrong — a date minus a date is announced as a date even though it produces a length of time. Put the rules in one table both the planner and the evaluator read.
files:
  - packages/quereus/src/types/temporal-ops.ts                 # NEW — the one operation table (kind classifier, result type, apply)
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts   # tryTemporalArithmetic — replace the 15-branch cascade with a table lookup
  - packages/quereus/src/planner/nodes/scalar.ts               # BinaryOpNode.generateType — arithmetic case, ~line 40-60
  - packages/quereus/src/types/temporal-types.ts               # DATE/TIME/DATETIME/TIMESPAN/TIMESTAMP singletons — identity source
  - packages/quereus/src/types/builtin-types.ts                # REAL_TYPE / INTEGER_TYPE / isNumeric flags
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # existing behavior lock
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts       # emit-note assertions
  - docs/types.md                                              # § type system — document the arithmetic result-type table
difficulty: medium
---

# One table for temporal arithmetic

Today two different pieces of code decide, separately, what `date_col - date_col` means:

- **The evaluator** (`tryTemporalArithmetic`, `runtime/emit/temporal-arithmetic.ts:144+`)
  sniffs both runtime values with four regex/prefix probes each, then walks a ~15-branch
  `if (operator === X && isV1Date && isV2Timespan)` cascade to find the applicable case.
- **The planner** (`BinaryOpNode.generateType`, `planner/nodes/scalar.ts:30+`) does not
  consult those rules at all. For any non-numeric operand pair it announces
  *the left operand's type* as the result type.

The planner is therefore frequently wrong, and verified so:

| expression | announced result type | value actually produced |
|---|---|---|
| `date('2024-01-20') - date('2024-01-15')` | DATE | `'P5D'` — a TIMESPAN |
| `2 * timespan('PT1H')` | INTEGER | `'PT7200S'` — a TIMESPAN |
| `timespan('PT2H') / timespan('PT1H')` | TIMESPAN | `2` — a number |

That inaccuracy is already producing a wrong answer today, without any new work:

```sql
select (2 * timespan('PT1H')) + 3;   -- returns null
```

The inner expression is announced INTEGER, so the outer `+` takes the numeric-fast path in
`buildNumericOpSpec` (`runtime/emit/binary.ts:182`), which trusts the declared type and skips
coercion. It hands the string `'PT7200S'` to `v1 + v2` as if it were a number, gets the
string `'PT7200S3'`, fails the finite check, and returns null.

It also blocks the follow-on work (`runtime-temporal-arithmetic-emit-specialization`), which
wants to pick the temporal case from declared types at emit time instead of re-sniffing every
row. That is only sound if a declared temporal type actually predicts the runtime value, which
today it does not:

```sql
select (date('2024-01-20') - date('2024-01-15')) + timespan('P1D');   -- 'P6D' today
```

The left operand is announced DATE but holds `'P5D'`. Emit-time selection would pick
DATE + TIMESPAN, call `PlainDate.from('P5D')`, and return null.

## Root cause

The set of supported `(operator, left-kind, right-kind)` combinations exists only as
control flow inside one function, so nothing else can read it. Extract it into data.

## Design

### New module: `src/types/temporal-ops.ts`

Lives in `types/` (not `runtime/emit/`) because **both** the planner and the runtime import
it; `types/` already depends on `temporal-polyfill`, so nothing new is pulled in.

An **operand kind** is the coarse shape temporal arithmetic dispatches on. Five values:

```ts
export type TemporalOperandKind = 'date' | 'time' | 'datetime' | 'timespan' | 'number';
```

Two classifiers, one per direction — they must agree on canonical values:

```ts
/** Plan-time kind from a declared logical type. Identity against the registered
 *  singletons, matching the precedent in runtime/emit/unary.ts:111. Returns
 *  undefined for TEXT / ANY / BLOB / TIMESTAMP and for any plugin-registered type,
 *  so callers fall back to runtime sniffing. */
export function temporalKindOfType(logical: LogicalType): TemporalOperandKind | undefined;

/** Runtime kind from an actual value — the shape probes lifted out of
 *  tryTemporalArithmetic, unchanged. */
export function temporalKindOfValue(v: SqlValue): TemporalOperandKind | undefined;
```

`temporalKindOfType` rules, in order:

- `logical === DATE_TYPE` → `'date'`; `TIME_TYPE` → `'time'`; `DATETIME_TYPE` → `'datetime'`;
  `TIMESPAN_TYPE` → `'timespan'`
- `logical.isNumeric && !logical.isTemporal` → `'number'`
- otherwise `undefined`

TIMESTAMP falls to `undefined` deliberately: it is `isTemporal` but not `isNumeric`, it is an
integer instant rather than a string temporal, and it appears in no case below. `ts_col + 1`
keeps taking today's runtime path unchanged.

`temporalKindOfValue` rules (the four existing probes plus number), unchanged semantics:

- `/^\d{4}-\d{2}-\d{2}$/` → `'date'`
- `v.includes('T') && /^\d{4}-\d{2}-\d{2}T/` → `'datetime'`
- `/^\d{2}:\d{2}:\d{2}/` → `'time'`
- `v.startsWith('P') || v.startsWith('-P')` → `'timespan'`
- `typeof v === 'number'` → `'number'` (note: **not** `bigint` — see edge cases)
- otherwise `undefined`

The four string shapes are mutually exclusive on canonical values, so probe order is not
observable; keep them in a single `typeof v === 'string'` block.

### The table

```ts
export interface TemporalOpCase {
	/** Logical type of the result — what BinaryOpNode.generateType announces. */
	readonly resultType: LogicalType;
	/** Perform the operation on two non-null values. May throw; callers wrap. */
	readonly apply: (v1: SqlValue, v2: SqlValue) => SqlValue;
}

/** Look up the case for one (operator, left kind, right kind) triple.
 *  undefined = this combination is not supported. */
export function temporalOpCase(
	operator: string,
	left: TemporalOperandKind,
	right: TemporalOperandKind,
): TemporalOpCase | undefined;
```

Back it with a `ReadonlyMap<string, TemporalOpCase>` keyed `` `${operator}|${left}|${right}` ``.
The 20 supported combinations, each lifted verbatim from the current cascade:

| op | left | right | result | body |
|---|---|---|---|---|
| `-` | date | date | TIMESPAN | `PlainDate.since` |
| `-` | date | datetime | TIMESPAN | right → `toPlainDate()`, then `since` |
| `-` | datetime | date | TIMESPAN | left → `toPlainDate()`, then `since` |
| `-` | datetime | datetime | TIMESPAN | both → `toPlainDate()`, then `since` |
| `-` | time | time | TIMESPAN | `PlainTime.since` |
| `-` | date | timespan | DATE | `PlainDate.subtract` |
| `-` | datetime | timespan | DATETIME | `PlainDateTime.subtract` |
| `-` | time | timespan | TIME | `PlainTime.subtract` |
| `-` | timespan | timespan | TIMESPAN | `Duration.subtract` |
| `+` | date | timespan | DATE | `PlainDate.add` |
| `+` | timespan | date | DATE | commuted |
| `+` | datetime | timespan | DATETIME | `PlainDateTime.add` |
| `+` | timespan | datetime | DATETIME | commuted |
| `+` | time | timespan | TIME | `PlainTime.add` |
| `+` | timespan | time | TIME | commuted |
| `+` | timespan | timespan | TIMESPAN | `Duration.add` |
| `*` | timespan | number | TIMESPAN | scale (calendar-aware) |
| `*` | number | timespan | TIMESPAN | commuted |
| `/` | timespan | number | TIMESPAN | divide; divisor `0` → null |
| `/` | timespan | timespan | REAL | ratio of total seconds; calendar units or zero divisor → null |

`%` has no cases, and neither does any combination absent from the table (DATE+DATE,
DATE\*NUMBER, TIME−DATE, DATE−NUMBER, …). Those keep throwing
`QuereusError(StatusCode.UNSUPPORTED, 'Unsupported temporal operation')` at runtime, byte
for byte — tests assert that message.

Export the throw as a shared helper so the message has one home:

```ts
export function unsupportedTemporalOp(): never;
```

The `number`-side `apply` bodies keep their `typeof v === 'number'` guard and call
`unsupportedTemporalOp()` when it fails. In the runtime-sniffed path the guard is
unreachable (the kind was derived from `typeof`); the follow-on emit-time path needs it,
since a declared INTEGER operand can hold a `bigint`.

Move `hasCalendarUnits`, `scaleDuration`, and `divideDuration` from
`runtime/emit/temporal-arithmetic.ts` into this module (they are pure duration helpers and
the `apply` bodies need them). `temporal-arithmetic.ts` re-imports them if it still needs
them elsewhere.

### The one wrapper both callers share

```ts
/** null-propagation, table lookup, and the null-on-malformed-value guarantee —
 *  the exact envelope tryTemporalArithmetic has today. */
export function runTemporalCase(entry: TemporalOpCase, v1: SqlValue, v2: SqlValue): SqlValue {
	if (v1 === null || v2 === null) return null;
	try {
		return entry.apply(v1, v2);
	} catch (e) {
		if (e instanceof QuereusError) throw e;   // UNSUPPORTED propagates
		return null;                              // malformed value → null
	}
}
```

The follow-on ticket's emit-time path calls this same function, so the specialized and the
sniffed path cannot diverge on null handling or on malformed-value behavior.

### `tryTemporalArithmetic` after the refactor

```ts
export function tryTemporalArithmetic(operator: string, v1: SqlValue, v2: SqlValue): SqlValue | undefined {
	if (v1 === null || v2 === null) return null;

	const lk = temporalKindOfValue(v1);
	const rk = temporalKindOfValue(v2);

	// Neither operand looks temporal — signal "not a temporal operation" so the
	// caller falls through to numeric arithmetic. ('number' is not temporal.)
	if (!isTemporalKind(lk) && !isTemporalKind(rk)) return undefined;

	const entry = lk && rk ? temporalOpCase(operator, lk, rk) : undefined;
	if (!entry) unsupportedTemporalOp();
	return runTemporalCase(entry, v1, v2);
}
```

`isTemporalKind(k)` = `k !== undefined && k !== 'number'`.

Behavior is identical to today's cascade for every input; this ticket's only intended
behavior changes come from the planner wiring below.

### `BinaryOpNode.generateType`

In the `'+' | '-' | '*' | '/' | '%'` arm, consult the table **before** the numeric-promotion
rule:

```ts
const lk = temporalKindOfType(leftType.logicalType);
const rk = temporalKindOfType(rightType.logicalType);
const temporalCase = lk && rk ? temporalOpCase(this.expression.operator, lk, rk) : undefined;
if (temporalCase) {
	logicalType = temporalCase.resultType;
	break;
}
// …existing numeric promotion, then left-operand fallback, unchanged
```

Two numeric operands never produce a temporal case, so the reordering is inert for
non-temporal arithmetic. `nullable`, `isReadOnly`, and the collation merge are untouched.

### Deliberate behavior changes

Both follow from the result type finally being right. Both need a locking test.

1. `select (2 * timespan('PT1H')) + 3` — **null today, `Unsupported temporal operation`
   after.** The inner result is now announced TIMESPAN, so the outer `+` takes the temporal
   path and finds no TIMESPAN+INTEGER case. An error is the honest answer; the null was an
   artifact of the numeric-fast path being handed a duration string.
2. `select (timespan('PT2H') / timespan('PT1H')) + 1` — same value (`3`) but by a different
   route: the ratio is now announced REAL and takes the numeric-fast path instead of
   falling through the temporal probes.

## Edge cases & interactions

- **Chained temporal arithmetic must keep working.** `(date_a - date_b) + timespan('P1D')`
  → `'P6D'`; `(date_a + ts) - date_b` → a TIMESPAN. These are the expressions the follow-on
  ticket depends on; they are the whole reason the result type has to be fixed first.
- **`bigint` on the numeric side.** `select timespan('PT1H') * 9007199254740993` throws
  `Unsupported temporal operation` today, because the probe is `typeof v === 'number'` and a
  value past 2^53 is a `bigint`. Preserve exactly — do not widen the guard in this ticket.
  Add a `NOTE:` at the `*`/`/` number cases recording that this is preserved-as-found, not
  designed, and that widening it is a separate call.
- **DATETIME − DATETIME drops the time of day.** `datetime('2024-01-20T10:00:00') -
  datetime('2024-01-15T08:00:00')` returns `'P5D'`, not `'P5DT2H'`, because the cascade
  converts both sides to `PlainDate` first. Preserve verbatim — the fix is filed separately
  as `bug-datetime-difference-drops-time-of-day`. Do not silently correct it here; a
  behavior change buried in a refactor is worse than the bug.
- **Mixed temporal-vs-TEXT stays on runtime sniffing.** `'not-a-date' - date('2024-01-15')`
  (error) and `timespan('PT1H') + 'PT1H'` (`'PT2H'`) both go through the TEXT operand, whose
  `temporalKindOfType` is undefined. `generateType` finds no case and keeps the left-operand
  fallback type; `tryTemporalArithmetic` still sniffs. Unchanged.
- **TIMESTAMP operands.** `temporalKindOfType(TIMESTAMP_TYPE)` is undefined, so
  `ts_col + 1` / `ts_col - ts_col` keep today's path and today's announced type. Add a test
  so a future edit does not quietly pull TIMESTAMP into the table.
- **Plugin-registered type shadowing a built-in name.** `registerType` overwrites by name;
  a plugin type called `DATE` would be a different object, so identity fails and the pair
  falls back to sniffing. Correct and conservative — no wrong answer, just no
  specialization.
- **NULL operands short-circuit before any kind check** in both `tryTemporalArithmetic` and
  `runTemporalCase`, so `date(...) + null`, `timespan(...) * null`, `null - date(...)` all
  stay null. Confirm what `NULL_TYPE.isNumeric` is: if it is set, `timespan * null` resolves
  to the (timespan, number) case, and only the null check keeps it returning null. Either
  way the answer is null — but state which in a comment so the next reader does not have to
  re-derive it.
- **Result-type change reaches metadata sites.** `create table … as select date_a - date_b`,
  view column types, `column_info`, and `Statement.getColumnType()` all read the announced
  type and will now report TIMESPAN/REAL where they reported DATE/INTEGER. Run the full
  suite; if a test asserts the old announcement, the test was asserting the bug — update it
  and say so in the handoff.
- **Comparison specialization shifts for temporal-difference operands.**
  `(d2 - d1) = (d4 - d3)` was TEXT-ish/generic and is now TIMESPAN = TIMESPAN, which
  `buildComparisonOpSpec` routes to the `sharedSemanticType` typed comparator
  (`=(compare-typed)`). Same answers, better path — assert the note so it stays.
- **`%` on temporal operands** has no case; `generateType` keeps the left-type fallback and
  the runtime still throws. No change.
- **`nullable` stays operand-derived.** `timespan('PT1H') / 0` returns null from
  non-nullable operands, so the announced `nullable` is still optimistic — exactly as
  `1 / 0` already is for plain numeric division. Out of scope; do not touch.

## TODO

- Create `src/types/temporal-ops.ts`: `TemporalOperandKind`, `temporalKindOfType`,
  `temporalKindOfValue`, `isTemporalKind`, `TemporalOpCase`, `temporalOpCase`,
  `runTemporalCase`, `unsupportedTemporalOp`.
- Move `hasCalendarUnits` / `scaleDuration` / `divideDuration` into it from
  `runtime/emit/temporal-arithmetic.ts`; keep their bodies byte-identical.
- Populate the 20-case table, lifting each body verbatim from the cascade it replaces.
  Keep the existing comments (calendar-unit ratio → null, month cascade caveat).
- Rewrite `tryTemporalArithmetic` as sniff-kinds → lookup → `runTemporalCase`. Delete the
  four `isXxxValue` helpers and the cascade.
- Wire `BinaryOpNode.generateType`'s arithmetic arm to `temporalOpCase(...).resultType`.
- Tests — extend `test/logic/107-temporal-arithmetic-mutation-kills.sqllogic`:
  - every one of the 20 cases still returns today's value (most already covered; fill gaps —
    `date - datetime`, `datetime - date`, `datetime - timespan`, `timespan + datetime`)
  - chained: `(date_a - date_b) + timespan('P1D')` → `'P6D'`
  - chained: `(date_a + timespan('P1D')) - date_b` → a TIMESPAN string
  - chained: `(timespan('PT2H') / timespan('PT1H')) + 1` → `3`
  - changed: `(2 * timespan('PT1H')) + 3` → error `Unsupported temporal operation`
  - preserved errors: `date + date`, `date * 2`, `time - date`, `timespan % timespan`,
    `date - 5`, `timespan * 9007199254740993`
  - preserved fallbacks: `'not-a-date' - date(...)` errors; `timespan(...) + 'PT1H'` → `'PT2H'`
  - TIMESTAMP: `ts_col + 1` unchanged
  - null propagation on every arity
- Tests — `test/runtime/scalar-op-spec.spec.ts`: assert `(d2 - d1) = (d4 - d3)` emits
  `=(compare-typed)`, proving the TIMESPAN result type reached the planner.
- Test — a small unit spec over the table itself: every key parses into
  `(operator, kind, kind)` with known kinds, every `resultType` is one of the five expected
  singletons, and `temporalOpCase` returns undefined for `%` on every kind pair.
- Docs — `docs/types.md`: add the result-type table to the type-system section and state
  that the planner and the evaluator read it from one place.
- Run `yarn lint` and `yarn test`; fix fallout from the two intended behavior changes and
  from any metadata assertion that encoded the old announced type.
