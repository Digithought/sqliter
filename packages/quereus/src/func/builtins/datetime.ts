import { createLogger } from '../../common/logger.js';
import { Temporal } from 'temporal-polyfill';
import { StatusCode, type SqlValue } from '../../common/types.js';
import { createScalarFunction } from '../registration.js';
import { quereusError } from '../../common/errors.js';
import { BOOLEAN_RETURN_NOT_NULL, INTEGER_RETURN, REAL_RETURN, TEXT_RETURN } from './return-types.js';

const log = createLogger('func:builtins:datetime');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

// --- Constants ---

const MILLIS_PER_DAY = 86400000;
const MILLIS_PER_SECOND = 1000;
const JULIAN_DAY_UNIX_EPOCH = 2440587.5;
const SQLITE_DEFAULT_DATE = { year: 2000, month: 1, day: 1 };

// Reasonable epoch-seconds range: approx 1900–3000 AD
const MIN_EPOCH_SECONDS = -2208988800;
const MAX_EPOCH_SECONDS = 32503680000;

// Julian day heuristic bounds
const MIN_JULIAN_DAY = 1000000;
const MAX_JULIAN_DAY = 4000000;

// --- Parsing Helpers --- //

function instantFromEpochSeconds(seconds: number): Temporal.Instant {
	return Temporal.Instant.fromEpochMilliseconds(seconds * MILLIS_PER_SECOND);
}

function instantToUtcZoned(instant: Temporal.Instant): Temporal.ZonedDateTime {
	return instant.toZonedDateTimeISO('UTC');
}

function plainDateTimeToUtcZoned(pdt: Temporal.PlainDateTime): Temporal.ZonedDateTime {
	return pdt.toZonedDateTime('UTC');
}

function isInRange(value: number, min: number, max: number): boolean {
	return value > min && value < max;
}

/**
 * Parses a numeric value as a Julian day number, Unix epoch seconds, or Unix
 * epoch milliseconds — using heuristics when `isUnixEpoch` is not set.
 */
function parseNumericToTemporal(timeVal: number, isUnixEpoch: boolean): Temporal.ZonedDateTime | null {
	if (isUnixEpoch)
		return instantToUtcZoned(instantFromEpochSeconds(timeVal));

	if (isInRange(timeVal, MIN_JULIAN_DAY, MAX_JULIAN_DAY)) {
		const epochMillis = (timeVal - JULIAN_DAY_UNIX_EPOCH) * MILLIS_PER_DAY;
		return instantToUtcZoned(Temporal.Instant.fromEpochMilliseconds(epochMillis));
	}

	// Prioritize seconds if within reasonable range
	if (isInRange(timeVal, MIN_EPOCH_SECONDS, MAX_EPOCH_SECONDS)) {
		try {
			return instantToUtcZoned(instantFromEpochSeconds(timeVal));
		} catch { /* fall through to milliseconds */ }
	}

	// Fall back to milliseconds
	if (isInRange(timeVal, MIN_EPOCH_SECONDS * MILLIS_PER_SECOND, MAX_EPOCH_SECONDS * MILLIS_PER_SECOND)) {
		try {
			return instantToUtcZoned(Temporal.Instant.fromEpochMilliseconds(timeVal));
		} catch { /* exhausted */ }
	}

	return null;
}

/**
 * Attempts parsing the fractional-seconds portion of a manual time match,
 * returning {millisecond, microsecond, nanosecond} components.
 */
function parseFractionalNanos(fracDigits: string): { millisecond: number; microsecond: number; nanosecond: number } {
	const ns = parseInt(fracDigits.padEnd(9, '0').substring(0, 9));
	return {
		millisecond: Math.floor(ns / 1_000_000),
		microsecond: Math.floor((ns % 1_000_000) / 1_000),
		nanosecond: ns % 1_000,
	};
}

