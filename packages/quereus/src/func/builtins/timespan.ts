import { Temporal } from 'temporal-polyfill';
import { type SqlValue } from '../../common/types.js';
import { createScalarFunction } from '../registration.js';
import { INTEGER_RETURN, REAL_RETURN } from './return-types.js';

/**
 * Helper to parse a value as a Temporal.Duration
 */
function parseDuration(value: SqlValue): Temporal.Duration | null {
	if (value === null) return null;
	if (typeof value !== 'string') return null;

	try {
		return Temporal.Duration.from(value);
	} catch {
		return null;
	}
}

// --- Extraction Functions ---

/**
 * timespan_years() - Extract years component from timespan
 */
export const timespanYearsFunc = createScalarFunction(
	{ name: 'timespan_years', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.years;
	}
);

/**
 * timespan_months() - Extract months component from timespan
 */
export const timespanMonthsFunc = createScalarFunction(
	{ name: 'timespan_months', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.months;
	}
);

/**
 * timespan_weeks() - Extract weeks component from timespan
 */
export const timespanWeeksFunc = createScalarFunction(
	{ name: 'timespan_weeks', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.weeks;
	}
);

/**
 * timespan_days() - Extract days component from timespan
 */
export const timespanDaysFunc = createScalarFunction(
	{ name: 'timespan_days', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.days;
	}
);

/**
 * timespan_hours() - Extract hours component from timespan
 */
export const timespanHoursFunc = createScalarFunction(
	{ name: 'timespan_hours', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.hours;
	}
);

/**
 * timespan_minutes() - Extract minutes component from timespan
 */
export const timespanMinutesFunc = createScalarFunction(
	{ name: 'timespan_minutes', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.minutes;
	}
);

/**
 * timespan_seconds() - Extract seconds component from timespan
 *
 * REAL, not INTEGER like its six sibling component extractors: this one folds the
 * sub-second components into its result, so 'PT1.5S' returns 1.5.
 */
export const timespanSecondsFunc = createScalarFunction(
	{ name: 'timespan_seconds', numArgs: 1, deterministic: true, returnType: REAL_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		return duration.seconds + duration.milliseconds / 1000 + duration.microseconds / 1000000 + duration.nanoseconds / 1000000000;
	}
);

// --- Total Functions ---

/**
 * timespan_total_seconds() - Convert entire timespan to seconds
 */
export const timespanTotalSecondsFunc = createScalarFunction(
	{ name: 'timespan_total_seconds', numArgs: 1, deterministic: true, returnType: REAL_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		try {
			// Use a reference date for calendar units (weeks, months, years)
			const referenceDate = Temporal.PlainDate.from('2024-01-01');
			return duration.total({ unit: 'seconds', relativeTo: referenceDate });
		} catch {
			return null;
		}
	}
);

/**
 * timespan_total_minutes() - Convert entire timespan to minutes
 */
export const timespanTotalMinutesFunc = createScalarFunction(
	{ name: 'timespan_total_minutes', numArgs: 1, deterministic: true, returnType: REAL_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		try {
			// Use a reference date for calendar units (weeks, months, years)
			const referenceDate = Temporal.PlainDate.from('2024-01-01');
			return duration.total({ unit: 'minutes', relativeTo: referenceDate });
		} catch {
			return null;
		}
	}
);

/**
 * timespan_total_hours() - Convert entire timespan to hours
 */
export const timespanTotalHoursFunc = createScalarFunction(
	{ name: 'timespan_total_hours', numArgs: 1, deterministic: true, returnType: REAL_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		try {
			// Use a reference date for calendar units (weeks, months, years)
			const referenceDate = Temporal.PlainDate.from('2024-01-01');
			return duration.total({ unit: 'hours', relativeTo: referenceDate });
		} catch {
			return null;
		}
	}
);

/**
 * timespan_total_days() - Convert entire timespan to days
 */
export const timespanTotalDaysFunc = createScalarFunction(
	{ name: 'timespan_total_days', numArgs: 1, deterministic: true, returnType: REAL_RETURN },
	(value: SqlValue): SqlValue => {
		const duration = parseDuration(value);
		if (!duration) return null;
		try {
			// Use a reference date for calendar units (weeks, months, years)
			const referenceDate = Temporal.PlainDate.from('2024-01-01');
			return duration.total({ unit: 'days', relativeTo: referenceDate });
		} catch {
			return null;
		}
	}
);

