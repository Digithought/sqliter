import { Temporal } from 'temporal-polyfill';
import { StatusCode } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import type { SqlValue } from '../common/types.js';
import type { LogicalType } from './logical-type.js';
import { DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESPAN_TYPE } from './temporal-types.js';
import { REAL_TYPE } from './builtin-types.js';

/**
 * The single table of supported temporal arithmetic operations, keyed by
 * `(operator, left operand kind, right operand kind)`.
 *
 * Two ways in, and they must agree:
 *  - from *declared* logical types, via {@link temporalOpCaseForTypes} — the planner
 *    (`BinaryOpNode.generateType`) announces the case's `resultType` and the emitter
 *    (`buildNumericOpSpec`) bakes the same case's `apply` into the per-row body. One
 *    function for both, so the announced type and the executed case cannot diverge;
 *  - from the *values*, via `tryTemporalArithmetic` — the per-row path taken only when a
 *    declared type settles nothing (TEXT / ANY / NULL / TIMESTAMP / a plugin type).
 *
 * Before this table existed, the set of supported combinations lived only as control
 * flow inside `tryTemporalArithmetic`, so the planner could not consult it and
 * announced the left operand's type for every temporal pair — DATE for
 * `date - date`, INTEGER for `2 * timespan`. Callers of the declared type
 * (the numeric-fast arithmetic path, `create table … as select`, view column types,
 * `Statement.getColumnType`) were reading a type that did not predict the value.
 *
 * Lives in `types/` rather than `runtime/emit/` precisely because both sides import
 * it; `types/` already depends on temporal-polyfill, so nothing new is pulled in.
 */

/** The coarse operand shape temporal arithmetic dispatches on. */
export type TemporalOperandKind = 'date' | 'time' | 'datetime' | 'timespan' | 'number';

/** True for the four kinds that make an operation *temporal*; `'number'` alone does not. */
export function isTemporalKind(kind: TemporalOperandKind | undefined): boolean {
	return kind !== undefined && kind !== 'number';
}

/**
 * Plan-time operand kind from a declared logical type.
 *
 * Identity against the registered singletons (the precedent set by
 * `runtime/emit/unary.ts`'s TIMESPAN negation arm): a plugin-registered type that
 * shadows a built-in name is a different object, so it fails identity and the caller
 * falls back to runtime sniffing rather than mis-specializing.
 *
 * Returns undefined for TEXT / ANY / BLOB / NULL and for TIMESTAMP. TIMESTAMP is
 * deliberately excluded: it is `isTemporal` but not `isNumeric`, it is an integer
 * instant rather than a string temporal, and it appears in no case below — so
 * `ts_col + 1` keeps taking the runtime-sniffed path and today's announced type.
 */
export function temporalKindOfType(logical: LogicalType): TemporalOperandKind | undefined {
	if (logical === DATE_TYPE) return 'date';
	if (logical === TIME_TYPE) return 'time';
	if (logical === DATETIME_TYPE) return 'datetime';
	if (logical === TIMESPAN_TYPE) return 'timespan';
	// NULL_TYPE is not `isNumeric`, so a NULL-typed operand lands here as undefined
	// and no case is selected. Either way the answer is NULL — both
	// `tryTemporalArithmetic` and `runTemporalCase` short-circuit on a null value
	// before any kind is consulted.
	if (logical.isNumeric && !logical.isTemporal) return 'number';
	return undefined;
}

/**
 * Runtime operand kind from an actual value — the shape probes that used to sit at the
 * top of `tryTemporalArithmetic`, with unchanged semantics.
 *
 * The four string shapes are mutually exclusive on canonical values, so probe order is
 * not observable.
 *
 * `bigint` deliberately yields undefined rather than `'number'` — see the NOTE on the
 * `*` / `/` number cases below.
 */