/** Try parsing with a Temporal type constructor, returning null on failure. */
function tryParse<T>(parseFn: () => T): T | null {
	try { return parseFn(); } catch { return null; }
}

/**
 * Parses various date/time string formats, Julian day numbers, or Unix timestamps
 * into a Temporal.ZonedDateTime. Mimics SQLite's lenient parsing.
 */
function parseToTemporal(timeVal: SqlValue, isUnixEpoch = false): Temporal.ZonedDateTime | null {
	if (timeVal === null || timeVal === undefined) return null;

	try {
		if (typeof timeVal === 'number')
			return parseNumericToTemporal(timeVal, isUnixEpoch);

		if (typeof timeVal !== 'string') return null;

		const trimmed = timeVal.trim();

		if (trimmed.toLowerCase() === 'now')
			return Temporal.Now.zonedDateTimeISO();

		return parseISOString(trimmed)
			?? parseLenientFormats(trimmed);

	} catch (e) {
		warnLog('Error parsing date/time value "%s": %O', timeVal, e);
		return null;
	}
}

/** Matches ISO datetime with an explicit offset (Z or ±HH:MM). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Matches ISO datetime without any timezone/offset suffix. */
const ISO_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Attempts standard ISO 8601 parsing strategies in priority order:
 * offset datetime, plain datetime, plain date, plain time.
 */
function parseISOString(s: string): Temporal.ZonedDateTime | null {
	const normalised = s.replace(' ', 'T');

	// ISO datetime with explicit offset (Z or ±HH:MM) → parse as Instant → UTC
	if (ISO_WITH_OFFSET.test(s)) {
		const instant = tryParse(() => Temporal.Instant.from(normalised));
		if (instant) return instantToUtcZoned(instant);
	}

	// ISO datetime without timezone → treat as UTC
	if (ISO_WITHOUT_OFFSET.test(s)) {
		const instant = tryParse(() => Temporal.Instant.from(normalised + 'Z'));
		if (instant) return instantToUtcZoned(instant);
	}

	// Full ZonedDateTime (includes bracket timezone notation)
	const zdt = tryParse(() => Temporal.ZonedDateTime.from(s));
	if (zdt) return zdt;

	// PlainDateTime
	const pdt = tryParse(() => Temporal.PlainDateTime.from(normalised));
	if (pdt) return plainDateTimeToUtcZoned(pdt);

	// PlainDate (YYYY-MM-DD)
	const pd = tryParse(() => Temporal.PlainDate.from(s));
	if (pd) return pd.toZonedDateTime('UTC');

	// PlainTime → anchored to default date
	const pt = tryParse(() => Temporal.PlainTime.from(s));
	if (pt) return plainTimeToDefaultZoned(pt);

	return null;
}

/** Anchors a PlainTime to the SQLite default date (2000-01-01) at UTC. */
function plainTimeToDefaultZoned(pt: Temporal.PlainTime): Temporal.ZonedDateTime {
	return plainDateTimeToUtcZoned(Temporal.PlainDateTime.from({
		...SQLITE_DEFAULT_DATE,
		hour: pt.hour,
		minute: pt.minute,
		second: pt.second,
		millisecond: pt.millisecond,
		microsecond: pt.microsecond,
		nanosecond: pt.nanosecond,
	}));
}

/**
 * Fallback manual parsing for SQLite lenient formats that Temporal doesn't
 * handle directly: YYYYMMDD, HH:MM, HH:MM:SS, HH:MM:SS.fff
 */
