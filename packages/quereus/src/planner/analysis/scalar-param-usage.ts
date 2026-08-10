import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { BinaryOpNode, CastNode, BetweenNode } from '../nodes/scalar.js';
import { InNode } from '../nodes/subquery.js';
import { ParameterReferenceNode } from '../nodes/reference.js';
import { PhysicalType } from '../../types/logical-type.js';

/**
 * Comparison operators whose runtime compares operands by storage class
 * (`emitComparisonOp` in runtime/emit/binary.ts). An array/object value on one
 * side and a scalar on the other can never be equal/ordered — the OBJECT
 * storage class sorts above every scalar — so the predicate silently matches
 * nothing. `IS` / `IS NOT` are null-safe and intentionally excluded.
 */
const SCALAR_COMPARISON_OPS = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=']);

/** A non-object scalar physical type — INTEGER / REAL / TEXT / BLOB / BOOLEAN. */
function isScalarPhysical(pt: PhysicalType | undefined): boolean {
	return pt === PhysicalType.INTEGER
		|| pt === PhysicalType.REAL
		|| pt === PhysicalType.TEXT
		|| pt === PhysicalType.BLOB
		|| pt === PhysicalType.BOOLEAN;
}

/** Unwrap `CastNode` wrappers and return the parameter ref if the operand is statically one. */
function paramOperand(node: ScalarPlanNode): ParameterReferenceNode | undefined {
	let cur: ScalarPlanNode = node;
	while (cur instanceof CastNode) cur = cur.operand;
	return cur instanceof ParameterReferenceNode ? cur : undefined;
}

/** A comparison counterpart that is statically a non-object scalar value. */
function isScalarCounterpart(node: ScalarPlanNode): boolean {
	return isScalarPhysical(node.getType().logicalType.physicalType);
}

/**
 * Record `operand` as scalar-required (keyed by its parameter name/index) when
 * it is a parameter reference compared against any definitely-scalar counterpart.
 */
function consider(operand: ScalarPlanNode, counterparts: ScalarPlanNode[], out: Set<string | number>): void {
	const param = paramOperand(operand);
	if (param && counterparts.some(isScalarCounterpart)) {
		out.add(param.nameOrIndex);
	}
}

/**
 * Walk a (logical) plan tree and collect the set of parameter names/indices
 * that are used directly (through `CAST`s) as a comparand in a scalar comparison
 * (`= <> < <= > >=`, `IN`, `BETWEEN`) against a non-object scalar operand.
 *
 * Binding such a parameter to a JS array / plain object can never match — the
 * OBJECT storage class sorts above every scalar — so the caller rejects it at
 * bind time ({@link Statement.validateParameterTypes}) rather than letting the
 * query silently return no rows. This replaces the per-row runtime predicate
 * guard, keeping the hot comparison path untouched.
 *
 * Must walk the *logical* plan: a `col = ?` predicate is still a `BinaryOpNode`
 * there (the access-path optimizer later folds it into an index seek, erasing
 * the comparison node). The JSON-vs-JSON case is excluded via the
 * counterpart-type check, so this never over-fires on a legitimate query
 * (`jsoncol = :p` with a JSON-bound `:p` stays allowed).
 */
export function collectScalarRequiredParams(plan: PlanNode): Set<string | number> {
	const out = new Set<string | number>();
	plan.visit((node) => {
		if (node instanceof BinaryOpNode) {
			if (!SCALAR_COMPARISON_OPS.has(node.expression.operator.toUpperCase())) return;
			consider(node.left, [node.right], out);
			consider(node.right, [node.left], out);
		} else if (node instanceof BetweenNode) {
			consider(node.expr, [node.lower, node.upper], out);
			consider(node.lower, [node.expr], out);
			consider(node.upper, [node.expr], out);
		} else if (node instanceof InNode) {
			const values = node.values ?? [];
			// The LHS condition is compared against each RHS element (value list)
			// or the subquery's single output column.
			const condParam = paramOperand(node.condition);
			if (condParam) {
				const subColScalar = node.source
					? isScalarPhysical(node.source.getType().columns[0]?.type.logicalType.physicalType)
					: false;
				if (subColScalar || values.some(isScalarCounterpart)) {
					out.add(condParam.nameOrIndex);
				}
			}
			// Each value-list element is compared against the LHS condition.
			for (const value of values) {
				consider(value, [node.condition], out);
			}
		}
	});
	return out;
}
