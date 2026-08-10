/**
 * Rule: Sargable Range Rewrite
 *
 * For predicates of the form `f(col) = c` where `f` is a monotone-but-lossy
 * bucket conversion (e.g. `date(datetime_col) = '2024-01-15'`), rewrite the
 * conjunct to a half-open range on the underlying column:
 *
 *   f(col) = c   →   col >= lower(c)  AND  col < upper(c)
 *
 * The half-open bounds come from `ScalarPlanNode.rangeRewriteIn(attrId, c)`,
 * which delegates to `LogicalType.bucketBounds` on the column's logical type.
 * The rewritten `col op literal` shape is what `analysis/constraint-extractor`
 * already recognizes, so the resulting range can be pushed through
 * `rule-predicate-pushdown` into the Retrieve pipeline and consumed by
 * `rule-select-access-path` (IndexSeek, range scans, etc.).
 *
 * NULL semantics: a null constant is left alone (`f(col) = null` is already
 * null, which WHERE / ON treat as false). A null column value satisfies neither
 * `col >= L` nor `col < U` (both yield null), so row-rejection behavior
 * matches the original predicate.
 *
 * Only the `=` shape is handled in this pass; `<`/`<=`/`>`/`>=` need direction
 * analysis on `monotonicityIn` and asymmetric bound mapping — tracked
 * separately in the optimization backlog.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { BinaryOpNode, CastNode, LiteralNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../nodes/reference.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { getSyncLiteral } from '../../../parser/utils.js';
import type { SqlValue } from '../../../common/types.js';
import type * as AST from '../../../parser/ast.js';
import type { ScalarType } from '../../../common/datatype.js';

const log = createLogger('optimizer:rule:sargable-range-rewrite');

export function ruleSargableRangeRewrite(node: PlanNode, _context: OptContext): PlanNode | null {
	if (node.nodeType !== PlanNodeType.Filter) return null;
	const filter = node as FilterNode;

	const conjuncts = splitConjuncts(filter.predicate);
	let rewrittenCount = 0;
	const out: ScalarPlanNode[] = [];
	for (const c of conjuncts) {
		const rewritten = tryRewriteEqualityToRange(c);
		if (rewritten) {
			out.push(rewritten);
			rewrittenCount++;
		} else {
			out.push(c);
		}
	}
	if (rewrittenCount === 0) return null;

	const combined = combineConjuncts(out);
	if (!combined) return null;

	log('Rewrote %d sargable bucket-equality conjunct(s)', rewrittenCount);
	return new FilterNode(filter.scope, filter.source, combined);
}

/**
 * Recognize a `f(col) = const` conjunct and lift it to a half-open range on
 * `col`. Returns the rewritten AND-tree on success, or `undefined` when the
 * conjunct is not in the recognized shape / the function declines the rewrite.
 */
function tryRewriteEqualityToRange(expr: ScalarPlanNode): ScalarPlanNode | undefined {
	if (expr.nodeType !== PlanNodeType.BinaryOp) return undefined;
	const bin = expr as BinaryOpNode;
	if (bin.expression.operator !== '=') return undefined;

	// Exactly one side must be a literal constant; the other is the candidate
	// function-shaped expression.
	const leftLit = isLiteralConstant(bin.left);
	const rightLit = isLiteralConstant(bin.right);
	if (leftLit === rightLit) return undefined; // both or neither

	const literalSide = leftLit ? bin.left : bin.right;
	const candidateSide = leftLit ? bin.right : bin.left;
	const literalValue = getLiteralValue(literalSide);
	if (literalValue === null) return undefined;

	// The candidate must depend on exactly one column attribute. Other leaves
	// (literals / parameters) are fine — `rangeRewriteIn` itself enforces that
	// the operand at the trait index is a bare ColumnReferenceNode.
	const colRef = findUniqueColumnReference(candidateSide);
	if (!colRef) return undefined;

	const bounds = candidateSide.rangeRewriteIn(colRef.attributeId, literalValue);
	if (!bounds) return undefined;

	// Build `col >= L AND col < U` reusing the original ColumnReferenceNode (so
	// the attribute id survives verbatim for downstream constraint extraction).
	const scope = expr.scope;
	const colType = colRef.getType();
	const lower = makeComparison(scope, colRef, '>=', bounds.lowerInclusive, colType);
	const upper = makeComparison(scope, colRef, '<', bounds.upperExclusive, colType);
	const andAst: AST.BinaryExpr = {
		type: 'binary',
		operator: 'AND',
		left: lower.expression,
		right: upper.expression,
	};
	return new BinaryOpNode(scope, andAst, lower, upper);
}

function makeComparison(
	scope: ScalarPlanNode['scope'],
	colRef: ColumnReferenceNode,
	op: '>=' | '<',
	value: SqlValue,
	colType: ScalarType,
): BinaryOpNode {
	const litExpr: AST.LiteralExpr = { type: 'literal', value };
	const literal = new LiteralNode(scope, litExpr, colType);
	const ast: AST.BinaryExpr = {
		type: 'binary',
		operator: op,
		left: colRef.expression,
		right: litExpr,
	};
	return new BinaryOpNode(scope, ast, colRef, literal);
}

/**
 * Strip a planner-inserted CastNode wrapper.
 *
 * NOTE: this strips a *converting* cast too, so `getLiteralValue` below would
 * yield the pre-cast value for `cast(1 as text)` — the same defect fixed in
 * `constraint-extractor.ts`'s `unwrapCast` (ticket
 * `bug-cast-stripped-from-seek-constraints`). It is dormant here because
 * constant folding collapses a cast over a literal before this rule runs, and
 * because the column side never reaches this helper: the rule calls
 * `candidateSide.rangeRewriteIn(...)`, which a CastNode declines. If either
 * assumption stops holding, gate on `isNoOpCast` as that file does.
 */
function unwrapCast(node: ScalarPlanNode): ScalarPlanNode {
	return node.nodeType === PlanNodeType.Cast ? (node as CastNode).operand : node;
}

function isLiteralConstant(node: ScalarPlanNode): boolean {
	return unwrapCast(node).nodeType === PlanNodeType.Literal;
}

function getLiteralValue(node: ScalarPlanNode): SqlValue {
	const lit = unwrapCast(node) as LiteralNode;
	return getSyncLiteral(lit.expression);
}

/**
 * Walk the subtree's leaves and return the single `ColumnReferenceNode` if
 * exactly one is found and every other leaf is a literal or parameter; return
 * undefined for zero, two, or any unrecognized leaf shape (subqueries,
 * function-of-other-column, etc.).
 */
function findUniqueColumnReference(node: ScalarPlanNode): ColumnReferenceNode | undefined {
	let found: ColumnReferenceNode | undefined;
	let ok = true;
	const visit = (n: ScalarPlanNode): void => {
		if (!ok) return;
		const children = n.getChildren();
		if (children.length === 0) {
			if (n instanceof ColumnReferenceNode) {
				if (found && found !== n) { ok = false; return; }
				found = n;
				return;
			}
			if (n instanceof LiteralNode || n instanceof ParameterReferenceNode) {
				return;
			}
			ok = false;
			return;
		}
		for (const c of children) {
			visit(c as ScalarPlanNode);
		}
	};
	visit(node);
	return ok ? found : undefined;
}