function parseLenientFormats(s: string): Temporal.ZonedDateTime | null {
	// YYYYMMDD
	let match = s.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (match) {
		const pdt = Temporal.PlainDateTime.from({
			year: parseInt(match[1]), month: parseInt(match[2]), day: parseInt(match[3]),
		});
		return plainDateTimeToUtcZoned(pdt);
	}

	// HH:MM
	match = s.match(/^(\d{2}):(\d{2})$/);
	if (match) {
		return plainDateTimeToUtcZoned(Temporal.PlainDateTime.from({
			...SQLITE_DEFAULT_DATE,
			hour: parseInt(match[1]), minute: parseInt(match[2]),
		}));
	}

	// HH:MM:SS
	match = s.match(/^(\d{2}):(\d{2}):(\d{2})$/);
	if (match) {
		return plainDateTimeToUtcZoned(Temporal.PlainDateTime.from({
			...SQLITE_DEFAULT_DATE,
			hour: parseInt(match[1]), minute: parseInt(match[2]), second: parseInt(match[3]),
		}));
	}

	// HH:MM:SS.fff (variable precision)
	match = s.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,9})$/);
	if (match) {
		return plainDateTimeToUtcZoned(Temporal.PlainDateTime.from({
			...SQLITE_DEFAULT_DATE,
			hour: parseInt(match[1]), minute: parseInt(match[2]), second: parseInt(match[3]),
			...parseFractionalNanos(match[4]),
		}));
	}

	warnLog('Failed to parse date/time string: %s', s);
	return null;
}

// --- Strict Parsing (for epoch_* functions) --- //

/**
 * ISO 8601 date/time pattern for strict parsing.
 * Accepts: YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM], and 'now'.
 * Rejects bare numbers, lenient formats like YYYYMMDD, and time-only strings.
 */
const STRICT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function parseStrictTimestring(timeVal: SqlValue): Temporal.ZonedDateTime | null {
	if (timeVal === null || timeVal === undefined) return null;
	if (typeof timeVal !== 'string') return null;

	const trimmed = timeVal.trim();

	if (trimmed.toLowerCase() === 'now')
		return Temporal.Now.zonedDateTimeISO();

	if (!STRICT_ISO_PATTERN.test(trimmed)) return null;

	return parseISOString(trimmed);
}

// --- Modifier Application --- //

const RELATIVE_MODIFIER_REGEX = /^\s*([+-]?\s*\d+(\.\d+)?)\s+(day|hour|minute|second|month|year)s?\s*$/i;
const WEEKDAY_MODIFIER_REGEX = /^\s*weekday\s+([0-6])\s*$/i;

function applyRelativeShift(dt: Temporal.ZonedDateTime, value: number, unit: string): Temporal.ZonedDateTime {
	const durationLike: Record<string, number> = {};

	if (unit === 'year' || unit === 'month' || unit === 'day') {
		durationLike[`${unit}s`] = Math.trunc(value);
	} else if (unit === 'second') {
		durationLike.seconds = Math.trunc(value);
		const nanoseconds = Math.round((value % 1) * 1e9);
		if (nanoseconds !== 0) durationLike.nanoseconds = nanoseconds;
	} else {
		durationLike[`${unit}s`] = value;
	}

	return dt.add(Temporal.Duration.from(durationLike));
}

function applyWeekdayAdjustment(dt: Temporal.ZonedDateTime, targetSqlWeekday: number): Temporal.ZonedDateTime {
	const targetISO = targetSqlWeekday === 0 ? 7 : targetSqlWeekday;
	const daysToAdd = ((targetISO - dt.dayOfWeek) + 7) % 7;
	if (daysToAdd > 0) return dt.add({ days: daysToAdd });
	return dt;
}

function applyTemporalModifier(dt: Temporal.ZonedDateTime, modifier: string): Temporal.ZonedDateTime {
	const trimmed = modifier.trim().toLowerCase();

	const relativeMatch = trimmed.match(RELATIVE_MODIFIER_REGEX);
	if (relativeMatch) {
		const value = parseFloat(relativeMatch[1].replace(/\s/g, ''));
		if (isNaN(value))
			quereusError(`Invalid number in modifier: ${modifier}`, StatusCode.MISUSE);
		return applyRelativeShift(dt, value, relativeMatch[3]);
	}

	switch (trimmed) {
		case 'start of day': return dt.startOfDay();
		case 'start of month': return dt.startOfDay().with({ day: 1 });
		case 'start of year': return dt.startOfDay().with({ month: 1, day: 1 });
	}

	const weekdayMatch = trimmed.match(WEEKDAY_MODIFIER_REGEX);
	if (weekdayMatch)
		return applyWeekdayAdjustment(dt, parseInt(weekdayMatch[1], 10));

	warnLog('Modifier not implemented or unrecognized: %s', modifier);
	return dt;
}

