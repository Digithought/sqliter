import type { SqlValue } from "../../common/types.js";
import { TIMESPAN_TYPE } from "../../types/temporal-types.js";
import {
	isTemporalKind,
	runTemporalCase,
	temporalKindOfValue,
	temporalOpCase,
	unsupportedTemporalOp,
} from "../../types/temporal-ops.js";

/**
 * Try to perform temporal arithmetic on two values.
 * Returns the result if successful, or undefined if the values are not temporal types.
 * Throws QuereusError if the operation is invalid.
 *
 * Which combinations exist, what each produces, and what each announces as its result
 * type all live in one table (`types/temporal-ops.ts`) that the planner reads too. This
 * function is the *value-sniffed* entry into that table: it derives both operand kinds
 * from the runtime values, which is the defined behavior whenever the declared types
 * cannot settle the case (a TEXT column holding a duration string, for instance).
 */
export function tryTemporalArithmetic(operator: string, v1: SqlValue, v2: SqlValue): SqlValue | undefined {
	if (v1 === null || v2 === null) return null;

	const lk = temporalKindOfValue(v1);
	const rk = temporalKindOfValue(v2);

	// Neither operand looks temporal — signal "not a temporal operation" so the caller
	// falls through to numeric arithmetic. ('number' is a kind, but not a temporal one.)
	if (!isTemporalKind(lk) && !isTemporalKind(rk)) return undefined;

	const entry = lk && rk ? temporalOpCase(operator, lk, rk) : undefined;
	if (!entry) unsupportedTemporalOp();
	return runTemporalCase(entry, v1, v2);
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
 * NOTE: deliberately NOT given the emit-time specialization `buildNumericOpSpec`'s temporal
 * arm got. The shapes look alike, but the economics do not:
 *  - the per-row cost here is one `startsWith` per operand, not four regexes — TIMESPAN is
 *    the only temporal type whose text order differs from its semantic order, so it is the
 *    only one {@link tryTemporalCompare} probes for;
 *  - `buildComparisonOpSpec` already bypasses this function for the hot case: two operands
 *    of the same semantic-ordering type take the `sharedSemanticType` path
 *    (`=(compare-typed)`) and never reach the generic comparison run;
 *  - what is left is the mixed TIMESPAN-vs-TEXT/ANY shape, where runtime sniffing is the
 *    defined semantics and cannot be resolved from the declared types anyway.
 * Revisit only if a profile shows the generic comparison run hot on temporal operands.
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
	if (temporalKindOfValue(v1) !== 'timespan' || temporalKindOfValue(v2) !== 'timespan') return undefined;
	return TIMESPAN_TYPE.compare!(v1, v2);
}
