import { StatusCode } from "../../common/types.js";
import { QuereusError } from "../../common/errors.js";
import type { SqlValue } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { BinaryOpNode } from "../../planner/nodes/scalar.js";
import { emitPlanNode } from "../emitters.js";
import type { EmissionContext } from "../emission-context.js";
import { Temporal } from 'temporal-polyfill';
import { TIMESPAN_TYPE } from "../../types/temporal-types.js";

/**
 * Check if a value is a date string (YYYY-MM-DD format)
 */
function isDateValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// Simple check for ISO 8601 date format
	return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Check if a value is a time string (HH:MM:SS format)
 */
function isTimeValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// Simple check for ISO 8601 time format
	return /^\d{2}:\d{2}:\d{2}/.test(v);
}

/**
 * Check if a value is a datetime string (ISO 8601 format)
 */
function isDateTimeValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// Check for ISO 8601 datetime format (with T separator)
	return v.includes('T') && /^\d{4}-\d{2}-\d{2}T/.test(v);
}

/**
 * Check if a value is a timespan/duration string (ISO 8601 duration format)
 */
function isTimespanValue(v: SqlValue): boolean {
	if (typeof v !== 'string') return false;
	// ISO 8601 duration starts with P (or -P for negative)
	return v.startsWith('P') || v.startsWith('-P');
}

/**
 * Check if a Temporal.Duration contains calendar units (years, months, weeks)
 * that cannot be converted to a single time unit without a relativeTo reference.
 */
function hasCalendarUnits(d: Temporal.Duration): boolean {
	return d.years !== 0 || d.months !== 0 || d.weeks !== 0;
}

/**
 * Scale each field of a duration by a factor.
 * Works for both calendar and non-calendar durations.
 */
