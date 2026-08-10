import type * as AST from '../../parser/ast.js';
import type { Scope } from '../scopes/scope.js';
import { CastNode } from '../nodes/scalar.js';
import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { comparisonGroupCoercions, comparisonGroupIndices, crossTypeCoercion } from '../../types/comparison-coercion.js';

/**
 * Plan-build cross-type coercion for comparison sites. Every construct that
 * compares operands — `=` and friends, BETWEEN, IN value lists, simple CASE,
 * and scalar builtins that declare a comparison group
 * ({@link import('../../schema/function.js').BaseFunctionSchema.comparesArgs}) —
 * reconciles its operands through this one module so none of them can drift
 * from the others.
 *
 * This file owns only the *rewrite*: which operand gets wrapped in a synthetic
 * `CastNode`. The decision of which operand converts and to what lives in
 * `types/comparison-coercion.ts`, shared with the emit-time consumer
 * (`runtime/emit/operand-comparator.ts` `makeComparisonGroup`) that serves the
 * builtins which return one of their arguments and so cannot be rewritten here.
 */

/**
 * Reconcile operands of a comparison whose plan-time types cannot be compared
 * meaningfully as-is, by wrapping one side in a synthetic CastNode.
 * Returns `[left, right]` — possibly with one side replaced by a CastNode.
 *
 * See {@link crossTypeCoercion} for the rule (object-physical vs anything else,
 * then numeric vs textual) and why each side is chosen.
 */
export function insertCrossTypeCoercion(
	scope: Scope,
	left: ScalarPlanNode,
	right: ScalarPlanNode,
): [ScalarPlanNode, ScalarPlanNode] {
	const coercion = crossTypeCoercion(left.getType().logicalType, right.getType().logicalType);
	if (!coercion) return [left, right];
	return coercion.side === 'left'
		? [wrapInCast(scope, left, coercion.target.name), right]
		: [left, wrapInCast(scope, right, coercion.target.name)];
}

/**
 * Apply {@link comparisonGroupCoercions} across the one-probe-against-many-values
 * shape shared by an IN value list, a simple CASE and a scalar builtin's
 * comparison group, so `json_col in ('{"a":1}')`, `int_col in ('1')` and
 * `case int_col when '1' …` all agree with the `=` spelling of the same
 * comparison. See that function for the probe-vs-value asymmetry and the one
 * documented gap it leaves.
 */
export function coerceComparisonSet(
	scope: Scope,
	probe: ScalarPlanNode,
	values: ScalarPlanNode[],
): [ScalarPlanNode, ScalarPlanNode[]] {
	const nodes = [probe, ...values];
	const targets = comparisonGroupCoercions(nodes.map(node => node.getType().logicalType));
	const coerced = nodes.map((node, i) => {
		const target = targets[i];
		return target ? wrapInCast(scope, node, target.name) : node;
	});
	return [coerced[0], coerced.slice(1)];
}

/**
 * Apply {@link coerceComparisonSet} across the argument positions a scalar
 * function declares as one comparison group
 * ({@link import('../../schema/function.js').BaseFunctionSchema.comparesArgs}),
 * so `nullif(json_col, '{"a":1}')` reconciles its operands exactly as
 * `json_col = '{"a":1}'` does. The group's first member plays the probe role and
 * the rest the value-list role; positions outside the argument list are ignored
 * (defensive — a well-formed declaration never names one). Mutates `args` in
 * place, replacing coerced members with their CastNode wrappers.
 *
 * NOT for a function that returns one of its arguments verbatim
 * ({@link import('../../schema/function.js').BaseFunctionSchema.returnsArg}):
 * replacing the argument replaces the *returned value* too. Those go through
 * `makeComparisonGroup` at emit time instead.
 */
export function coerceComparisonGroup(
	scope: Scope,
	comparesArgs: 'all' | readonly number[],
	args: ScalarPlanNode[],
): void {
	const indices = comparisonGroupIndices(comparesArgs, args.length);
	if (indices.length < 2) return;

	const [probeIdx, ...valueIdx] = indices;
	const [probe, values] = coerceComparisonSet(scope, args[probeIdx], valueIdx.map(i => args[i]));
	args[probeIdx] = probe;
	valueIdx.forEach((argIdx, j) => { args[argIdx] = values[j]; });
}

/** Create a synthetic CastNode wrapping `operand` with the given target type name. */
export function wrapInCast(
	scope: Scope,
	operand: ScalarPlanNode,
	targetType: string,
): CastNode {
	// Synthesise an AST.CastExpr. `targetType` is the only field CastNode itself
	// reads, but `formatExpression` renders a node from its AST rather than from
	// its children — a `literal null` placeholder here made every coerced operand
	// print as `cast(null as integer)` in EXPLAIN while the real operand child was
	// intact. Carrying the operand's own AST keeps the rendering truthful.
	const syntheticExpr: AST.CastExpr = {
		type: 'cast',
		expr: operand.expression,
		targetType,
	};
	return new CastNode(scope, syntheticExpr, operand);
}
