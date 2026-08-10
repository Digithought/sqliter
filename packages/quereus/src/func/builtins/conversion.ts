import type { SqlValue } from '../../common/types.js';
import { createScalarFunction } from '../registration.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BOOLEAN_TYPE, BLOB_TYPE } from '../../types/builtin-types.js';
import { DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESPAN_TYPE } from '../../types/temporal-types.js';
import { JSON_TYPE } from '../../types/json-type.js';
import { BLOB_RETURN, BOOLEAN_RETURN, INTEGER_RETURN, JSON_RETURN, REAL_RETURN, TEXT_RETURN, scalarReturn } from './return-types.js';

/**
 * integer() - Convert value to INTEGER
 * Usage: integer(value)
 */
export const INTEGER_FUNC = createScalarFunction(
	{ name: 'integer', numArgs: 1, deterministic: true, returnType: INTEGER_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return INTEGER_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to INTEGER: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * real() - Convert value to REAL
 * Usage: real(value)
 */
export const REAL_FUNC = createScalarFunction(
	{ name: 'real', numArgs: 1, deterministic: true, returnType: REAL_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return REAL_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to REAL: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * text() - Convert value to TEXT
 * Usage: text(value)
 */
export const TEXT_FUNC = createScalarFunction(
	{ name: 'text', numArgs: 1, deterministic: true, returnType: TEXT_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return TEXT_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to TEXT: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * blob() - Convert value to BLOB
 * Usage: blob(value)
 */
export const BLOB_FUNC = createScalarFunction(
	{ name: 'blob', numArgs: 1, deterministic: true, returnType: BLOB_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return BLOB_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to BLOB: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * boolean() - Convert value to BOOLEAN
 * Usage: boolean(value)
 */
export const BOOLEAN_FUNC = createScalarFunction(
	{ name: 'boolean', numArgs: 1, deterministic: true, returnType: BOOLEAN_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return BOOLEAN_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to BOOLEAN: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * date() - Convert value to DATE
 * Usage: date(value)
 *
 * Note: This replaces the existing date() function in datetime.ts
 * The old date() function will be renamed to date_now() or similar
 */
export const DATE_FUNC = createScalarFunction(
	{
		name: 'date',
		numArgs: 1,
		deterministic: false,
		returnType: scalarReturn(DATE_TYPE),
		// `date(x) = D` is equivalent to `x` falling inside the half-open day window
		// `[D, D+1)`; the boundary computation lives on the argument's logical type
		// via `bucketBounds('date_bucket', value)`. Only the unary form is annotated —
		// the variadic `dateFunc` in `datetime.ts` accepts arbitrary modifiers that
		// can shift / re-bucket the result, so the rewrite would be unsound there.
		rangeRewriteOnArg: { 0: { kind: 'date_bucket' } },
	},
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		// Special case: 'now' returns current date
		if (value === 'now') {
			const now = new Date();
			const year = now.getUTCFullYear();
			const month = String(now.getUTCMonth() + 1).padStart(2, '0');
			const day = String(now.getUTCDate()).padStart(2, '0');
			return `${year}-${month}-${day}`;
		}

		try {
			return DATE_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to DATE: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * time() - Convert value to TIME
 * Usage: time(value)
 *
 * Note: This replaces the existing time() function in datetime.ts
 */
export const TIME_FUNC = createScalarFunction(
	{ name: 'time', numArgs: 1, deterministic: false, returnType: scalarReturn(TIME_TYPE) },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		// Special case: 'now' returns current time
		if (value === 'now') {
			const now = new Date();
			const hours = String(now.getUTCHours()).padStart(2, '0');
			const minutes = String(now.getUTCMinutes()).padStart(2, '0');
			const seconds = String(now.getUTCSeconds()).padStart(2, '0');
			return `${hours}:${minutes}:${seconds}`;
		}

		try {
			return TIME_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to TIME: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * datetime() - Convert value to DATETIME
 * Usage: datetime(value)
 *
 * Note: This replaces the existing datetime() function in datetime.ts
 */
export const DATETIME_FUNC = createScalarFunction(
	{ name: 'datetime', numArgs: 1, deterministic: false, returnType: scalarReturn(DATETIME_TYPE) },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		// Special case: 'now' returns current datetime
		if (value === 'now') {
			return new Date().toISOString();
		}

		try {
			return DATETIME_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to DATETIME: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * json() - Convert value to JSON
 * Usage: json(value)
 *
 * Converts a value to a native JSON object. If the value is a valid JSON string,
 * it parses it. Otherwise, it converts the value to its JSON representation.
 */
export const JSON_FUNC = createScalarFunction(
	{ name: 'json', numArgs: 1, deterministic: true, returnType: JSON_RETURN },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return JSON_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to JSON: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

/**
 * timespan() - Convert value to TIMESPAN
 * Usage: timespan(value)
 *
 * Accepts:
 * - ISO 8601 duration strings: 'PT1H30M', 'P1D', 'P1Y2M3D'
 * - Human-readable strings: '1 hour', '30 minutes', '2 days 3 hours'
 * - Numeric values (interpreted as seconds): 3600, 86400
 */
export const TIMESPAN_FUNC = createScalarFunction(
	{ name: 'timespan', numArgs: 1, deterministic: true, returnType: scalarReturn(TIMESPAN_TYPE) },
	(value: SqlValue): SqlValue => {
		if (value === null) return null;

		try {
			return TIMESPAN_TYPE.parse!(value);
		} catch (e) {
			throw new QuereusError(
				`Cannot convert to TIMESPAN: ${e instanceof Error ? e.message : String(e)}`,
				StatusCode.MISMATCH
			);
		}
	}
);