export function temporalKindOfValue(v: SqlValue): TemporalOperandKind | undefined {
	if (typeof v === 'string') {
		// ISO 8601 date (YYYY-MM-DD)
		if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
		// ISO 8601 datetime (with T separator)
		if (v.includes('T') && /^\d{4}-\d{2}-\d{2}T/.test(v)) return 'datetime';
		// ISO 8601 time (HH:MM:SS)
		if (/^\d{2}:\d{2}:\d{2}/.test(v)) return 'time';
		// ISO 8601 duration (starts with P, or -P when negative)
		if (v.startsWith('P') || v.startsWith('-P')) return 'timespan';
		return undefined;
	}
	if (typeof v === 'number') return 'number';
	return undefined;
}

/** The one home for the "no such combination" error, so both callers spell it alike. */
export function unsupportedTemporalOp(): never {
	throw new QuereusError(
		`Unsupported temporal operation`,
		StatusCode.UNSUPPORTED
	);
}

export interface TemporalOpCase {
	/** Logical type of the result — what `BinaryOpNode.generateType` announces. */
	readonly resultType: LogicalType;
	/** Perform the operation on two non-null values. May throw; callers wrap. */
	readonly apply: (v1: SqlValue, v2: SqlValue) => SqlValue;
}

/**
 * Check if a Temporal.Duration contains calendar units (years, months, weeks)
 * that cannot be converted to a single time unit without a relativeTo reference.
 */
export function hasCalendarUnits(d: Temporal.Duration): boolean {
	return d.years !== 0 || d.months !== 0 || d.weeks !== 0;
}

/**
 * Scale each field of a duration by a factor.
 * Works for both calendar and non-calendar durations.
 */
export function scaleDuration(d: Temporal.Duration, factor: number): Temporal.Duration {
	return Temporal.Duration.from({
		years: d.years * factor,
		months: d.months * factor,
		weeks: d.weeks * factor,
		days: d.days * factor,
		hours: d.hours * factor,
		minutes: d.minutes * factor,
		seconds: d.seconds * factor,
		milliseconds: d.milliseconds * factor,
		microseconds: d.microseconds * factor,
		nanoseconds: d.nanoseconds * factor,
	});
}

/**
 * Divide a duration's fields by a divisor, cascading remainders to smaller units.
 * Cascade chain: years→months(×12), weeks→days(×7), days→hours(×24),
 * hours→minutes(×60), minutes→seconds(×60), seconds→ms(×1000),
 * ms→μs(×1000), μs→ns(×1000).
 * Note: months cannot cascade to days (variable month length).
 */
export function divideDuration(d: Temporal.Duration, divisor: number): Temporal.Duration {
	// Cascade pairs: [field, next-field, conversion-factor]
	const cascade: [string, string, number][] = [
		['years', 'months', 12],
		// months→days gap: no fixed conversion
		['weeks', 'days', 7],
		['days', 'hours', 24],
		['hours', 'minutes', 60],
		['minutes', 'seconds', 60],
		['seconds', 'milliseconds', 1000],
		['milliseconds', 'microseconds', 1000],
		['microseconds', 'nanoseconds', 1000],
	];

	// Build a mutable map of field values
	const fields: Record<string, number> = {
		years: d.years, months: d.months, weeks: d.weeks,
		days: d.days, hours: d.hours, minutes: d.minutes,
		seconds: d.seconds, milliseconds: d.milliseconds,
		microseconds: d.microseconds, nanoseconds: d.nanoseconds,
	};

	for (const [field, nextField, factor] of cascade) {
		const value = fields[field];
		const quotient = Math.trunc(value / divisor);
		const remainder = value - quotient * divisor;
		fields[field] = quotient;
		fields[nextField] += remainder * factor;
	}

	// Final field (nanoseconds) — just divide, truncate to integer
	fields['nanoseconds'] = Math.trunc(fields['nanoseconds'] / divisor);

	// Months divide independently: the cascade above already folded years into them, but
	// a month has no fixed day count, so the sub-month remainder cannot cascade onward.
	// NOTE: that remainder is truncated away — `timespan('P1M') / 2` is `PT0S`, not `P15D`.
	// Preserved as found; revisit if a caller needs a reference-date-relative division.
	fields['months'] = Math.trunc(fields['months'] / divisor);

	return Temporal.Duration.from({
		years: fields['years'],
		months: fields['months'],
		weeks: fields['weeks'],
		days: fields['days'],
		hours: fields['hours'],
		minutes: fields['minutes'],
		seconds: fields['seconds'],
		milliseconds: fields['milliseconds'],
		microseconds: fields['microseconds'],
		nanoseconds: fields['nanoseconds'],
	});
}