function scaleDuration(d: Temporal.Duration, factor: number): Temporal.Duration {
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
function divideDuration(d: Temporal.Duration, divisor: number): Temporal.Duration {
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

	// Handle months independently (not part of cascade chain above for months→days)
	// months was already accumulated from years cascade; now divide it
	const monthQuotient = Math.trunc(fields['months'] / divisor);
	const monthRemainder = fields['months'] - monthQuotient * divisor;
	fields['months'] = monthQuotient;
	// Fractional months can't be converted to days; truncate
	if (monthRemainder !== 0) {
		// Best-effort: drop sub-month remainder since we can't convert to days
	}

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

/**
 * Try to perform temporal arithmetic on two values.
 * Returns the result if successful, or undefined if the values are not temporal types.
 * Throws QuereusError if the operation is invalid.
 */
export function tryTemporalArithmetic(operator: string, v1: SqlValue, v2: SqlValue): SqlValue | undefined {
		if (v1 === null || v2 === null) return null;

		// Detect types at runtime
		const isV1Date = isDateValue(v1);
		const isV1Time = isTimeValue(v1);
		const isV1DateTime = isDateTimeValue(v1);
		const isV1Timespan = isTimespanValue(v1);

		const isV2Date = isDateValue(v2);
		const isV2Time = isTimeValue(v2);
		const isV2DateTime = isDateTimeValue(v2);
		const isV2Timespan = isTimespanValue(v2);

		// If neither operand is temporal, return undefined to signal non-temporal operation
		const isV1Temporal = isV1Date || isV1Time || isV1DateTime || isV1Timespan;
		const isV2Temporal = isV2Date || isV2Time || isV2DateTime || isV2Timespan;
		if (!isV1Temporal && !isV2Temporal) {
			return undefined;
		}

		try {

			// DATE/DATETIME - DATE/DATETIME → TIMESPAN
			if (operator === '-' &&
				(isV1Date || isV1DateTime) &&
				(isV2Date || isV2DateTime)) {

				// Parse both values as dates
				const date1 = isV1DateTime
					? Temporal.PlainDateTime.from(v1 as string).toPlainDate()
					: Temporal.PlainDate.from(v1 as string);
				const date2 = isV2DateTime
					? Temporal.PlainDateTime.from(v2 as string).toPlainDate()
					: Temporal.PlainDate.from(v2 as string);

				const duration = date1.since(date2);
				return duration.toString();
			}

			// TIME - TIME → TIMESPAN
			if (operator === '-' && isV1Time && isV2Time) {
				const time1 = Temporal.PlainTime.from(v1 as string);
				const time2 = Temporal.PlainTime.from(v2 as string);
				const duration = time1.since(time2);
				return duration.toString();
			}

			// DATE + TIMESPAN → DATE
			if (operator === '+' && isV1Date && isV2Timespan) {
				const date = Temporal.PlainDate.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = date.add(duration);
				return result.toString();
			}

			// TIMESPAN + DATE → DATE (commutative)
			if (operator === '+' && isV1Timespan && isV2Date) {
				const duration = Temporal.Duration.from(v1 as string);
				const date = Temporal.PlainDate.from(v2 as string);
				const result = date.add(duration);
				return result.toString();
			}

			// DATE - TIMESPAN → DATE
			if (operator === '-' && isV1Date && isV2Timespan) {
				const date = Temporal.PlainDate.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = date.subtract(duration);
				return result.toString();
			}

			// DATETIME + TIMESPAN → DATETIME
			if (operator === '+' && isV1DateTime && isV2Timespan) {
				const dt = Temporal.PlainDateTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = dt.add(duration);
				return result.toString();
			}

			// TIMESPAN + DATETIME → DATETIME (commutative)
			if (operator === '+' && isV1Timespan && isV2DateTime) {
				const duration = Temporal.Duration.from(v1 as string);
				const dt = Temporal.PlainDateTime.from(v2 as string);
				const result = dt.add(duration);
				return result.toString();
			}

			// DATETIME - TIMESPAN → DATETIME
			if (operator === '-' && isV1DateTime && isV2Timespan) {
				const dt = Temporal.PlainDateTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = dt.subtract(duration);
				return result.toString();
			}

			// TIME + TIMESPAN → TIME
			if (operator === '+' && isV1Time && isV2Timespan) {
				const time = Temporal.PlainTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = time.add(duration);
				return result.toString();
			}

			// TIMESPAN + TIME → TIME (commutative)
			if (operator === '+' && isV1Timespan && isV2Time) {
				const duration = Temporal.Duration.from(v1 as string);
				const time = Temporal.PlainTime.from(v2 as string);
				const result = time.add(duration);
				return result.toString();
			}

			// TIME - TIMESPAN → TIME
			if (operator === '-' && isV1Time && isV2Timespan) {
				const time = Temporal.PlainTime.from(v1 as string);
				const duration = Temporal.Duration.from(v2 as string);
				const result = time.subtract(duration);
				return result.toString();
			}

			// TIMESPAN + TIMESPAN → TIMESPAN
			if (operator === '+' && isV1Timespan && isV2Timespan) {
				const d1 = Temporal.Duration.from(v1 as string);
				const d2 = Temporal.Duration.from(v2 as string);
				const result = d1.add(d2);
				return result.toString();
			}

			// TIMESPAN - TIMESPAN → TIMESPAN
			if (operator === '-' && isV1Timespan && isV2Timespan) {
				const d1 = Temporal.Duration.from(v1 as string);
				const d2 = Temporal.Duration.from(v2 as string);
				const result = d1.subtract(d2);
				return result.toString();
			}

			// TIMESPAN * NUMBER → TIMESPAN
			if (operator === '*' && isV1Timespan && typeof v2 === 'number') {
				const duration = Temporal.Duration.from(v1 as string);
				if (hasCalendarUnits(duration)) {
					return scaleDuration(duration, v2).toString();
				}
				const totalSeconds = duration.total({ unit: 'seconds' });
				const newDuration = Temporal.Duration.from({ seconds: totalSeconds * v2 });
				return newDuration.toString();
			}

			// NUMBER * TIMESPAN → TIMESPAN (commutative)
			if (operator === '*' && typeof v1 === 'number' && isV2Timespan) {
				const duration = Temporal.Duration.from(v2 as string);
				if (hasCalendarUnits(duration)) {
					return scaleDuration(duration, v1).toString();
				}
				const totalSeconds = duration.total({ unit: 'seconds' });
				const newDuration = Temporal.Duration.from({ seconds: totalSeconds * v1 });
				return newDuration.toString();
			}

			// TIMESPAN / NUMBER → TIMESPAN
			if (operator === '/' && isV1Timespan && typeof v2 === 'number') {
				if (v2 === 0) return null;
				const duration = Temporal.Duration.from(v1 as string);
				if (hasCalendarUnits(duration)) {
					return divideDuration(duration, v2).toString();
				}
				const totalSeconds = duration.total({ unit: 'seconds' });
				const newDuration = Temporal.Duration.from({ seconds: totalSeconds / v2 });
				return newDuration.toString();
			}

			// TIMESPAN / TIMESPAN → NUMBER (ratio)
			if (operator === '/' && isV1Timespan && isV2Timespan) {
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

			// If we get here, the operation is not supported
			throw new QuereusError(
				`Unsupported temporal operation`,
				StatusCode.UNSUPPORTED
			);
		} catch (e) {
			// Invalid temporal operation - return null
			if (e instanceof QuereusError) throw e;
			return null;
		}
}

/**
 * Emit temporal arithmetic operations
 * Handles operations between temporal types (DATE, TIME, DATETIME, TIMESPAN)
 */
export function emitTemporalArithmetic(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	const operator = plan.expression.operator;

	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		return tryTemporalArithmetic(operator, v1, v2) ?? null;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: asRun(run),
		note: `${operator}(temporal)`
	};
}

/**
 * Attempts to perform temporal comparison. Returns undefined if not a temporal comparison.
 * This allows the caller to fall back to standard comparison logic.
 *
 * Temporal types that need special comparison logic (beyond lexicographic string comparison):
 * - TIMESPAN: Durations need to be compared semantically, not lexicographically
 *   (e.g., "PT30M" > "PT1H" lexicographically, but 30 minutes < 1 hour semantically)
 *
 * Note: DATE, TIME, and DATETIME use ISO 8601 format which compares correctly lexicographically,
 * so they don't need special handling here.
 *
 * @param operator The comparison operator (=, !=, <, <=, >, >=)
 * @param v1 First value
 * @param v2 Second value
 * @returns Comparison result (boolean) if temporal comparison, undefined otherwise
 */
export function tryTemporalComparison(operator: string, v1: SqlValue, v2: SqlValue): SqlValue | undefined {
	const cmp = tryTemporalCompare(v1, v2);
	if (cmp === undefined) return undefined;

	switch (operator) {
		case '=':
		case '==':
			return cmp === 0;
		case '!=':
		case '<>':
			return cmp !== 0;
		case '<':
			return cmp < 0;
		case '<=':
			return cmp <= 0;
		case '>':
			return cmp > 0;
		case '>=':
			return cmp >= 0;
		default:
			return undefined;
	}
}

/**
 * Three-way duration compare, for callers that need an ordering rather than a
 * boolean verdict (BETWEEN's per-bound comparator). Returns undefined unless BOTH
 * values look like ISO 8601 duration strings — the same guard
 * {@link tryTemporalComparison} applies, so the two never disagree.
 */
export function tryTemporalCompare(v1: SqlValue, v2: SqlValue): number | undefined {
	// Timespans are the only temporal type that needs special comparison logic
	// because ISO 8601 duration strings don't compare correctly lexicographically
	if (!isTimespanValue(v1) || !isTimespanValue(v2)) return undefined;
	return TIMESPAN_TYPE.compare!(v1, v2);
}
