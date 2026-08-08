import type { SqlValue } from '../common/types.js';

/**
 * SQL type coercion utilities.
 * Different SQL contexts have different coercion rules.
 */

/**
 * Attempts to convert a value to a number if it's a numeric string.
 * Returns the original value if conversion is not appropriate.
 * Used for comparison contexts where numeric strings should be treated as numbers.
 */
export function tryCoerceToNumber(value: SqlValue): SqlValue {
	if (typeof value === 'string' && value.trim() !== '') {
		// Try to parse as number
		const trimmed = value.trim();
		const asNumber = Number(trimmed);
		if (!isNaN(asNumber) && isFinite(asNumber)) {
			return asNumber;
		}
	}
	return value;
}

/**
 * Converts a value to a number for arithmetic contexts.
 * Non-numeric strings become 0 (SQL arithmetic semantics).
 * Used for +, -, *, /, % operations.
 *
 * NOTE: return type is `number`, so a numeric string past
 * Number.MAX_SAFE_INTEGER (e.g. `'9007199254740993' + 0`) rounds here —
 * unlike CAST/comparison, which go through INTEGER_TYPE.parse/NUMERIC_TYPE.parse
 * (types/builtin-types.ts) and preserve exact bigint precision past 2^53. Fixing
 * this means widening this function's return type to `number | bigint` and
 * propagating that into mixedBigIntArithmetic (runtime/emit/binary.ts) — separate
 * blast radius from the CAST/comparison/insert fix this note sits next to.
 */
export function coerceToNumberForArithmetic(value: SqlValue): number {
	if (typeof value === 'number') {
		return value;
	} else if (typeof value === 'boolean') {
		return value ? 1 : 0;
	} else if (typeof value === 'string') {
		const parsed = Number(value.trim());
		return isNaN(parsed) ? 0 : parsed; // Non-numeric strings become 0
	} else {
		return 0; // Blobs, null, etc. become 0
	}
}

/**
 * Performs SQL type coercion for comparison operations.
 * If one operand is numeric and the other is text that can be converted to a number,
 * converts the text to a number before comparison.
 *
 * @deprecated Cross-category coercion is now inserted at plan time via explicit
 * CastNodes in the planner. This function is no longer called from comparison or
 * BETWEEN emission and will be removed in a future release.
 */
export function coerceForComparison(v1: SqlValue, v2: SqlValue): [SqlValue, SqlValue] {
	// If either value is null, no coercion needed
	if (v1 === null || v2 === null) {
		return [v1, v2];
	}

	const v1IsNumeric = typeof v1 === 'number' || typeof v1 === 'bigint' || typeof v1 === 'boolean';
	const v2IsNumeric = typeof v2 === 'number' || typeof v2 === 'bigint' || typeof v2 === 'boolean';
	const v1IsText = typeof v1 === 'string';
	const v2IsText = typeof v2 === 'string';

	// Case 1: v1 is numeric, v2 is text -> try to convert v2 to numeric
	if (v1IsNumeric && v2IsText) {
		const coercedV2 = tryCoerceToNumber(v2);
		return [v1, coercedV2];
	}

	// Case 2: v1 is text, v2 is numeric -> try to convert v1 to numeric
	if (v1IsText && v2IsNumeric) {
		const coercedV1 = tryCoerceToNumber(v1);
		return [coercedV1, v2];
	}

	// No coercion needed or possible
	return [v1, v2];
}

/** Aggregates that never want their argument read as a number. */
const NON_NUMERIC_AGGREGATES = new Set(['COUNT', 'GROUP_CONCAT']);

/**
 * Does this aggregate read its arguments numerically? False for COUNT, GROUP_CONCAT and
 * the `JSON_*` family, which take their arguments as-is.
 *
 * Split out so the routing decision has one home: the aggregate emitters resolve it once
 * per call site at emit time (`computeAggregateValueTransforms`,
 * runtime/emit/aggregate-setup.ts) rather than per row, and must reach the same verdict
 * this function does.
 */
export function aggregateCoercesArguments(functionName: string): boolean {
	const upperName = functionName.toUpperCase();
	return !NON_NUMERIC_AGGREGATES.has(upperName) && !upperName.startsWith('JSON_');
}

/**
 * The value-level half of aggregate-argument coercion: a numeric-looking string becomes
 * a number, everything else passes through. Callers that have already established the
 * aggregate coerces at all (see {@link aggregateCoercesArguments}) use this directly.
 *
 * NOTE: this converts a numeric-looking string for min/max too, so `min('5','10')`
 * over a plain TEXT column returns the NUMBER 5 — disagreeing with
 * `order by … limit 1`, which keeps text order. Predates the semantic-ordering
 * min/max binding and is unchanged by it (the emitters skip the transform entirely when
 * every argument type is numeric or carries semantic ordering). Tracked as backlog
 * `bug-text-minmax-numeric-coercion`.
 */
export function coerceAggregateValue(value: SqlValue): SqlValue {
	return typeof value === 'string' && value.trim() !== '' ? tryCoerceToNumber(value) : value;
}

/**
 * Coerces a value for aggregate function arguments.
 * Most aggregate functions should accept numeric strings as numbers.
 * For COUNT, no coercion needed. For SUM/AVG, numeric strings should be converted.
 */
export function coerceForAggregate(value: SqlValue, functionName: string): SqlValue {
	return aggregateCoercesArguments(functionName) ? coerceAggregateValue(value) : value;
}

/**
 * Determines if a value should be treated as numeric in the given context.
 */
export function isNumericValue(value: SqlValue): boolean {
	if (value === null) return false;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
		return true;
	}
	if (typeof value === 'string') {
		return tryCoerceToNumber(value) !== value;
	}
	return false;
}
