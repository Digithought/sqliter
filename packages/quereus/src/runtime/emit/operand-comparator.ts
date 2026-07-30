import type { SqlValue } from "../../common/types.js";
import type { ScalarType } from "../../common/datatype.js";
import { compareSqlValuesFast, createTypedComparator, hasSemanticOrdering } from "../../util/comparison.js";
import type { CollationFunction, LogicalType } from "../../types/logical-type.js";
import { castedScalarType, lenientCast } from "../../types/cast-semantics.js";
import { comparisonGroupCoercions, comparisonGroupIndices } from "../../types/comparison-coercion.js";
import { tryTemporalCompare } from "./temporal-arithmetic.js";

/** Three-way comparison of a probe value against one operand value. */
export type OperandComparator = (probe: SqlValue, operand: SqlValue) => number;

/**
 * Comparator for a group of declared operand types that are all compared against
 * one another, selecting the SAME path `emitComparisonOp` would select for the
 * equivalent binary comparison, so every comparison construct and its desugared
 * form agree:
 *  - every operand declares the same semantic-ordering type (TIMESPAN, JSON) ⇒ that
 *    type's compare, matching the operator's typed fast path;
 *  - no operand is temporal and all share a category (all numeric or all textual) ⇒
 *    plain storage-class + collation compare, matching the operator's same-category
 *    fast path. Notably a plain TEXT column holding duration-shaped text ('PT30M')
 *    stays text-ordered here, exactly as `>=` leaves it;
 *  - otherwise ⇒ a runtime duration check first, matching the operator's generic path.
 *    This is what makes `greatest(timespan_col, 'PT30M')` rank by elapsed time even
 *    though the literal declares TEXT.
 *
 * This is THE one copy of the routing rule — {@link makeOperandComparator} is the
 * two-operand case of it — so BETWEEN, `=`, simple CASE and the comparison builtins
 * cannot drift apart. The collation must already be resolved through the shared
 * provenance lattice (`planner/analysis/comparison-collation.ts`) by the caller.
 */
export function makeGroupComparator(
	logicals: readonly LogicalType[],
	collationFunc: CollationFunction,
): OperandComparator {
	const first = logicals[0];
	if (first && logicals.every(l => l === first) && hasSemanticOrdering(first)) {
		return createTypedComparator(first, collationFunc);
	}

	const needsTemporalCheck = logicals.some(l => l.isTemporal);
	const sameCategory = logicals.every(l => l.isNumeric) || logicals.every(l => l.isTextual);
	if (!needsTemporalCheck && sameCategory) {
		return (a, b) => compareSqlValuesFast(a, b, collationFunc);
	}

	return (a, b) => tryTemporalCompare(a, b) ?? compareSqlValuesFast(a, b, collationFunc);
}

/**
 * Comparator for ONE operand of a "probe against N independently-typed operands"
 * construct (a BETWEEN bound, a simple-CASE WHEN value, a `nullif` pair) — the
 * two-operand case of {@link makeGroupComparator}.
 */
export function makeOperandComparator(
	probeLogical: LogicalType,
	operandLogical: LogicalType,
	collationFunc: CollationFunction,
): OperandComparator {
	return makeGroupComparator([probeLogical, operandLogical], collationFunc);
}

/**
 * A comparison builtin's argument group with its cross-type coercion resolved at
 * emit time rather than by a plan-time cast, for the builtins that *return* one of
 * their arguments (`nullif`, `greatest`, `least` — see
 * {@link import('../../schema/function.js').BaseFunctionSchema.returnsArg}).
 * Rewriting such an argument with a `CastNode` would replace the returned value
 * too, so `greatest(t, 1)` handed back the integer 3 for the stored text '3', and
 * `least('abc', 1)` handed back `0` — a value that was never an argument.
 */
export interface ComparisonGroup {
	/** Effective operand types after coercion — collation and comparator routing read these. */
	readonly types: readonly ScalarType[];
	/** The comparison key for the operand at `index`; the value itself when it does not convert. */
	key(index: number, value: SqlValue): SqlValue;
}

/**
 * Resolve a comparison group's per-operand conversion ONCE at emit time.
 *
 * The conversion decision is {@link comparisonGroupCoercions} — the same rule the
 * plan-time rewrite reads — and the per-row conversion is
 * {@link import('../../types/cast-semantics.js').lenientCast}, which is what a
 * plan-time `CastNode` runs anyway. So the comparison a coerced key takes part in
 * is byte-identical to the one the cast operand took part in; only the *returned*
 * value differs, and that is the point.
 *
 * Positions outside the declared group are identity in both `types` and `key`, so
 * a future function with a partial group needs no second code path.
 */
export function makeComparisonGroup(
	operandTypes: readonly ScalarType[],
	comparesArgs: 'all' | readonly number[],
): ComparisonGroup {
	const targets: (LogicalType | null)[] = operandTypes.map(() => null);
	const indices = comparisonGroupIndices(comparesArgs, operandTypes.length);
	if (indices.length >= 2) {
		const coercions = comparisonGroupCoercions(indices.map(i => operandTypes[i].logicalType));
		indices.forEach((argIdx, groupPos) => { targets[argIdx] = coercions[groupPos]; });
	}

	const types = operandTypes.map((operandType, i) => {
		const target = targets[i];
		return target ? castedScalarType(operandType, target) : operandType;
	});

	return {
		types,
		key(index: number, value: SqlValue): SqlValue {
			const target = targets[index];
			return target ? lenientCast(value, target) : value;
		},
	};
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