/** A DATE or DATETIME operand as a PlainDate. */
function asPlainDate(v: SqlValue, kind: 'date' | 'datetime'): Temporal.PlainDate {
	return kind === 'datetime'
		? Temporal.PlainDateTime.from(v as string).toPlainDate()
		: Temporal.PlainDate.from(v as string);
}

/**
 * DATE/DATETIME − DATE/DATETIME → TIMESPAN.
 *
 * NOTE: both sides collapse to a PlainDate first, so the time of day is dropped —
 * `datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')` is `'P5D'`, not
 * `'P5DT2H'`. Preserved verbatim from the cascade this table replaces; the fix is
 * tracked separately as `bug-datetime-difference-drops-time-of-day`.
 */
function dateDifference(lk: 'date' | 'datetime', rk: 'date' | 'datetime'): TemporalOpCase {
	return {
		resultType: TIMESPAN_TYPE,
		apply: (v1, v2) => asPlainDate(v1, lk).since(asPlainDate(v2, rk)).toString(),
	};
}

/** DATE ± TIMESPAN → DATE. */
function dateShift(sign: 'add' | 'subtract'): TemporalOpCase {
	return {
		resultType: DATE_TYPE,
		apply: (date, ts) => Temporal.PlainDate.from(date as string)[sign](Temporal.Duration.from(ts as string)).toString(),
	};
}

/** DATETIME ± TIMESPAN → DATETIME. */
function dateTimeShift(sign: 'add' | 'subtract'): TemporalOpCase {
	return {
		resultType: DATETIME_TYPE,
		apply: (dt, ts) => Temporal.PlainDateTime.from(dt as string)[sign](Temporal.Duration.from(ts as string)).toString(),
	};
}

/** TIME ± TIMESPAN → TIME. */
function timeShift(sign: 'add' | 'subtract'): TemporalOpCase {
	return {
		resultType: TIME_TYPE,
		apply: (t, ts) => Temporal.PlainTime.from(t as string)[sign](Temporal.Duration.from(ts as string)).toString(),
	};
}

/** The commuted form of a shift case: `TIMESPAN + DATE` reads the same as `DATE + TIMESPAN`. */
function commuted(entry: TemporalOpCase): TemporalOpCase {
	return { resultType: entry.resultType, apply: (v1, v2) => entry.apply(v2, v1) };
}

/**
 * TIMESPAN * NUMBER → TIMESPAN.
 *
 * NOTE: the `typeof n === 'number'` guard rejects `bigint`, so
 * `timespan('PT1H') * 9007199254740993` raises `Unsupported temporal operation`.
 * That is preserved-as-found (the old cascade's match condition was literally
 * `typeof v2 === 'number'`), not designed — widening it to accept bigint is a
 * separate call. The guard is unreachable on the runtime-sniffed path, where the
 * kind was derived from `typeof`; it is load-bearing on the emit-time path, where a
 * declared INTEGER operand can hold a bigint.
 */
function scaleTimespan(ts: SqlValue, n: SqlValue): SqlValue {
	if (typeof n !== 'number') unsupportedTemporalOp();
	const duration = Temporal.Duration.from(ts as string);
	if (hasCalendarUnits(duration)) {
		return scaleDuration(duration, n).toString();
	}
	const totalSeconds = duration.total({ unit: 'seconds' });
	return Temporal.Duration.from({ seconds: totalSeconds * n }).toString();
}

