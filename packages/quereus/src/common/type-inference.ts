import type { SqlValue } from "./types.js";
import type { LogicalType } from "../types/logical-type.js";
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, BOOLEAN_TYPE } from "../types/builtin-types.js";
import { JSON_TYPE } from "../types/json-type.js";

/**
 * Infer LogicalType from a SqlValue — THE value⇒type mapping (parameter type
 * hints, literal nodes):
 * - null → NULL
 * - number (safe integer) → INTEGER
 * - number (fractional, or whole but past the safe-integer range) → REAL
 * - bigint → INTEGER
 * - boolean → BOOLEAN
 * - string → TEXT
 * - Uint8Array → BLOB
 * - object/array → JSON
 *
 * The integer split is `Number.isSafeInteger`, NOT `Number.isInteger`: INTEGER's
 * value space is safe-integer `number` or out-of-range `bigint`
 * (`INTEGER_TYPE.validate`), and a whole double past 2^53 (`1e308`) inhabits
 * REAL's space as it stands — calling it INTEGER would announce a space the
 * value is not in, and coercing a parameter through `INTEGER_TYPE.parse` would
 * rewrite the float as an exact bigint the caller never bound.
 */
export function inferLogicalTypeFromValue(v: SqlValue): LogicalType {
	if (v === null) return NULL_TYPE;
	if (typeof v === 'number') {
		return Number.isSafeInteger(v) ? INTEGER_TYPE : REAL_TYPE;
	}
	if (typeof v === 'bigint') return INTEGER_TYPE;
	if (typeof v === 'boolean') return BOOLEAN_TYPE;
	if (typeof v === 'string') return TEXT_TYPE;
	if (v instanceof Uint8Array) return BLOB_TYPE;
	if (typeof v === 'object') return JSON_TYPE;
	return BLOB_TYPE;
}
