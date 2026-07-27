/**
 * Expression fingerprinting for common subexpression detection.
 *
 * Produces a canonical string for a ScalarPlanNode tree. Two subtrees with the
 * same fingerprint compute the same value given the same row input.
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { LiteralNode, BinaryOpNode, UnaryOpNode, CaseExprNode, CastNode, CollateNode, BetweenNode } from '../nodes/scalar.js';
import type { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import type { ScalarFunctionCallNode } from '../nodes/function.js';
import type { AggregateFunctionCallNode } from '../nodes/aggregate-function.js';
import type { ArrayIndexNode } from '../nodes/array-index-node.js';
import type { WindowFunctionCallNode } from '../nodes/window-function.js';
import type { JSONValue } from '../../common/json-types.js';
import { canonicalJsonString } from '../../util/json-canonical.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:expression-fingerprint');

/** Commutative binary operators where operand order doesn't matter */
const COMMUTATIVE_OPS = new Set(['+', '*', '=', '!=', '<>', 'AND', 'OR']);

/**
 * Produce a deterministic fingerprint string for a scalar expression tree.
 *
 * Non-deterministic expressions return a unique string (the node id) so they
 * are never considered equal to any other expression.
 */
export function fingerprintExpression(node: ScalarPlanNode): string {
	// Non-deterministic nodes must never be deduplicated
	if (node.physical.deterministic === false) {
		return `_ND:${node.id}`;
	}

	switch (node.nodeType) {
		case PlanNodeType.Literal:
			return fingerprintLiteral(node as unknown as LiteralNode);

		case PlanNodeType.ColumnReference:
			return `CR:${(node as unknown as ColumnReferenceNode).attributeId}`;

		case PlanNodeType.ParameterReference: {
			const pr = node as unknown as ParameterReferenceNode;
			return `PR:${pr.nameOrIndex}`;
		}

		case PlanNodeType.UnaryOp: {
			const uo = node as unknown as UnaryOpNode;
			const operandFp = fingerprintExpression(uo.operand);
			return `UO:${uo.expression.operator}(${operandFp})`;
		}

		case PlanNodeType.BinaryOp: {
			const bo = node as unknown as BinaryOpNode;
			let leftFp = fingerprintExpression(bo.left);
			let rightFp = fingerprintExpression(bo.right);
			if (COMMUTATIVE_OPS.has(bo.expression.operator) && rightFp < leftFp) {
				[leftFp, rightFp] = [rightFp, leftFp];
			}
			return `BO:${bo.expression.operator}(${leftFp},${rightFp})`;
		}

		case PlanNodeType.ScalarFunctionCall:
			return fingerprintFunctionCall(node);

		case PlanNodeType.CaseExpr:
			return fingerprintCase(node as unknown as CaseExprNode);

		case PlanNodeType.Cast: {
			const ca = node as unknown as CastNode;
			// NOTE: keys off the written target name, so `cast(x as varchar)` and
			// `cast(x as text)` fingerprint apart even though both resolve to TEXT. Only
			// costs a missed CSE (never an over-merge); switch to
			// `ca.getType().logicalType.name` if alias-spelled casts ever need to share.
			return `CA:${ca.expression.targetType}(${fingerprintExpression(ca.operand)})`;
		}

		case PlanNodeType.Collate: {
			const co = node as unknown as CollateNode;
			return `CO:${co.expression.collation}(${fingerprintExpression(co.operand)})`;
		}

		case PlanNodeType.Between: {
			const bw = node as unknown as BetweenNode;
			const neg = bw.expression.not ? '!' : '';
			return `BW:${neg}(${fingerprintExpression(bw.expr)},${fingerprintExpression(bw.lower)},${fingerprintExpression(bw.upper)})`;
		}

		case PlanNodeType.ArrayIndex:
			return `AI:${(node as unknown as ArrayIndexNode).index}`;

		case PlanNodeType.WindowFunctionCall: {
			const wf = node as unknown as WindowFunctionCallNode;
			return `WF:${wf.functionName}:${wf.isDistinct}:${node.id}`;
		}

		// Subquery-bearing nodes get unique fingerprints — their relational
		// subtrees are too complex to canonicalize here.
		case PlanNodeType.ScalarSubquery:
		case PlanNodeType.In:
		case PlanNodeType.Exists:
			return `_SQ:${node.id}`;

		default:
			// Unknown scalar node type — treat as unique
			return `_UK:${node.id}`;
	}
}

function fingerprintLiteral(node: LiteralNode): string {
	const value = node.expression.value;
	if (value === null) return 'LI:null';
	if (typeof value === 'bigint') return `LI:${value}n`;
	if (typeof value === 'number') return `LI:${value}f`;
	if (typeof value === 'string') return `LI:'${value}'`;
	if (typeof value === 'boolean') return `LI:${value}`;
	if (value instanceof Uint8Array) {
		return `LI:x${Array.from(value, b => b.toString(16).padStart(2, '0')).join('')}`;
	}
	if (typeof value === 'object') {
		// A JSON document (the only OBJECT-class literal). `String(value)` collapses
		// every one of them to '[object Object]', which would make CSE treat
		// `v = {"a":1}` and `v = {"a":2}` as the same expression and evaluate only the
		// first. Canonical JSON is the same key derivation the value comparator and the
		// index agree on: reorder-equal documents share a fingerprint, distinct ones
		// never do.
		//
		// NOTE: the fingerprint embeds the whole document, so it grows with the literal.
		// Fine while literals are hand-written or small folded constants; if large JSON
		// constants ever become common, hash the canonical string instead of inlining it.
		try {
			return `LI:j${canonicalJsonString(value as JSONValue)}`;
		} catch (e) {
			// Not serializable (cyclic, or a non-JSON host object). Fall back to a
			// per-node fingerprint so it is never deduplicated against anything — safe,
			// but it silently disables CSE for this literal, so say so.
			log('literal object is not canonicalizable, fingerprinting node %d uniquely: %s',
				node.id, e instanceof Error ? e.message : String(e));
			return `LI:?${node.id}`;
		}
	}
	return `LI:?${String(value)}`;
}

/**
 * Fingerprint for ScalarFunctionCallNode and AggregateFunctionCallNode.
 * Both share PlanNodeType.ScalarFunctionCall; we distinguish them by
 * checking for the aggregate-specific `functionName` property.
 */
function fingerprintFunctionCall(node: ScalarPlanNode): string {
	// AggregateFunctionCallNode has a `functionName` property and `isDistinct`
	if ('functionName' in node) {
		const agg = node as unknown as AggregateFunctionCallNode;
		const argsFp = agg.args.map(a => fingerprintExpression(a)).join(',');
		const distTag = agg.isDistinct ? 'D' : '';
		return `AG:${agg.functionName}${distTag}(${argsFp})`;
	}

	const fn = node as unknown as ScalarFunctionCallNode;
	const argsFp = fn.operands.map(a => fingerprintExpression(a)).join(',');
	return `FN:${fn.expression.name}(${argsFp})`;
}

function fingerprintCase(node: CaseExprNode): string {
	const parts: string[] = [];
	if (node.baseExpr) {
		parts.push(fingerprintExpression(node.baseExpr));
	}
	for (const clause of node.whenThenClauses) {
		parts.push(`W:${fingerprintExpression(clause.when)}`);
		parts.push(`T:${fingerprintExpression(clause.then)}`);
	}
	if (node.elseExpr) {
		parts.push(`E:${fingerprintExpression(node.elseExpr)}`);
	}
	return `CE(${parts.join(',')})`;
}
