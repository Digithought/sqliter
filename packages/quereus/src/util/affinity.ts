import type { SqlValue } from '../common/types.js';
import { valueToText } from './value-text.js';

// NOTE: nothing in src/ imports this module today, and it is not re-exported from the
// package index — the engine reaches type conversion through LogicalType.parse and
// types/cast-semantics.ts instead, and these SQLite-affinity helpers are left over from
// an earlier model. They are kept (and kept correct — applyTextAffinity shares the one
// value-to-text rule) rather than deleted, because affinity is still the documented
// SQLite behaviour a declared-type coercion path would need. If a release ever needs to
// shrink the surface, deleting this module is a safe call; if a caller appears, the
// blob-passthrough contract below is the part to preserve.

/**
 * Attempts to parse a string as an integer according to SQLite rules.
 * Ignores leading/trailing whitespace. Stops at the first non-digit.
 * Returns null if the string doesn't represent a valid integer start.
 */
function tryParseInt(str: string): bigint | number | null {
	str = str.trim();
	if (!str) return null;
	const sign = str.startsWith('-') ? -1 : str.startsWith('+') ? 1 : 1;
	if (sign !== 1) str = str.substring(1);

	let numStr = '';
	for (let i = 0; i < str.length; i++) {
		if (str[i] >= '0' && str[i] <= '9') {
			numStr += str[i];
		} else {
			break;
		}
	}

	if (!numStr) return null;

	// Check if we consumed the entire string (meaning it's a pure integer)
	const remainingStr = str.substring(numStr.length);
	if (remainingStr) {
		// If there are remaining characters (like '.99'), this is not a pure integer
		return null;
	}

	try {
		const bigIntValue = BigInt(numStr) * BigInt(sign);
		if (bigIntValue >= Number.MIN_SAFE_INTEGER && bigIntValue <= Number.MAX_SAFE_INTEGER) {
			return Number(bigIntValue);
		}
		return bigIntValue;
	} catch {
		return null;
	}
}

/**
 * Attempts to parse a string as a floating-point number.
 * Returns null if the string doesn't represent a valid number.
 * This is used for affinity conversion, not explicit casting.
 */
export function tryParseReal(s: string): number | null {
	if (s === null || s === undefined || s.trim() === '') return null;

	const num = parseFloat(s);
	// For affinity conversion (not explicit casting), non-numeric strings should be preserved
	// by returning null. The 0.0 conversion only applies to explicit CAST operations.
	return isNaN(num) ? null : num;
}

/**
 * Applies SQLite INTEGER affinity to a value.
 * Converts numeric strings to integers, rounds non-integer numbers toward zero.
 */
export function applyIntegerAffinity(value: SqlValue): SqlValue {
	if (value === null || typeof value === 'bigint') return value;
	if (typeof value === 'number') {
		const intVal = Math.trunc(value);
		if (intVal >= Number.MIN_SAFE_INTEGER && intVal <= Number.MAX_SAFE_INTEGER) {
			return intVal;
		} else {
			try {
				return BigInt(intVal);
			} catch {
				return value;
			}
		}
	}
	if (typeof value === 'string') {
		const intAttempt = tryParseInt(value);
		if (intAttempt !== null) return intAttempt;
		const realAttempt = tryParseReal(value);
		if (realAttempt !== null) {
			return applyIntegerAffinity(realAttempt);
		}
		return null;
	}
	if (value instanceof Uint8Array) {
		return null;
	}
	return value;
}

/**
 * Applies SQLite REAL affinity to a value.
 * Converts numeric strings and integers to floating point numbers.
 */
export function applyRealAffinity(value: SqlValue): SqlValue {
	if (value === null) return null;
	if (typeof value === 'number' || typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'string') {
		return tryParseReal(value);
	}
	if (value instanceof Uint8Array) {
		return null;
	}
	return value;
}

/**
 * Applies SQLite NUMERIC affinity to a value.
 * Attempts to convert strings to INTEGER first, then REAL if INTEGER fails.
 * BLOBs remain unchanged.
 */
export function applyNumericAffinity(value: SqlValue): SqlValue {
	if (value === null || typeof value === 'number' || typeof value === 'bigint') {
		return value;
	}
	if (typeof value === 'string') {
		const intAttempt = tryParseInt(value);
		if (intAttempt !== null) return intAttempt;
		const realAttempt = tryParseReal(value);
		if (realAttempt !== null) return realAttempt;
		return value;
	}
	if (value instanceof Uint8Array) {
		return value;
	}
	return value;
}

/**
 * Applies SQLite TEXT affinity to a value.
 * Converts every other storage class through the shared value-to-text rule,
 * leaves BLOBs unchanged.
 */
export function applyTextAffinity(value: SqlValue): SqlValue {
	if (value === null || typeof value === 'string') return value;
	// SQLite's TEXT affinity does NOT convert a blob — it stays in the BLOB storage
	// class. That is a different question from "render this value as text", so this
	// early return must survive: folding it into valueToText would silently rewrite
	// stored blobs in TEXT-affinity columns.
	if (value instanceof Uint8Array) {
		return value;
	}
	return valueToText(value);
}

/**
 * Applies SQLite BLOB affinity to a value.
 * This is essentially a no-op in SQLite terms.
 */
export function applyBlobAffinity(value: SqlValue): SqlValue {
	return value;
}
