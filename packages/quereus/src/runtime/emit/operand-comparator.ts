import type { SqlValue } from "../../common/types.js";
import { compareSqlValuesFast, createTypedComparator, hasSemanticOrdering } from "../../util/comparison.js";
import type { CollationFunction, LogicalType } from "../../types/logical-type.js";
import { tryTemporalCompare } from "./temporal-arithmetic.js";

/** Three-way comparison of a probe value against one operand value. */
export type OperandComparator = (probe: SqlValue, operand: SqlValue) => number;

/**
 * Comparator for ONE operand of a "probe against N independently-typed operands"
 * construct (a BETWEEN bound, a simple-CASE WHEN value), selecting the SAME path
 * `emitComparisonOp` would select for the equivalent binary comparison, so those
 * constructs and their desugared forms never disagree:
 *  - both sides declare the same semantic-ordering type (TIMESPAN, JSON) ⇒ the type's
 *    compare, matching the operator's typed fast path;
 *  - neither side is temporal and both share a category (numeric/numeric or
 *    textual/textual) ⇒ plain storage-class + collation compare, matching the
 *    operator's same-category fast path. Notably a plain TEXT column holding
 *    duration-shaped text ('PT30M') stays text-ordered here, exactly as `>=` leaves it;
 *  - otherwise ⇒ a runtime duration check first, matching the operator's generic path.
 *
 * This is THE one copy of the routing rule for those sites — `between.ts` and
 * `case.ts` both call it, so BETWEEN, `=` and simple CASE cannot drift apart.
 * The collation must already be resolved through the shared provenance lattice
 * (`planner/analysis/comparison-collation.ts`) by the caller.
 */
export function makeOperandComparator(
	probeLogical: LogicalType,
	operandLogical: LogicalType,
	collationFunc: CollationFunction,
): OperandComparator {
	if (probeLogical === operandLogical && hasSemanticOrdering(probeLogical)) {
		return createTypedComparator(probeLogical, collationFunc);
	}

	const needsTemporalCheck = probeLogical.isTemporal || operandLogical.isTemporal;
	const bothSameCategory = (probeLogical.isNumeric && operandLogical.isNumeric)
		|| (probeLogical.isTextual && operandLogical.isTextual);
	if (!needsTemporalCheck && bothSameCategory) {
		return (probe, operand) => compareSqlValuesFast(probe, operand, collationFunc);
	}

	return (probe, operand) => tryTemporalCompare(probe, operand) ?? compareSqlValuesFast(probe, operand, collationFunc);
}

/**
 * Build the collation suffix for an instruction note over per-operand collations:
 * nothing when every operand resolved to BINARY, a single name when they all agree,
 * or the slash-joined per-operand list when they differ (BETWEEN's `lower/upper`
 * generalizes to a simple CASE's one entry per WHEN clause). So `explain` shows what
 * each operand is actually compared under.
 */
export function formatOperandCollationNote(collationNames: readonly string[]): string {
	if (collationNames.length === 0) return '';
	const first = collationNames[0];
	if (collationNames.every(name => name === first)) {
		return first !== 'BINARY' ? ` ${first}` : '';
	}
	return ` ${collationNames.join('/')}`;
}
