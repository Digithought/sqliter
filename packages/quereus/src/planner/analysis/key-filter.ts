/**
 * Residual key-filter injection.
 *
 * Shared machinery for delta-driven consumers (assertions, materialized views)
 * that compile a *residual* plan: the original body with a key-equality filter
 * injected onto one `TableReferenceNode`, parameterized by `pk0..`/`gk0..`. The
 * consumer then binds one changed binding tuple per run and executes the residual
 * to evaluate/maintain only the affected slice.
 *
 * Extracted verbatim from the assertion evaluator so assertions and MVs cannot
 * drift. See `database-assertions.ts` and `database-materialized-views.ts`.
 */

import type * as AST from '../../parser/ast.js';
import type { ScalarType } from '../../common/datatype.js';
import { BlockNode } from '../nodes/block.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode } from '../nodes/plan-node.js';
import { FilterNode } from '../nodes/filter.js';
import { BinaryOpNode, UnaryOpNode } from '../nodes/scalar.js';
import { ParameterReferenceNode, ColumnReferenceNode, TableReferenceNode } from '../nodes/reference.js';

/**
 * Inject a key-equality filter onto the `TableReferenceNode` matching
 * `targetRelationKey`. Used for both `'row'` (with PK columns + `'pk'` prefix)
 * and `'group'` (with group-key columns + `'gk'` prefix) bindings. Returns the
 * rewritten block (or the original block unchanged if the target reference was
 * not found — the caller treats that as "no residual available").
 */
export function injectKeyFilter(
	block: BlockNode,
	targetRelationKey: string,
	keyColumns: readonly number[],
	paramPrefix: 'pk' | 'gk',
): BlockNode {
	const newStatements = block.getChildren().map(stmt =>
		rewriteForKeyFilter(stmt, targetRelationKey, keyColumns, paramPrefix)
	);
	if (newStatements.every((s, i) => s === block.getChildren()[i])) return block;
	return new BlockNode(block.scope, newStatements, block.parameters);
}

function rewriteForKeyFilter(
	node: PlanNode,
	targetRelationKey: string,
	keyColumns: readonly number[],
	paramPrefix: 'pk' | 'gk',
): PlanNode {
	const maybe = tryWrapTableReference(node, targetRelationKey, keyColumns, paramPrefix);
	if (maybe) return maybe;

	const originalChildren = node.getChildren();
	if (!originalChildren || originalChildren.length === 0) return node;

	const rewrittenChildren = originalChildren.map(child =>
		rewriteForKeyFilter(child, targetRelationKey, keyColumns, paramPrefix)
	);
	const changed = rewrittenChildren.some((c, i) => c !== originalChildren[i]);
	return changed ? node.withChildren(rewrittenChildren) : node;
}

function tryWrapTableReference(
	node: PlanNode,
	targetRelationKey: string,
	keyColumns: readonly number[],
	paramPrefix: 'pk' | 'gk',
): PlanNode | null {
	if (!(node instanceof TableReferenceNode)) return null;

	const tableSchema = node.tableSchema;
	const schemaName = tableSchema.schemaName;
	const tableName = tableSchema.name;
	const relName = `${schemaName}.${tableName}`.toLowerCase();
	const relKey = `${relName}#${node.id ?? 'unknown'}`;

	if (relKey !== targetRelationKey) return null;

	const relational = node as RelationalPlanNode;
	const scope = relational.scope;
	const attributes = relational.getAttributes();

	const makeColumnRef = (colIndex: number): ScalarPlanNode => {
		const attr = attributes[colIndex];
		const expr: AST.ColumnExpr = { type: 'column', name: attr.name, table: tableName, schema: schemaName };
		return new ColumnReferenceNode(scope, expr, attr.type, attr.id, colIndex);
	};

	const makeParamRef = (i: number, type: ScalarType): ScalarPlanNode => {
		const name = `${paramPrefix}${i}`;
		const pexpr: AST.ParameterExpr = { type: 'parameter', name };
		return new ParameterReferenceNode(scope, pexpr, name, type);
	};

	// Per-column NULL safety: `col = :param` evaluates UNKNOWN when either
	// side is NULL, so a residual built from plain equalities would silently
	// skip change tuples whose key columns are NULL and miss real rows.
	// For each nullable key column emit the NULL-safe form:
	//   (col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i
	// For NOT NULL columns (typically PK columns on the 'row' path) keep
	// the simpler `col = :prefix_i` form to avoid disjunctive predicates
	// that could regress index-driven access.
	let predicate: ScalarPlanNode | null = null;
	for (let i = 0; i < keyColumns.length; i++) {
		const colIdx = keyColumns[i];
		const colNullable = attributes[colIdx].type.nullable === true;
		const left = makeColumnRef(colIdx);
		const right = makeParamRef(i, attributes[colIdx].type);
		const eqAst: AST.BinaryExpr = { type: 'binary', operator: '=', left: left.expression, right: right.expression };
		const eqNode = new BinaryOpNode(scope, eqAst, left, right);
		let conjunct: ScalarPlanNode = eqNode;
		if (colNullable) {
			const leftForNullCheck = makeColumnRef(colIdx);
			const rightForNullCheck = makeParamRef(i, attributes[colIdx].type);
			const leftIsNullAst: AST.UnaryExpr = { type: 'unary', operator: 'IS NULL', expr: leftForNullCheck.expression };
			const rightIsNullAst: AST.UnaryExpr = { type: 'unary', operator: 'IS NULL', expr: rightForNullCheck.expression };
			const leftIsNull = new UnaryOpNode(scope, leftIsNullAst, leftForNullCheck);
			const rightIsNull = new UnaryOpNode(scope, rightIsNullAst, rightForNullCheck);
			const bothNullAst: AST.BinaryExpr = { type: 'binary', operator: 'AND', left: leftIsNull.expression, right: rightIsNull.expression };
			const bothNull = new BinaryOpNode(scope, bothNullAst, leftIsNull, rightIsNull);
			const orAst: AST.BinaryExpr = { type: 'binary', operator: 'OR', left: bothNull.expression, right: eqNode.expression };
			conjunct = new BinaryOpNode(scope, orAst, bothNull, eqNode);
		}
		predicate = predicate
			? new BinaryOpNode(
				scope,
				{ type: 'binary', operator: 'AND', left: predicate.expression, right: conjunct.expression },
				predicate,
				conjunct
			)
			: conjunct;
	}

	// No predicate built ⇒ `keyColumns` was empty (a ≤1-row 'row' binding).
	// Leave the TableReferenceNode unwrapped: scanning the ≤1-row table whole
	// is exactly the seek. (The delta executor also demotes such bindings to a
	// global re-evaluation, so this residual is normally never dispatched.)
	if (!predicate) return null;

	return new FilterNode(scope, relational, predicate);
}
