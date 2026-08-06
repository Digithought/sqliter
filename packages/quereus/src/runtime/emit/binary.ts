import { StatusCode } from "../../common/types.js";
import { quereusError } from "../../common/errors.js";
import type { SqlValue, MaybePromise } from "../../common/types.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { BinaryOpNode } from "../../planner/nodes/scalar.js";
import { LiteralNode } from "../../planner/nodes/scalar.js";
import type { ScalarPlanNode } from "../../planner/nodes/plan-node.js";
import { hasRelationalDescendant } from "../../planner/analysis/scalar-subqueries.js";
import { emitPlanNode, emitCallFromPlan } from "../emitters.js";
import { compareSqlValuesFast, createTypedComparator, hasSemanticOrdering, isTruthy } from "../../util/comparison.js";
import type { LogicalType } from "../../types/logical-type.js";
import type { CollationFunction } from "../../util/comparison.js";
import { coerceToNumberForArithmetic } from "../../util/coercion.js";
import { valueToText } from "../../util/value-text.js";
import { simpleLike, compileLikeMatcher } from "../../util/patterns.js";
import type { EmissionContext } from "../emission-context.js";
import { tryTemporalArithmetic, tryTemporalComparison } from "./temporal-arithmetic.js";
import { effectiveComparisonCollation } from "../../planner/analysis/comparison-collation.js";

export function emitBinaryOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	// Normalize operator to uppercase for case-insensitive matching of keywords
	const operator = plan.expression.operator.toUpperCase();

	switch (operator) {
		case '+':
		case '-':
		case '*':
		case '/':
		case '%':
			return emitNumericOp(plan, ctx);
		case '=':
		case '==':
		case '!=':
		case '<>':
		case '<':
		case '<=':
		case '>':
		case '>=':
			return emitComparisonOp(plan, ctx);
		case '||':
			return emitConcatOp(plan, ctx);
		case 'AND':
		case 'OR':
		case 'XOR':
			return emitLogicalOp(plan, ctx);
		case 'LIKE':
			return emitLikeOp(plan, ctx);
		// TODO: emitBitwise
		default:
			quereusError(`Unsupported binary operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}
}

/** Handle arithmetic when at least one operand is bigint.
 *  Both bigint → use bigint arithmetic directly.
 *  Mixed (one bigint, one non-bigint):
 *    Non-bigint operand is coerced through SQL arithmetic affinity (string/bool/blob → number).
 *    - integer-valued number → promote to BigInt, stay in bigint domain
 *    - fractional number → demote bigint to Number, use float arithmetic */
function mixedBigIntArithmetic(
	v1: SqlValue, v2: SqlValue,
	inner: (v1: number, v2: number) => number,
	innerBigInt: (v1: bigint, v2: bigint) => bigint
): SqlValue {
	if (typeof v1 === 'bigint' && typeof v2 === 'bigint') {
		try {
			return innerBigInt(v1, v2);
		} catch {
			return null;
		}
	}
	// Mixed: one bigint, one non-bigint. Coerce the non-bigint side through
	// SQL arithmetic affinity so strings/booleans/blobs map to numbers
	// consistently with the non-bigint arithmetic path.
	const v1n: bigint | number = typeof v1 === 'bigint' ? v1 : coerceToNumberForArithmetic(v1);
	const v2n: bigint | number = typeof v2 === 'bigint' ? v2 : coerceToNumberForArithmetic(v2);
	const num = typeof v1n === 'bigint' ? v2n as number : v1n as number;
	if (Number.isInteger(num)) {
		try {
			return innerBigInt(
				typeof v1n === 'bigint' ? v1n : BigInt(v1n),
				typeof v2n === 'bigint' ? v2n : BigInt(v2n)
			);
		} catch {
			// Fall through to float path (e.g., division by zero)
		}
	}
	// Float path: convert bigint → Number, use float arithmetic
	const n1 = typeof v1n === 'bigint' ? Number(v1n) : v1n;
	const n2 = typeof v2n === 'bigint' ? Number(v2n) : v2n;
	const result = inner(n1, n2);
	if (!Number.isFinite(result)) return null;
	return result;
}

export function emitNumericOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	let inner: (v1: number, v2: number) => number;
	let innerBigInt: (v1: bigint, v2: bigint) => bigint;

	switch (plan.expression.operator) {
		case '+':
			inner = (v1, v2) => v1 + v2;
			innerBigInt = (v1, v2) => v1 + v2;
			break;
		case '-':
			inner = (v1, v2) => v1 - v2;
			innerBigInt = (v1, v2) => v1 - v2;
			break;
		case '*':
			inner = (v1, v2) => v1 * v2;
			innerBigInt = (v1, v2) => v1 * v2;
			break;
		case '/':
			inner = (v1, v2) => v1 / v2;
			innerBigInt = (v1, v2) => v1 / v2;
			break;
		case '%':
			inner = (v1, v2) => v1 % v2;
			innerBigInt = (v1, v2) => v1 % v2;
			break;
		default:
			quereusError(`Unsupported numeric operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}

	// Use plan-time type info to select a specialized run function
	const leftLogical = plan.left.getType().logicalType;
	const rightLogical = plan.right.getType().logicalType;

	let run: (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue;
	let note: string;

	if (leftLogical.isTemporal || rightLogical.isTemporal) {
		// Temporal path: must check temporal arithmetic first
		run = function runTemporalArithmetic(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			const temporalResult = tryTemporalArithmetic(plan.expression.operator, v1, v2);
			if (temporalResult !== undefined) {
				return temporalResult;
			}

			if (v1 !== null && v2 !== null) {
				if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
					return mixedBigIntArithmetic(v1, v2, inner, innerBigInt);
				} else {
					const n1 = coerceToNumberForArithmetic(v1);
					const n2 = coerceToNumberForArithmetic(v2);
					try {
						const result = inner(n1, n2);
						if (!Number.isFinite(result)) return null;
						return result;
					} catch {
						return null;
					}
				}
			}
			return null;
		};
		note = `${plan.expression.operator}(temporal)`;
	} else if (leftLogical.isNumeric && rightLogical.isNumeric) {
		// Numeric-only path: skip temporal check and coercion entirely
		run = function runNumericOnly(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			if (v1 !== null && v2 !== null) {
				if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
					return mixedBigIntArithmetic(v1, v2, inner, innerBigInt);
				} else {
					try {
						const result = inner(v1 as number, v2 as number);
						if (!Number.isFinite(result)) return null;
						return result;
					} catch {
						return null;
					}
				}
			}
			return null;
		};
		note = `${plan.expression.operator}(numeric-fast)`;
	} else {
		// Generic path: temporal check + coercion (for TEXT or mixed types)
		run = function runGenericArithmetic(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			const temporalResult = tryTemporalArithmetic(plan.expression.operator, v1, v2);
			if (temporalResult !== undefined) {
				return temporalResult;
			}

			if (v1 !== null && v2 !== null) {
				if (typeof v1 === 'bigint' || typeof v2 === 'bigint') {
					return mixedBigIntArithmetic(v1, v2, inner, innerBigInt);
				} else {
					const n1 = coerceToNumberForArithmetic(v1);
					const n2 = coerceToNumberForArithmetic(v2);
					try {
						const result = inner(n1, n2);
						if (!Number.isFinite(result)) return null;
						return result;
					} catch {
						return null;
					}
				}
			}
			return null;
		};
		note = `${plan.expression.operator}(numeric)`;
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: asRun(run),
		note
	};
}

