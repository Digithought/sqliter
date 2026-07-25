import { PhysicalType, type LogicalType, compareNulls } from './logical-type.js';
import { BINARY_COLLATION } from '../util/comparison.js';
import { Temporal } from 'temporal-polyfill';

/**
 * Parse any string ISO datetime form into a UTC PlainDateTime — the canonical
 * stored shape for DATETIME values. Zone-bearing inputs ([zone] annotation,
 * `Z` suffix, or `±HH:MM` offset) are converted to UTC; bare ISO datetimes
 * are treated as already-UTC wall-clock.
 */
function parseDateTimeStringToUtcPlain(v: string): Temporal.PlainDateTime {
	// ZonedDateTime first — requires explicit [zone], so the match is unambiguous.
	try { return Temporal.ZonedDateTime.from(v).toPlainDateTime(); } catch { /* fall through */ }
	// Instant.from handles `Z` suffix and bare offsets like `+00:00`.
	try { return Temporal.Instant.from(v).toZonedDateTimeISO('UTC').toPlainDateTime(); } catch { /* fall through */ }
	// Bare PlainDateTime (no zone/offset) — assume UTC wall-clock.
	return Temporal.PlainDateTime.from(v);
}

/**
 * DATE type - stores ISO 8601 date strings (YYYY-MM-DD)
 * Uses Temporal.PlainDate for validation and parsing
 */
export const DATE_TYPE: LogicalType = {
	name: 'DATE',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			// Full datetime parsing first so offset/zoned inputs canonicalize to UTC
			// before the date is extracted. PlainDate.from would otherwise silently
			// accept offset-bearing strings and return the wall-clock date.
			parseDateTimeStringToUtcPlain(v);
			return true;
		} catch {
			try {
				Temporal.PlainDate.from(v);
				return true;
			} catch {
				return false;
			}
		}
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') {
			try {
				// Datetime-shaped inputs (with or without offset/zone) canonicalize
				// through UTC. PlainDate.from is only consulted for bare date-only
				// strings, which the helper rejects.
				return parseDateTimeStringToUtcPlain(v).toPlainDate().toString();
			} catch {
				try {
					return Temporal.PlainDate.from(v).toString(); // ISO 8601 format: YYYY-MM-DD
				} catch (eDate) {
					throw new TypeError(`Cannot convert '${v}' to DATE: ${eDate instanceof Error ? eDate.message : String(eDate)}`);
				}
			}
		}
		if (typeof v === 'number') {
			// Unix timestamp (milliseconds)
			const instant = Temporal.Instant.fromEpochMilliseconds(v);
			return instant.toZonedDateTimeISO('UTC').toPlainDate().toString();
		}
		throw new TypeError(`Cannot convert ${typeof v} to DATE`);
	},

	compare: (a, b) => compareNulls(a, b) ?? BINARY_COLLATION(a as string, b as string),

	supportedCollations: [],

	bucketBounds: (kind, value) => {
		if (kind !== 'date_bucket') return undefined;
		if (typeof value !== 'string') return undefined;
		try {
			const date = Temporal.PlainDate.from(value);
			const next = date.add({ days: 1 });
			return { lowerInclusive: date.toString(), upperExclusive: next.toString() };
		} catch {
			return undefined;
		}
	},
};

/**
 * TIME type - stores ISO 8601 time strings (HH:MM:SS or HH:MM:SS.sss)
 * Uses Temporal.PlainTime for validation and parsing
 */