/** TIMESPAN / NUMBER → TIMESPAN. Divisor `0` → null. Same bigint NOTE as {@link scaleTimespan}. */
function divideTimespanByNumber(ts: SqlValue, n: SqlValue): SqlValue {
	if (typeof n !== 'number') unsupportedTemporalOp();
	if (n === 0) return null;
	const duration = Temporal.Duration.from(ts as string);
	if (hasCalendarUnits(duration)) {
		return divideDuration(duration, n).toString();
	}
	const totalSeconds = duration.total({ unit: 'seconds' });
	return Temporal.Duration.from({ seconds: totalSeconds / n }).toString();
}

/** TIMESPAN / TIMESPAN → REAL (ratio of elapsed seconds). */
function timespanRatio(v1: SqlValue, v2: SqlValue): SqlValue {
	const d1 = Temporal.Duration.from(v1 as string);
	const d2 = Temporal.Duration.from(v2 as string);
	if (hasCalendarUnits(d1) || hasCalendarUnits(d2)) {
		// Cannot compute a numeric ratio when calendar units are involved
		// (months/years have variable lengths without a reference date)
		return null;
	}
	const total1 = d1.total({ unit: 'seconds' });
	const total2 = d2.total({ unit: 'seconds' });
	if (total2 === 0) return null;
	return total1 / total2;
}

/**
 * NOTE: the value-sniffed path builds one of these strings per row, where the old cascade
 * allocated nothing. Immaterial next to the `Temporal.Duration.from` parse that follows it
 * on the same row, and the emit-time specialization hoists the lookup out of the row loop
 * entirely; if temporal arithmetic ever shows up in a profile without that hoist, nest the
 * table two levels deep instead of keying on a concatenation.
 */
function key(operator: string, left: TemporalOperandKind, right: TemporalOperandKind): string {
	return `${operator}|${left}|${right}`;
}

const DATE_PLUS_TIMESPAN = dateShift('add');
const DATETIME_PLUS_TIMESPAN = dateTimeShift('add');
const TIME_PLUS_TIMESPAN = timeShift('add');

/**
 * Every supported `(operator, left kind, right kind)` combination. Anything absent —
 * `%` on any pair, DATE + DATE, DATE * NUMBER, TIME − DATE, DATE − NUMBER — is
 * unsupported and raises {@link unsupportedTemporalOp} at runtime.
 */
const TEMPORAL_OP_CASES: ReadonlyMap<string, TemporalOpCase> = new Map<string, TemporalOpCase>([
	// difference of two instants → elapsed time
	[key('-', 'date', 'date'), dateDifference('date', 'date')],
	[key('-', 'date', 'datetime'), dateDifference('date', 'datetime')],
	[key('-', 'datetime', 'date'), dateDifference('datetime', 'date')],
	[key('-', 'datetime', 'datetime'), dateDifference('datetime', 'datetime')],
	[key('-', 'time', 'time'), {
		resultType: TIMESPAN_TYPE,
		apply: (v1, v2) => Temporal.PlainTime.from(v1 as string).since(Temporal.PlainTime.from(v2 as string)).toString(),
	}],

	// instant shifted by an elapsed time → same kind of instant
	[key('+', 'date', 'timespan'), DATE_PLUS_TIMESPAN],
	[key('+', 'timespan', 'date'), commuted(DATE_PLUS_TIMESPAN)],
	[key('-', 'date', 'timespan'), dateShift('subtract')],
	[key('+', 'datetime', 'timespan'), DATETIME_PLUS_TIMESPAN],
	[key('+', 'timespan', 'datetime'), commuted(DATETIME_PLUS_TIMESPAN)],
	[key('-', 'datetime', 'timespan'), dateTimeShift('subtract')],
	[key('+', 'time', 'timespan'), TIME_PLUS_TIMESPAN],
	[key('+', 'timespan', 'time'), commuted(TIME_PLUS_TIMESPAN)],
	[key('-', 'time', 'timespan'), timeShift('subtract')],

	// elapsed time combined with elapsed time
	[key('+', 'timespan', 'timespan'), {
		resultType: TIMESPAN_TYPE,
		apply: (v1, v2) => Temporal.Duration.from(v1 as string).add(Temporal.Duration.from(v2 as string)).toString(),
	}],
	[key('-', 'timespan', 'timespan'), {
		resultType: TIMESPAN_TYPE,
		apply: (v1, v2) => Temporal.Duration.from(v1 as string).subtract(Temporal.Duration.from(v2 as string)).toString(),
	}],
	[key('/', 'timespan', 'timespan'), { resultType: REAL_TYPE, apply: timespanRatio }],

	// elapsed time scaled by a plain number
	[key('*', 'timespan', 'number'), { resultType: TIMESPAN_TYPE, apply: scaleTimespan }],
	[key('*', 'number', 'timespan'), { resultType: TIMESPAN_TYPE, apply: (v1, v2) => scaleTimespan(v2, v1) }],
	[key('/', 'timespan', 'number'), { resultType: TIMESPAN_TYPE, apply: divideTimespanByNumber }],
]);