// --- Core Argument Processing --- //

/** Recognized control modifiers that affect parsing/timezone, not datetime arithmetic. */
type ControlModifier = 'unixepoch' | 'localtime' | 'utc' | 'subsec';

const _CONTROL_MODIFIERS = new Set<string>(['unixepoch', 'localtime', 'utc', 'subsec']);

interface ProcessedArgs {
	/** The resolved ZonedDateTime, or null on parse failure. */
	dt: Temporal.ZonedDateTime | null;
	/** Whether the 'subsec' modifier was present. */
	subsec: boolean;
}

/**
 * Core argument processor shared by all datetime functions.
 * Separates control modifiers (unixepoch, localtime, utc, subsec) from
 * arithmetic modifiers, parses the timestring, applies timezone conversion,
 * then applies arithmetic modifiers in order.
 */
function processDateTimeArgs(args: ReadonlyArray<SqlValue>): ProcessedArgs {
	if (args.length === 0) return { dt: null, subsec: false };

	const { timeVal, isUnixEpoch, subsec, targetTimeZoneId, arithmeticModifiers } = classifyArgs(args);

	let dt = parseToTemporal(timeVal, isUnixEpoch);
	if (!dt) return { dt: null, subsec };

	dt = convertTimezone(dt, targetTimeZoneId);
	if (!dt) return { dt: null, subsec };

	dt = applyModifiers(dt, arithmeticModifiers);

	return { dt, subsec };
}

/**
 * Strict variant for epoch_* functions: only accepts ISO 8601 strings and 'now'.
 * Rejects bare numbers (ambiguous), time-only strings, and YYYYMMDD format.
 */
function processStrictArgs(args: ReadonlyArray<SqlValue>): Temporal.ZonedDateTime | null {
	if (args.length === 0) return null;

	const timeVal = args[0];
	const modifiers = args.slice(1).filter((m): m is string => typeof m === 'string');

	let targetTimeZoneId = 'UTC';
	const arithmeticModifiers: string[] = [];

	for (const mod of modifiers) {
		const lower = mod.trim().toLowerCase();
		if (lower === 'localtime') targetTimeZoneId = Temporal.Now.timeZoneId();
		else if (lower === 'utc') targetTimeZoneId = 'UTC';
		else arithmeticModifiers.push(mod);
	}

	let dt = parseStrictTimestring(timeVal);
	if (!dt) return null;

	dt = convertTimezone(dt, targetTimeZoneId);
	if (!dt) return null;

	return applyModifiers(dt, arithmeticModifiers);
}

function classifyArgs(args: ReadonlyArray<SqlValue>) {
	const hasUnixEpoch = args.some(a => typeof a === 'string' && a.trim().toLowerCase() === 'unixepoch');

	let timeVal: SqlValue;
	let rawModifiers: SqlValue[];

	if (hasUnixEpoch && typeof args[0] === 'string' && args[0].trim().toLowerCase() === 'unixepoch') {
		timeVal = args.length > 1 ? args[1] : null;
		rawModifiers = args.slice(2) as SqlValue[];
	} else {
		timeVal = args[0];
		rawModifiers = args.slice(1) as SqlValue[];
	}

	let targetTimeZoneId = 'UTC';
	let subsec = false;
	const arithmeticModifiers: string[] = [];

	for (const mod of rawModifiers) {
		if (typeof mod !== 'string') continue;
		const lower = mod.trim().toLowerCase() as ControlModifier;
		if (lower === 'unixepoch') continue;
		if (lower === 'localtime') { targetTimeZoneId = Temporal.Now.timeZoneId(); continue; }
		if (lower === 'utc') { targetTimeZoneId = 'UTC'; continue; }
		if (lower === 'subsec') { subsec = true; continue; }
		arithmeticModifiers.push(mod);
	}

	const isUnixEpoch = hasUnixEpoch && typeof timeVal === 'number';

	return { timeVal, isUnixEpoch, subsec, targetTimeZoneId, arithmeticModifiers };
}