export const TIME_TYPE: LogicalType = {
	name: 'TIME',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			// Full datetime parsing first so offset/zoned inputs canonicalize to UTC
			// before the time is extracted. PlainTime.from would otherwise silently
			// accept offset-bearing strings and return the wall-clock time.
			parseDateTimeStringToUtcPlain(v);
			return true;
		} catch {
			try {
				Temporal.PlainTime.from(v);
				return true;
			} catch {
				return false;
			}
		}
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') {
			try {
				// Datetime-shaped inputs (with or without offset/zone) canonicalize
				// through UTC. PlainTime.from is only consulted for bare time-only
				// strings, which the helper rejects.
				return parseDateTimeStringToUtcPlain(v).toPlainTime().toString();
			} catch {
				try {
					return Temporal.PlainTime.from(v).toString(); // ISO 8601 format: HH:MM:SS or HH:MM:SS.sss
				} catch (eTime) {
					throw new TypeError(`Cannot convert '${v}' to TIME: ${eTime instanceof Error ? eTime.message : String(eTime)}`);
				}
			}
		}
		if (typeof v === 'number') {
			if (v < 0 || !Number.isFinite(v)) {
				throw new TypeError(`Cannot convert '${v}' to TIME: value must be a non-negative finite number of seconds`);
			}
			// Convert to total milliseconds for clean integer arithmetic (avoids carry bugs)
			const totalMs = Math.round(v * 1000);
			const hours = Math.floor(totalMs / 3600_000) % 24;
			const minutes = Math.floor((totalMs % 3600_000) / 60_000);
			const seconds = Math.floor((totalMs % 60_000) / 1000);
			const milliseconds = totalMs % 1000;
			const time = new Temporal.PlainTime(hours, minutes, seconds, milliseconds);
			return time.toString();
		}
		throw new TypeError(`Cannot convert ${typeof v} to TIME`);
	},

	compare: (a, b) => compareNulls(a, b) ?? BINARY_COLLATION(a as string, b as string),

	supportedCollations: [],
};

/**
 * DATETIME type - stores ISO 8601 datetime strings (YYYY-MM-DDTHH:MM:SS or with timezone)
 * Uses Temporal.PlainDateTime for validation and parsing
 */