/**
 * Look up the case for one `(operator, left kind, right kind)` triple.
 * `undefined` means the combination is not supported.
 */
export function temporalOpCase(
	operator: string,
	left: TemporalOperandKind,
	right: TemporalOperandKind,
): TemporalOpCase | undefined {
	return TEMPORAL_OP_CASES.get(key(operator, left, right));
}

/**
 * What a pair of DECLARED logical types settles about the operation, resolved once at
 * plan/emit time.
 *
 * `kinds` absent means at least one declared type settles nothing (TEXT / ANY / NULL /
 * TIMESTAMP / a plugin-registered type), so the caller must derive the kinds from the
 * runtime values instead. `kinds` present with `entry` absent means both kinds are known
 * and the table has no case for them — statically unsupported, whatever the values are.
 */
export interface TemporalTypeLookup {
	readonly kinds?: readonly [TemporalOperandKind, TemporalOperandKind];
	readonly entry?: TemporalOpCase;
}

/**
 * The one route from two declared logical types to a case.
 *
 * Two callers must reach the same answer or the announced result type stops predicting
 * the value: `BinaryOpNode.generateType` announces `entry.resultType`, and
 * `buildNumericOpSpec`'s temporal branch emits a body that runs `entry.apply`. Neither
 * re-spells the kind derivation, so the two cannot come to select different entries.
 */
export function temporalOpCaseForTypes(
	operator: string,
	left: LogicalType,
	right: LogicalType,
): TemporalTypeLookup {
	const lk = temporalKindOfType(left);
	const rk = temporalKindOfType(right);
	if (!lk || !rk) return {};
	return { kinds: [lk, rk], entry: temporalOpCase(operator, lk, rk) };
}

/** Test-only view of the table's keys, so a spec can assert its shape without re-listing it. */
export function temporalOpCaseKeys(): readonly string[] {
	return [...TEMPORAL_OP_CASES.keys()];
}

/**
 * Run one case with the exact envelope `tryTemporalArithmetic` has always had:
 * null propagation, then `apply`, with a malformed value degrading to null while an
 * `UNSUPPORTED` error propagates.
 *
 * Both the runtime-sniffed path and the emit-time specialized path call this, so the
 * two cannot diverge on null handling or on what a bad value does.
 */
export function runTemporalCase(entry: TemporalOpCase, v1: SqlValue, v2: SqlValue): SqlValue {
	if (v1 === null || v2 === null) return null;
	try {
		return entry.apply(v1, v2);
	} catch (e) {
		// UNSUPPORTED propagates; anything else means the value did not parse as the
		// shape its kind promised, which is a null result rather than an error.
		if (e instanceof QuereusError) throw e;
		return null;
	}
}