function convertTimezone(dt: Temporal.ZonedDateTime, targetTimeZoneId: string): Temporal.ZonedDateTime | null {
	if (targetTimeZoneId === dt.timeZoneId) return dt;
	try {
		return dt.toInstant().toZonedDateTimeISO(targetTimeZoneId);
	} catch (e) {
		warnLog('Failed to convert to timezone "%s": %O', targetTimeZoneId, e);
		return null;
	}
}

function applyModifiers(dt: Temporal.ZonedDateTime, modifiers: string[]): Temporal.ZonedDateTime | null {
	let current = dt;
	for (const modifier of modifiers) {
		try {
			current = applyTemporalModifier(current, modifier);
		} catch (e) {
			warnLog('Error applying modifier "%s": %O', modifier, e);
			return null;
		}
	}
	return current;
}

// --- Epoch Conversion Helpers --- //

function toEpochSeconds(dt: Temporal.ZonedDateTime): number {
	return Math.floor(dt.epochMilliseconds / MILLIS_PER_SECOND);
}

function toEpochMilliseconds(dt: Temporal.ZonedDateTime): number {
	return dt.epochMilliseconds;
}

function toEpochSecondsFractional(dt: Temporal.ZonedDateTime): number {
	return dt.epochMilliseconds / MILLIS_PER_SECOND;
}

function toJulianDay(dt: Temporal.ZonedDateTime): number {
	return (dt.toInstant().epochMilliseconds / MILLIS_PER_DAY) + JULIAN_DAY_UNIX_EPOCH;
}

// --- Formatting Helpers --- //

function formatDate(dt: Temporal.ZonedDateTime): string {
	return dt.toPlainDate().toString();
}

function formatTime(dt: Temporal.ZonedDateTime, subsec: boolean): string {
	if (subsec) return dt.toPlainTime().toString({ smallestUnit: 'millisecond' });
	return dt.toPlainTime().toString({ smallestUnit: 'second' });
}

function formatDateTime(dt: Temporal.ZonedDateTime, subsec: boolean): string {
	return `${formatDate(dt)} ${formatTime(dt, subsec)}`;
}

// --- Function Implementations --- //

// All date/time functions are non-deterministic because they accept 'now'.

// TEXT, not DATE / TIME / DATETIME, for the three variadic modifier-accepting forms
// below — a deliberate divergence from their single-argument conversion siblings
// (`date/1`, `time/1`, `datetime/1` in conversion.ts), which DO declare the temporal
// types. These functions emit SQLite's *display* spelling, which is not the canonical
// stored spelling of those types:
//   - datetime() separates date and time with a SPACE; DATETIME_TYPE.parse canonicalizes
//     to the ISO 'T' form.
//   - time(..., 'subsec') always emits three fractional digits ('12:00:00.000');
//     TIME_TYPE.parse trims them ('12:00:00').
// Declaring the temporal type would tell buildRowCoercion the value is already in
// declared form, so `insert into t(dt) select datetime(x, '+1 day')` would store the
// display spelling verbatim into a DATETIME column — where `compare` is binary text, so
// the row would stop matching the canonical spelling every other write produces.
// `date()` alone is canonical (YYYY-MM-DD either way), but typing it apart from its two
// siblings is a worse trap than typing all three the same. Reconciling the two families
// (canonicalize the output, or teach the write path) is tracked by
// `debt-variadic-datetime-functions-not-temporally-typed`.
export const dateFunc = createScalarFunction(
	{ name: 'date', numArgs: -1, deterministic: false, returnType: TEXT_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const { dt } = processDateTimeArgs(args);
		return dt ? formatDate(dt) : null;
	}
);