export function emitComparisonOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	const leftType = plan.left.getType();
	const rightType = plan.right.getType();

	// One shared, symmetric resolution for plan-time facts and runtime behavior
	// (analysis/comparison-collation.ts). The throw inside is an unreachable
	// backstop — BinaryOpNode.generateType already rejected conflicts at plan time.
	const collationName = effectiveComparisonCollation(plan.left, plan.right);

	// Pre-resolve collation function for optimal performance
	const collationFunc = ctx.resolveCollation(collationName);

	const operator = plan.expression.operator;

	// Use plan-time type info to select a specialized comparison path
	const leftLogical = leftType.logicalType;
	const rightLogical = rightType.logicalType;
	const needsTemporalCheck = leftLogical.isTemporal || rightLogical.isTemporal;
	const bothNumeric = leftLogical.isNumeric && rightLogical.isNumeric;
	const bothTextual = leftLogical.isTextual && rightLogical.isTextual;
	const bothSameCategory = bothNumeric || bothTextual;

	let run: (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue;
	let noteTag: string;

	// Both operands declare the SAME logical type with semantic ordering (TIMESPAN,
	// JSON): route the operator through the type's compare so `<`/`>`/`=` agree with
	// ORDER BY and index order (elapsed-time for TIMESPAN, structural for JSON).
	// createTypedComparator keeps the storage-class-mismatch fallback, so a runtime
	// probe of a different storage class orders by class rather than falsely matching.
	// Mixed pairs (typed column vs plain text literal) fall to the generic path below,
	// whose runtime temporal check already handles duration-vs-text semantically.
	const sharedSemanticType = leftLogical === rightLogical && hasSemanticOrdering(leftLogical as LogicalType)
		? leftLogical as LogicalType
		: undefined;

	if (sharedSemanticType) {
		const typedCompare = createTypedComparator(sharedSemanticType, collationFunc);
		const cmpToResult = buildCmpToResult(operator, plan);
		run = function runSemanticTypedCompare(_ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			if (v1 === null || v2 === null) return null;
			return cmpToResult(typedCompare(v1, v2));
		};
		noteTag = 'compare-typed';
	} else if (!needsTemporalCheck && bothSameCategory) {
		// Fast same-category comparison: no temporal check, no coercion needed
		// Use compareSqlValuesFast which handles runtime type mismatches gracefully
		const cmpToResult = buildCmpToResult(operator, plan);
		run = function runSameCategoryCompare(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
			if (v1 === null || v2 === null) return null;
			return cmpToResult(compareSqlValuesFast(v1, v2, collationFunc));
		};
		noteTag = 'compare-fast';
	} else {
		// Generic path: temporal check + coercion
		run = buildGenericComparisonRun(operator, plan, collationFunc);
		noteTag = 'compare';
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: asRun(run),
		note: `${plan.expression.operator}(${noteTag}${collationName !== 'BINARY' ? ` ${collationName}` : ''})`
	};
}