export const DATETIME_TYPE: LogicalType = {
	name: 'DATETIME',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			parseDateTimeStringToUtcPlain(v);
			return true;
		} catch {
			return false;
		}
	},

	parse: (v) => {
		if (v === null) return null;
		if (typeof v === 'string') {
			try {
				return parseDateTimeStringToUtcPlain(v).toString();
			} catch (e) {
				throw new TypeError(`Cannot convert '${v}' to DATETIME: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (typeof v === 'number') {
			// Unix timestamp (milliseconds) — canonicalize to bare PlainDateTime in UTC.
			const instant = Temporal.Instant.fromEpochMilliseconds(v);
			return instant.toZonedDateTimeISO('UTC').toPlainDateTime().toString();
		}
		throw new TypeError(`Cannot convert ${typeof v} to DATETIME`);
	},

	compare: (a, b) => compareNulls(a, b) ?? BINARY_COLLATION(a as string, b as string),

	supportedCollations: [],

	bucketBounds: (kind, value) => {
		if (kind !== 'date_bucket') return undefined;
		if (typeof value !== 'string') return undefined;
		try {
			const date = Temporal.PlainDate.from(value);
			const next = date.add({ days: 1 });
			// Express bounds in the column's value space (ISO datetime strings, midnight UTC).
			return {
				lowerInclusive: `${date.toString()}T00:00:00`,
				upperExclusive: `${next.toString()}T00:00:00`,
			};
		} catch {
			return undefined;
		}
	},
};

/**
 * Parse human-readable duration strings into Temporal.Duration
 * Supports formats like "1 hour", "30 minutes", "2 days 3 hours"
 */
function parseHumanReadableDuration(input: string): Temporal.Duration | null {
	const normalized = input.trim().toLowerCase();

	// Handle negative durations
	const isNegative = normalized.startsWith('-');
	const workingInput = isNegative ? normalized.substring(1).trim() : normalized;

	// Pattern: [number] [unit]
	// Units: year(s), month(s), week(s), day(s), hour(s), minute(s), second(s), min(s), sec(s)
	const pattern = /(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|hours?|minutes?|seconds?|mins?|secs?)/g;

	const components: Record<string, number> = {};
	let match;
	let hasMatch = false;

	while ((match = pattern.exec(workingInput)) !== null) {
		hasMatch = true;
		const value = parseFloat(match[1]);
		const unit = match[2];

		// Map unit to Temporal.Duration field
		if (unit.startsWith('year')) {
			components.years = (components.years || 0) + value;
		} else if (unit.startsWith('month')) {
			components.months = (components.months || 0) + value;
		} else if (unit.startsWith('week')) {
			components.weeks = (components.weeks || 0) + value;
		} else if (unit.startsWith('day')) {
			components.days = (components.days || 0) + value;
		} else if (unit.startsWith('hour')) {
			components.hours = (components.hours || 0) + value;
		} else if (unit.startsWith('min')) {
			components.minutes = (components.minutes || 0) + value;
		} else if (unit.startsWith('sec')) {
			components.seconds = (components.seconds || 0) + value;
		}
	}

	if (!hasMatch) return null;

	try {
		const duration = Temporal.Duration.from(components);
		return isNegative ? duration.negated() : duration;
	} catch {
		return null;
	}
}

/**
 * Total elapsed seconds of an ISO 8601 duration string, resolving calendar units
 * (years/months/weeks) against a fixed reference date so the mapping is total and
 * deterministic engine-wide. This single helper backs both `TIMESPAN_TYPE.compare`
 * and `TIMESPAN_TYPE.groupKey`, so ordering and hash-grouping identity can never
 * disagree on the reference date. Returns undefined for unparseable input.
 */
function timespanTotalSeconds(v: string): number | undefined {
	try {
		const duration = Temporal.Duration.from(v);
		// Reference date resolves calendar units (months/years have no fixed length)
		const referenceDate = Temporal.PlainDate.from('2024-01-01');
		return duration.total({ unit: 'seconds', relativeTo: referenceDate });
	} catch {
		return undefined;
	}
}

/**
 * TIMESPAN type - stores ISO 8601 duration strings
 * Uses Temporal.Duration for validation and parsing
 */
export const TIMESPAN_TYPE: LogicalType = {
	name: 'TIMESPAN',
	physicalType: PhysicalType.TEXT,
	isTemporal: true,
	// Ordered by elapsed time, not by duration text: 'PT90M' < 'PT2H' though the
	// text sorts the other way. See LogicalType.semanticOrdering.
	semanticOrdering: true,

	validate: (v) => {
		if (v === null) return true;
		if (typeof v !== 'string') return false;
		try {
			Temporal.Duration.from(v);
			return true;
		} catch {
			// Try parsing human-readable format
			return parseHumanReadableDuration(v) !== null;
		}
	},

	parse: (v) => {
		if (v === null) return null;

		if (typeof v === 'number') {
			// Interpret as seconds
			const duration = Temporal.Duration.from({ seconds: v });
			return duration.toString();
		}

		if (typeof v === 'string') {
			try {
				// Try ISO 8601 first
				const duration = Temporal.Duration.from(v);
				return duration.toString();
			} catch {
				// Try human-readable format
				const duration = parseHumanReadableDuration(v);
				if (duration) return duration.toString();
				throw new TypeError(`Cannot convert '${v}' to TIMESPAN`);
			}
		}

		throw new TypeError(`Cannot convert ${typeof v} to TIMESPAN`);
	},

	compare: (a, b) => {
		const nullCmp = compareNulls(a, b);
		if (nullCmp !== undefined) return nullCmp;

		const totalA = timespanTotalSeconds(a as string);
		const totalB = timespanTotalSeconds(b as string);
		if (totalA === undefined || totalB === undefined) {
			// If parsing fails, fall back to binary string comparison
			return BINARY_COLLATION(a as string, b as string);
		}
		return totalA < totalB ? -1 : totalA > totalB ? 1 : 0;
	},

	// Hash-grouping identity representative: equal elapsed times ('PT1H' ≡ 'PT60M')
	// must key alike, so group on the total seconds compare() ranks by. Unparseable
	// values keep their raw text (compare falls back to text for those too).
	groupKey: (v) => {
		if (typeof v !== 'string') return v;
		return timespanTotalSeconds(v) ?? v;
	},

	supportedCollations: [],
};