export const timeFunc = createScalarFunction(
	{ name: 'time', numArgs: -1, deterministic: false, returnType: TEXT_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const { dt, subsec } = processDateTimeArgs(args);
		return dt ? formatTime(dt, subsec) : null;
	}
);

export const datetimeFunc = createScalarFunction(
	{ name: 'datetime', numArgs: -1, deterministic: false, returnType: TEXT_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const { dt, subsec } = processDateTimeArgs(args);
		return dt ? formatDateTime(dt, subsec) : null;
	}
);

export const juliandayFunc = createScalarFunction(
	{ name: 'julianday', numArgs: -1, deterministic: false, returnType: REAL_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const { dt } = processDateTimeArgs(args);
		return dt ? toJulianDay(dt) : null;
	}
);

// --- Epoch Functions --- //

/**
 * epoch_s(timestring, modifier, ...)
 * Returns INTEGER Unix epoch seconds. Accepts only ISO 8601 strings and 'now';
 * rejects bare numbers to avoid ambiguity. All epoch outputs are UTC-based:
 * the 'localtime' modifier affects how the timestring is interpreted and
 * modifiers applied, but the returned value is always seconds since
 * 1970-01-01 00:00:00 UTC.
 */
export const epochSFunc = createScalarFunction(
	{ name: 'epoch_s', numArgs: -1, deterministic: false, returnType: INTEGER_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const dt = processStrictArgs(args);
		return dt ? toEpochSeconds(dt) : null;
	}
);

/**
 * epoch_ms(timestring, modifier, ...)
 * Returns INTEGER Unix epoch milliseconds. Same strict parsing as epoch_s.
 * Epoch values are always relative to UTC regardless of timezone modifiers.
 */
export const epochMsFunc = createScalarFunction(
	{ name: 'epoch_ms', numArgs: -1, deterministic: false, returnType: INTEGER_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const dt = processStrictArgs(args);
		return dt ? toEpochMilliseconds(dt) : null;
	}
);

/**
 * epoch_s_frac(timestring, modifier, ...)
 * Returns REAL Unix epoch seconds with fractional (millisecond) precision.
 * Same strict parsing as epoch_s. Use epoch_s() when integer precision suffices.
 */
export const epochSFracFunc = createScalarFunction(
	{ name: 'epoch_s_frac', numArgs: -1, deterministic: false, returnType: REAL_RETURN },
	(...args: SqlValue[]): SqlValue => {
		const dt = processStrictArgs(args);
		return dt ? toEpochSecondsFractional(dt) : null;
	}
);

// --- strftime --- //

const ABBREVIATED_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string { return n.toString().padStart(2, '0'); }
function pad3(n: number): string { return n.toString().padStart(3, '0'); }
function pad4(n: number): string { return n.toString().padStart(4, '0'); }
function space2(n: number): string { return n.toString().padStart(2, ' '); }
function hour12(h: number): number { return h % 12 || 12; }