/** Build a function that converts a numeric cmp result to a boolean for the given operator */
function buildCmpToResult(operator: string, plan: BinaryOpNode): (cmp: number) => boolean {
	switch (operator) {
		case '=':
		case '==':
			return (cmp: number) => cmp === 0;
		case '!=':
		case '<>':
			return (cmp: number) => cmp !== 0;
		case '<':
			return (cmp: number) => cmp < 0;
		case '<=':
			return (cmp: number) => cmp <= 0;
		case '>':
			return (cmp: number) => cmp > 0;
		case '>=':
			return (cmp: number) => cmp >= 0;
		default:
			quereusError(`Unsupported comparison operator: ${operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
	}
}

/** Build the generic (unspecialized) comparison run function with temporal check.
 *  Cross-category coercion is handled at plan time via explicit CastNodes,
 *  so no runtime coercion is needed here. */
function buildGenericComparisonRun(
	operator: string,
	plan: BinaryOpNode,
	collationFunc: CollationFunction
): (ctx: RuntimeContext, v1: SqlValue, v2: SqlValue) => SqlValue {
	const cmpToResult = buildCmpToResult(operator, plan);
	return function runGenericComparison(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		if (v1 === null || v2 === null) return null;

		const temporalResult = tryTemporalComparison(operator, v1, v2);
		if (temporalResult !== undefined) return temporalResult;

		return cmpToResult(compareSqlValuesFast(v1, v2, collationFunc));
	};
}

export function emitConcatOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	function run(ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		// SQL concatenation: NULL || anything -> NULL
		if (v1 === null || v2 === null) return null;

		// Convert both operands through the shared value-to-text rule, so `b || ''`
		// spells a blob or a JSON document exactly as `cast(b as text)` does.
		return valueToText(v1) + valueToText(v2);
	}

	const leftExpr = emitPlanNode(plan.left, ctx);
	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: asRun(run),
		note: '||(concat)'
	};
}

export function emitLogicalOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	// Normalize operator to uppercase for case-insensitive matching
	const operator = plan.expression.operator.toUpperCase();

	// SQL three-valued-logic combine — single source of truth shared by the eager
	// `run` and the deferred `runShortCircuit` path, so the two cannot diverge (the
	// parity tests in test/and-or-short-circuit.spec.ts guard exactly this). Coerce
	// non-NULL operands to a boolean using SQL truthiness (isTruthy) rather than JS
	// truthiness so that values like blobs and non-numeric strings agree with how
	// FilterNode/CASE/NOT treat them — otherwise `<blob> AND true` and a bare
	// `<blob>` predicate diverge.
	function combineLogical(v1: SqlValue, v2: SqlValue): SqlValue {
		const b1 = v1 === null ? null : isTruthy(v1);
		const b2 = v2 === null ? null : isTruthy(v2);
		switch (operator) {
			case 'AND': {
				// false dominates; else NULL if any operand is NULL; else true.
				if (b1 === false || b2 === false) return false;
				if (b1 === null || b2 === null) return null;
				return true;
			}

			case 'OR': {
				// true dominates; else NULL if any operand is NULL; else false.
				if (b1 === true || b2 === true) return true;
				if (b1 === null || b2 === null) return null;
				return false;
			}

			case 'XOR': {
				// NULL with anything -> NULL; else logical inequality.
				if (b1 === null || b2 === null) return null;
				return b1 !== b2;
			}

			default:
				quereusError(`Unsupported logical operator: ${plan.expression.operator}`, StatusCode.UNSUPPORTED, undefined, plan.expression);
		}
	}

	// Eager two-param combine. Used for XOR (both operands always required) and for
	// AND/OR whose right operand is cheap (no subquery) — the zero-overhead path.
	function run(_ctx: RuntimeContext, v1: SqlValue, v2: SqlValue): SqlValue {
		return combineLogical(v1, v2);
	}

	const leftExpr = emitPlanNode(plan.left, ctx);

	// Short-circuit deferral: for AND/OR whose right operand contains a subquery
	// (a scalar/IN/EXISTS subquery — a relational descendant), emit the right
	// operand as an on-demand callback and evaluate it lazily, only when the left
	// operand does not already decide the result (`false AND x` → false;
	// `true OR x` → true). This stops an expensive/side-effecting subquery from
	// running on every row for nothing. Left stays eager — it is always needed
	// and always evaluated first, so operand order is unchanged.
	//
	// NOTE: only a *subquery* right operand defers. A non-subquery expensive
	// scalar operand (deeply nested arithmetic, or a volatile/slow UDF called
	// directly rather than inside a subquery) is still evaluated eagerly. Such
	// operands are rare and the dominant expensive case in SQL is the subquery;
	// if a non-subquery volatile/expensive scalar operand ever shows up hot,
	// extend this gate with a cost or volatility check.
	if ((operator === 'AND' || operator === 'OR') && hasRelationalDescendant(plan.right)) {
		const rightCall = emitCallFromPlan(plan.right, ctx);

		function runShortCircuit(
			ctx: RuntimeContext,
			v1: SqlValue,
			rightFn: (ctx: RuntimeContext) => MaybePromise<SqlValue>
		): MaybePromise<SqlValue> {
			// Left decides — the right operand is never fetched (`false AND x` → false;
			// `true OR x` → true). Same SQL truthiness as the eager path.
			const b1 = v1 === null ? null : isTruthy(v1);
			if (operator === 'AND' && b1 === false) return false;
			if (operator === 'OR' && b1 === true) return true;

			// Otherwise fetch the deferred right and combine with the shared 3VL
			// (combineLogical) — byte-identical to the eager path. Stay synchronous
			// when the right sub-program resolves synchronously; only take the
			// microtask hop on a genuinely async subquery (see docs/runtime.md
			// "Avoid a per-row microtask hop on the synchronous fast path"). A
			// left-decides row returned above, so it never pays an async tick.
			const raw = rightFn(ctx);
			return raw instanceof Promise
				? raw.then(v2 => combineLogical(v1, v2))
				: combineLogical(v1, raw);
		}

		return {
			params: [leftExpr, rightCall],
			run: asRun(runShortCircuit),
			note: `${plan.expression.operator}(logical short-circuit)`
		};
	}

	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: asRun(run),
		note: `${plan.expression.operator}(logical)`
	};
}

/**
 * If `node` is a literal-constant, non-NULL pattern, return the exact string the
 * per-row path would derive from it ({@link valueToText}), otherwise undefined.
 * A NULL literal, a not-yet-resolved Promise value, or any non-literal node
 * falls through to the dynamic (memoized) per-row path so semantics are
 * unchanged. Cast/collate-wrapped literals are intentionally NOT unwrapped —
 * emitLikeOp ignores collation, and peeling could silently diverge.
 */
function constLikePattern(node: ScalarPlanNode): string | undefined {
	if (!(node instanceof LiteralNode)) return undefined;
	const value = node.expression.value;
	if (value === null || value === undefined || value instanceof Promise) return undefined;
	return valueToText(value);
}

export function emitLikeOp(plan: BinaryOpNode, ctx: EmissionContext): Instruction {
	const leftExpr = emitPlanNode(plan.left, ctx);

	// Fast path: the pattern operand is a literal constant. Compile the matcher
	// once here at emit time and capture it in the closure, so no per-row compile
	// or cache lookup happens at all. The literal operand is not emitted as a
	// param since its value is already baked into `matcher`.
	const constPattern = constLikePattern(plan.right);
	if (constPattern !== undefined) {
		const matcher = compileLikeMatcher(constPattern);
		function runConstPattern(_ctx: RuntimeContext, text: SqlValue): SqlValue {
			// text LIKE <const>: NULL text → NULL, else run the pre-compiled matcher.
			if (text === null) return null;
			return matcher(valueToText(text));
		}
		return {
			params: [leftExpr],
			run: asRun(runConstPattern),
			note: 'LIKE(like-const)'
		};
	}

	function run(ctx: RuntimeContext, text: SqlValue, pattern: SqlValue): SqlValue {
		// SQL LIKE logic: text LIKE pattern
		// NULL handling: if either operand is NULL, result is NULL
		if (text === null || pattern === null) {
			return null;
		}

		// Convert both operands through the shared value-to-text rule and perform LIKE
		// matching (memoized compile). Must agree with `constLikePattern` above, or the
		// constant-pattern fast path starts answering differently from this one.
		const textStr = valueToText(text);
		const patternStr = valueToText(pattern);

		return simpleLike(patternStr, textStr);
	}

	const rightExpr = emitPlanNode(plan.right, ctx);

	return {
		params: [leftExpr, rightExpr],
		run: asRun(run),
		note: 'LIKE(like)'
	};
}