function formatStrftimeSpecifier(spec: string, dt: Temporal.ZonedDateTime): string {
	switch (spec) {
		// Date
		case '%Y': return pad4(dt.year);
		case '%m': return pad2(dt.month);
		case '%d': return pad2(dt.day);
		case '%j': return pad3(dt.dayOfYear);
		case '%F': return `${pad4(dt.year)}-${pad2(dt.month)}-${pad2(dt.day)}`;
		case '%D': return `${pad2(dt.month)}/${pad2(dt.day)}/${dt.year.toString().slice(-2)}`;
		case '%C': return pad2(Math.floor(dt.year / 100));
		case '%y': return dt.year.toString().slice(-2);
		case '%h': return ABBREVIATED_MONTHS[dt.month - 1];
		case '%e': return space2(dt.day);

		// Time
		case '%H': return pad2(dt.hour);
		case '%M': return pad2(dt.minute);
		case '%S': return pad2(dt.second);
		case '%f': return `.${pad3(dt.millisecond)}`;
		case '%s': return toEpochSeconds(dt).toString();
		case '%I': return pad2(hour12(dt.hour));
		case '%k': return space2(dt.hour);
		case '%l': return space2(hour12(dt.hour));
		case '%p': return dt.hour < 12 ? 'AM' : 'PM';
		case '%P': return dt.hour < 12 ? 'am' : 'pm';
		case '%T': return `${pad2(dt.hour)}:${pad2(dt.minute)}:${pad2(dt.second)}`;
		case '%R': return `${pad2(dt.hour)}:${pad2(dt.minute)}`;
		case '%r': return `${pad2(hour12(dt.hour))}:${pad2(dt.minute)}:${pad2(dt.second)} ${dt.hour < 12 ? 'AM' : 'PM'}`;

		// Weekday / Week Number
		case '%w': return (dt.dayOfWeek % 7).toString();
		case '%u': return dt.dayOfWeek.toString();
		case '%W':
			warnLog('strftime %%W not fully implemented');
			return pad2(dt.weekOfYear ?? 0);
		case '%V': return pad2(dt.weekOfYear ?? 0);
		case '%g': return (dt.yearOfWeek ?? dt.year).toString().slice(-2);
		case '%G': return pad4(dt.yearOfWeek ?? dt.year);

		// Julian Day
		case '%J': return toJulianDay(dt).toString();

		// Epoch (new specifiers)
		case '%E': return toEpochSeconds(dt).toString();
		case '%Q': return toEpochMilliseconds(dt).toString();

		// Timezone
		case '%z': {
			const sign = dt.offset.startsWith('-') ? '-' : '+';
			const parts = dt.offset.substring(1).split(':');
			return `${sign}${parts[0].padStart(2, '0')}${parts[1]?.padStart(2, '0') ?? '00'}`;
		}

		// Literal Percent
		case '%%': return '%';

		default:
			warnLog(`Unsupported strftime specifier: ${spec}`);
			return spec;
	}
}

export const strftimeFunc = createScalarFunction(
	{ name: 'strftime', numArgs: -1, deterministic: false, returnType: TEXT_RETURN },
	(format: SqlValue, ...timeArgs: SqlValue[]): SqlValue => {
		if (typeof format !== 'string') return null;
		const { dt } = processDateTimeArgs(timeArgs);
		if (!dt) return null;

		try {
			return format.replace(/%./g, (spec) => formatStrftimeSpecifier(spec, dt));
		} catch (e) {
			errorLog('Error during strftime formatting: %O', e);
			return null;
		}
	}
);

// --- ISO Validation Functions --- //

export const isISODateFunc = createScalarFunction(
	{ name: 'IsISODate', numArgs: 1, deterministic: true, returnType: BOOLEAN_RETURN_NOT_NULL },
	(value: SqlValue): SqlValue => {
		if (typeof value !== 'string') return false;
		const s = value.trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
		const d = tryParse(() => Temporal.PlainDate.from(s));
		return d !== null && d.toString() === s;
	}
);

export const isISODateTimeFunc = createScalarFunction(
	{ name: 'IsISODateTime', numArgs: 1, deterministic: true, returnType: BOOLEAN_RETURN_NOT_NULL },
	(value: SqlValue): SqlValue => {
		if (typeof value !== 'string') return false;
		const s = value.trim();
		const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
		if (!re.test(s)) return false;
		const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(s);
		if (hasZone) return tryParse(() => Temporal.Instant.from(s)) !== null;
		return tryParse(() => Temporal.PlainDateTime.from(s)) !== null;
	}
);
